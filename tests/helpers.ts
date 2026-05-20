import { randomUUID } from 'crypto';
import { db, initDb } from '../src/shared/db.js';
import { users, sessions, rooms, gameSessions, gamePlayers, campaigns } from '../src/shared/schema.js';
import { getDevOtpLog } from '../src/api/mailer.js';
import { __resetAuthStateForTests } from '../src/api/auth.js';
import type { Client, ServerMessage } from '../src/shared/types.js';
import type { HandlerContext } from '../src/relay/handlers.js';

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


// ── Фейковый WebSocket-клиент для unit-тестов handlers ──────────────────────
// readyState=1 (OPEN), отправки пишутся в outbox — тесты ассертят через lastMsg.

export interface TestClient extends Client {
  outbox: ServerMessage[];
  closed: boolean;
}

export function makeClient(name = 'tester', userId: string | null = null): TestClient {
  const outbox: ServerMessage[] = [];
  const c: TestClient = {
    id:           randomUUID(),
    name,
    ws: {
      readyState: 1,
      send:      (data: string) => { outbox.push(JSON.parse(data) as ServerMessage); },
      close:     () => { c.closed = true; },
      terminate: () => { c.closed = true; },
      ping:      () => {},
    } as unknown as Client['ws'],
    roomId:       null,
    alive:        true,
    missedPings:  0,
    userId,
    rejected:     false,
    ready:        false,
    investigator: '',
    outbox,
    closed:       false,
  };
  return c;
}

export function ctxOf(...clients: TestClient[]): HandlerContext {
  const map = new Map<string, Client>();
  for (const c of clients) map.set(c.id, c);
  return { clients: map };
}

export function lastMsg(c: TestClient, type: string): ServerMessage | undefined {
  return [...c.outbox].reverse().find(m => m.type === type);
}
