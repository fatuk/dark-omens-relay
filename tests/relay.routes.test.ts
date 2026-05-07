import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from './helpers.js';
import { buildApp } from '../src/relay/app.js';
import { createRoom, markRoomEmpty, addPlayer } from '../src/relay/rooms.js';
import { db } from '../src/shared/db.js';
import { users } from '../src/shared/schema.js';
import { startGameSession, getGameSession } from '../src/shared/db.js';
import type { Client } from '../src/shared/types.js';
import { randomUUID } from 'crypto';

const app = buildApp();

// ── Минимальный фейковый WebSocket-клиент ─────────────────────────────────────
// readyState=3 (CLOSED), чтобы send() ничего не отправлял в несуществующий сокет.
function fakeClient(name = 'tester', userId: string | null = null): Client {
  return {
    id:           randomUUID(),
    name,
    ws:           { readyState: 3, send: () => {}, close: () => {}, terminate: () => {}, ping: () => {} } as unknown as Client['ws'],
    roomId:       null,
    alive:        true,
    missedPings:  0,
    userId,
    rejected:     false,
    ready:        false,
    investigator: '',
  };
}

beforeEach(() => { resetDb(); });

describe('GET /health', () => {
  it('возвращает status:ok + uptime + counters', async () => {
    const res = await app.fetch(new Request('http://localhost/health'));
    expect(res.status).toBe(200);
    const json = await res.json() as { status: string; uptime_s: number; clients: number; rooms: number };
    expect(json.status).toBe('ok');
    expect(typeof json.uptime_s).toBe('number');
    expect(typeof json.clients).toBe('number');
    expect(typeof json.rooms).toBe('number');
  });
});

describe('GET /stats', () => {
  it('возвращает полный snapshot метрик', async () => {
    const res = await app.fetch(new Request('http://localhost/stats'));
    expect(res.status).toBe(200);
    const snap = await res.json() as Record<string, unknown>;
    expect(snap).toHaveProperty('uptime_s');
    expect(snap).toHaveProperty('connections');
    expect(snap).toHaveProperty('rooms');
    expect(snap).toHaveProperty('messages');
  });
});

describe('GET /rooms', () => {
  it('пустой список когда комнат нет', async () => {
    const res = await app.fetch(new Request('http://localhost/rooms'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('возвращает созданные комнаты с playerCount/locked', async () => {
    createRoom(fakeClient('host1'), 'open',   '',         8);
    createRoom(fakeClient('host2'), 'locked', 'secret',   4);

    const res = await app.fetch(new Request('http://localhost/rooms'));
    const list = await res.json() as Array<{ name: string; locked: boolean; maxPlayers: number; playerCount: number }>;
    expect(list).toHaveLength(2);

    const open = list.find(r => r.name === 'open')!;
    expect(open.locked).toBe(false);
    expect(open.maxPlayers).toBe(8);
    expect(open.playerCount).toBe(1);   // host автоматически добавлен

    const locked = list.find(r => r.name === 'locked')!;
    expect(locked.locked).toBe(true);
    expect(locked.maxPlayers).toBe(4);
  });
});

describe('DELETE /rooms (admin: удалить все пустые)', () => {
  it('без admin-key → 403', async () => {
    const res = await app.fetch(new Request('http://localhost/rooms', { method: 'DELETE' }));
    expect(res.status).toBe(403);
  });

  it('с верным ключом → удаляет только пустые', async () => {
    const r1 = createRoom(fakeClient('h1'), 'empty1', '', 8);
    const r2 = createRoom(fakeClient('h2'), 'active', '', 8);
    const r3 = createRoom(fakeClient('h3'), 'empty2', '', 8);
    // Делаем r1 и r3 пустыми (host вышел)
    markRoomEmpty(r1);
    markRoomEmpty(r3);

    const res = await app.fetch(new Request('http://localhost/rooms', {
      method:  'DELETE',
      headers: { 'x-admin-key': 'test-admin-key' },
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: 2 });

    // Активная комната осталась
    const listRes = await app.fetch(new Request('http://localhost/rooms'));
    const list = await listRes.json() as Array<{ name: string }>;
    expect(list.map(r => r.name)).toEqual(['active']);
    void r2;
  });
});

describe('DELETE /rooms/:id (admin)', () => {
  it('без admin-key → 403', async () => {
    const res = await app.fetch(new Request('http://localhost/rooms/some-id', { method: 'DELETE' }));
    expect(res.status).toBe(403);
  });

  it('несуществующая комната → 404', async () => {
    const res = await app.fetch(new Request('http://localhost/rooms/nope', {
      method:  'DELETE',
      headers: { 'x-admin-key': 'test-admin-key' },
    }));
    expect(res.status).toBe(404);
  });

  it('удаляет комнату + каскадно убирает game_session', async () => {
    const r = createRoom(fakeClient('host'), 'doomed', '', 8);
    startGameSession(r.id, r.hostId);
    expect(getGameSession(r.id)).not.toBeNull();

    const res = await app.fetch(new Request(`http://localhost/rooms/${r.id}`, {
      method:  'DELETE',
      headers: { 'x-admin-key': 'test-admin-key' },
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, room_id: r.id });
    expect(getGameSession(r.id)).toBeNull();
  });
});

describe('GET /dashboard', () => {
  it('возвращает HTML', async () => {
    const res = await app.fetch(new Request('http://localhost/dashboard'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    expect(await res.text()).toContain('Dark Omens Relay');
  });
});

describe('GET /users (admin)', () => {
  it('без admin-key → 403', async () => {
    const res = await app.fetch(new Request('http://localhost/users'));
    expect(res.status).toBe(403);
  });

  it('возвращает зарегистрированных, отсортированных по createdAt DESC', async () => {
    db.insert(users).values({ id: 'u1', email: 'old@x.com',   name: 'Old',    createdAt: 1000 }).run();
    db.insert(users).values({ id: 'u2', email: 'new@x.com',   name: 'New',    createdAt: 5000 }).run();
    db.insert(users).values({ id: 'u3', email: 'mid@x.com',   name: 'Mid',    createdAt: 3000 }).run();

    const res = await app.fetch(new Request('http://localhost/users', {
      headers: { 'x-admin-key': 'test-admin-key' },
    }));
    expect(res.status).toBe(200);
    const list = await res.json() as Array<{ email: string; createdAt: string }>;
    expect(list.map(u => u.email)).toEqual(['new@x.com', 'mid@x.com', 'old@x.com']);
    // createdAt сериализован в ISO-строку
    expect(list[0]!.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('CORS', () => {
  it('добавляет Access-Control-Allow-Origin:*', async () => {
    const res = await app.fetch(new Request('http://localhost/health'));
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
});

// Подавляем неиспользуемый параметр для линтера (addPlayer импортирован для будущих тестов)
void addPlayer;
