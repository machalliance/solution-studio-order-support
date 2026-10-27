// The in-process event bus for case updates (resolved / more-info-requested /
// escalation-started): the event types and the emitter. server.ts publishes here after a rep's
// decision or an escalation, and the storefront's live-update stream
// (GET /chat/:agentId/events) subscribes, filtered by sessionId so only the tab that opened the
// case receives it. Events are also recorded (event-history.ts) so a tab that reconnects can
// catch up. Single-process only — see the note on `caseEvents` below.

import { createEventHistory } from "./event-history";
import { EventEmitter } from "node:events";

export interface CaseResolvedEvent {
  runId: string;
  orderId: string;
  customerId: string;
  // The sessionId of the chat tab that originally escalated this case (carried through
  // suspend/resume — see policy-review-workflow.ts) — the SSE endpoint only forwards this
  // to a connection whose own sessionId matches. See request-context.ts's SESSION_ID_KEY
  // for why this replaced "any open tab for this customer."
  sessionId: string;
  action: "executed" | "denied" | "escalated_to_support";
  refundAmount?: number;
  // ISO 4217 code refundAmount is denominated in — set alongside it so a frontend never
  // has to assume or hardcode a currency to render this number.
  currency?: string;
  reason?: string;
  // Only set when action is "executed" AND either the case was a plain_return, or a rep
  // explicitly asked for the item back on a damage/fault claim (the Desk's per-case
  // checkbox) — a delivery dispute never needs the item shipped back, and a damage claim
  // only does when a rep says so, so this is never invented otherwise. A request only:
  // the refund and the case's resolution never wait on it. Set here (server.ts's
  // resumeAndNotify), not left for the customer to ask for separately — see
  // wismo-agent.ts's instructions for the matching rule on the autonomous (same-turn)
  // approval path.
  returnLabelUrl?: string;
  returnTrackingNumber?: string;
  // The rep's own message on an approve / modify (the Desk's "Message to the customer" box) — shown to the customer in the
  // chat push and the email. Without it a MODIFIED refund reads as a bare smaller number with no explanation.
  comment?: string;
  // Only set when action is "escalated_to_support" — see escalate-support-ticket.ts /
  // runtime-settings.ts's getSupportTicketContactHours().
  ticketId?: string;
  contactWindowHours?: number;
  // Only set when action is "escalated_to_support": "system" for an SLA timeout or an
  // unreachable request_more_info, "rep" for a rep's own proactive "escalate to
  // support" decision (policy-review-workflow.ts) — the two need different customer-
  // facing copy, since nothing "took too long" when a rep actively decided this needs
  // a higher tier of support.
  resolvedBy?: "system" | "rep";
  // Only set when action is "escalated_to_support" because a rep's question could not be delivered (the customer's chat tab
  // was not connected): the question the rep asked, which the notice sent to the customer then quotes.
  question?: string;
  // Only set when action is "escalated_to_support" because the customer did not answer a rep's question within the response window.
  customerDidNotReply?: boolean;
}

// A rep asking "request more info" re-suspends the case rather than resolving it — a
// separate event from CaseResolvedEvent above, not a variant of it, since the chat needs
// to render it differently (a question to answer, not an outcome to report).
export interface CaseMoreInfoEvent {
  runId: string;
  orderId: string;
  customerId: string;
  sessionId: string;
  question: string;
}

// Fired the moment a case is first escalated (refund-policy-gate.ts / delivery-dispute.ts), not
// on resume — this is what puts the live countdown in the customer's chat. deadlineIso
// is computed once here, server-side, and never left to the model to state or compute
// itself (see wismo-agent.ts's instructions on why).
export interface CaseEscalationStartedEvent {
  runId: string;
  orderId: string;
  customerId: string;
  sessionId: string;
  deadlineIso: string;
}

// A plain in-process event bus — the Escalation Desk's resume endpoint and the
// storefront's live-update stream (server.ts) are both handled by this same Node
// process (one Mastra instance, one server — see server.ts's own header comment), so
// there's no real pub/sub infrastructure (Redis, etc.) needed to bridge them. This
// would need to become a real message bus the moment this ran across more than one
// process.
export const caseEvents = new EventEmitter();
caseEvents.setMaxListeners(50);

// Record before notifying stream listeners, so disconnected tabs can catch up.
export const caseEventHistory = createEventHistory();
for (const [source, type] of [["resolved", "case-resolved"], ["more-info-requested", "case-more-info"], ["escalation-started", "case-escalation-started"]] as const) {
  caseEvents.on(source, (data: CaseResolvedEvent | CaseMoreInfoEvent | CaseEscalationStartedEvent) => {
    const event = caseEventHistory.record(type, data);
    caseEvents.emit("replayable", event);
  });
}
