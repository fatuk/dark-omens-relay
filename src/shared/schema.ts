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

export type User    = typeof users.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type Room    = typeof rooms.$inferSelect;
