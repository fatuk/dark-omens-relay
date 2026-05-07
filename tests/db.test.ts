import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from './helpers.js';
import {
  startGameSession, endGameSession, getGameSession,
  upsertGamePlayer, getGamePlayer, getGamePlayers,
  db,
} from '../src/shared/db.js';
import { rooms } from '../src/shared/schema.js';

const ROOM_ID = 'room-abc';
const HOST_ID = 'host-uuid';
const USER_A  = 'user-aaa';
const USER_B  = 'user-bbb';

function seedRoom(id = ROOM_ID): void {
  db.insert(rooms).values({
    id, name: 'test-room', passwordHash: '', hostId: HOST_ID,
    maxPlayers: 8, createdAt: Date.now(), emptyAt: null,
  }).run();
}

describe('game_sessions', () => {
  beforeEach(() => { resetDb(); seedRoom(); });

  it('start → get → end', () => {
    expect(getGameSession(ROOM_ID)).toBeNull();
    startGameSession(ROOM_ID, HOST_ID);
    const s = getGameSession(ROOM_ID);
    expect(s).not.toBeNull();
    expect(s!.hostId).toBe(HOST_ID);
    expect(s!.startedAt).toBeGreaterThan(0);
    endGameSession(ROOM_ID);
    expect(getGameSession(ROOM_ID)).toBeNull();
  });

  it('start дважды → перезаписывает host_id (UPSERT)', () => {
    startGameSession(ROOM_ID, HOST_ID);
    startGameSession(ROOM_ID, 'new-host');
    expect(getGameSession(ROOM_ID)!.hostId).toBe('new-host');
  });

  it('FK cascade: удаление room удаляет game_session', () => {
    startGameSession(ROOM_ID, HOST_ID);
    db.delete(rooms).run();
    expect(getGameSession(ROOM_ID)).toBeNull();
  });
});

describe('game_players', () => {
  beforeEach(() => { resetDb(); seedRoom(); });

  it('upsert → getGamePlayer возвращает то, что вставили', () => {
    upsertGamePlayer(ROOM_ID, USER_A, 'Alice', 'Akachi Onyele', true);
    const p = getGamePlayer(ROOM_ID, USER_A);
    expect(p).toEqual({ playerName: 'Alice', investigator: 'Akachi Onyele', ready: true });
  });

  it('getGamePlayer возвращает null для несуществующего', () => {
    expect(getGamePlayer(ROOM_ID, 'ghost')).toBeNull();
  });

  it('upsert обновляет существующую запись (тот же roomId+userId)', () => {
    upsertGamePlayer(ROOM_ID, USER_A, 'Alice', 'Diana', false);
    upsertGamePlayer(ROOM_ID, USER_A, 'Alice', 'Akachi', true);
    const p = getGamePlayer(ROOM_ID, USER_A)!;
    expect(p.investigator).toBe('Akachi');
    expect(p.ready).toBe(true);
  });

  it('getGamePlayers возвращает всех в комнате', () => {
    upsertGamePlayer(ROOM_ID, USER_A, 'Alice', 'Akachi', true);
    upsertGamePlayer(ROOM_ID, USER_B, 'Bob',   'Diana',  false);
    const all = getGamePlayers(ROOM_ID);
    expect(all).toHaveLength(2);
    const names = all.map(p => p.playerName).sort();
    expect(names).toEqual(['Alice', 'Bob']);
  });

  it('игрок в комнате A не виден в комнате B', () => {
    seedRoom('room-other');
    upsertGamePlayer(ROOM_ID, USER_A, 'Alice', 'Akachi', true);
    expect(getGamePlayer('room-other', USER_A)).toBeNull();
  });

  it('FK cascade: удаление room удаляет всех game_players', () => {
    upsertGamePlayer(ROOM_ID, USER_A, 'Alice', 'Akachi', true);
    upsertGamePlayer(ROOM_ID, USER_B, 'Bob',   'Diana',  true);
    db.delete(rooms).run();
    expect(getGamePlayers(ROOM_ID)).toHaveLength(0);
  });
});
