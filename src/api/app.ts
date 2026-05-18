import { Hono }          from 'hono';
import { cors }          from 'hono/cors';
import { auth }          from './auth.js';
import { encounters }    from './encounters.js';
import { campaign }      from './campaign.js';
import { getDevOtpLog }  from './mailer.js';

/**
 * Создаёт Hono-приложение API. Без побочных эффектов (не вызывает serve, не пишет логи).
 * Используется как server.ts (для запуска), так и тестами.
 */
export function buildApp(): Hono {
  const app = new Hono();

  // CORS для web-билда Godot. Раньше был самописный middleware, но он
  // возвращал preflight через `new Response(null, ...)` — этот объект НЕ
  // нёс заголовки, выставленные через `c.header()`, и браузер блокировал
  // основной запрос. `hono/cors` корректно обрабатывает preflight + ставит
  // Allow-Methods (которого не хватало).
  app.use('*', cors({
    origin:       '*',
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    maxAge:       86400,
  }));

  app.get('/health', (c) => c.json({
    status:    'ok',
    uptime_s:  Math.floor(process.uptime()),
  }));

  app.route('/auth', auth);
  app.route('/encounters', encounters);
  app.route('/campaign', campaign);

  // ── DEV only — выводит выпущенные OTP-коды ─────────────────────────────────
  if (process.env['DEV_MODE'] === 'true' || process.env['NODE_ENV'] !== 'production') {
    app.get('/dev/otp', (c) => {
      const log = getDevOtpLog();
      return c.html(`<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta http-equiv="refresh" content="3">
  <title>OTP Dev</title>
  <style>
    body { font-family: monospace; background: #0d0b18; color: #d4cfc0; padding: 32px; }
    h1 { color: #c7a84a; margin-bottom: 4px; }
    .hint { color: #4a4055; font-size: 12px; margin-bottom: 24px; }
    .entry { background: #14111f; border: 1px solid #3d2e10; border-radius: 6px;
             padding: 16px 20px; margin-bottom: 12px; display: flex; align-items: center; gap: 24px; }
    .code { font-size: 32px; letter-spacing: 10px; color: #4db870; font-weight: bold; }
    .meta { color: #7a7060; font-size: 13px; }
    .email { color: #d4cfc0; }
    .empty { color: #4a4055; font-style: italic; }
  </style>
</head>
<body>
  <h1>📧 OTP Dev Viewer</h1>
  <div class="hint">Обновляется каждые 3 секунды · только в DEV_MODE</div>
  ${log.length === 0
    ? '<div class="empty">Коды ещё не запрашивались</div>'
    : log.map(e => `
      <div class="entry">
        <div class="code">${e.code}</div>
        <div class="meta">
          <div class="email">${e.email}</div>
          <div>${new Date(e.sentAt).toLocaleTimeString('ru')}</div>
        </div>
      </div>`).join('')}
</body>
</html>`);
    });
  }

  app.notFound((c) => c.json({ error: 'Not found' }, 404));

  return app;
}
