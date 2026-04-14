import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

const LEVEL_RANK: Record<LogLevel, number> = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
const MIN_LEVEL: LogLevel = (process.env['LOG_LEVEL'] as LogLevel | undefined) ?? 'INFO';

const COLORS: Record<LogLevel, string> = {
  DEBUG: '\x1b[36m',
  INFO:  '\x1b[32m',
  WARN:  '\x1b[33m',
  ERROR: '\x1b[31m',
};
const RESET = '\x1b[0m';

const LOG_DIR = join(process.cwd(), 'logs');
try { mkdirSync(LOG_DIR, { recursive: true }); } catch {}

function logFilePath(): string {
  const d = new Date();
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return join(LOG_DIR, `server-${date}.log`);
}

function write(level: LogLevel, msg: string, ctx?: Record<string, unknown>): void {
  if (LEVEL_RANK[level] < LEVEL_RANK[MIN_LEVEL]) return;
  const ts   = new Date().toISOString();
  const line = `[${ts}] [${level.padEnd(5)}] ${msg}${ctx ? ' ' + JSON.stringify(ctx) : ''}`;
  console.log(`${COLORS[level]}${line}${RESET}`);
  try { appendFileSync(logFilePath(), line + '\n', 'utf-8'); } catch {}
}

export const logger = {
  debug: (msg: string, ctx?: Record<string, unknown>) => write('DEBUG', msg, ctx),
  info:  (msg: string, ctx?: Record<string, unknown>) => write('INFO',  msg, ctx),
  warn:  (msg: string, ctx?: Record<string, unknown>) => write('WARN',  msg, ctx),
  error: (msg: string, ctx?: Record<string, unknown>) => write('ERROR', msg, ctx),
};
