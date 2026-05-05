import { serve }  from '@hono/node-server';
import { Hono }   from 'hono';

import { initDb }        from '../shared/db.js';
import { logger }        from '../shared/logger.js';
import { auth }          from './auth.js';
import { getDevOtpLog }  from './mailer.js';

const PORT = parseInt(process.env['API_PORT'] ?? '3031', 10);

initDb();

const app = new Hono();

app.use('*', async (c, next) => {
  c.header('Access-Control-Allow-Origin', '*');
  c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (c.req.method === 'OPTIONS') return new Response(null, { status: 204 });
  await next();
});

app.get('/health', (c) => c.json({ status: 'ok', uptime_s: Math.floor(process.uptime()) }));

app.route('/auth', auth);

// ── DEV only ──────────────────────────────────────────────────────────────────
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
  logger.info('DEV endpoint: OTP viewer', { url: `http://localhost:${PORT}/dev/otp` });
}

app.notFound((c) => c.json({ error: 'Not found' }, 404));

serve({ fetch: app.fetch, port: PORT }, (info) => {
  logger.info('dark-omens-api started', { port: info.port });
  logger.info('endpoints', {
    health:       `http://localhost:${info.port}/health`,
    auth_request: `http://localhost:${info.port}/auth/request`,
    auth_verify:  `http://localhost:${info.port}/auth/verify`,
    auth_me:      `http://localhost:${info.port}/auth/me`,
  });
});

process.on('uncaughtException', (err: Error) => {
  logger.error('Uncaught exception [api]', { err: err.message, stack: err.stack });
});

process.on('unhandledRejection', (reason: unknown) => {
  logger.error('Unhandled rejection [api]', { reason: String(reason) });
});
