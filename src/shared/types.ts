import type { WebSocket } from 'ws';

// ── WebSocket клиент (in-memory) ───────────────────────────────────────────────

export interface Client {
  id:          string;
  name:        string;
  ws:          WebSocket;
  roomId:      string | null;
  alive:       boolean;
  missedPings: number;
  userId:      string | null;
  rejected:    boolean;       // hello с невалидным токеном — игнорировать последующие сообщения
  // ── Игровая сессия ──────────────────────────────────────────────────────────
  ready:       boolean;       // нажал «Готов»
  investigator: string;       // выбранный сыщик (пусто = не выбран)
}

// ── Резюме комнаты для списка ──────────────────────────────────────────────────

export interface RoomSummary {
  id:          string;
  name:        string;
  playerCount: number;
  maxPlayers:  number;
  locked:      boolean;
  empty:       boolean;
}

export interface PlayerInfo {
  id:          string;
  name:        string;
  ready:       boolean;
  investigator: string;
}

// ── WebSocket протокол: Client → Server ───────────────────────────────────────

export type ClientMessage =
  | { type: 'hello';       name: string; token?: string }
  | { type: 'ping' }
  | { type: 'list_rooms' }
  | { type: 'create_room'; room_name: string; password?: string; max_players?: number }
  | { type: 'join_room';   room_id: string;   password?: string }
  | { type: 'leave_room' }
  | { type: 'delete_room' }
  | { type: 'relay';       data: unknown }
  | { type: 'relay_to';    to: string; data: unknown };

// ── WebSocket протокол: Server → Client ───────────────────────────────────────

export type ServerMessage =
  | { type: 'welcome';       your_id: string }
  | { type: 'pong' }
  | { type: 'room_created';  room_id: string; room_name: string }
  | { type: 'rooms_list';    rooms: RoomSummary[] }
  | { type: 'joined_room';   room_id: string; room_name: string; your_id: string; is_host: boolean; players: PlayerInfo[]; game_started: boolean }
  | { type: 'player_joined'; player: PlayerInfo }
  | { type: 'player_left';   player_id: string; new_host_id: string | null }
  | { type: 'room_deleted';  room_id: string; reason: string }
  | { type: 'relay';         from_id: string; data: unknown }
  | { type: 'error';         message: string };
