import { serve }      from '@hono/node-server';
import { Hono }        from 'hono';
import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID }  from 'crypto';
import type { IncomingMessage } from 'http';

import { initDb }      from '../shared/db.js';
import { logger }      from '../shared/logger.js';
import type { Client, ClientMessage, ServerMessage } from '../shared/types.js';

import {
  createRoom, getRoom, deleteRoom,
  listRooms, checkPassword, getPlayersList,
  promoteNextHost, addPlayer, removePlayer, getPlayerCount,
  getRoomPlayers, markRoomEmpty, markRoomActive,
  pruneStaleRooms, startPruneTimer, EMPTY_ROOM_TTL_MS,
} from './rooms.js';

import {
  onClientConnect, onClientDisconnect,
  onRoomCreated, onRoomDeleted,
  onMessageReceived, onMessageSent, onErrorSent,
  onRelayBroadcast, onRelayTargeted,
  onHeartbeatPing, onHeartbeatTerminate,
  getSnapshot,
} from './metrics.js';

const PORT        = parseInt(process.env['RELAY_PORT'] ?? '3030', 10);
const ADMIN_KEY   = process.env['ADMIN_KEY'] ?? '';
const HEARTBEAT_MS = 30_000;

// ── In-memory: все активные WS-клиенты ───────────────────────────────────────
const clients = new Map<string, Client>();

// ── Hono HTTP-приложение ─────────────────────────────────────────────────────

const app = new Hono();

app.use('*', async (c, next) => {
  c.header('Access-Control-Allow-Origin', '*');
  await next();
});

app.get('/health', (c) => {
  const snap = getSnapshot();
  return c.json({ status: 'ok', uptime_s: snap.uptime_s, clients: snap.connections.current, rooms: snap.rooms.current });
});

app.get('/stats', (c) => c.json(getSnapshot()));

app.get('/rooms', (c) => c.json(listRooms()));

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

// ── Запуск сервера с WebSocket ────────────────────────────────────────────────

initDb();
pruneStaleRooms();
startPruneTimer();

const server = serve({ fetch: app.fetch, port: PORT }, (info) => {
  logger.info('dark-omens-relay started', {
    port: info.port,
    empty_room_ttl_days: (EMPTY_ROOM_TTL_MS / 86_400_000).toFixed(1),
  });
  logger.info('endpoints', {
    ws:        `ws://localhost:${info.port}`,
    health:    `http://localhost:${info.port}/health`,
    stats:     `http://localhost:${info.port}/stats`,
    rooms:     `http://localhost:${info.port}/rooms`,
    dashboard: `http://localhost:${info.port}/dashboard`,
  });
});

// ── WebSocket ─────────────────────────────────────────────────────────────────

const wss = new WebSocketServer({ server });

wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
  const client: Client = {
    id:     randomUUID(),
    name:   'Unknown',
    ws,
    roomId: null,
    alive:  true,
    userId: null,
  };
  clients.set(client.id, client);
  onClientConnect();
  send(client, { type: 'welcome', your_id: client.id });

  const ip = req.socket.remoteAddress ?? '?';
  logger.info('+ connected', { id: short(client.id), ip, total: clients.size });

  ws.on('pong', () => { client.alive = true; });

  ws.on('message', (raw: Buffer) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString()) as ClientMessage;
    } catch {
      sendError(client, 'Invalid JSON');
      logger.warn('Invalid JSON from client', { id: short(client.id) });
      return;
    }
    onMessageReceived(msg.type);
    handle(client, msg);
  });

  ws.on('close', (code, reason) => {
    leaveRoom(client);
    clients.delete(client.id);
    onClientDisconnect();
    logger.info('- disconnected', {
      id:     short(client.id),
      name:   client.name,
      code,
      reason: reason.toString() || undefined,
      total:  clients.size,
    });
  });

  ws.on('error', (err: Error) => {
    logger.error('WS error', { id: short(client.id), name: client.name, err: err.message });
  });
});

