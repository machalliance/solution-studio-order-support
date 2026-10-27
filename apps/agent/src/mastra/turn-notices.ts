// Notices pushed to a customer while the agent is still answering them (a rep's question or decision) are stored AFTER the answer.
// The widget shows a pushed notice only once the answer has finished, so the customer sees: their message, the answer, the notice.
// Stored the moment they arrived, the notice would sit between the message and the answer, and the model's history would disagree
// with what the customer saw. A notice that arrives when no answer is being written is stored at once.
//
// A turn is "in flight" from the moment the customer's message is saved until its reply has been stored and the notices that waited
// have been written. The next request for the conversation waits for that (server.ts's pendingThreadWrites), so it always finds the
// answer and the notices, in the order the customer saw them.

import { randomUUID } from "node:crypto";
import { appendManyToThread, latestConversationIdOfSession, type StoredMessage } from "./conversation-threads";

const turnsInFlight = new Set<string>();
const waiting = new Map<string, string[]>();
// One chain per session, so notices are stored in the order they arrived.
const chains = new Map<string, Promise<void>>();

const noticeMessage = (text: string): StoredMessage => ({ id: randomUUID(), role: "assistant", parts: [{ type: "text", text }] });

export function beginTurn(conversationId: string): void {
  turnsInFlight.add(conversationId);
}

// Called once the turn's reply is stored, or when the turn failed before there was one. Writes every notice that waited, in order.
export async function endTurn(conversationId: string): Promise<void> {
  try {
    for (;;) {
      const queued = waiting.get(conversationId);
      if (!queued || queued.length === 0) break;
      waiting.delete(conversationId);
      await appendManyToThread(conversationId, queued.map(noticeMessage));
    }
  } finally {
    // Straight after the last check, with no wait in between: a notice cannot slip into the queue after it was last looked at.
    turnsInFlight.delete(conversationId);
  }
}

// The notice goes into the session's most recently used conversation: that is where the browser shows it too.
export function recordNotice(sessionId: string, text: string): Promise<void> {
  const next = (chains.get(sessionId) ?? Promise.resolve())
    .then(async () => {
      const conversationId = await latestConversationIdOfSession(sessionId);
      if (!conversationId) return;
      if (turnsInFlight.has(conversationId)) {
        waiting.set(conversationId, [...(waiting.get(conversationId) ?? []), text]);
        return;
      }
      await appendManyToThread(conversationId, [noticeMessage(text)]);
    })
    .catch((error) => console.error("[chat] Could not record a case notice in the thread:", error));
  chains.set(sessionId, next);
  void next.then(() => {
    if (chains.get(sessionId) === next) chains.delete(sessionId);
  });
  return next;
}
