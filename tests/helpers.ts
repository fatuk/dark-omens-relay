import { db, initDb } from '../src/shared/db.js';
import { users, sessions, rooms, gameSessions, gamePlayers, campaigns } from '../src/shared/schema.js';
import { getDevOtpLog } from '../src/api/mailer.js';
import { __resetAuthStateForTests } from '../src/api/auth.js';

let _initialized = false;

/**
 * Чистит все таблицы + in-memory OTP-лог. Используй в beforeEach.
 * Первый вызов также накатывает схему.
 */
export function resetDb(): void {
  if (!_initialized) {
    initDb();
    _initialized = true;
  }
  // Порядок важен из-за FK: сначала зависимые, потом родители
  db.delete(gamePlayers).run();
  db.delete(gameSessions).run();
  db.delete(rooms).run();
  db.delete(sessions).run();
  db.delete(users).run();
  db.delete(campaigns).run();   // без FK — порядок не важен
  // Чистим in-memory лог OTP-кодов (mailer хранит последние 20 в массиве)
  getDevOtpLog().splice(0);
  // OTP-store и rate-counters /auth/request — без сброса тесты упираются
  // в лимит по unknown-IP (10 запросов в 10 минут на весь процесс).
  __resetAuthStateForTests();
}
