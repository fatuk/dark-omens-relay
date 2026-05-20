import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from './helpers.js';
import { buildApp } from '../src/api/app.js';
import { getDevOtpLog } from '../src/api/mailer.js';

const app = buildApp();

function jsonReq(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

async function getOtpFor(email: string): Promise<string> {
  const res = await app.fetch(jsonReq('/auth/request', { email }));
  expect(res.status).toBe(200);
  const entry = getDevOtpLog().find(e => e.email === email.toLowerCase());
  if (!entry) throw new Error(`OTP не выпущен для ${email}`);
  return entry.code;
}

beforeEach(() => { resetDb(); });

describe('POST /auth/request', () => {
  it('успешно создаёт OTP для валидного email', async () => {
    const res = await app.fetch(jsonReq('/auth/request', { email: 'alice@example.com' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
    expect(getDevOtpLog().some(e => e.email === 'alice@example.com')).toBe(true);
  });

  it('email нормализуется в lowercase + trim', async () => {
    await app.fetch(jsonReq('/auth/request', { email: '  ALICE@Example.COM  ' }));
    expect(getDevOtpLog().some(e => e.email === 'alice@example.com')).toBe(true);
  });

  it('400 для невалидного email', async () => {
    const res = await app.fetch(jsonReq('/auth/request', { email: 'not-an-email' }));
    expect(res.status).toBe(400);
  });

  it('rate-limit: после 3 запросов на один email → 429', async () => {
    for (let i = 0; i < 3; i++) {
      const ok = await app.fetch(jsonReq('/auth/request', { email: 'spam@example.com' }));
      expect(ok.status).toBe(200);
    }
    const fourth = await app.fetch(jsonReq('/auth/request', { email: 'spam@example.com' }));
    expect(fourth.status).toBe(429);
  });
});

describe('POST /auth/verify', () => {
  it('правильный код → 200, токен, новый пользователь', async () => {
    const code = await getOtpFor('alice@example.com');
    const res = await app.fetch(jsonReq('/auth/verify', { email: 'alice@example.com', code }));
    expect(res.status).toBe(200);
    const json = await res.json() as { token?: string; user?: { id: string; email: string } };
    expect(typeof json.token).toBe('string');
    expect(json.token!.length).toBeGreaterThan(0);
    expect(json.user!.email).toBe('alice@example.com');
  });

  it('неверный код → 400', async () => {
    await getOtpFor('alice@example.com');
    const res = await app.fetch(jsonReq('/auth/verify', { email: 'alice@example.com', code: '000000' }));
    expect(res.status).toBe(400);
  });

  it('код не запрашивался → 400', async () => {
    const res = await app.fetch(jsonReq('/auth/verify', { email: 'never@asked.com', code: '123456' }));
    expect(res.status).toBe(400);
  });

  it('после 5 неудачных попыток код выкидывается → 429', async () => {
    await getOtpFor('alice@example.com');
    for (let i = 0; i < 5; i++) {
      await app.fetch(jsonReq('/auth/verify', { email: 'alice@example.com', code: '000000' }));
    }
    const res = await app.fetch(jsonReq('/auth/verify', { email: 'alice@example.com', code: '000000' }));
    expect(res.status).toBe(429);
  });

  it('второй вызов с тем же кодом → 400 (одноразовый)', async () => {
    const code = await getOtpFor('alice@example.com');
    const ok = await app.fetch(jsonReq('/auth/verify', { email: 'alice@example.com', code }));
    expect(ok.status).toBe(200);
    const again = await app.fetch(jsonReq('/auth/verify', { email: 'alice@example.com', code }));
    expect(again.status).toBe(400);
  });

  it('повторный вход того же email не создаёт второго пользователя', async () => {
    const code1 = await getOtpFor('alice@example.com');
    const r1 = await app.fetch(jsonReq('/auth/verify', { email: 'alice@example.com', code: code1 }));
    const userId1 = (await r1.json() as { user: { id: string } }).user.id;

    const code2 = await getOtpFor('alice@example.com');
    const r2 = await app.fetch(jsonReq('/auth/verify', { email: 'alice@example.com', code: code2 }));
    const userId2 = (await r2.json() as { user: { id: string } }).user.id;

    expect(userId2).toBe(userId1);
  });
});

describe('GET /auth/me', () => {
  async function login(email: string): Promise<string> {
    const code = await getOtpFor(email);
    const res = await app.fetch(jsonReq('/auth/verify', { email, code }));
    return (await res.json() as { token: string }).token;
  }

  it('валидный токен → 200, user object', async () => {
    const token = await login('alice@example.com');
    const res = await app.fetch(new Request('http://localhost/auth/me', {
      headers: { Authorization: `Bearer ${token}` },
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ email: 'alice@example.com' });
  });

  it('без токена → 401', async () => {
    const res = await app.fetch(new Request('http://localhost/auth/me'));
    expect(res.status).toBe(401);
  });

  it('невалидный токен → 401', async () => {
    const res = await app.fetch(new Request('http://localhost/auth/me', {
      headers: { Authorization: 'Bearer not-a-real-token' },
    }));
    expect(res.status).toBe(401);
  });

  it('после logout токен инвалидируется → 401', async () => {
    const token = await login('alice@example.com');
    const out = await app.fetch(new Request('http://localhost/auth/logout', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    }));
    expect(out.status).toBe(200);
    const me = await app.fetch(new Request('http://localhost/auth/me', {
      headers: { Authorization: `Bearer ${token}` },
    }));
    expect(me.status).toBe(401);
  });
});

describe('POST /auth/logout', () => {
  it('без токена → всё равно 200 (best-effort)', async () => {
    const res = await app.fetch(new Request('http://localhost/auth/logout', { method: 'POST' }));
    expect(res.status).toBe(200);
  });
});