// ── Обработчики сообщений ─────────────────────────────────────────────────────

function handle(client: Client, msg: ClientMessage): void {
  switch (msg.type) {

    case 'hello': {
      client.name   = String(msg.name).slice(0, 32).trim() || 'Player';
      client.userId = (msg as { token?: string }).token ?? null;   // пока просто сохраняем
      logger.debug('hello', { id: short(client.id), name: client.name });
      break;
    }

    case 'list_rooms': {
      const rooms = listRooms();
      send(client, { type: 'rooms_list', rooms });
      logger.debug('list_rooms', { id: short(client.id), count: rooms.length });
      break;
    }

    case 'create_room': {
      if (client.roomId) return sendError(client, 'Вы уже в комнате');
      const name = String(msg.room_name ?? '').slice(0, 64).trim();
      if (!name) return sendError(client, 'Укажите название комнаты');
      const maxPlayers = clamp(Number(msg.max_players) || 8, 2, 16);
      const room = createRoom(client, name, msg.password ?? '', maxPlayers);
      client.roomId = room.id;
      onRoomCreated();
      send(client, { type: 'room_created', room_id: room.id, room_name: room.name });
      send(client, {
        type: 'joined_room', room_id: room.id, room_name: room.name,
        your_id: client.id, is_host: true, players: getPlayersList(room.id),
      });
      logger.info('room created', {
        room_id: room.id, name, host: client.name, maxPlayers, locked: !!msg.password,
      });
      break;
    }

    case 'join_room': {
      if (client.roomId) return sendError(client, 'Вы уже в комнате');
      const room = getRoom(msg.room_id);
      if (!room) return sendError(client, 'Комната не найдена');
      if (getPlayerCount(room.id) >= room.maxPlayers) return sendError(client, 'Комната заполнена');
      if (!checkPassword(room, msg.password ?? '')) {
        logger.warn('wrong password', { room_id: room.id, client: client.name });
        return sendError(client, 'Неверный пароль');
      }

      const wasEmpty = getPlayerCount(room.id) === 0;
      if (wasEmpty) {
        // Первый вошедший в пустую комнату становится хостом
        markRoomActive(room.id, client);
      } else {
        addPlayer(room.id, client);
      }
      client.roomId = room.id;

      // Сообщаем всем остальным
      broadcastToRoom(room.id, { type: 'player_joined', player: { id: client.id, name: client.name } }, client.id);

      // Получаем актуальные данные комнаты (hostId мог обновиться)
      const freshRoom = getRoom(room.id)!;
      send(client, {
        type: 'joined_room', room_id: room.id, room_name: room.name,
        your_id: client.id, is_host: freshRoom.hostId === client.id,
        players: getPlayersList(room.id),
      });
      logger.info('player joined room', {
        room_id: room.id, room_name: room.name,
        player: client.name, players_now: getPlayerCount(room.id),
      });
      break;
    }

    case 'leave_room': {
      leaveRoom(client);
      break;
    }

    case 'delete_room': {
      if (!client.roomId) return sendError(client, 'Вы не в комнате');
      const room = getRoom(client.roomId);
      if (!room) return sendError(client, 'Комната не найдена');
      if (room.hostId !== client.id) return sendError(client, 'Только хост может удалить комнату');
      const playerCount = getPlayerCount(room.id);
      dissolveRoom(room.id, room.name, playerCount, 'Хост закрыл комнату');
      break;
    }

    case 'relay': {
      if (!client.roomId) return sendError(client, 'Вы не в комнате');
      const payload: ServerMessage = { type: 'relay', from_id: client.id, data: msg.data };
      const bytes = broadcastToRoom(client.roomId, payload, client.id);
      onRelayBroadcast(bytes);
      logger.debug('relay broadcast', {
        from: client.name, room_id: client.roomId,
        recipients: getPlayerCount(client.roomId) - 1,
      });
      break;
    }

    case 'relay_to': {
      if (!client.roomId) return sendError(client, 'Вы не в комнате');
      const target = getRoomPlayers(client.roomId).get(msg.to);
      if (!target) return sendError(client, `Игрок ${msg.to} не найден`);
      const payload: ServerMessage = { type: 'relay', from_id: client.id, data: msg.data };
      const json = JSON.stringify(payload);
      send(target, payload);
      onRelayTargeted(json.length);
      logger.debug('relay_to', { from: client.name, to: target.name, room_id: client.roomId });
      break;
    }
  }
}

