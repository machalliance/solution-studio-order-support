// Tracks which chat sessions currently have a live SSE connection to
// /chat/:agentId/events — the only signal this app has for "is the customer's browser
// tab actually still open." Used by the /resume route (server.ts) to decide whether a
// rep's request_more_info can actually reach the customer live, or whether email (and
// so a support ticket, same as a genuine SLA timeout) is the only channel left.
//
// Reference-counted, not a plain Set — a browser's own EventSource auto-reconnect can
// briefly hold two connections open for the same sessionId (the old one's onAbort
// hasn't fired yet when the new one connects), and a plain Set's delete() on the old
// connection's cleanup would incorrectly report the session as gone while the new one
// is still live.
const connectionCounts = new Map<string, number>();

export function markSessionConnected(sessionId: string): void {
  connectionCounts.set(sessionId, (connectionCounts.get(sessionId) ?? 0) + 1);
}

export function markSessionDisconnected(sessionId: string): void {
  const count = connectionCounts.get(sessionId) ?? 0;
  if (count <= 1) connectionCounts.delete(sessionId);
  else connectionCounts.set(sessionId, count - 1);
}

export function isSessionConnected(sessionId: string): boolean {
  return connectionCounts.has(sessionId);
}
