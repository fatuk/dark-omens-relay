import { randomUUID, createHash } from 'crypto';
import { eq, isNull, lt, and } from 'drizzle-orm';
import { db, initDb } from '../shared/db.js';
import { rooms as roomsTable, type Room } from '../shared/schema.js';
import type { Client, RoomSummary, PlayerInfo } from '../shared/types.js';
import { logger } from '../shared/logger.js';

export const EMPTY_ROOM_TTL_MS = parseInt(
  process.env['EMPTY_ROOM_TTL_MS'] ?? String(7 * 24 * 60 * 60 * 1000), 10
);

// ── In-memory: активные WebSocket соединения ─────────────────────────────────
// room.players не хранится в БД — только живые WS-клиенты
const activePlayers = new Map<string, Map<string, Client>>();

function getPlayers(roomId: string): Map<string, Client> {
  if (!activePlayers.has(roomId)) activePlayers.set(roomId, new Map());
  return activePlayers.get(roomId)!;
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

export function createRoom(
  host:       Client,
  name:       string,
  password:   string,
  maxPlayers: number,
): Room {
  const room: Room = {
    id:           randomUUID().slice(0, 8),
    name,
    passwordHash: password ? hashPassword(password) : '',
    hostId:       host.id,
    maxPlayers,
    createdAt:    Date.now(),
    emptyAt:      null,
  };
  db.insert(roomsTable).values(room).run();
  getPlayers(room.id).set(host.id, host);
  return room;
}

export function getRoom(id: string): Room | undefined {
  return db.select().from(roomsTable).where(eq(roomsTable.id, id)).get();
}

export function deleteRoom(id: string): void {
  db.delete(roomsTable).where(eq(roomsTable.id, id)).run();
  activePlayers.delete(id);
}

export function markRoomEmpty(room: Room): void {
  db.update(roomsTable)
    .set({ emptyAt: Date.now() })
    .where(eq(roomsTable.id, room.id))
    .run();
  activePlayers.delete(room.id);
}

export function markRoomActive(roomId: string, firstPlayer: Client): void {
  db.update(roomsTable)
    .set({ hostId: firstPlayer.id, emptyAt: null })
    .where(eq(roomsTable.id, roomId))
    .run();
  getPlayers(roomId).set(firstPlayer.id, firstPlayer);
}

export function addPlayer(roomId: string, client: Client): void {
  getPlayers(roomId).set(client.id, client);
}

export function removePlayer(roomId: string, clientId: string): void {
  getPlayers(roomId).delete(clientId);
}

export function getPlayerCount(roomId: string): number {
  return getPlayers(roomId).size;
}

export function getRoomPlayers(roomId: string): Map<string, Client> {
  return getPlayers(roomId);
}

export function listRooms(): RoomSummary[] {
  const all = db.select().from(roomsTable).all();
  return all.map(r => ({
    id:          r.id,
    name:        r.name,
    playerCount: getPlayers(r.id).size,
    maxPlayers:  r.maxPlayers,
    locked:      r.passwordHash !== '',
    empty:       getPlayers(r.id).size === 0,
  }));
}

export function promoteNextHost(room: Room): string | null {
  const next = getPlayers(room.id).keys().next().value ?? null;
  if (next) {
    db.update(roomsTable).set({ hostId: next }).where(eq(roomsTable.id, room.id)).run();
  }
  return next;
}

export function checkPassword(room: Room, password: string): boolean {
  if (!room.passwordHash) return true;
  return hashPassword(password) === room.passwordHash;
}

export function getPlayersList(roomId: string): PlayerInfo[] {
  return Array.from(getPlayers(roomId).values()).map(c => ({
    id:          c.id,
    name:        c.name,
    ready:       c.ready,
    investigator: c.investigator,
  }));
}

// ── Pruning ───────────────────────────────────────────────────────────────────

export function pruneStaleRooms(): void {
  const cutoff = Date.now() - EMPTY_ROOM_TTL_MS;
  const stale = db.select()
    .from(roomsTable)
    .where(and(lt(roomsTable.emptyAt, cutoff)))
    .all()
    .filter(r => r.emptyAt !== null);

  for (const r of stale) {
    db.delete(roomsTable).where(eq(roomsTable.id, r.id)).run();
    activePlayers.delete(r.id);
  }
  if (stale.length > 0) logger.info(`pruned ${stale.length} stale room(s)`);
}

export function startPruneTimer(): void {
  setInterval(pruneStaleRooms, 60_000);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function hashPassword(pw: string): string {
  return createHash('sha256').update(pw).digest('hex');
}
