import { getCustomer } from "../fixtures/demo-data";

export interface NotificationResult {
  notificationId: string;
  channel: "email";
  sentTo: string;
}

// Stubbed notification adapter — same "fixture-first" pattern as
// tools/escalate-support-ticket.ts / tools/payment.ts / tools/shipping.ts. A case's final
// resolution and any further rep action (a follow-up question, a timeout ticket) must
// ALWAYS reach the customer through a durable channel, not only the live SSE push
// (case-events.ts) that only ever reaches a tab that happens to still be open and
// connected. Called from server.ts's resumeAndNotify UNCONDITIONALLY, alongside every
// "resolved" / "more-info-requested" emission — never as a fallback gated on whether
// the live push actually landed anywhere, and never for "escalation-started" (the
// customer is already right there in the chat, mid-conversation, the moment that one
// fires — an immediate email about something they just did adds nothing new).
//
// Email only, always — Customer (fixtures/demo-data.ts) has no phone number or
// channel-preference field yet, so there's nothing to branch a real SMS path on. The
// interface takes a customerId rather than an address so a real provider — and a real
// per-customer channel choice, once that field exists — could be swapped in behind it
// without any caller changing.
export function notifyCustomer(customerId: string, subject: string, message: string): NotificationResult {
  const customer = getCustomer(customerId);
  const notificationId = `ntf_${Math.random().toString(36).slice(2, 8)}`;
  const sentTo = customer?.email ?? "(unknown customer)";
  console.log(`[notify] ${notificationId} -> ${sentTo} (email): ${subject}`);
  console.log(`[notify] ${notificationId} body: ${message}`);
  return { notificationId, channel: "email", sentTo };
}
