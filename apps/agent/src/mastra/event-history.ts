import { randomUUID } from "node:crypto";

export interface ReplayEvent {
  id: string;
  type: string;
  data: { customerId: string; sessionId: string };
  recordedAt: number;
}

// Temporary reconnect recovery for this single-process prototype. History expires
// after a day and is cleared by a process restart, just like live connections.
export function createEventHistory(maxEvents = 10000, retentionMs = 86400000) {
  const epoch = randomUUID();
  let sequence = 0;
  let events: ReplayEvent[] = [];
  return {
    record(type: string, data: ReplayEvent["data"], now = Date.now()): ReplayEvent {
      const event = { id: epoch + ":" + ++sequence, type, data, recordedAt: now };
      events = events.filter((entry) => now - entry.recordedAt < retentionMs);
      events.push(event);
      if (events.length > maxEvents) events.splice(0, events.length - maxEvents);
      return event;
    },
    since(customerId: string, sessionId: string, cursor?: string, now = Date.now()) {
      const after = cursor?.startsWith(epoch + ":") ? Number(cursor.slice(epoch.length + 1)) : 0;
      return events.filter((entry) =>
        entry.data.customerId === customerId && entry.data.sessionId === sessionId &&
        now - entry.recordedAt < retentionMs &&
        Number(entry.id.slice(epoch.length + 1)) > (Number.isFinite(after) ? after : 0));
    },
  };
}
