const { createHash } = require('node:crypto');

const CANONICAL_ORIGIN = 'https://xn--hc0bj51alpe00g.com';
const CANONICAL_HOST = 'xn--hc0bj51alpe00g.com';
const MAX_BODY_BYTES = 6 * 1024;
const MIN_FORM_AGE_MS = 2_500;
const MAX_FORM_AGE_MS = 2 * 60 * 60 * 1000;
const DUPLICATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_WINDOW_MS = 60 * 60 * 1000;
const MAX_REQUESTS_PER_IP = 3;
const ALLOWED_FIELDS = new Set([
  'name', 'phone', 'program', 'visitor', 'preferredTime', 'email', 'message',
  'source', 'pageUrl', 'website', 'formStartedAt', 'submissionId', 'turnstileToken',
]);
const FROM_EMAIL = process.env.CONSULT_FROM_EMAIL || '중흥복싱 상담 <onboarding@resend.dev>';

// Vercel Functions are stateless. These are only supplements to Turnstile, not
// a durable replacement for it.
const recentSubmissions = new Map();
const requestWindows = new Map();

class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function hasCanonicalHost(req) {
  const host = String(req.headers.host || '').toLowerCase();
  return host === CANONICAL_HOST || host === `${CANONICAL_HOST}:443`;
}

function hasCanonicalOrigin(req) {
  return String(req.headers.origin || '') === CANONICAL_ORIGIN;
}

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', CANONICAL_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');
}

function setSafeResponseHeaders(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

function reject(res, status, message) {
  return res.status(status).json({ ok: false, message });
}

function isJsonContentType(req) {
  return /^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type'] || ''));
}

function parseContentLength(req) {
  const rawLength = req.headers['content-length'];
  if (rawLength === undefined) return null;
  if (!/^\d+$/.test(String(rawLength))) throw new RequestError(400, '잘못된 요청입니다.');
  const length = Number(rawLength);
  if (!Number.isSafeInteger(length)) throw new RequestError(400, '잘못된 요청입니다.');
  return length;
}

async function readJsonBody(req) {
  const contentLength = parseContentLength(req);
  if (contentLength !== null && contentLength > MAX_BODY_BYTES) {
    throw new RequestError(413, '상담 내용은 6KB 이하로 입력해 주세요.');
  }

  // Vercel's body parser is separately capped below. Keep this check for tests
  // and runtimes that hand the function an already-parsed body.
  if (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) {
    if (Buffer.byteLength(JSON.stringify(req.body)) > MAX_BODY_BYTES) {
      throw new RequestError(413, '상담 내용은 6KB 이하로 입력해 주세요.');
    }
    return req.body;
  }

  if (typeof req.body === 'string') {
    if (Buffer.byteLength(req.body) > MAX_BODY_BYTES) throw new RequestError(413, '상담 내용은 6KB 이하로 입력해 주세요.');
    try {
      return req.body ? JSON.parse(req.body) : {};
    } catch {
      throw new RequestError(400, 'JSON 형식의 요청만 허용됩니다.');
    }
  }

  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_BODY_BYTES) throw new RequestError(413, '상담 내용은 6KB 이하로 입력해 주세요.');
    chunks.push(buffer);
  }

  try {
    const raw = Buffer.concat(chunks).toString('utf8');
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw new RequestError(400, 'JSON 형식의 요청만 허용됩니다.');
  }
}

function clean(value, maxLength = 500) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, maxLength);
}

function assertBodyShape(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RequestError(400, '잘못된 요청입니다.');
  for (const [key, value] of Object.entries(body)) {
    if (!ALLOWED_FIELDS.has(key) || (value !== undefined && typeof value !== 'string' && typeof value !== 'number')) {
      throw new RequestError(400, '잘못된 요청입니다.');
    }
  }
}

function canonicalPageUrl(value) {
  if (!value) return '';
  try {
    const url = new URL(value);
    if (url.origin !== CANONICAL_ORIGIN || url.username || url.password || url.hash) return '';
    return `${url.origin}${url.pathname}${url.search}`.slice(0, 500);
  } catch {
    return '';
  }
}

