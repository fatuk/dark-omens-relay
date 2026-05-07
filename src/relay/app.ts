import { Hono } from 'hono';
import { desc } from 'drizzle-orm';

import { db, endGameSession } from '../shared/db.js';
import { users as usersTable } from '../shared/schema.js';
import { logger } from '../shared/logger.js';
import type { Client, ServerMessage } from '../shared/types.js';

import {
  listRooms, getRoom, deleteRoom,
  getPlayersList, getRoomPlayers,
} from './rooms.js';

import {
  onMessageSent, onErrorSent, onRoomDeleted,
  getSnapshot,
} from './metrics.js';

const ADMIN_KEY = process.env['ADMIN_KEY'] ?? '';

/**
 * Создаёт Hono-приложение relay-сервера. Без побочных эффектов
 * (не открывает WS, не вызывает serve, не пишет логи).
 * Используется и server.ts, и тестами.
 */
export function buildApp(): Hono {
  const app = new Hono();

  app.use('*', async (c, next) => {
    c.header('Access-Control-Allow-Origin', '*');
    await next();
  });

  app.get('/health', (c) => {
    const snap = getSnapshot();
    return c.json({
      status:   'ok',
      uptime_s: snap.uptime_s,
      clients:  snap.connections.current,
      rooms:    snap.rooms.current,
    });
  });

  app.get('/stats', (c) => c.json(getSnapshot()));

  app.get('/rooms', (c) => c.json(listRooms()));

  // Админ: удалить ВСЕ пустые комнаты
  app.delete('/rooms', (c) => {
    if (ADMIN_KEY && c.req.header('x-admin-key') !== ADMIN_KEY) {
      return c.text('Forbidden', 403);
    }
    let count = 0;
    for (const r of listRooms()) {
      if (r.empty) {
        const room = getRoom(r.id);
        if (room) { dissolveRoom(room.id, room.name, 0, 'Удалено администратором'); count++; }
      }
    }
    return c.json({ deleted: count });
  });

  // Админ: удалить конкретную комнату
  app.delete('/rooms/:id', (c) => {
    if (ADMIN_KEY && c.req.header('x-admin-key') !== ADMIN_KEY) {
      return c.text('Forbidden', 403);
    }
    const room = getRoom(c.req.param('id'));
    if (!room) return c.text('Room not found', 404);
    dissolveRoom(room.id, room.name, 0, 'Удалено администратором');
    return c.json({ ok: true, room_id: room.id });
  });

  app.get('/dashboard', (c) => c.html(buildDashboard()));

  // Админ: список зарегистрированных пользователей
  app.get('/users', (c) => {
    if (ADMIN_KEY && c.req.header('x-admin-key') !== ADMIN_KEY) {
      return c.text('Forbidden', 403);
    }
    const rows = db.select().from(usersTable).orderBy(desc(usersTable.createdAt)).all();
    return c.json(rows.map(u => ({
      id:        u.id,
      email:     u.email,
      name:      u.name,
      createdAt: new Date(u.createdAt).toISOString(),
    })));
  });

  return app;
}

// ── Принудительный роспуск комнаты (используется и HTTP, и WS-кодом) ────────

export function dissolveRoom(
  roomId: string, roomName: string, playerCount: number, reason: string,
): void {
  logger.info('room dissolved', { room_id: roomId, name: roomName, reason, players: playerCount });
  broadcastToRoom(roomId, { type: 'room_deleted', room_id: roomId, reason });
  // Сбрасываем roomId у всех присутствующих клиентов
  for (const c of getRoomPlayers(roomId).values()) {
    c.roomId = null;
  }
  endGameSession(roomId);  // каскадно удаляет game_players (FK ON DELETE CASCADE через rooms)
  deleteRoom(roomId);
  onRoomDeleted();
}

// ── Рассылка / отправка сообщений ─────────────────────────────────────────────

export function send(client: Client, msg: ServerMessage): void {
  if (client.ws.readyState === 1 /* WebSocket.OPEN */) {
    const json = JSON.stringify(msg);
    client.ws.send(json);
    onMessageSent(json.length);
  }
}

export function sendError(client: Client, message: string): void {
  send(client, { type: 'error', message });
  onErrorSent();
  logger.warn('error → client', { id: short(client.id), name: client.name, message });
}

/** Рассылает сообщение всем в комнате, кроме excludeId. Возвращает примерный объём байт. */
export function broadcastToRoom(
  roomId: string, msg: ServerMessage, excludeId?: string,
): number {
  const json = JSON.stringify(msg);
  let bytes = 0;
  for (const [id, c] of getRoomPlayers(roomId)) {
    if (id !== excludeId) {
      send(c, msg);
      bytes += json.length;
    }
  }
  return bytes;
}

export { getPlayersList };

function short(uuid: string): string {
  return uuid.slice(0, 8);
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

function buildDashboard(): string {
  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="5">
<title>Dark Omens Relay — Dashboard</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0d0b18; color: #d4cfc0; font-family: monospace; font-size: 14px; padding: 24px; }
  h1 { color: #c7a84a; font-size: 22px; margin-bottom: 4px; }
  .sub { color: #7a7060; margin-bottom: 24px; font-size: 12px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 16px; margin-bottom: 24px; }
  .card { background: #14111f; border: 1px solid #3d2e10; border-radius: 6px; padding: 16px; }
  .card h2 { color: #8a7050; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 12px; }
  .stat { display: flex; justify-content: space-between; margin-bottom: 6px; }
  .stat .label { color: #7a7060; }
  .stat .value { color: #d4cfc0; font-weight: bold; }
  .value.green { color: #4db870; }
  .value.yellow { color: #c7a84a; }
  .value.red { color: #cc3a2e; }
  .section { background: #14111f; border: 1px solid #3d2e10; border-radius: 6px; padding: 16px; margin-bottom: 16px; }
  .section h2 { color: #8a7050; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 12px; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; color: #7a7060; font-weight: normal; padding: 4px 8px; border-bottom: 1px solid #2a2035; }
  td { padding: 6px 8px; border-bottom: 1px solid #1a1525; }
  tr:last-child td { border-bottom: none; }
  .refresh { color: #4a4055; font-size: 11px; text-align: right; margin-top: 16px; }
</style>
</head>
<body>
<h1>⚔ Dark Omens Relay</h1>
<div class="sub" id="ts">Обновляется каждые 5 секунд</div>
<div class="grid" id="cards"></div>
<div class="section"><h2>Сообщения по типам (входящие)</h2><table id="msg-table"></table></div>
<div class="section"><h2>Комнаты</h2><table id="rooms-table"></table></div>
<div class="refresh">auto-refresh: 5s</div>
</body>
</html>`;
}
