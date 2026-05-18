// ВАЖНО: первый импорт — подгружает .env в process.env до того, как остальные
// модули прочитают переменные на этапе загрузки (mailer, anthropic).
import '../shared/env.js';

import { serve } from '@hono/node-server';

import { initDb } from '../shared/db.js';
import { logger } from '../shared/logger.js';
import { buildApp } from './app.js';

const PORT = parseInt(process.env['API_PORT'] ?? '3031', 10);

initDb();
const app = buildApp();

if (process.env['DEV_MODE'] === 'true' || process.env['NODE_ENV'] !== 'production') {
  logger.info('DEV endpoint: OTP viewer', { url: `http://localhost:${PORT}/dev/otp` });
}

serve({ fetch: app.fetch, port: PORT }, (info) => {
  logger.info('dark-omens-api started', { port: info.port });
  logger.info('endpoints', {
    health:        `http://localhost:${info.port}/health`,
    auth_request:  `http://localhost:${info.port}/auth/request`,
    auth_verify:   `http://localhost:${info.port}/auth/verify`,
    auth_me:       `http://localhost:${info.port}/auth/me`,
    encounters:    `http://localhost:${info.port}/encounters/generate`,
  });
});

process.on('uncaughtException', (err: Error) => {
  logger.error('Uncaught exception [api]', { err: err.message, stack: err.stack });
});

process.on('unhandledRejection', (reason: unknown) => {
  logger.error('Unhandled rejection [api]', { reason: String(reason) });
});
