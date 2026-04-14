import { serve }  from '@hono/node-server';
import { Hono }   from 'hono';

import { initDb } from '../shared/db.js';
import { logger } from '../shared/logger.js';
import { auth }   from './auth.js';

const PORT = parseInt(process.env['API_PORT'] ?? '3031', 10);

initDb();

const app = new Hono();

app.use('*', async (c, next) => {
  c.header('Access-Control-Allow-Origin', '*');
  c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (c.req.method === 'OPTIONS') return c.text('', 204);
  await next();
});

app.get('/health', (c) => c.json({ status: 'ok', uptime_s: Math.floor(process.uptime()) }));

app.route('/auth', auth);

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
