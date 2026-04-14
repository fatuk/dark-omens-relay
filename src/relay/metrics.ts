// Все метрики живут в памяти — доступны через /stats

export interface MessageStats {
  hello:       number;
  list_rooms:  number;
  create_room: number;
  join_room:   number;
  leave_room:  number;
  delete_room: number;
  relay:       number;
  relay_to:    number;
  unknown:     number;
}

export interface Snapshot {
  uptime_s:          number;
  started_at:        string;
  connections: {
    current:   number;
    peak:      number;
    total:     number;
    rejected:  number;
  };
  rooms: {
    current:       number;
    total_created: number;
    total_deleted: number;
  };
  messages: {
    received:    MessageStats;
    sent:        number;
    errors_sent: number;
  };
  relay_messages: {
    broadcast: number;
    targeted:  number;
    bytes_est: number;
  };
  heartbeat: {
    pings_sent:  number;
    terminated:  number;
  };
  memory_mb: number;
}

const startedAt = new Date();

const m = {
  connections: { current: 0, peak: 0, total: 0, rejected: 0 },
  rooms:       { current: 0, totalCreated: 0, totalDeleted: 0 },
  messages: {
    received: {
      hello: 0, list_rooms: 0, create_room: 0, join_room: 0,
      leave_room: 0, delete_room: 0, relay: 0, relay_to: 0, unknown: 0,
    } as MessageStats,
    sent: 0,
    errorsSent: 0,
  },
  relay:     { broadcast: 0, targeted: 0, bytesEst: 0 },
  heartbeat: { pingsSent: 0, terminated: 0 },
};

// ── Инкременторы ──────────────────────────────────────────────────────────────

export function onClientConnect(): void {
  m.connections.current++;
  m.connections.total++;
  if (m.connections.current > m.connections.peak)
    m.connections.peak = m.connections.current;
}

export function onClientDisconnect(): void {
  if (m.connections.current > 0) m.connections.current--;
}

export function onClientRejected(): void {
  m.connections.rejected++;
}

export function onRoomCreated(): void {
  m.rooms.current++;
  m.rooms.totalCreated++;
}

export function onRoomDeleted(): void {
  if (m.rooms.current > 0) m.rooms.current--;
  m.rooms.totalDeleted++;
}

export function onMessageReceived(type: string): void {
  const key = type as keyof MessageStats;
  if (key in m.messages.received) {
    (m.messages.received[key] as number)++;
  } else {
    m.messages.received.unknown++;
  }
}

export function onMessageSent(byteLength: number): void {
  m.messages.sent++;
  m.relay.bytesEst += byteLength;
}

export function onErrorSent(): void {
  m.messages.errorsSent++;
}

export function onRelayBroadcast(byteLength: number): void {
  m.relay.broadcast++;
  m.relay.bytesEst += byteLength;
}

export function onRelayTargeted(byteLength: number): void {
  m.relay.targeted++;
  m.relay.bytesEst += byteLength;
}

export function onHeartbeatPing(count: number): void {
  m.heartbeat.pingsSent += count;
}

export function onHeartbeatTerminate(): void {
  m.heartbeat.terminated++;
  onClientRejected();
}

// ── Снимок состояния ──────────────────────────────────────────────────────────

export function getSnapshot(): Snapshot {
  const mem = process.memoryUsage();
  return {
    uptime_s:   Math.floor(process.uptime()),
    started_at: startedAt.toISOString(),
    connections: {
      current:  m.connections.current,
      peak:     m.connections.peak,
      total:    m.connections.total,
      rejected: m.connections.rejected,
    },
    rooms: {
      current:       m.rooms.current,
      total_created: m.rooms.totalCreated,
      total_deleted: m.rooms.totalDeleted,
    },
    messages: {
      received:    { ...m.messages.received },
      sent:        m.messages.sent,
      errors_sent: m.messages.errorsSent,
    },
    relay_messages: {
      broadcast: m.relay.broadcast,
      targeted:  m.relay.targeted,
      bytes_est: m.relay.bytesEst,
    },
    heartbeat: {
      pings_sent: m.heartbeat.pingsSent,
      terminated: m.heartbeat.terminated,
    },
    memory_mb: Math.round(mem.rss / 1024 / 1024 * 10) / 10,
  };
}
