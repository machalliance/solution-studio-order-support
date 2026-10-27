import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { getOrder } from "../../fixtures/demo-data";
import { getSessionCustomerId, markOrderTouched } from "../request-context";
import { describeDispute, findMostRecentCaseRun, findMostRecentCaseForItems, findSupportTicketForItems, findOpenCasesForOrder, caseTypeOf, itemIdsOf, resolveItemRefs, returnScopesOverlap } from "./case-lookup";
import { alreadyRefundedItemIds } from "../refund-ledger";
import { getSupportTicketContactHours } from "../runtime-settings";
import { getDisagreementTicket } from "../disagreement-tickets";
import { caseStatusStatement } from "../customer-statements";

// A rep resolving a case in the Escalation Desk doesn't push anything back into an open
// chat tab on its own — that's what the /chat/:agentId/events SSE push (server.ts) and
// the automatic post-turn transcript sync are for. This tool covers the other direction:
// the customer actively asking for an update. The only way this agent can ever give an
// accurate answer to "did my refund go through?" is by actively checking, which is what
// this tool is for — without it, a customer asking gets either silence or a guess.

// Adds `statement` to whatever a lookup found, from that result's own fields — one place, so every
// return path below (open case, decided case, ticket, item-scoped) is covered the same way.
function withStatement<A extends unknown[], R extends { found: boolean }>(run: (...args: A) => Promise<R>) {
  return async (...args: A): Promise<R & { statement?: string }> => {
    const result = await run(...args);
    return result.found ? { ...result, statement: caseStatusStatement(result as any) } : result;
  };
}

