// AI SDK's UIMessage carries no timestamp at all ({id, role, metadata?, parts} — verified
// against the installed 'ai' package's own type, nothing else), and nothing in this app
// attaches one client-side either — so there's no "real" send time available to trust
// even if we wanted one. This is the honest alternative: the first moment THIS SERVER
// PROCESS ever sees a given message id, kept for the life of the process (same
// in-process, non-persistent scope as case-events.ts's event bus) — accurate to within
// one HTTP round trip of when the message was actually sent, not fabricated after the
// fact. A message's id is stable across every resend of the growing history
// (assistant-ui keeps reusing the same id for the same message), so the first-seen time
// keeps matching that same message on every later call.
const firstSeenAt = new Map<string, string>();

export function timestampFor(messageId: string | undefined): string {
  if (!messageId) return new Date().toISOString();
  const existing = firstSeenAt.get(messageId);
  if (existing) return existing;
  const now = new Date().toISOString();
  firstSeenAt.set(messageId, now);
  return now;
}
