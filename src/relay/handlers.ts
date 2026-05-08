import {
  getUserByToken,
  startGameSession, getGameSession, upsertGamePlayer, getGamePlayer,
  saveGameSnapshot, getGameSnapshot,
} from '../shared/db.js';
import { logger } from '../shared/logger.js';
import type { Client, ClientMessage, ServerMessage } from '../shared/types.js';

import {
  createRoom, getRoom, listRooms,
  checkPassword, getPlayersList,
  promoteNextHost, addPlayer, removePlayer, getPlayerCount,
  getRoomPlayers, markRoomEmpty, markRoomActive,
  EMPTY_ROOM_TTL_MS,
} from './rooms.js';

import { dissolveRoom, send, sendError, broadcastToRoom } from './app.js';

import {
  onRoomCreated, onRelayBroadcast, onRelayTargeted,
} from './metrics.js';

/** Контекст для обработчиков — единственное module state, нужное логике. */
export interface HandlerContext {
  /** Все активные WS-клиенты (для lookup'а имён при promote new host). */
  clients: Map<string, Client>;
}


/**
 * Push актуального rooms_list всем клиентам в главном меню (roomId=null).
 * Вызывается после любого изменения списка/счётчиков игроков.
 */
function broadcastRoomsList(ctx: HandlerContext): void {
  const payload: ServerMessage = { type: 'rooms_list', rooms: listRooms() };
  for (const c of ctx.clients.values()) {
    if (c.roomId === null && !c.rejected) {
      send(c, payload);
    }
  }
}

