import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'path';
import * as schema from './schema.js';

const DB_PATH = process.env['DB_PATH'] ?? join(process.cwd(), 'game.db');

const sqlite = new Database(DB_PATH);

// WAL mode — быстрее для конкурентных чтений
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');

export const db = drizzle(sqlite, { schema });

/** Синхронная проверка токена. Возвращает {id, name} если токен валиден, иначе null. */
export function getUserByToken(token: string): { id: string; name: string } | null {
  const row = sqlite.prepare(`
    SELECT u.id, u.name
    FROM sessions s
    JOIN users u ON s.user_id = u.id
    WHERE s.token = ? AND s.expires_at > ?
  `).get(token, Date.now()) as { id: string; name: string } | undefined;
  return row ?? null;
}

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

    CREATE TABLE IF NOT EXISTS game_sessions (
      room_id    TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
      host_id    TEXT NOT NULL,
      started_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS game_players (
      room_id      TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      user_id      TEXT NOT NULL,
      player_name  TEXT NOT NULL,
      investigator TEXT NOT NULL DEFAULT '',
      ready        INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (room_id, user_id)
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_rooms_empty ON rooms(empty_at);
  `);
  console.log(`[db] SQLite ready at ${DB_PATH}`);
}

// ── Игровые сессии ─────────────────────────────────────────────────────────────

export function startGameSession(roomId: string, hostId: string): void {
  sqlite.prepare(`
    INSERT INTO game_sessions (room_id, host_id, started_at)
    VALUES (?, ?, ?)
    ON CONFLICT(room_id) DO UPDATE SET
      host_id    = excluded.host_id,
      started_at = excluded.started_at
  `).run(roomId, hostId, Date.now());
}

export function endGameSession(roomId: string): void {
  sqlite.prepare(`DELETE FROM game_sessions WHERE room_id = ?`).run(roomId);
}

export function getGameSession(roomId: string): { hostId: string; startedAt: number } | null {
  const row = sqlite.prepare(
    `SELECT host_id, started_at FROM game_sessions WHERE room_id = ?`
  ).get(roomId) as { host_id: string; started_at: number } | undefined;
  return row ? { hostId: row.host_id, startedAt: row.started_at } : null;
}

export function upsertGamePlayer(
  roomId: string, userId: string, playerName: string,
  investigator: string, ready: boolean,
): void {
  sqlite.prepare(`
    INSERT INTO game_players (room_id, user_id, player_name, investigator, ready)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(room_id, user_id) DO UPDATE SET
      player_name  = excluded.player_name,
      investigator = excluded.investigator,
      ready        = excluded.ready
  `).run(roomId, userId, playerName, investigator, ready ? 1 : 0);
}

export function getGamePlayer(
  roomId: string, userId: string,
): { playerName: string; investigator: string; ready: boolean } | null {
  const row = sqlite.prepare(
    `SELECT player_name, investigator, ready FROM game_players WHERE room_id = ? AND user_id = ?`
  ).get(roomId, userId) as { player_name: string; investigator: string; ready: number } | undefined;
  if (!row) return null;
  return {
    playerName:   row.player_name,
    investigator: row.investigator,
    ready:        row.ready === 1,
  };
}


export function getGamePlayers(
  roomId: string,
): { userId: string; playerName: string; investigator: string; ready: boolean }[] {
  const rows = sqlite.prepare(
    `SELECT user_id, player_name, investigator, ready FROM game_players WHERE room_id = ?`
  ).all(roomId) as { user_id: string; player_name: string; investigator: string; ready: number }[];
  return rows.map(r => ({
    userId:       r.user_id,
    playerName:   r.player_name,
    investigator: r.investigator,
    ready:        r.ready === 1,
  }));
}
