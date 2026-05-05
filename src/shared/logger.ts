import { appendFileSync, mkdirSync, statSync, readdirSync, unlinkSync, renameSync } from 'fs';
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

const LOG_DIR        = process.env['LOG_DIR'] ?? join(process.cwd(), 'logs');
const MAX_FILE_BYTES = 20 * 1024 * 1024;   // 20 MB per file
const MAX_FILES      = 7;                   // keep last 7 files

try { mkdirSync(LOG_DIR, { recursive: true }); } catch {}

function logFilePath(): string {
  const d = new Date();
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return join(LOG_DIR, `server-${date}.log`);
}

/** Rotate: rename current file if over MAX_FILE_BYTES, then prune old files. */
function maybeRotate(filePath: string): void {
  try {
    const size = statSync(filePath).size;
    if (size < MAX_FILE_BYTES) return;

    // Rename current file with a timestamp suffix
    const ts   = Date.now();
    const rotated = filePath.replace(/\.log$/, `-${ts}.log`);
    renameSync(filePath, rotated);
  } catch {
    // file doesn't exist yet — that's fine
  }
  pruneOldLogs();
}

let _lastPrunedDay = '';
function pruneOldLogs(): void {
  const today = new Date().toISOString().slice(0, 10);
  if (_lastPrunedDay === today) return;   // only once per day
  _lastPrunedDay = today;
  try {
    const files = readdirSync(LOG_DIR)
      .filter(f => f.startsWith('server-') && f.endsWith('.log'))
      .map(f => ({ name: f, path: join(LOG_DIR, f) }))
      .sort((a, b) => a.name.localeCompare(b.name));   // oldest first

    const excess = files.length - MAX_FILES;
    for (let i = 0; i < excess; i++) {
      unlinkSync(files[i]!.path);
    }
  } catch { /* ignore */ }
}

function write(level: LogLevel, msg: string, ctx?: Record<string, unknown>): void {
  if (LEVEL_RANK[level] < LEVEL_RANK[MIN_LEVEL]) return;
  const ts   = new Date().toISOString();
  const line = `[${ts}] [${level.padEnd(5)}] ${msg}${ctx ? ' ' + JSON.stringify(ctx) : ''}`;
  console.log(`${COLORS[level]}${line}${RESET}`);
  try {
    const fp = logFilePath();
    maybeRotate(fp);
    appendFileSync(fp, line + '\n', 'utf-8');
  } catch { /* ignore */ }
}

export const logger = {
  debug: (msg: string, ctx?: Record<string, unknown>) => write('DEBUG', msg, ctx),
  info:  (msg: string, ctx?: Record<string, unknown>) => write('INFO',  msg, ctx),
  warn:  (msg: string, ctx?: Record<string, unknown>) => write('WARN',  msg, ctx),
  error: (msg: string, ctx?: Record<string, unknown>) => write('ERROR', msg, ctx),
};