// ── Выход из комнаты ──────────────────────────────────────────────────────────

function leaveRoom(client: Client): void {
  if (!client.roomId) return;
  const roomId = client.roomId;
  const room   = getRoom(roomId);
  client.roomId = null;
  if (!room) return;

  removePlayer(roomId, client.id);
  logger.info('player left room', {
    room_id: roomId, name: room.name, player: client.name,
    players_left: getPlayerCount(roomId),
  });

  if (getPlayerCount(roomId) === 0) {
    markRoomEmpty(room);
    onRoomDeleted();
    const ttlDays = (EMPTY_ROOM_TTL_MS / 86_400_000).toFixed(1);
    logger.info(`room empty — will prune in ${ttlDays}d if nobody returns`, { room_id: roomId, name: room.name });
    return;
  }

  let newHostId: string | null = null;
  if (room.hostId === client.id) {
    newHostId = promoteNextHost(room);
    logger.info('new host promoted', {
      room_id: roomId, new_host: clients.get(newHostId ?? '')?.name,
    });
  }

  broadcastToRoom(roomId, { type: 'player_left', player_id: client.id, new_host_id: newHostId });
}

// ── Принудительный роспуск комнаты ───────────────────────────────────────────

function dissolveRoom(roomId: string, roomName: string, playerCount: number, reason: string): void {
  logger.info('room dissolved', { room_id: roomId, name: roomName, reason, players: playerCount });
  broadcastToRoom(roomId, { type: 'room_deleted', room_id: roomId, reason });
  // Сбрасываем roomId у всех присутствующих клиентов
  for (const c of getRoomPlayers(roomId).values()) {
    c.roomId = null;
  }
  deleteRoom(roomId);
  onRoomDeleted();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function send(client: Client, msg: ServerMessage): void {
  if (client.ws.readyState === WebSocket.OPEN) {
    const json = JSON.stringify(msg);
    client.ws.send(json);
    onMessageSent(json.length);
  }
}

function sendError(client: Client, message: string): void {
  send(client, { type: 'error', message });
  onErrorSent();
  logger.warn('error → client', { id: short(client.id), name: client.name, message });
}

/** Рассылает сообщение всем в комнате, кроме excludeId. Возвращает примерный объём байт. */
function broadcastToRoom(roomId: string, msg: ServerMessage, excludeId?: string): number {
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

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(Math.round(v), min), max);
}

function short(uuid: string): string {
  return uuid.slice(0, 8);
}

// ── Heartbeat ─────────────────────────────────────────────────────────────────

setInterval(() => {
  let pinged = 0;
  for (const client of clients.values()) {
    if (!client.alive) {
      logger.warn('heartbeat timeout — terminating', { id: short(client.id), name: client.name });
      client.ws.terminate();
      onHeartbeatTerminate();
      continue;
    }
    client.alive = false;
    client.ws.ping();
    pinged++;
  }
  if (pinged > 0) {
    onHeartbeatPing(pinged);
    logger.debug('heartbeat', { pinged, clients: clients.size });
  }
}, HEARTBEAT_MS);

// ── Graceful shutdown ─────────────────────────────────────────────────────────

for (const sig of ['SIGINT', 'SIGTERM', 'SIGQUIT'] as const) {
  process.on(sig, () => {
    logger.info(`Received ${sig}, shutting down...`);
    wss.close(() => {
      server.close(() => {
        logger.info('Shutdown complete');
        process.exit(0);
      });
    });
  });
}

