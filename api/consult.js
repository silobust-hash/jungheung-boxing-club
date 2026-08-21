const ALLOWED_ORIGINS = new Set([
  'https://xn--hc0bj51alpe00g.com',
  'https://www.xn--hc0bj51alpe00g.com',
  'https://blog.xn--hc0bj51alpe00g.com',
  'http://localhost:3000',
  'http://localhost:8080',
]);

const FROM_EMAIL = process.env.CONSULT_FROM_EMAIL || '중흥복싱 상담 <onboarding@resend.dev>';

function setCorsHeaders(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') {
    return req.body;
  }

  if (typeof req.body === 'string') {
    return req.body ? JSON.parse(req.body) : {};
  }

  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
  }
  return raw ? JSON.parse(raw) : {};
}

function clean(value, maxLength = 500) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, maxLength);
}

function escapeHtml(value) {
  return clean(value, 2000)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildEmailHtml(fields) {
  const rows = [
    ['이름', fields.name],
    ['연락처', fields.phone],
    ['관심 프로그램', fields.program],
    ['운동 대상', fields.visitor],
    ['희망 연락 시간', fields.preferredTime],
    ['이메일', fields.email],
    ['유입 경로', fields.source],
    ['접수 페이지', fields.pageUrl],
  ]
    .filter(([, value]) => value)
    .map(([label, value]) => `
      <tr>
        <th style="width:120px;padding:10px 12px;text-align:left;background:#111827;color:#fbbf24;border:1px solid #374151">${label}</th>
        <td style="padding:10px 12px;border:1px solid #374151;color:#111827">${escapeHtml(value)}</td>
      </tr>`)
    .join('');

  const message = fields.message
    ? `<h2 style="font-size:16px;margin:22px 0 8px;color:#111827">문의 내용</h2><div style="white-space:pre-line;padding:14px;border:1px solid #374151;background:#f9fafb;color:#111827">${escapeHtml(fields.message)}</div>`
    : '';

  return `
    <div style="font-family:Arial,'Noto Sans KR',sans-serif;line-height:1.6;color:#111827">
      <h1 style="font-size:20px;margin:0 0 16px;color:#b91c1c">중흥복싱 상담 신청</h1>
      <table style="border-collapse:collapse;width:100%;max-width:680px">${rows}</table>
      ${message}
    </div>`;
}

function buildEmailText(fields) {
  return [
    '[중흥복싱 상담 신청]',
    `이름: ${fields.name}`,
    `연락처: ${fields.phone}`,
    fields.program ? `관심 프로그램: ${fields.program}` : '',
    fields.visitor ? `운동 대상: ${fields.visitor}` : '',
    fields.preferredTime ? `희망 연락 시간: ${fields.preferredTime}` : '',
    fields.email ? `이메일: ${fields.email}` : '',
    fields.source ? `유입 경로: ${fields.source}` : '',
    fields.pageUrl ? `접수 페이지: ${fields.pageUrl}` : '',
    '',
    fields.message ? `문의 내용:\n${fields.message}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

module.exports = async function handler(req, res) {
  setCorsHeaders(req, res);

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, message: '상담 신청은 POST 요청만 가능합니다.' });
  }

  try {
    const body = await readJsonBody(req);

    if (clean(body.website)) {
      return res.status(200).json({ ok: true, message: '상담 신청이 접수되었습니다.' });
    }

    const fields = {
      name: clean(body.name, 80),
      phone: clean(body.phone || body.contact, 80),
      program: clean(body.program, 120),
      visitor: clean(body.visitor, 120),
      preferredTime: clean(body.preferredTime, 120),
      email: clean(body.email, 160),
      message: clean(body.message, 1500),
      source: clean(body.source, 80),
      pageUrl: clean(body.pageUrl, 500),
    };

    if (!fields.name || !fields.phone) {
      return res.status(400).json({ ok: false, message: '이름과 연락처를 입력해 주세요.' });
    }

    if (!process.env.RESEND_API_KEY || !process.env.CONSULT_TO_EMAIL) {
      return res.status(500).json({ ok: false, message: '상담 접수 설정이 아직 완료되지 않았습니다.' });
    }

    const payload = {
      from: FROM_EMAIL,
      to: [process.env.CONSULT_TO_EMAIL],
      subject: `[중흥복싱 상담] ${fields.name}님 문의`,
      html: buildEmailHtml(fields),
      text: buildEmailText(fields),
    };

    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fields.email)) {
      payload.reply_to = fields.email;
    }

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error('Resend send failed', response.status, result);
      return res.status(502).json({ ok: false, message: '메일 발송에 실패했습니다. 전화 문의를 이용해 주세요.' });
    }

    return res.status(200).json({ ok: true, message: '상담 신청이 접수되었습니다.', id: result.id });
  } catch (error) {
    console.error('Consult request failed', error);
    return res.status(500).json({ ok: false, message: '상담 신청 처리 중 오류가 발생했습니다.' });
  }
};