function validateFormTiming(body) {
  const startedAt = Number(body.formStartedAt);
  const age = Date.now() - startedAt;
  if (!Number.isSafeInteger(startedAt) || age < MIN_FORM_AGE_MS || age > MAX_FORM_AGE_MS) {
    throw new RequestError(400, '상담 페이지를 새로 열어 다시 작성해 주세요.');
  }
}

function getClientIp(req) {
  const forwarded = String(req.headers['x-vercel-forwarded-for'] || req.headers['x-forwarded-for'] || '');
  return forwarded.split(',')[0].trim().slice(0, 100) || 'unknown';
}

function pruneMemory(now) {
  for (const [key, expiresAt] of recentSubmissions) if (expiresAt <= now) recentSubmissions.delete(key);
  for (const [ip, timestamps] of requestWindows) {
    const active = timestamps.filter((timestamp) => timestamp > now - RATE_WINDOW_MS);
    if (active.length) requestWindows.set(ip, active);
    else requestWindows.delete(ip);
  }
}

function enforceBestEffortAbuseLimits(req, fields, submissionId) {
  const now = Date.now();
  pruneMemory(now);
  const ip = getClientIp(req);
  const attempts = requestWindows.get(ip) || [];
  if (attempts.length >= MAX_REQUESTS_PER_IP) throw new RequestError(429, '잠시 후 다시 시도해 주세요. 전화 문의도 가능합니다.');

  const fingerprint = createHash('sha256').update(`${ip}\n${submissionId}\n${fields.name}\n${fields.phone}\n${fields.message}`).digest('hex');
  if (recentSubmissions.has(fingerprint)) throw new RequestError(409, '이미 접수된 상담 신청입니다.');

  attempts.push(now);
  requestWindows.set(ip, attempts);
  recentSubmissions.set(fingerprint, now + DUPLICATE_WINDOW_MS);
  return { fingerprint, ip };
}

function clearAbuseReservation(reservation) {
  if (reservation) recentSubmissions.delete(reservation.fingerprint);
}

function escapeHtml(value) {
  return clean(value, 2000).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function buildEmailHtml(fields) {
  const rows = [
    ['이름', fields.name], ['연락처', fields.phone], ['관심 프로그램', fields.program], ['운동 대상', fields.visitor],
    ['희망 연락 시간', fields.preferredTime], ['이메일', fields.email], ['유입 경로', fields.source], ['접수 페이지', fields.pageUrl],
  ].filter(([, value]) => value).map(([label, value]) => `<tr><th style="width:120px;padding:10px 12px;text-align:left;background:#111827;color:#fbbf24;border:1px solid #374151">${label}</th><td style="padding:10px 12px;border:1px solid #374151;color:#111827">${escapeHtml(value)}</td></tr>`).join('');
  const message = fields.message ? `<h2 style="font-size:16px;margin:22px 0 8px;color:#111827">문의 내용</h2><div style="white-space:pre-line;padding:14px;border:1px solid #374151;background:#f9fafb;color:#111827">${escapeHtml(fields.message)}</div>` : '';
  return `<div style="font-family:Arial,'Noto Sans KR',sans-serif;line-height:1.6;color:#111827"><h1 style="font-size:20px;margin:0 0 16px;color:#b91c1c">중흥복싱 상담 신청</h1><table style="border-collapse:collapse;width:100%;max-width:680px">${rows}</table>${message}</div>`;
}

function buildEmailText(fields) {
  return [
    '[중흥복싱 상담 신청]', `이름: ${fields.name}`, `연락처: ${fields.phone}`, fields.program ? `관심 프로그램: ${fields.program}` : '',
    fields.visitor ? `운동 대상: ${fields.visitor}` : '', fields.preferredTime ? `희망 연락 시간: ${fields.preferredTime}` : '',
    fields.email ? `이메일: ${fields.email}` : '', fields.source ? `유입 경로: ${fields.source}` : '', fields.pageUrl ? `접수 페이지: ${fields.pageUrl}` : '',
    '', fields.message ? `문의 내용:\n${fields.message}` : '',
  ].filter(Boolean).join('\n');
}

async function verifyTurnstile(token, ip) {
  const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ secret: process.env.CONSULT_TURNSTILE_SECRET, response: token, remoteip: ip }),
  });
  const result = await response.json().catch(() => ({}));
  return response.ok && result.success === true && result.hostname === CANONICAL_HOST;
}

