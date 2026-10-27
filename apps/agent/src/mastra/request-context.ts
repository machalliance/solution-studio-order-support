import type { RequestContext } from "@mastra/core/request-context";

// The anti-coercion rule: "customerId (and every fact keyed
// off it) is bound server-side at session start, injected into every tool call by the
// orchestration layer — never supplied or overridable by anything the LLM extracts from
// chat." server.ts injects this into every /chat request's requestContext; tools read it
// from here, never as an LLM-settable input parameter — see commerce.ts.
export const SESSION_CUSTOMER_ID_KEY = "customerId";

export function getSessionCustomerId(context: { requestContext?: RequestContext<any> }): string {
  const customerId = context.requestContext?.getRaw(SESSION_CUSTOMER_ID_KEY);
  if (typeof customerId !== "string" || !customerId) {
    throw new Error("No session customerId in requestContext — every /chat request must inject one (see server.ts).");
  }
  return customerId;
}

// A per-browser-tab identifier (ChatWidget.tsx generates one once per mount and sends it
// with every /chat request) — NOT persisted anywhere client-side, so a reload or a new
// tab gets a fresh one. Its only job is scoping live pushes: a case's escalation-created
// sessionId travels with it through suspend/resume (policy-review-workflow.ts), and the
// SSE endpoint (server.ts's /chat/:agentId/events) only forwards an event to a
// connection whose own sessionId matches. Deliberately not "any open tab for this
// customer" — with a single shared demo identity, that leaked updates into whichever tab
// happened to be open, not necessarily the one that created the case. If the tab that
// escalated a case is gone, the case is still fully live in Mastra's own records (the
// Escalation Desk reads and resumes it same as ever) — it just has no live chat
// connection left to push an update into, the same as a customer who closed a real chat
// window would.
export const SESSION_ID_KEY = "sessionId";

export function getSessionId(context: { requestContext?: RequestContext<any> }): string {
  const sessionId = context.requestContext?.getRaw(SESSION_ID_KEY);
  if (typeof sessionId !== "string" || !sessionId) {
    throw new Error("No sessionId in requestContext — every /chat request must inject one (see server.ts).");
  }
  return sessionId;
}

// One chat CONVERSATION — a single thread of messages, from the customer's first message
// until the storefront starts a fresh one (ChatWidget.tsx's "new chat" button, offered by
// the agent's own offer_new_chat tool — see mastra/tools/offer-new-chat.ts). Deliberately
// a SEPARATE id from SESSION_ID_KEY above, because the two answer different questions:
//   - sessionId       → "which browser tab do I push to?"  (lives as long as the tab)
//   - conversationId  → "which thread of messages is this?" (lives until a new chat starts)
// A new chat swaps the conversation but must keep the tab's live-push channel, so a
// resolution for an older case can still reach the same open tab. Everything that scopes
// a case to "the chat it came from" — the transcript boundary (session-case-boundary.ts),
// offer_new_chat's/offer_escalation_to_support's own "does this chat have an open/resolved
// case?" lookups (case-lookup.ts's summarizeConversationCases /
// findMostRecentResolvedCaseForConversation), and the agent-run trace tag — keys on this
// one.
//
// A request that doesn't send one (an older client, a raw curl) falls back to its
// sessionId, i.e. "the whole tab is one conversation" — exactly the behavior before this
// existed, so nothing depends on every caller having been updated.
export const CONVERSATION_ID_KEY = "conversationId";

export function getConversationId(context: { requestContext?: RequestContext<any> }): string {
  const conversationId = context.requestContext?.getRaw(CONVERSATION_ID_KEY);
  if (typeof conversationId === "string" && conversationId) return conversationId;
  return getSessionId(context);
}

// Which orders any order-facing tool actually touched this turn — read back by
// server.ts's onFinish handler (the SAME requestContext instance passed into
// handleChatStream, per Mastra's own doc comment on RequestContext.set: middleware sets
// it, downstream code reads it — the object flows by reference through the whole tool-
// calling loop, not a copy) to know which cases might need their transcript refreshed
// once the turn's full reply text is known. Deliberately NOT dependent on the model
// deciding to call a bookkeeping tool — two real live-testing sessions showed that
// judgment call doesn't fire reliably (a "keep talking, does it still sync" case and a
// "case ID line" case, both from the customer's own natural follow-ups, not a contrived
// test). Any order a tool call validated ownership for is worth checking, regardless of
// which specific tool it was.
const TOUCHED_ORDER_IDS_KEY = "touchedOrderIds";

