import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, makeClient, ctxOf, lastMsg, type TestClient } from './helpers.js';
import { handle, leaveRoom } from '../src/relay/handlers.js';
import { listRooms, getRoom, getPlayerCount } from '../src/relay/rooms.js';
import { getGameSession, getGamePlayer, db, hashToken } from '../src/shared/db.js';
import { users, sessions } from '../src/shared/schema.js';

beforeEach(() => { resetDb(); });

// ─────────────────────────────────────────────────────────────────────────────
describe('hello', () => {
  it('без токена — устанавливает name из msg.name', () => {
    const c = makeClient();
    handle(c, { type: 'hello', name: 'Alice' }, ctxOf(c));
    expect(c.name).toBe('Alice');
    expect(c.userId).toBeNull();
    expect(c.rejected).toBe(false);
  });

  it('с валидным токеном — name/userId из БД', () => {
    db.insert(users).values({ id: 'u1', email: 'a@b.c', name: 'AuthedAlice', createdAt: Date.now() }).run();
    db.insert(sessions).values({
      tokenHash: hashToken('tok-good'), userId: 'u1', createdAt: Date.now(), expiresAt: Date.now() + 60_000,
    }).run();

    const c = makeClient();
    handle(c, { type: 'hello', token: 'tok-good' } as never, ctxOf(c));
    expect(c.name).toBe('AuthedAlice');
    expect(c.userId).toBe('u1');
  });

  it('с невалидным токеном — rejected=true + error + close', () => {
    const c = makeClient();
    handle(c, { type: 'hello', token: 'tok-bad' } as never, ctxOf(c));
    expect(c.rejected).toBe(true);
    expect(c.closed).toBe(true);
    expect(lastMsg(c, 'error')).toBeDefined();
  });

  it('rejected клиент игнорирует все последующие сообщения', () => {
    const c = makeClient();
    c.rejected = true;
    handle(c, { type: 'create_room', room_name: 'X' } as never, ctxOf(c));
    expect(c.outbox).toHaveLength(0);
    expect(c.roomId).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('ping', () => {
  it('сбрасывает missedPings и шлёт pong', () => {
    const c = makeClient();
    c.alive = false;
    c.missedPings = 5;
    handle(c, { type: 'ping' } as never, ctxOf(c));
    expect(c.alive).toBe(true);
    expect(c.missedPings).toBe(0);
    expect(lastMsg(c, 'pong')).toEqual({ type: 'pong' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('create_room', () => {
  it('создаёт комнату, шлёт room_created + joined_room', () => {
    const host = makeClient('host');
    handle(host, { type: 'create_room', room_name: 'My Room', max_players: 4 } as never, ctxOf(host));

    expect(host.roomId).not.toBeNull();
    expect(lastMsg(host, 'room_created')).toMatchObject({ room_name: 'My Room' });
    const joined = lastMsg(host, 'joined_room') as { is_host: boolean; players: unknown[]; game_started: boolean };
    expect(joined.is_host).toBe(true);
    expect(joined.players).toHaveLength(1);
    expect(joined.game_started).toBe(false);

    expect(listRooms()).toHaveLength(1);
  });

  it('пустое имя → error', () => {
    const c = makeClient();
    handle(c, { type: 'create_room', room_name: '   ' } as never, ctxOf(c));
    expect(c.roomId).toBeNull();
    expect(lastMsg(c, 'error')).toMatchObject({ message: expect.stringContaining('название') });
  });

  it('повторный create_room когда уже в комнате → error', () => {
    const c = makeClient();
    handle(c, { type: 'create_room', room_name: 'A' } as never, ctxOf(c));
    c.outbox.length = 0;
    handle(c, { type: 'create_room', room_name: 'B' } as never, ctxOf(c));
    expect(lastMsg(c, 'error')).toMatchObject({ message: expect.stringContaining('уже') });
  });

  it('max_players клампится в [2, 16]', () => {
    const c1 = makeClient('a');
    handle(c1, { type: 'create_room', room_name: 'huge', max_players: 999 } as never, ctxOf(c1));
    expect(getRoom(c1.roomId!)?.maxPlayers).toBe(16);

    const c2 = makeClient('b');
    handle(c2, { type: 'create_room', room_name: 'tiny', max_players: 1 } as never, ctxOf(c2));
    expect(getRoom(c2.roomId!)?.maxPlayers).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('join_room', () => {
  function setupRoomWithHost(): { host: TestClient; roomId: string } {
    const host = makeClient('host');
    handle(host, { type: 'create_room', room_name: 'R' } as never, ctxOf(host));
    host.outbox.length = 0;
    return { host, roomId: host.roomId! };
  }

  it('второй игрок присоединяется → joined_room с is_host=false', () => {
    const { host, roomId } = setupRoomWithHost();
    const guest = makeClient('guest');
    handle(guest, { type: 'join_room', room_id: roomId } as never, ctxOf(host, guest));

    expect(guest.roomId).toBe(roomId);
    const joined = lastMsg(guest, 'joined_room') as { is_host: boolean; players: { name: string }[] };
    expect(joined.is_host).toBe(false);
    expect(joined.players.map(p => p.name).sort()).toEqual(['guest', 'host']);

    // Хост получил player_joined
    const evt = lastMsg(host, 'player_joined') as { player: { name: string } };
    expect(evt.player.name).toBe('guest');
  });

  it('несуществующая комната → error', () => {
    const c = makeClient();
    handle(c, { type: 'join_room', room_id: 'no-such' } as never, ctxOf(c));
    expect(c.roomId).toBeNull();
    expect(lastMsg(c, 'error')).toMatchObject({ message: expect.stringContaining('не найдена') });
  });

  it('неверный пароль → error', () => {
    const host = makeClient('h');
    handle(host, { type: 'create_room', room_name: 'R', password: 'secret' } as never, ctxOf(host));
    const guest = makeClient('g');
    handle(guest, { type: 'join_room', room_id: host.roomId!, password: 'wrong' } as never, ctxOf(host, guest));
    expect(guest.roomId).toBeNull();
    expect(lastMsg(guest, 'error')).toMatchObject({ message: expect.stringContaining('пароль') });
  });

  it('правильный пароль → joined_room', () => {
    const host = makeClient('h');
    handle(host, { type: 'create_room', room_name: 'R', password: 'secret' } as never, ctxOf(host));
    const guest = makeClient('g');
    handle(guest, { type: 'join_room', room_id: host.roomId!, password: 'secret' } as never, ctxOf(host, guest));
    expect(guest.roomId).toBe(host.roomId);
    expect(lastMsg(guest, 'joined_room')).toBeDefined();
  });

  it('заполненная комната → error', () => {
    const host = makeClient('host');
    handle(host, { type: 'create_room', room_name: 'R', max_players: 2 } as never, ctxOf(host));
    const guest = makeClient('guest');
    handle(guest, { type: 'join_room', room_id: host.roomId! } as never, ctxOf(host, guest));
    const third = makeClient('third');
    handle(third, { type: 'join_room', room_id: host.roomId! } as never, ctxOf(host, guest, third));
    expect(third.roomId).toBeNull();
    expect(lastMsg(third, 'error')).toMatchObject({ message: expect.stringContaining('заполнена') });
  });

  it('rejoin при сохранённом снапшоте — joined_room.game_state не null', () => {
    const host = makeClient('host');
    handle(host, { type: 'create_room', room_name: 'R' } as never, ctxOf(host));
    handle(host, { type: 'relay', data: { action: 'start_game' } } as never, ctxOf(host));
    handle(host, {
      type: 'relay',
      data: { action: 'game_sync', round_num: 3, phase: 'action', marker: 'snap' },
    } as never, ctxOf(host));

    const late = makeClient('late');
    handle(late, { type: 'join_room', room_id: host.roomId! } as never, ctxOf(host, late));

    const joined = lastMsg(late, 'joined_room') as {
      game_started: boolean;
      game_state: { round_num?: number; marker?: string } | null;
    };
    expect(joined.game_started).toBe(true);
    expect(joined.game_state).not.toBeNull();
    expect(joined.game_state!.round_num).toBe(3);
    expect(joined.game_state!.marker).toBe('snap');
  });

  it('reactivation: новый join в пустую комнату делает игрока хостом и сбрасывает emptyAt', () => {
    const founder = makeClient('founder');
    handle(founder, { type: 'create_room', room_name: 'reactivate' } as never, ctxOf(founder));
    const roomId = founder.roomId!;
    leaveRoom(founder, ctxOf(founder));
    expect(getRoom(roomId)?.emptyAt).not.toBeNull();

    const reviver = makeClient('reviver');
    handle(reviver, { type: 'join_room', room_id: roomId } as never, ctxOf(reviver));

    expect(reviver.roomId).toBe(roomId);
    const room = getRoom(roomId)!;
    expect(room.emptyAt).toBeNull();
    expect(room.hostId).toBe(reviver.id);   // первый входящий становится хостом
    const joined = lastMsg(reviver, 'joined_room') as { is_host: boolean };
    expect(joined.is_host).toBe(true);
  });

  it('поздний игрок (нет записи в game_players) → investigator="", ready=false', () => {
    // Готовим started-сессию с одним игроком в БД
    const u1 = 'user-old';
    db.insert(users).values({ id: u1, email: 'o@u.com', name: 'Old', createdAt: Date.now() }).run();
    const host = makeClient('Old', u1);
    handle(host, { type: 'create_room', room_name: 'started-game' } as never, ctxOf(host));
    const roomId = host.roomId!;
    handle(host, { type: 'relay', data: { action: 'set_ready', investigator: 'Akachi Onyele' } } as never, ctxOf(host));
    handle(host, { type: 'relay', data: { action: 'start_game' } } as never, ctxOf(host));

    // Заходит совершенно новый аутентифицированный игрок
    const u2 = 'user-new';
    db.insert(users).values({ id: u2, email: 'n@u.com', name: 'New', createdAt: Date.now() }).run();
    const late = makeClient('New', u2);
    handle(late, { type: 'join_room', room_id: roomId } as never, ctxOf(host, late));

    // На сервере ничего не восстановилось
    expect(late.investigator).toBe('');
    expect(late.ready).toBe(false);

    // В joined_room моя запись с пустым сыщиком — клиент по этому решит,
    // что нужно остаться в лобби (а не прыгать на карту).
    const joined = lastMsg(late, 'joined_room') as {
      game_started: boolean;
      players: Array<{ id: string; investigator: string }>;
    };
    expect(joined.game_started).toBe(true);
    const myRow = joined.players.find(p => p.id === late.id)!;
    expect(myRow.investigator).toBe('');
  });

  it('rejoin: восстанавливает investigator/ready из БД', () => {
    const userId = 'returning-user';
    db.insert(users).values({ id: userId, email: 'r@u.com', name: 'Ret', createdAt: Date.now() }).run();

    // Раунд 1: создаём комнату, ставим ready
    const c1 = makeClient('Ret', userId);
    handle(c1, { type: 'create_room', room_name: 'rejoin-test' } as never, ctxOf(c1));
    const roomId = c1.roomId!;
    handle(c1, { type: 'relay', data: { action: 'set_ready', investigator: 'Akachi Onyele' } } as never, ctxOf(c1));
    expect(getGamePlayer(roomId, userId)).toMatchObject({ investigator: 'Akachi Onyele', ready: true });

    // Раунд 2: тот же userId переподключается (новый Client)
    leaveRoom(c1, ctxOf(c1));
    const c2 = makeClient('Ret', userId);
    handle(c2, { type: 'join_room', room_id: roomId } as never, ctxOf(c2));

    expect(c2.investigator).toBe('Akachi Onyele');
    expect(c2.ready).toBe(true);
    // В joined_room сам игрок виден с восстановленным сыщиком
    const joined = lastMsg(c2, 'joined_room') as { players: { investigator: string }[] };
    expect(joined.players[0]!.investigator).toBe('Akachi Onyele');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('relay → set_ready', () => {
  it('сохраняет в БД для аутентифицированного и рассылает всем (включая отправителя)', () => {
    const userId = 'auth-user';
    db.insert(users).values({ id: userId, email: 'a@u.com', name: 'A', createdAt: Date.now() }).run();

    const host  = makeClient('host', userId);
    handle(host, { type: 'create_room', room_name: 'R' } as never, ctxOf(host));
    const guest = makeClient('guest');
    handle(guest, { type: 'join_room', room_id: host.roomId! } as never, ctxOf(host, guest));
    host.outbox.length = 0;
    guest.outbox.length = 0;

    handle(host, { type: 'relay', data: { action: 'set_ready', investigator: 'Diana' } } as never, ctxOf(host, guest));

    expect(host.ready).toBe(true);
    expect(host.investigator).toBe('Diana');
    expect(getGamePlayer(host.roomId!, userId)).toMatchObject({ investigator: 'Diana', ready: true });
    // set_ready рассылается ВСЕМ (включая отправителя)
    expect(lastMsg(host,  'relay')).toBeDefined();
    expect(lastMsg(guest, 'relay')).toBeDefined();
  });

  it('не персистит для анонимного (userId=null)', () => {
    const c = makeClient('anon', null);
    handle(c, { type: 'create_room', room_name: 'R' } as never, ctxOf(c));
    handle(c, { type: 'relay', data: { action: 'set_ready', investigator: 'Diana' } } as never, ctxOf(c));
    // В памяти есть, в БД — нет (некого сохранять — userId null)
    expect(c.investigator).toBe('Diana');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('relay → start_game', () => {
  it('создаёт запись в game_sessions', () => {
    const host = makeClient('host');
    handle(host, { type: 'create_room', room_name: 'R' } as never, ctxOf(host));
    expect(getGameSession(host.roomId!)).toBeNull();

    handle(host, { type: 'relay', data: { action: 'start_game' } } as never, ctxOf(host));
    expect(getGameSession(host.roomId!)).not.toBeNull();
  });

  it('после start_game новый join видит game_started=true', () => {
    const host = makeClient('host');
    handle(host, { type: 'create_room', room_name: 'R' } as never, ctxOf(host));
    handle(host, { type: 'relay', data: { action: 'start_game' } } as never, ctxOf(host));

    const late = makeClient('late');
    handle(late, { type: 'join_room', room_id: host.roomId! } as never, ctxOf(host, late));
    const joined = lastMsg(late, 'joined_room') as { game_started: boolean };
    expect(joined.game_started).toBe(true);
  });

  it('start_game от не-хоста — отклоняется, game_session не создаётся', () => {
    const host = makeClient('host');
    handle(host, { type: 'create_room', room_name: 'R' } as never, ctxOf(host));
    const intruder = makeClient('intruder');
    handle(intruder, { type: 'join_room', room_id: host.roomId! } as never, ctxOf(host, intruder));
    intruder.outbox.length = 0;

    handle(intruder, { type: 'relay', data: { action: 'start_game' } } as never, ctxOf(host, intruder));

    expect(getGameSession(host.roomId!)).toBeNull();
    expect(lastMsg(intruder, 'error')).toMatchObject({ message: expect.stringContaining('хост') });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('relay → game_sync (host-only)', () => {
  it('game_sync от хоста — снапшот пишется в БД', async () => {
    const { getGameSnapshot } = await import('../src/shared/db.js');
    const host = makeClient('host');
    handle(host, { type: 'create_room', room_name: 'R' } as never, ctxOf(host));
    handle(host, { type: 'relay', data: { action: 'start_game' } } as never, ctxOf(host));

    handle(host, {
      type: 'relay',
      data: { action: 'game_sync', round_num: 7, phase: 'action' },
    } as never, ctxOf(host));

    const snap = getGameSnapshot(host.roomId!);
    expect(snap).not.toBeNull();
    expect(JSON.parse(snap!)).toMatchObject({ action: 'game_sync', round_num: 7 });
  });

  it('game_sync от не-хоста — игнорируется (снапшот не перезаписывается)', async () => {
    const { getGameSnapshot } = await import('../src/shared/db.js');
    const host = makeClient('host');
    handle(host, { type: 'create_room', room_name: 'R' } as never, ctxOf(host));
    handle(host, { type: 'relay', data: { action: 'start_game' } } as never, ctxOf(host));
    handle(host, {
      type: 'relay',
      data: { action: 'game_sync', round_num: 5, marker: 'legit' },
    } as never, ctxOf(host));

    const intruder = makeClient('intruder');
    handle(intruder, { type: 'join_room', room_id: host.roomId! } as never, ctxOf(host, intruder));

    handle(intruder, {
      type: 'relay',
      data: { action: 'game_sync', round_num: 999, marker: 'forged' },
    } as never, ctxOf(host, intruder));

    const snap = JSON.parse(getGameSnapshot(host.roomId!)!);
    expect(snap.marker).toBe('legit');
    expect(snap.round_num).toBe(5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('relay_to (targeted)', () => {
  it('доставляет только указанному получателю', () => {
    const host  = makeClient('host');
    handle(host, { type: 'create_room', room_name: 'R' } as never, ctxOf(host));
    const a = makeClient('a');
    const b = makeClient('b');
    handle(a, { type: 'join_room', room_id: host.roomId! } as never, ctxOf(host, a, b));
    handle(b, { type: 'join_room', room_id: host.roomId! } as never, ctxOf(host, a, b));
    host.outbox.length = 0; a.outbox.length = 0; b.outbox.length = 0;

    handle(host, { type: 'relay_to', to: a.id, data: { action: 'whisper', text: 'hi' } } as never, ctxOf(host, a, b));

    expect(lastMsg(a, 'relay')).toMatchObject({ from_id: host.id });
    expect(lastMsg(b, 'relay')).toBeUndefined();
  });

  it('несуществующий получатель → error', () => {
    const host = makeClient('host');
    handle(host, { type: 'create_room', room_name: 'R' } as never, ctxOf(host));
    host.outbox.length = 0;
    handle(host, { type: 'relay_to', to: 'ghost', data: {} } as never, ctxOf(host));
    expect(lastMsg(host, 'error')).toMatchObject({ message: expect.stringContaining('не найден') });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('leaveRoom', () => {
  it('одинокий хост → комната становится пустой (empty_at != null)', () => {
    const host = makeClient('host');
    handle(host, { type: 'create_room', room_name: 'R' } as never, ctxOf(host));
    const roomId = host.roomId!;

    leaveRoom(host, ctxOf(host));
    expect(host.roomId).toBeNull();
    expect(getPlayerCount(roomId)).toBe(0);
    expect(getRoom(roomId)?.emptyAt).not.toBeNull();
  });

  it('хост уходит при наличии гостя → promote next host + broadcast player_left', () => {
    const host = makeClient('host');
    handle(host, { type: 'create_room', room_name: 'R' } as never, ctxOf(host));
    const guest = makeClient('guest');
    handle(guest, { type: 'join_room', room_id: host.roomId! } as never, ctxOf(host, guest));
    guest.outbox.length = 0;

    const roomId = host.roomId!;
    leaveRoom(host, ctxOf(host, guest));

    const evt = lastMsg(guest, 'player_left') as { player_id: string; new_host_id: string };
    expect(evt.player_id).toBe(host.id);
    expect(evt.new_host_id).toBe(guest.id);
    // В БД hostId обновился
    expect(getRoom(roomId)?.hostId).toBe(guest.id);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('delete_room (host only)', () => {
  it('хост удаляет → broadcast room_deleted + удаление из БД', () => {
    const host  = makeClient('host');
    handle(host, { type: 'create_room', room_name: 'R' } as never, ctxOf(host));
    const guest = makeClient('guest');
    handle(guest, { type: 'join_room', room_id: host.roomId! } as never, ctxOf(host, guest));
    const roomId = host.roomId!;
    guest.outbox.length = 0;

    handle(host, { type: 'delete_room' } as never, ctxOf(host, guest));

    expect(lastMsg(guest, 'room_deleted')).toMatchObject({ room_id: roomId });
    expect(getRoom(roomId)).toBeUndefined();
  });

  it('не-хост пытается удалить → error', () => {
    const host  = makeClient('host');
    handle(host, { type: 'create_room', room_name: 'R' } as never, ctxOf(host));
    const guest = makeClient('guest');
    handle(guest, { type: 'join_room', room_id: host.roomId! } as never, ctxOf(host, guest));
    guest.outbox.length = 0;

    handle(guest, { type: 'delete_room' } as never, ctxOf(host, guest));
    expect(lastMsg(guest, 'error')).toMatchObject({ message: expect.stringContaining('хост') });
    expect(getRoom(host.roomId!)).not.toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('list_rooms (msg)', () => {
  it('возвращает rooms_list со всеми существующими комнатами', () => {
    const h1 = makeClient('h1');
    handle(h1, { type: 'create_room', room_name: 'A' } as never, ctxOf(h1));
    const h2 = makeClient('h2');
    handle(h2, { type: 'create_room', room_name: 'B' } as never, ctxOf(h2));

    const observer = makeClient('obs');
    handle(observer, { type: 'list_rooms' } as never, ctxOf(observer));

    const msg = lastMsg(observer, 'rooms_list') as { rooms: { name: string }[] };
    expect(msg.rooms.map(r => r.name).sort()).toEqual(['A', 'B']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('leave_room (msg)', () => {
  it('handle(leave_room) эквивалентно leaveRoom() — комната освобождается', () => {
    const host  = makeClient('host');
    handle(host, { type: 'create_room', room_name: 'R' } as never, ctxOf(host));
    const guest = makeClient('guest');
    handle(guest, { type: 'join_room', room_id: host.roomId! } as never, ctxOf(host, guest));
    const roomId = host.roomId!;
    host.outbox.length = 0;

    handle(guest, { type: 'leave_room' } as never, ctxOf(host, guest));

    expect(guest.roomId).toBeNull();
    expect(getPlayerCount(roomId)).toBe(1);
    // Хост получает player_left
    expect(lastMsg(host, 'player_left')).toMatchObject({ player_id: guest.id });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('delete_any_room (списком из лобби)', () => {
  it('требует userId (анонимам — error)', () => {
    const host = makeClient('host', null);   // анонимный
    handle(host, { type: 'create_room', room_name: 'A' } as never, ctxOf(host));
    const otherRoom = makeClient('o', 'u-other');
    handle(otherRoom, { type: 'create_room', room_name: 'B' } as never, ctxOf(otherRoom));
    leaveRoom(otherRoom, ctxOf(otherRoom));   // B стала пустой

    const anon = makeClient('anon', null);
    handle(anon, { type: 'delete_any_room', room_id: otherRoom.roomId! } as never, ctxOf(anon));
    expect(lastMsg(anon, 'error')).toMatchObject({ message: expect.stringContaining('авториз') });
  });

  it('удаляет пустую комнату', () => {
    const founder = makeClient('f');
    handle(founder, { type: 'create_room', room_name: 'A' } as never, ctxOf(founder));
    const roomId = founder.roomId!;
    leaveRoom(founder, ctxOf(founder));
    expect(getRoom(roomId)?.emptyAt).not.toBeNull();

    const cleaner = makeClient('c', 'u-cleaner');
    handle(cleaner, { type: 'delete_any_room', room_id: roomId } as never, ctxOf(cleaner));

    expect(getRoom(roomId)).toBeUndefined();
  });

  it('не пустая комната → error', () => {
    const host = makeClient('h');
    handle(host, { type: 'create_room', room_name: 'A' } as never, ctxOf(host));
    const roomId = host.roomId!;

    const cleaner = makeClient('c', 'u-cleaner');
    handle(cleaner, { type: 'delete_any_room', room_id: roomId } as never, ctxOf(host, cleaner));

    expect(lastMsg(cleaner, 'error')).toMatchObject({ message: expect.stringContaining('не пуста') });
    expect(getRoom(roomId)).not.toBeUndefined();
  });

  it('несуществующая комната → error', () => {
    const cleaner = makeClient('c', 'u-cleaner');
    handle(cleaner, { type: 'delete_any_room', room_id: 'no-such' } as never, ctxOf(cleaner));
    expect(lastMsg(cleaner, 'error')).toMatchObject({ message: expect.stringContaining('не найдена') });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('relay → generic (без специального action)', () => {
  it('произвольное сообщение шлётся всем в комнате, кроме отправителя', () => {
    const host  = makeClient('host');
    handle(host, { type: 'create_room', room_name: 'R' } as never, ctxOf(host));
    const a = makeClient('a');
    const b = makeClient('b');
    handle(a, { type: 'join_room', room_id: host.roomId! } as never, ctxOf(host, a, b));
    handle(b, { type: 'join_room', room_id: host.roomId! } as never, ctxOf(host, a, b));
    host.outbox.length = 0; a.outbox.length = 0; b.outbox.length = 0;

    handle(host, {
      type: 'relay',
      data: { action: 'chat', text: 'hello' },
    } as never, ctxOf(host, a, b));

    expect(lastMsg(a, 'relay')).toMatchObject({ from_id: host.id, data: { action: 'chat', text: 'hello' } });
    expect(lastMsg(b, 'relay')).toMatchObject({ from_id: host.id });
    // Отправитель НЕ получает свой generic-relay (excludeId).
    expect(lastMsg(host, 'relay')).toBeUndefined();
  });
});