/** Обработать входящее сообщение от клиента. Маршрутизирует по msg.type. */
export function handle(client: Client, msg: ClientMessage, ctx: HandlerContext): void {
  if (client.rejected) return;

  switch (msg.type) {

    case 'hello': {
      const token = (msg as { token?: string }).token ?? null;
      if (token) {
        const user = getUserByToken(token);
        if (!user) {
          client.rejected = true;
          sendError(client, 'Сессия недействительна или истекла — войдите заново');
          client.ws.close();
          return;
        }
        client.name   = user.name;
        client.userId = user.id;
        logger.debug('hello (authenticated)', { id: short(client.id), name: client.name, userId: short(client.userId) });
      } else {
        client.name   = String(msg.name ?? '').slice(0, 32).trim() || 'Player';
        client.userId = null;
        logger.debug('hello (no token)', { id: short(client.id), name: client.name });
      }
      break;
    }

    case 'ping': {
      client.alive = true;
      client.missedPings = 0;
      send(client, { type: 'pong' });
      break;
    }

    case 'list_rooms': {
      send(client, { type: 'rooms_list', rooms: listRooms() });
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
        game_started: false,
        game_state: null,
      });
      logger.info('room created', { room_id: room.id, name, host: client.name, maxPlayers, locked: !!msg.password });
      broadcastRoomsList(ctx);
      break;
    }

    case 'join_room': {
      if (client.roomId) return sendError(client, 'Вы уже в комнате');
      const room = getRoom(msg.room_id);
      if (!room) return sendError(client, 'Комната не найдена');
      if (getPlayerCount(room.id) >= room.maxPlayers) return sendError(client, 'Комната заполнена');
      if (!checkPassword(room, msg.password ?? '')) {
        return sendError(client, 'Неверный пароль');
      }

      const wasEmpty = getPlayerCount(room.id) === 0;
      if (wasEmpty) markRoomActive(room.id, client);
      else          addPlayer(room.id, client);
      client.roomId = room.id;

      // Восстанавливаем прошлое состояние из БД (rejoin сценарий)
      if (client.userId) {
        const prev = getGamePlayer(room.id, client.userId);
        if (prev) {
          client.ready        = prev.ready;
          client.investigator = prev.investigator;
          logger.info('rejoined with prior state', {
            player: client.name, investigator: client.investigator, ready: client.ready,
          });
        }
      }

      broadcastToRoom(room.id, {
        type: 'player_joined',
        player: { id: client.id, name: client.name, ready: client.ready, investigator: client.investigator },
      }, client.id);

      const freshRoom = getRoom(room.id)!;
      const playersList = getPlayersList(room.id);
      const session = getGameSession(room.id);
      const snapshotJson = session ? getGameSnapshot(room.id) : null;
      send(client, {
        type: 'joined_room', room_id: room.id, room_name: room.name,
        your_id: client.id, is_host: freshRoom.hostId === client.id,
        players: playersList,
        game_started: session !== null,
        // Снапшот стейта от хоста (если был сохранён). Клиент инициализирует
        // GameState из него если хоста сейчас нет (или просто использует как
        // быстрое восстановление).
        game_state: snapshotJson ? JSON.parse(snapshotJson) : null,
      });
      logger.info('player joined room', {
        room_id: room.id, room_name: room.name,
        player: client.name, players_now: getPlayerCount(room.id),
      });
      broadcastRoomsList(ctx);
      break;
    }

    case 'leave_room':
      leaveRoom(client, ctx);
      break;

    case 'delete_room': {
      if (!client.roomId) return sendError(client, 'Вы не в комнате');
      const room = getRoom(client.roomId);
      if (!room) return sendError(client, 'Комната не найдена');
      if (room.hostId !== client.id) return sendError(client, 'Только хост может удалить комнату');
      const playerCount = getPlayerCount(room.id);
      dissolveRoom(room.id, room.name, playerCount, 'Хост закрыл комнату');
      broadcastRoomsList(ctx);
      break;
    }

    case 'delete_any_room': {
      // Удаление любой ПУСТОЙ комнаты из списка (для чистки тестовых).
      // Не пустые удаляются только хостом изнутри (delete_room).
      if (!client.userId) return sendError(client, 'Нужна авторизация');
      const targetId = msg.room_id;
      const target = getRoom(targetId);
      if (!target) return sendError(client, 'Комната не найдена');
      if (getPlayerCount(target.id) > 0) {
        return sendError(client, 'Комната не пуста — попросите хоста закрыть её');
      }
      dissolveRoom(target.id, target.name, 0, 'Удалена пользователем из списка');
      broadcastRoomsList(ctx);
      break;
    }

    case 'relay': {
      if (!client.roomId) return sendError(client, 'Вы не в комнате');
      const relayData = msg.data as Record<string, unknown>;
      const action = String(relayData?.action ?? '');

      if (action === 'set_ready') {
        client.ready        = true;
        client.investigator = String(relayData.investigator ?? '');
        if (client.userId) {
          upsertGamePlayer(client.roomId, client.userId, client.name, client.investigator, true);
        }
        const payload: ServerMessage = { type: 'relay', from_id: client.id, data: msg.data };
        const bytes = broadcastToRoom(client.roomId, payload);
        onRelayBroadcast(bytes);
      } else if (action === 'start_game') {
        const room = getRoom(client.roomId);
        if (room) startGameSession(room.id, room.hostId);
        const payload: ServerMessage = { type: 'relay', from_id: client.id, data: msg.data };
        const bytes = broadcastToRoom(client.roomId, payload, client.id);
        onRelayBroadcast(bytes);
      } else if (action === 'game_sync') {
        // Хост рассылает полный стейт — сохраняем снапшот в БД для
        // восстановления, если все клиенты выйдут.
        saveGameSnapshot(client.roomId, JSON.stringify(relayData));
        const payload: ServerMessage = { type: 'relay', from_id: client.id, data: msg.data };
        const bytes = broadcastToRoom(client.roomId, payload, client.id);
        onRelayBroadcast(bytes);
      } else {
        const payload: ServerMessage = { type: 'relay', from_id: client.id, data: msg.data };
        const bytes = broadcastToRoom(client.roomId, payload, client.id);
        onRelayBroadcast(bytes);
      }
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
      break;
    }
  }
}

/** Обработать выход клиента из комнаты (через leave_room или close socket). */
export function leaveRoom(client: Client, ctx: HandlerContext): void {
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
  broadcastRoomsList(ctx);

  if (getPlayerCount(roomId) === 0) {
    markRoomEmpty(room);
    // game_session НЕ удаляем: вернувшиеся игроки восстановят стейт из
    // последнего снапшота (saveGameSnapshot пишет JSON в БД при game_sync).
    const ttlDays = (EMPTY_ROOM_TTL_MS / 86_400_000).toFixed(1);
    logger.info(`room empty — will prune in ${ttlDays}d if nobody returns`, { room_id: roomId, name: room.name });
    return;
  }

  let newHostId: string | null = null;
  if (room.hostId === client.id) {
    newHostId = promoteNextHost(room);
    logger.info('new host promoted', {
      room_id: roomId, new_host: ctx.clients.get(newHostId ?? '')?.name,
    });
  }

  broadcastToRoom(roomId, { type: 'player_left', player_id: client.id, new_host_id: newHostId });
}

// ── helpers ──

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(Math.round(v), min), max);
}

function short(uuid: string): string {
  return uuid.slice(0, 8);
}