module.exports = async function handler(req, res) {
  setSafeResponseHeaders(res);

  // Origin is an authentication signal here, not merely a CORS hint.
  if (!hasCanonicalHost(req) || !hasCanonicalOrigin(req)) return reject(res, 403, '허용되지 않은 요청입니다.');
  setCorsHeaders(res);

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return reject(res, 405, '상담 신청은 POST 요청만 가능합니다.');
  if (!isJsonContentType(req)) return reject(res, 415, 'JSON 형식의 요청만 허용됩니다.');

  try {
    const body = await readJsonBody(req);
    assertBodyShape(body);
    if (clean(body.website, 80)) return res.status(200).json({ ok: true, message: '상담 신청이 접수되었습니다.' });

    // Stateless memory cannot safely protect a public email relay on its own.
    if (process.env.CONSULT_API_ENABLED !== 'true' || !process.env.CONSULT_TURNSTILE_SECRET) {
      return reject(res, 503, '온라인 상담 접수는 현재 이용할 수 없습니다. 062-521-9848로 전화 문의해 주세요.');
    }

    validateFormTiming(body);
    const submissionId = clean(body.submissionId, 100);
    const turnstileToken = clean(body.turnstileToken, 2048);
    if (!/^[A-Za-z0-9_-]{16,100}$/.test(submissionId) || !turnstileToken) {
      return reject(res, 400, '상담 페이지를 새로 열어 다시 작성해 주세요.');
    }

    const fields = {
      name: clean(body.name, 80), phone: clean(body.phone, 80), program: clean(body.program, 120), visitor: clean(body.visitor, 120),
      preferredTime: clean(body.preferredTime, 120), email: clean(body.email, 160), message: clean(body.message, 1500),
      source: clean(body.source, 80), pageUrl: canonicalPageUrl(clean(body.pageUrl, 500)),
    };
    if (!fields.name || !fields.phone || (body.pageUrl && !fields.pageUrl)) return reject(res, 400, '이름과 연락처를 확인해 주세요.');

    const ip = getClientIp(req);
    const challengePassed = await verifyTurnstile(turnstileToken, ip);
    if (!challengePassed) {
      return reject(res, 403, '자동화 방지 확인에 실패했습니다. 전화 문의를 이용해 주세요.');
    }
    const reservation = enforceBestEffortAbuseLimits(req, fields, submissionId);
    if (!process.env.RESEND_API_KEY || !process.env.CONSULT_TO_EMAIL) {
      clearAbuseReservation(reservation);
      return reject(res, 503, '온라인 상담 접수는 현재 이용할 수 없습니다. 062-521-9848로 전화 문의해 주세요.');
    }

    const payload = { from: FROM_EMAIL, to: [process.env.CONSULT_TO_EMAIL], subject: `[중흥복싱 상담] ${fields.name}님 문의`, html: buildEmailHtml(fields), text: buildEmailText(fields) };
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fields.email)) payload.reply_to = fields.email;

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      clearAbuseReservation(reservation);
      console.error('Consult relay rejected the request.', response.status);
      return reject(res, 502, '메일 발송에 실패했습니다. 전화 문의를 이용해 주세요.');
    }
    return res.status(200).json({ ok: true, message: '상담 신청이 접수되었습니다.', id: result.id });
  } catch (error) {
    if (error instanceof RequestError) return reject(res, error.status, error.message);
    console.error('Consult request failed.', error && error.name);
    return reject(res, 503, '온라인 상담 접수는 현재 이용할 수 없습니다. 062-521-9848로 전화 문의해 주세요.');
  }
};

// Protect the request before Vercel parses it into req.body.
module.exports.config = { api: { bodyParser: { sizeLimit: '6kb' } } };
