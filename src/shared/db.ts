import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'path';
import * as schema from './schema.js';

const DB_PATH = join(process.cwd(), 'game.db');

const sqlite = new Database(DB_PATH);

// WAL mode — быстрее для конкурентных чтений
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');

export const db = drizzle(sqlite, { schema });

// Создаём таблицы если не существуют (без миграций для простоты)
export function initDb(): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id         TEXT PRIMARY KEY,
      email      TEXT UNIQUE NOT NULL,
      name       TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token      TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS rooms (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      password_hash TEXT NOT NULL DEFAULT '',
      host_id       TEXT NOT NULL,
      max_players   INTEGER NOT NULL DEFAULT 8,
      created_at    INTEGER NOT NULL,
      empty_at      INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_rooms_empty ON rooms(empty_at);
  `);
  console.log(`[db] SQLite ready at ${DB_PATH}`);
}
