// Once a matter in a chat reaches a real outcome (a refund approved, a return label handed over, a
// denial, or handed off as a pending escalation), it is done contributing to the conversation's
// "current topic". If the customer then raises something new after the closing "Is there anything
// else I can help you with?", a new case for THAT should start with a clean transcript, not the whole
// prior, often unrelated exchange glued on the front (a return on one item followed by a damage
// report on another order produced a case whose transcript opened with the first return).
//
// Keyed by CONVERSATION id (request-context.ts's CONVERSATION_ID_KEY), not the tab's sessionId.
// Within one conversation it keeps a second, unrelated case from inheriting the first one's
// transcript. A genuinely NEW chat (offer_new_chat's card, mastra/tools/offer-new-chat.ts) has a new
// conversation id, so this map has no entry and the count starts at zero.
//
// The boundary is an INDEX into the conversation's stored thread (conversation-threads.ts), the one list
// every transcript is built from: when a case is created (the thread then ends with the customer message that
// triggered it) and every time its transcript is rebuilt at the end of a later turn (case-sync.ts). The model's own
// message list is NOT used: it holds the identity message and splits one turn into separate tool messages, so
// its length means something different from the stored list's. "Stored messages now, plus one for the reply that
// narrates this case's outcome, which is appended when the turn ends" is where the NEXT case should start reading.
// Not bulletproof: a notice pushed outside a normal turn (a rep resolving a DIFFERENT open case while this tab
// stays open) shifts the later indexes by one, which scopeSinceLastCase (chat-transcript.ts) absorbs by skipping
// forward to the next customer message.
//
// refund-policy-gate.ts and delivery-dispute.ts both read it (to know where to cut) and write it
// (once their case exists), so the boundary is shared by every case-creation path. In-process only,
// like active-sessions.ts and case-events.ts: a restart forgets it, and a later case in that chat then reads the
// whole conversation. A session-scoped fact has nowhere else to live (RequestContext is fresh per HTTP request).
import { getThread } from "./conversation-threads";

const lastCaseBoundaryCount = new Map<string, number>();

export function recordCaseBoundaryCount(conversationId: string, messageCount: number): void {
  lastCaseBoundaryCount.set(conversationId, messageCount);
}

export function getLastCaseBoundaryCount(conversationId: string): number | undefined {
  return lastCaseBoundaryCount.get(conversationId);
}

// What a new case is built from, and the boundary to record for the next one. The stored thread, when the
// conversation has one (every chat turn does); otherwise `fallback`, the model-side list a direct caller (a test, a
// script) passes, counted the old way.
export async function conversationForNewCase(conversationId: string, fallback: unknown[]): Promise<{ messages: unknown[]; nextBoundary: number }> {
  const thread = await getThread(conversationId);
  const messages: unknown[] = thread ? thread.messages : fallback;
  return { messages, nextBoundary: messages.length + 1 };
}
