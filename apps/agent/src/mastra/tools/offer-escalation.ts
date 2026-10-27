import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { getConversationId, getSessionCustomerId } from "../request-context";
import { caseTypeOf, findCasesForItems, findDecidedDisputes, findMostRecentResolvedCaseForConversation, findSupportTicketForItems, readCaseRunsOnce, resolveItemRefs } from "./case-lookup";
import { getOrder } from "../../fixtures/demo-data";
import { getDisagreementTicket } from "../disagreement-tickets";
import { caseStatusStatement } from "../customer-statements";

// The customer-initiated half of "Escalate to support" (the Escalation Desk's own
// rep-initiated version lives at POST /escalations/:runId/resume): a customer who
// disagrees with a decision can be offered a guaranteed path to a human. The model sees
// and reacts to the disagreement directly and naturally, and this tool simply offers
// that path alongside its own reply, as its own tool call. (An earlier design had a
// separate classifier intercept the message before the model saw it; the model then
// inherited a history containing a customer message it never processed, and got
// visibly confused. Letting the model see the disagreement itself is what fixed that.)
// Same "silent, the card speaks for itself" pattern as present_return_item_picker/
// commerce_list_orders_for_customer; call this INSTEAD of respond_to_customer for this
// turn, never alongside it.
//
// Deliberately does NOT create the support ticket itself — clicking the card's own
// "Escalate to support" button (ChatWidget.tsx) calls the existing, already-proven
// POST /chat/:agentId/escalate-disagreement route directly, exactly as it did
// before this tool existed. This tool's only job is deciding whether to OFFER the
// card at all (and rendering it) — the actual ticket-creation path, its idempotency
// guard, and its own re-derivation of "is there really a resolved case to disagree
// with" are all completely unchanged.
export const offerEscalationToSupport = createTool({
  id: "offer_escalation_to_support",
  description:
    "Render a card offering to escalate the customer's disagreement to a human specialist. Call this INSTEAD of respond_to_customer for this turn, never alongside it, when the customer clearly REJECTS or disagrees with an already-resolved decision (not just asking a clarifying question about it) and there's no tool available to change that outcome yourself. The decision can be from this conversation OR an earlier one: when the customer is asking about specific item(s) whose refund was decided before, pass orderId and itemIds so the right case is found. It refuses (with the ticket's details) if a support ticket is already open for that case — in that case don't offer anything; just tell the customer the ticket id and when they'll hear back. A question about the resolution (\"why was this denied?\", \"how did you get to that number?\") is not a disagreement — answer it directly instead.",
  inputSchema: z.object({
    orderId: z.string().optional().describe("The order the decision was about — pass it (with itemIds) when the decision was made in an EARLIER conversation, so the right case is found. Omit it for a decision made in this conversation."),
    itemIds: z.array(z.string()).optional().describe("The objectID of each item the decision was about, when you know them. Omit for a whole-order matter."),
    message: z
      .string()
      .describe(
        'A short, warm, empathetic acknowledgment plus the offer — e.g. "I understand this isn\'t the outcome you wanted. I can escalate this to our support team for a closer look, if you\'d like." Never state exact policy numbers or thresholds, and never promise a specific outcome from the escalation.'
      ),
  }),
  // caseId: the decided case this card would escalate — the card sends it back with the click
  // (see ChatWidget.tsx's OfferEscalation / the escalate-disagreement route), which is what lets a
  // decision from an EARLIER conversation be escalated at all; the route re-validates it (it
  // belongs to this customer and is resolved) and never trusts it.
  outputSchema: z.object({ message: z.string(), caseId: z.string() }),
  execute: async ({ message, orderId, itemIds }, context) => {
    const workflow = context.mastra?.getWorkflow("policyReviewWorkflow");
    if (!workflow) throw new Error("Don't offer to escalate — nothing to look up. Just answer the customer directly instead.");

    // A support ticket already open for this is the end of the road: the customer is told about it,
    // not offered a second one (and the route would only hand back the same ticket anyway).
    const alreadyTicketed = (ticketId: string, caseId: string) =>
      new Error(`A support ticket is already open for this — do NOT offer escalation. Tell the customer, close to word for word: "${caseStatusStatement({ ticketId, caseId })}" Create nothing new, and add no timeline of your own.`);

    if (orderId) {
      const order = getOrder(orderId);
      if (!order || order.customerId !== getSessionCustomerId(context)) {
        throw new Error("Don't offer to escalate — no such order for this customer. Just answer the customer directly instead.");
      }
      // Only an OMITTED selection means the whole order. References that were given but match nothing on
      // this order are an error — falling back to every item would offer to escalate some OTHER item's
      // decided case. Same rule as check_escalation_status.
      const resolved = resolveItemRefs(order, itemIds);
      if (itemIds && itemIds.length > 0 && !resolved) {
        throw new Error("Don't offer to escalate — none of those item references match an item on this order. Ask the customer which item they mean, or answer directly instead.");
      }
      const ids = resolved ?? order.items.map((item) => item.objectID);
      const runs = await readCaseRunsOnce(workflow); // the three lookups below all ask of the same runs
      const ticket = await findSupportTicketForItems(runs, order.id, ids);
      if (ticket) throw alreadyTicketed(ticket.ticketId, ticket.caseId);
      // A delivery dispute is about the whole order, so it is a candidate only when the customer did not name items:
      // the newest decided matter wins, and if that is a dispute that already has a ticket, the customer is told so.
      const candidates = (await findCasesForItems(runs, order.id, ids)).filter((match) => match.step?.status === "success");
      if (!itemIds || itemIds.length === 0) candidates.push(...(await findDecidedDisputes(runs, order.id)));
      candidates.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
      const decided = candidates[0];
      if (decided && caseTypeOf(decided) === "delivery_dispute") {
        const existing = await getDisagreementTicket(decided.runId);
        const resolvedTicket = decided.step?.output?.action === "escalated_to_support" ? (decided.step.output.detail?.ticketId as string | undefined) : undefined;
        const ticketId = existing?.ticketId ?? resolvedTicket;
        if (ticketId) throw alreadyTicketed(ticketId, decided.runId);
      }
      if (!decided) {
        throw new Error("Don't offer to escalate — there's no decided case for those item(s) to disagree with. If a case is still with a specialist, tell the customer that instead.");
      }
      return { message, caseId: decided.runId };
    }

    const match = await findMostRecentResolvedCaseForConversation(workflow, getConversationId(context));
    if (!match) {
      throw new Error("Don't offer to escalate — there's no resolved case in this conversation to disagree with. If the matter was decided in an EARLIER conversation, call this again with orderId and itemIds. Otherwise just answer the customer directly instead.");
    }
    const existing = await getDisagreementTicket(match.runId);
    if (existing) throw alreadyTicketed(existing.ticketId, match.runId);
    const resolvedTicket = match.step?.output?.action === "escalated_to_support" ? (match.step.output.detail?.ticketId as string | undefined) : undefined;
    if (resolvedTicket) throw alreadyTicketed(resolvedTicket, match.runId);
    return { message, caseId: match.runId };
  },
});