export function markOrderTouched(context: { requestContext?: RequestContext<any> }, orderId: string): void {
  const existing = (context.requestContext?.getRaw(TOUCHED_ORDER_IDS_KEY) as string[] | undefined) ?? [];
  if (!existing.includes(orderId)) {
    context.requestContext?.setRaw(TOUCHED_ORDER_IDS_KEY, [...existing, orderId]);
  }
}

export function getTouchedOrderIds(requestContext: RequestContext<any>): string[] {
  return (requestContext.getRaw(TOUCHED_ORDER_IDS_KEY) as string[] | undefined) ?? [];
}

// Case IDs an escalation tool actually handed back THIS turn — recorded by whichever code
// just created the case (refund-policy-gate.ts for the payment tools, delivery-dispute.ts),
// read by case-id-guard.ts. Same by-reference-through-the-tool-loop mechanism as
// markOrderTouched above. Its one job is knowing which real ID a reply about a brand-new case
// SHOULD have quoted, so a mangled or invented one can be corrected to it (see that file);
// whether an ID is legitimate at all is decided by the durable workflow runs, not by this.
const ISSUED_CASE_IDS_KEY = "issuedCaseIds";

export function markCaseIdIssued(context: { requestContext?: RequestContext<any> }, caseId: string): void {
  const existing = (context.requestContext?.getRaw(ISSUED_CASE_IDS_KEY) as string[] | undefined) ?? [];
  if (!existing.includes(caseId)) {
    context.requestContext?.setRaw(ISSUED_CASE_IDS_KEY, [...existing, caseId]);
  }
}

export function getIssuedCaseIds(context: { requestContext?: RequestContext<any> }): string[] {
  return (context.requestContext?.getRaw(ISSUED_CASE_IDS_KEY) as string[] | undefined) ?? [];
}

// Every case run CREATED this turn, whatever its outcome — recorded at the point the run is
// created (refund-policy-gate.ts, delivery-dispute.ts). Deliberately NOT the same list as
// issued ids above: that one is only filled when a case is handed to a reviewer (the model
// is about to quote its ID) and exists for case-id-guard.ts, so an autonomously approved or
// denied case never appears in it. This one is read by server.ts's onFinish, which needs
// every case this turn made so one that already resolved still gets its transcript rebuilt
// (case-sync.ts's syncCreatedCaseTranscripts).
const CREATED_CASE_IDS_KEY = "createdCaseIds";

export function markCaseCreated(context: { requestContext?: RequestContext<any> }, caseId: string): void {
  const existing = (context.requestContext?.getRaw(CREATED_CASE_IDS_KEY) as string[] | undefined) ?? [];
  if (!existing.includes(caseId)) {
    context.requestContext?.setRaw(CREATED_CASE_IDS_KEY, [...existing, caseId]);
  }
}

export function getCreatedCaseIds(context: { requestContext?: RequestContext<any> }): string[] {
  return (context.requestContext?.getRaw(CREATED_CASE_IDS_KEY) as string[] | undefined) ?? [];
}

// How many times claim-grounding-guard.ts has sent a reply back for rewriting THIS turn — bounded, so a
// model that keeps restating an ungrounded specific ends up with the safe fallback instead of a loop.
const GROUNDING_CORRECTIONS_KEY = "groundingCorrections";

export function bumpGroundingCorrections(context: { requestContext?: RequestContext<any> }): number {
  const next = ((context.requestContext?.getRaw(GROUNDING_CORRECTIONS_KEY) as number | undefined) ?? 0) + 1;
  context.requestContext?.setRaw(GROUNDING_CORRECTIONS_KEY, next);
  return next;
}

// The tool-result text of this turn's COMPLETED steps, recorded by server.ts's prepareStep before each step
// and read by claim-grounding-guard.ts — a beforeToolCall hook cannot see them any other way (its
// `context.messages` stops at the start of the request).
const TURN_FACTS_KEY = "turnToolFacts";

export function setTurnFacts(context: { requestContext?: RequestContext<any> }, text: string): void {
  context.requestContext?.setRaw(TURN_FACTS_KEY, text);
}

export function getTurnFacts(context: { requestContext?: RequestContext<any> }): string {
  return (context.requestContext?.getRaw(TURN_FACTS_KEY) as string | undefined) ?? "";
}
