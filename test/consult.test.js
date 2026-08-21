const assert = require('node:assert/strict');
const fs = require('node:fs');
const { Readable } = require('node:stream');
const test = require('node:test');

const handler = require('../api/consult');

const CANONICAL_ORIGIN = 'https://xn--hc0bj51alpe00g.com';
const CANONICAL_HOST = 'xn--hc0bj51alpe00g.com';

function request({
  method = 'POST',
  origin = CANONICAL_ORIGIN,
  host = CANONICAL_HOST,
  contentType = 'application/json',
  ip = '203.0.113.10',
  body = {},
  rawBody,
} = {}) {
  const raw = rawBody === undefined ? JSON.stringify(body) : rawBody;
  const req = Readable.from(raw ? [Buffer.from(raw)] : []);
  req.method = method;
  req.headers = {
    host,
    origin,
    'content-type': contentType,
    'content-length': Buffer.byteLength(raw).toString(),
    'x-forwarded-for': ip,
  };
  return req;
}

function response() {
  return {
    headers: {},
    statusCode: 200,
    payload: undefined,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
    end() { this.ended = true; return this; },
  };
}

async function call(options) {
  const res = response();
  await handler(request(options), res);
  return res;
}

test('rejects a POST from an untrusted Origin before reading or relaying it', async () => {
  const res = await call({ origin: 'https://evil.example', body: { name: '홍길동', phone: '010-0000-0000' } });
  assert.equal(res.statusCode, 403);
  assert.equal(res.headers['access-control-allow-origin'], undefined);
});

test('rejects an allowed Origin when the Host is spoofed', async () => {
  const res = await call({ host: 'evil.example', body: { name: '홍길동', phone: '010-0000-0000' } });
  assert.equal(res.statusCode, 403);
});

test('rejects non-JSON requests', async () => {
  const res = await call({ contentType: 'text/plain', rawBody: 'name=Hong&phone=010' });
  assert.equal(res.statusCode, 415);
});

test('rejects bodies larger than the API byte cap', async () => {
  const res = await call({ rawBody: JSON.stringify({ name: '홍길동', phone: '010-0000-0000', message: 'x'.repeat(7000) }) });
  assert.equal(res.statusCode, 413);
});

test('fails closed while the externally durable anti-abuse gate is not enabled', async () => {
  const original = {
    enabled: process.env.CONSULT_API_ENABLED,
    turnstile: process.env.CONSULT_TURNSTILE_SECRET,
  };
  delete process.env.CONSULT_API_ENABLED;
  delete process.env.CONSULT_TURNSTILE_SECRET;
  try {
    const res = await call({ body: { name: '홍길동', phone: '010-0000-0000', formStartedAt: String(Date.now() - 5000) } });
    assert.equal(res.statusCode, 503);
    assert.match(res.payload.message, /전화/);
  } finally {
    if (original.enabled === undefined) delete process.env.CONSULT_API_ENABLED;
    else process.env.CONSULT_API_ENABLED = original.enabled;
    if (original.turnstile === undefined) delete process.env.CONSULT_TURNSTILE_SECRET;
    else process.env.CONSULT_TURNSTILE_SECRET = original.turnstile;
  }
});

test('never relays mail when Turnstile verification fails', async () => {
  const original = {
    enabled: process.env.CONSULT_API_ENABLED,
    turnstile: process.env.CONSULT_TURNSTILE_SECRET,
    resend: process.env.RESEND_API_KEY,
    recipient: process.env.CONSULT_TO_EMAIL,
    fetch: global.fetch,
  };
  process.env.CONSULT_API_ENABLED = 'true';
  process.env.CONSULT_TURNSTILE_SECRET = 'test-secret';
  process.env.RESEND_API_KEY = 'test-key';
  process.env.CONSULT_TO_EMAIL = 'test@example.invalid';
  const calls = [];
  global.fetch = async (url) => {
    calls.push(String(url));
    return { ok: true, json: async () => ({ success: false, hostname: CANONICAL_HOST }) };
  };
  try {
    const res = await call({
      ip: '203.0.113.21',
      body: {
        name: '홍길동', phone: '010-0000-0000', formStartedAt: String(Date.now() - 5000),
        submissionId: '1234567890abcdef', turnstileToken: 'invalid-token', pageUrl: `${CANONICAL_ORIGIN}/`,
      },
    });
    assert.equal(res.statusCode, 403);
    assert.deepEqual(calls, ['https://challenges.cloudflare.com/turnstile/v0/siteverify']);
  } finally {
    global.fetch = original.fetch;
    if (original.enabled === undefined) delete process.env.CONSULT_API_ENABLED;
    else process.env.CONSULT_API_ENABLED = original.enabled;
    if (original.turnstile === undefined) delete process.env.CONSULT_TURNSTILE_SECRET;
    else process.env.CONSULT_TURNSTILE_SECRET = original.turnstile;
    if (original.resend === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = original.resend;
    if (original.recipient === undefined) delete process.env.CONSULT_TO_EMAIL;
    else process.env.CONSULT_TO_EMAIL = original.recipient;
  }
});

test('does not render a personal-data form while the public relay is fail-closed', () => {
  const homepage = fs.readFileSync(require.resolve('../index.html'), 'utf8');
  assert.doesNotMatch(homepage, /id="consultForm"/);
  assert.doesNotMatch(homepage, /fetch\('\/api\/consult'/);
  assert.doesNotMatch(homepage, /온라인 상담 신청/);
  assert.match(homepage, /href="tel:062-521-9848"/);
  assert.match(homepage, /온라인 접수는 자동화 방지 보안 설정을 완료하는 동안 잠시 받지 않습니다/);
});
