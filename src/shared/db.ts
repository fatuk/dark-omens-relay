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
      started_at INTEGER NOT NULL,
      snapshot   TEXT
    );

    CREATE TABLE IF NOT EXISTS game_players (
      room_id      TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      user_id      TEXT NOT NULL,
      player_name  TEXT NOT NULL,
      investigator TEXT NOT NULL DEFAULT '',
      ready        INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (room_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS campaigns (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      json       TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_rooms_empty ON rooms(empty_at);
  `);
  // Миграция для старых БД: добавляем snapshot, если его не было.
  // SQLite не умеет ADD COLUMN IF NOT EXISTS, поэтому проверяем через PRAGMA.
  const cols = sqlite.prepare(`PRAGMA table_info(game_sessions)`).all() as Array<{ name: string }>;
  if (!cols.some(c => c.name === 'snapshot')) {
    sqlite.exec(`ALTER TABLE game_sessions ADD COLUMN snapshot TEXT`);
  }
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

/** Сохранить полный JSON-снапшот игрового стейта от хоста. */
export function saveGameSnapshot(roomId: string, snapshotJson: string): void {
  sqlite.prepare(`UPDATE game_sessions SET snapshot = ? WHERE room_id = ?`)
    .run(snapshotJson, roomId);
}

/** Прочитать снапшот игрового стейта (null если игра не запущена или snapshot пуст). */
export function getGameSnapshot(roomId: string): string | null {
  const row = sqlite.prepare(`SELECT snapshot FROM game_sessions WHERE room_id = ?`)
    .get(roomId) as { snapshot: string | null } | undefined;
  return row?.snapshot ?? null;
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


// ── Сгенерированные кампании ────────────────────────────────────────────────────

/** Сохранить сценарную библию (JSON-строка) под её id. */
export function saveCampaign(id: string, userId: string, json: string): void {
  sqlite.prepare(
    `INSERT INTO campaigns (id, user_id, created_at, json) VALUES (?, ?, ?, ?)`
  ).run(id, userId, Date.now(), json);
}

/** Достать сохранённую кампанию по id (null, если не найдена). */
export function getCampaign(
  id: string,
): { id: string; userId: string; createdAt: number; json: string } | null {
  const row = sqlite.prepare(
    `SELECT id, user_id, created_at, json FROM campaigns WHERE id = ?`
  ).get(id) as { id: string; user_id: string; created_at: number; json: string } | undefined;
  if (!row) return null;
  return { id: row.id, userId: row.user_id, createdAt: row.created_at, json: row.json };
}

/**
 * Список всех кампаний — для админ-вида. Тяжёлый json-блоб не отдаём,
 * только метаданные; title/ancientOne вынимаем из json через json_extract.
 */
export function listCampaigns(): {
  id: string; userId: string; createdAt: number;
  title: string | null; ancientOne: string | null;
}[] {
  const rows = sqlite.prepare(`
    SELECT id, user_id, created_at,
           json_extract(json, '$.title')           AS title,
           json_extract(json, '$.ancientOne.name') AS ancient_one
    FROM campaigns
    ORDER BY created_at DESC
  `).all() as {
    id: string; user_id: string; created_at: number;
    title: string | null; ancient_one: string | null;
  }[];
  return rows.map((r) => ({
    id: r.id, userId: r.user_id, createdAt: r.created_at,
    title: r.title, ancientOne: r.ancient_one,
  }));
}

/** Удалить кампанию по id. Возвращает true, если строка была удалена. */
export function deleteCampaign(id: string): boolean {
  return sqlite.prepare(`DELETE FROM campaigns WHERE id = ?`).run(id).changes > 0;
}
