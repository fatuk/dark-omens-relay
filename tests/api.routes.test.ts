import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from './helpers.js';
import { buildApp } from '../src/api/app.js';
import { db } from '../src/shared/db.js';
import { users, sessions } from '../src/shared/schema.js';

const app = buildApp();

beforeEach(() => { resetDb(); });

describe('GET /health', () => {
  it('возвращает 200 + status:ok + uptime_s', async () => {
    const res = await app.fetch(new Request('http://localhost/health'));
    expect(res.status).toBe(200);
    const json = await res.json() as { status: string; uptime_s: number };
    expect(json.status).toBe('ok');
    expect(typeof json.uptime_s).toBe('number');
    expect(json.uptime_s).toBeGreaterThanOrEqual(0);
  });
});

describe('CORS middleware', () => {
  it('добавляет Allow-Origin к обычным ответам', async () => {
    // hono/cors на simple-запросах кладёт только allow-origin; allow-methods
    // и allow-headers — это preflight-only (см. отдельный тест ниже).
    const res = await app.fetch(new Request('http://localhost/health', {
      headers: { 'Origin': 'http://localhost:5500' },
    }));
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('OPTIONS preflight → 204 + allow-methods/headers/max-age', async () => {
    const res = await app.fetch(new Request('http://localhost/auth/request', {
      method: 'OPTIONS',
      headers: {
        'Origin': 'http://localhost:5500',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    }));
    expect(res.status).toBe(204);
    expect((await res.text()).length).toBe(0);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
    expect(res.headers.get('access-control-allow-headers')).toMatch(/content-type/i);
    expect(res.headers.get('access-control-max-age')).toBe('86400');
  });
});

describe('LLM rate-limit', () => {
  // Создаём валидную сессию руками, без OTP-flow (он rate-limit'нет /auth/request).
  function login(): string {
    const userId = 'test-user';
    const token  = 'test-token-' + Math.random().toString(36).slice(2);
    const now    = Date.now();
    db.insert(users).values({ id: userId, email: `${userId}@x.com`, name: 'T', createdAt: now }).run();
    db.insert(sessions).values({ token, userId, createdAt: now, expiresAt: now + 86400_000 }).run();
    return token;
  }

  async function generateCampaign(token: string): Promise<Response> {
    return await app.fetch(new Request('http://localhost/campaign/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ locations: [{ name: 'Arkham', type: 'city' }] }),
    }));
  }

  it('после 10 запросов на /campaign/generate один user → 429', async () => {
    const token = login();
    // Первые 10 пройдут через rate-limit; реальный LLM-вызов завернётся
    // в 503 (ANTHROPIC_API_KEY не задан в тестах), но счётчик инкрементится
    // ДО getAnthropic — это и нужно.
    for (let i = 0; i < 10; i++) {
      const res = await generateCampaign(token);
      // 503 'не настроен' — нормально, 429 ещё не должно быть.
      expect(res.status).not.toBe(429);
    }
    const blocked = await generateCampaign(token);
    expect(blocked.status).toBe(429);
  });
});

describe('404 fallback', () => {
  it('неизвестный путь → JSON {error:"Not found"}', async () => {
    const res = await app.fetch(new Request('http://localhost/nonexistent'));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('известный путь, чужой метод → 404', async () => {
    // GET /auth/request не определён (только POST), Hono отдаёт 404
    const res = await app.fetch(new Request('http://localhost/auth/request'));
    expect(res.status).toBe(404);
  });
});

describe('GET /dev/otp (DEV only)', () => {
  it('доступен в DEV_MODE → 200 HTML', async () => {
    const res = await app.fetch(new Request('http://localhost/dev/otp'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toContain('OTP Dev Viewer');
  });

  it('отображает выпущенные коды', async () => {
    // Выпускаем код через /auth/request
    await app.fetch(new Request('http://localhost/auth/request', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ email: 'dev@user.com' }),
    }));
    const res = await app.fetch(new Request('http://localhost/dev/otp'));
    const body = await res.text();
    expect(body).toContain('dev@user.com');
    // 6-значный код где-то на странице
    expect(body).toMatch(/\d{6}/);
  });

  it('пустой лог показывает заглушку', async () => {
    const res = await app.fetch(new Request('http://localhost/dev/otp'));
    const body = await res.text();
    expect(body).toContain('Коды ещё не запрашивались');
  });
});
