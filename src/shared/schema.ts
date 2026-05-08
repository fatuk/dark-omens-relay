import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
  id:        text('id').primaryKey(),
  email:     text('email').unique().notNull(),
  name:      text('name').notNull(),
  createdAt: integer('created_at').notNull(),
});

export const sessions = sqliteTable('sessions', {
  token:     text('token').primaryKey(),
  userId:    text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
});

export const rooms = sqliteTable('rooms', {
  id:           text('id').primaryKey(),
  name:         text('name').notNull(),
  passwordHash: text('password_hash').notNull().default(''),
  hostId:       text('host_id').notNull(),
  maxPlayers:   integer('max_players').notNull().default(8),
  createdAt:    integer('created_at').notNull(),
  emptyAt:      integer('empty_at'),
});

// ── Игровые сессии ─────────────────────────────────────────────────────────────

export const gameSessions = sqliteTable('game_sessions', {
  roomId:    text('room_id').primaryKey().references(() => rooms.id, { onDelete: 'cascade' }),
  hostId:    text('host_id').notNull(),
  startedAt: integer('started_at').notNull(),
  // Полный JSON-снапшот стейта от хоста (round/phase/players/...).
  // Обновляется при каждом game_sync. Позволяет восстановить игру, если
  // все клиенты вышли и потом вернулись.
  snapshot:  text('snapshot'),
});

export const gamePlayers = sqliteTable('game_players', {
  roomId:       text('room_id').notNull().references(() => rooms.id, { onDelete: 'cascade' }),
  userId:       text('user_id').notNull(),
  playerName:   text('player_name').notNull(),
  investigator: text('investigator').notNull().default(''),
  ready:        integer('ready', { mode: 'boolean' }).notNull().default(false),
});

export type User        = typeof users.$inferSelect;
export type Session     = typeof sessions.$inferSelect;
export type Room        = typeof rooms.$inferSelect;
export type GameSession = typeof gameSessions.$inferSelect;
export type GamePlayer  = typeof gamePlayers.$inferSelect;
