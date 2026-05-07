import { serve }      from '@hono/node-server';
import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID }  from 'crypto';
import type { IncomingMessage, Server as HttpServer } from 'http';

import { initDb } from '../shared/db.js';
import { logger } from '../shared/logger.js';
import type { Client, ClientMessage } from '../shared/types.js';

import { pruneStaleRooms, startPruneTimer, EMPTY_ROOM_TTL_MS } from './rooms.js';
import { buildApp, send, sendError } from './app.js';
import { handle, leaveRoom } from './handlers.js';

import {
  onClientConnect, onClientDisconnect, onMessageReceived,
  onHeartbeatPing, onHeartbeatTerminate,
} from './metrics.js';

const PORT        = parseInt(process.env['RELAY_PORT'] ?? '3030', 10);
const HEARTBEAT_MS = 30_000;

// ── In-memory: все активные WS-клиенты ───────────────────────────────────────
const clients = new Map<string, Client>();

// ── Запуск ────────────────────────────────────────────────────────────────────

initDb();
pruneStaleRooms();
startPruneTimer();

const app = buildApp();

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

const wss = new WebSocketServer({ server: server as unknown as HttpServer });

wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
  const client: Client = {
    id:           randomUUID(),
    name:         'Unknown',
    ws,
    roomId:       null,
    alive:        true,
    missedPings:  0,
    userId:       null,
    rejected:     false,
    ready:        false,
    investigator: '',
  };
  clients.set(client.id, client);
  onClientConnect();
  send(client, { type: 'welcome', your_id: client.id });

  const ip = req.socket.remoteAddress ?? '?';
  logger.info('+ connected', { id: short(client.id), ip, total: clients.size });

  ws.on('pong', () => { client.alive = true; client.missedPings = 0; });

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
    handle(client, msg, { clients });
  });

  ws.on('close', (code, reason) => {
    leaveRoom(client, { clients });
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

function short(uuid: string): string {
  return uuid.slice(0, 8);
}

// ── Heartbeat ─────────────────────────────────────────────────────────────────

const HEARTBEAT_MAX_MISSED = 2;

setInterval(() => {
  let pinged = 0;
  for (const client of clients.values()) {
    if (!client.alive) {
      client.missedPings++;
      if (client.missedPings >= HEARTBEAT_MAX_MISSED) {
        logger.warn('heartbeat timeout — terminating', {
          id: short(client.id), name: client.name, missed: client.missedPings,
        });
        client.ws.terminate();
        onHeartbeatTerminate();
        continue;
      }
      client.ws.ping();
      pinged++;
      continue;
    }
    client.missedPings = 0;
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