export const checkEscalationStatus = createTool({
  id: "check_escalation_status",
  description:
    "Check on a case for one of the current customer's own orders. Three uses: (1) the customer asks for an update on something already escalated and no particular item is involved — call with just orderId, which matches the order's most recent case regardless of type or item; (2) the customer asks about, or you need to know where things stand for, SPECIFIC item(s) — pass orderId and itemIds and NO caseType: it returns the most recent case about those items, open or already decided (status, refund amount, and any support ticketId with its contact window), never an unrelated item's case; or (3) before filing a brand-new damage/fault claim, delivery dispute, or return, to check whether this exact thing is already covered by an OPEN case — pass caseType (and itemIds, for a refund or plain_return claim) so the match is scoped to the SAME issue, not just any open case on the order. caseType is what switches on use (3); with itemIds alone you get use (2).",
  inputSchema: z.object({
    orderId: z.string(),
    caseType: z
      .enum(["refund", "delivery_dispute", "plain_return"])
      .optional()
      .describe(
        "Pass this when checking for a duplicate before filing a NEW case, set to the type you're about to file. An open case of a DIFFERENT type never counts as a match — it's a genuinely separate issue. Omit for a general 'what's the status of my case' follow-up, which should match the order's most recent case of any type."
      ),
    itemIds: z
      .array(z.string())
      .optional()
      .describe(
        "The objectID of each item you mean, once you know them (same itemIds you'd pass to the matching escalate/payment tool). With caseType \"refund\" or \"plain_return\" it narrows a pre-filing duplicate check — an open case about a DIFFERENT item on the same order is not a duplicate. WITHOUT caseType it asks \"where does it stand for these item(s)?\" and returns the most recent case about them, open or decided. Omit for a single-item order (nothing to scope down from) or for delivery_dispute (never item-scoped)."
      ),
  }),
  outputSchema: z.object({
    found: z.boolean(),
    status: z.enum(["pending", "approved", "denied", "unclear"]).optional(),
    // The case's own real runId. Without it a status check could never give the customer a concrete
    // reference to their case, only vague reassurance ("this needs to be looked into by a specialist").
    // It is the SAME id case-id-guard.ts already verifies belongs to this customer before it can reach a
    // reply, so relaying it here is exactly as safe as the escalate_for_* tools' own runId.
    caseId: z.string().optional(),
    refundAmount: z.number().optional(),
    reason: z.string().optional(),
    // Only meaningful when status is "pending" — a live countdown only ever appears via
    // an escalate_for_* tool call (a fresh escalation) or automatically once the
    // customer replies to a specialist's question (case-sync.ts). This tool is a
    // read-only status check; it never causes one to appear, so the caller needs enough
    // detail here to describe what's actually true instead of assuming "there's a
    // countdown" (see wismo-agent.ts's instructions on this — a real, live-reproduced
    // bug where the model promised a countdown that a status check can never produce).
    awaitingCustomerReply: z.boolean().optional(),
    ticketId: z.string().optional(),
    contactWindowHours: z.number().optional(),
    // The exact sentence to say about this (customer-statements.ts) — relay it close to verbatim; it
    // contains every amount, id and timeline the reply is allowed to state.
    statement: z.string().optional(),
  }),
  execute: withStatement(async ({ orderId, caseType, itemIds: rawItemIds }: { orderId: string; caseType?: "refund" | "delivery_dispute" | "plain_return"; itemIds?: string[] }, context: any) => {
    const sessionCustomerId = getSessionCustomerId(context);
    const order = getOrder(orderId);
    if (!order || order.customerId !== sessionCustomerId) return { found: false };
    markOrderTouched(context, order.id);

    // The model passes product NAMES (and sometimes invented codes) where real objectIDs belong —
    // resolve to real ones (resolveItemRefs). Refs given but none resolving means "no such item on
    // this order": say nothing was found, never quietly widen to the whole order, which could report
    // some OTHER item's case as this one's. (The money-moving tools stay strict and have their own
    // checks; this tool is read-only.)
    const itemIds = resolveItemRefs(order, rawItemIds);
    if (rawItemIds && rawItemIds.length > 0 && !itemIds) return { found: false };

    const mastraInstance = context.mastra;
    const workflow = mastraInstance?.getWorkflow("policyReviewWorkflow");
    if (!workflow) return { found: false };

    // caseType set means this is a pre-filing duplicate check, not a status follow-up —
    // scope to the SAME open issue only, exactly like the matching escalation tool's own
    // findOpenCasesForOrder guard (refund-policy-gate.ts / delivery-dispute.ts),
    // so a case about a different item (or a different caseType entirely) on the same
    // order never counts as a match here either. Without this, a caller that only knows
    // "some case is open on this order" can't tell a real duplicate from an unrelated one
    // — a live-reproduced regression: reporting a SECOND, different item on a multi-item
    // order was wrongly told the whole order already had an open case, because the
    // order-wide findMostRecentCaseRun below doesn't know about items or case type at all.
    // Checks EVERY open case, not just the most recent — an order can carry more than
    // one simultaneously-open case, and the real match might not be the newest one.
    let scopeItemIds = itemIds;
    if (caseType) {
      const openCases = await findOpenCasesForOrder(workflow, order.id);
      const openCase = openCases.find((match) => caseTypeOf(match) === caseType && (caseType === "delivery_dispute" || returnScopesOverlap(itemIdsOf(match), itemIds)));
      if (openCase) {
        const payload = openCase.step?.suspendPayload;
        return {
          found: true,
          status: "pending" as const,
          caseId: openCase.runId,
          awaitingCustomerReply: payload?.reasonCode === "awaiting-customer-response",
          ticketId: payload?.ticketId,
          contactWindowHours: payload?.ticketId ? getSupportTicketContactHours() : undefined,
        };
      }
      // Nothing OPEN — but an item whose refund was already APPROVED is just as "already covered"
      // (otherwise a second case opens for an already-refunded item). Report that
      // case through the item-scoped lookup below instead of answering "found: false", which the
      // caller reads as "go ahead and file". Disputes aren't item-scoped, so they skip this.
      if (caseType === "delivery_dispute") {
        // A dispute that is not open can still be a ticket or already decided — "found: false" would read as "go ahead and
        // file another". Same facts commerce_get_order reports.
        const prior = await describeDispute(workflow, order.id);
        if (prior?.state === "denied" || prior?.state === "approved") return { found: true, status: prior.state, caseId: prior.caseId, refundAmount: prior.refundAmount };
        if (prior?.state === "with_support") return { found: true, status: "unclear" as const, caseId: prior.caseId, ticketId: prior.ticketId, contactWindowHours: getSupportTicketContactHours() };
        return { found: false };
      }
      const covered = await alreadyRefundedItemIds(order.id);
      const overlap = (itemIds ?? order.items.map((item) => item.objectID)).filter((id) => covered.has(id));
      if (overlap.length === 0) return { found: false };
      scopeItemIds = overlap;
    }

    // No caseType but itemIds: "where do THESE items stand?" — the most recent case about them,
    // open or already decided, so a customer asking about the socks gets the socks' case even
    // when a newer case on the same order is about something else. Without itemIds this stays
    // order-wide, exactly as before.
    if (scopeItemIds && scopeItemIds.length > 0) {
      // A support ticket for these items is the CURRENT state of the matter whichever case it
      // hangs off (see findSupportTicketForItems) — it wins over any case's own outcome, the
      // same priority the order-wide path below already gives a disagreement ticket.
      const ticket = await findSupportTicketForItems(workflow, order.id, scopeItemIds);
      if (ticket) {
        return { found: true, status: "unclear" as const, caseId: ticket.caseId, ticketId: ticket.ticketId, contactWindowHours: getSupportTicketContactHours() };
      }
    }
    const match = scopeItemIds && scopeItemIds.length > 0 ? await findMostRecentCaseForItems(workflow, order.id, scopeItemIds) : await findMostRecentCaseRun(workflow, order.id);
    if (!match) return { found: false };
    const { step } = match;

    // A case can only ever pick up a disagreement ticket AFTER it's resolved (the
    // route that creates one, server.ts's /chat/:agentId/escalate-disagreement,
    // requires findMostRecentResolvedCaseForConversation to find something first) —
    // so this only needs checking once the case is no longer suspended, and it takes
    // priority over that resolution's own outcome below: the ticket is the CURRENT
    // state of the matter, the original approve/deny is superseded history. Without
    // this, a customer who disagreed and escalated, then came back later to ask for a
    // status update, got the agent re-reciting the stale original outcome — see
    // mastra/disagreement-tickets.ts's own header comment for the live-reproduced bug.
    if (step.status === "success") {
      const disagreementTicket = await getDisagreementTicket(match.runId);
      if (disagreementTicket) {
        return {
          found: true,
          status: "unclear" as const,
          caseId: match.runId,
          ticketId: disagreementTicket.ticketId,
          contactWindowHours: getSupportTicketContactHours(),
        };
      }
    }

    if (step.status === "suspended") {
      const payload = step.suspendPayload;
      return {
        found: true,
        status: "pending" as const,
        caseId: match.runId,
        awaitingCustomerReply: payload?.reasonCode === "awaiting-customer-response",
        ticketId: payload?.ticketId,
        contactWindowHours: payload?.ticketId ? getSupportTicketContactHours() : undefined,
      };
    }
    if (step.status === "success" && step.output?.action === "executed" && (step.output.detail?.status === "approved" || step.output.detail?.status === "issued")) {
      return { found: true, status: "approved" as const, caseId: match.runId, refundAmount: step.output.detail?.amount };
    }
    if (step.status === "success" && step.output?.action === "denied") {
      return { found: true, status: "denied" as const, caseId: match.runId, reason: step.output.detail?.reason };
    }
    // A resolved-via-auto-ticket case (an SLA timeout, or a rep's own "escalate to
    // support" decision) previously fell into the generic "unclear" branch below with
    // no ticketId at all — a real, separate gap from the missing-reason one this same
    // pass fixed: a customer asking about a case that's ALREADY been ticketed got the
    // same vague non-answer as one that genuinely errored out. Reuses the exact same
    // ticketId/contactWindowHours fields the "pending" branches above already return,
    // rather than adding a new status value — wismo-agent.ts's own instructions for
    // "if ticketId is set, say a support ticket is already open" apply identically
    // whether the case is still open or has already resolved that way.
    if (step.status === "success" && step.output?.action === "escalated_to_support") {
      const ticketId = step.output.detail?.ticketId as string | undefined;
      return {
        found: true,
        status: "unclear" as const,
        caseId: match.runId,
        ticketId,
        contactWindowHours: ticketId ? getSupportTicketContactHours() : undefined,
      };
    }
    // The remaining fallback ("error" — e.g. issueRefund's own internal guard refused
    // a second refund attempt on an already-covered item) previously reported ONLY
    // `status: "unclear"` with no other information at all — live-reported gap: the
    // model, with nothing real to relay, invented a plausible-sounding but FALSE
    // narrative ("there's already a case open being reviewed by a specialist") for a
    // case that had actually already resolved, just not as a clean approve/deny.
    // Surfacing the real reason here (the same field "denied" above already returns)
    // gives it something true to relay instead.
    return { found: true, status: "unclear" as const, caseId: match.runId, reason: step.output?.detail?.reason };
  }),
});