process.on('uncaughtException', (err: Error) => {
  logger.error('Uncaught exception', { err: err.message, stack: err.stack });
});

process.on('unhandledRejection', (reason: unknown) => {
  logger.error('Unhandled rejection', { reason: String(reason) });
});

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

<script>
async function load() {
  const [snap, rooms] = await Promise.all([
    fetch('/stats').then(r => r.json()),
    fetch('/rooms').then(r => r.json()),
  ]);

  document.getElementById('ts').textContent =
    'Запущен: ' + snap.started_at + '  |  Аптайм: ' + fmtUptime(snap.uptime_s) +
    '  |  RAM: ' + snap.memory_mb + ' MB';

  const c = snap.connections, r = snap.rooms, rel = snap.relay_messages, hb = snap.heartbeat;

  document.getElementById('cards').innerHTML = \`
    \${card('Подключения', [
      ['Сейчас', c.current, c.current > 0 ? 'green' : ''],
      ['Пик', c.peak, 'yellow'],
      ['Всего за сессию', c.total],
      ['Убито heartbeat', c.rejected, c.rejected > 0 ? 'red' : ''],
    ])}
    \${card('Комнаты', [
      ['Активных', r.current, r.current > 0 ? 'green' : ''],
      ['Создано', r.total_created],
      ['Удалено', r.total_deleted],
    ])}
    \${card('Relay-сообщения', [
      ['Broadcast', rel.broadcast],
      ['Targeted', rel.targeted],
      ['Трафик ~', fmtBytes(rel.bytes_est), 'yellow'],
    ])}
    \${card('Исходящие', [
      ['Отправлено всего', snap.messages.sent],
      ['Ошибок отправлено', snap.messages.errors_sent, snap.messages.errors_sent > 0 ? 'red' : ''],
      ['Heartbeat pings', hb.pings_sent],
      ['Terminated', hb.terminated, hb.terminated > 0 ? 'red' : ''],
    ])}
  \`;

  const msg = snap.messages.received;
  document.getElementById('msg-table').innerHTML =
    '<tr><th>Тип</th><th>Кол-во</th></tr>' +
    Object.entries(msg).map(([k, v]) =>
      \`<tr><td>\${k}</td><td>\${v}</td></tr>\`
    ).join('');

  document.getElementById('rooms-table').innerHTML = rooms.length === 0
    ? '<tr><td style="color:#4a4055">Нет активных комнат</td></tr>'
    : '<tr><th>ID</th><th>Название</th><th>Игроков</th><th>Макс</th><th>Пароль</th><th>Статус</th></tr>' +
      rooms.map(r => \`<tr style="\${r.empty ? 'opacity:0.55' : ''}">
        <td style="color:#4a4055">\${r.id}</td>
        <td>\${esc(r.name)}</td>
        <td style="color:\${r.empty ? '#c7a84a' : '#4db870'}">\${r.playerCount}</td>
        <td>\${r.maxPlayers}</td>
        <td>\${r.locked ? '🔒' : '—'}</td>
        <td style="color:\${r.empty ? '#c7a84a' : '#4db870'}">\${r.empty ? '⏳ пустая' : '● активна'}</td>
      </tr>\`).join('');
}

function card(title, rows) {
  const cells = rows.map(([label, value, cls = '']) =>
    \`<div class="stat"><span class="label">\${label}</span><span class="value \${cls}">\${value}</span></div>\`
  ).join('');
  return \`<div class="card"><h2>\${title}</h2>\${cells}</div>\`;
}

function fmtUptime(s) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return \`\${h}h \${m}m \${sec}s\`;
}

function fmtBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1024*1024) return (b/1024).toFixed(1) + ' KB';
  return (b/1024/1024).toFixed(2) + ' MB';
}

function esc(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

load().catch(console.error);
</script>
</body>
</html>`;
}
