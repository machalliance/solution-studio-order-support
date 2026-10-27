import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { getSessionCustomerId, markOrderTouched } from "../request-context";
import { findCaseForCustomer } from "./case-lookup";
import { getSupportTicketContactHours } from "../runtime-settings";
import { getDisagreementTicket } from "../disagreement-tickets";

// check_escalation_status keys off orderId — the right lookup when the agent already
// knows which order is under discussion. This covers the
// other direction: the customer volunteers a case number directly ("what's happening
// with my case?"), with no order mentioned at all. Since the case ID IS the workflow's
// own runId (see case-id.ts — createRun({ runId }) makes the short code the real
// identifier, not a separate lookup key), this is a direct getWorkflowRunById(), not a
// search. The existence + ownership check itself lives in case-lookup.ts's
// findCaseForCustomer (shared with case-id-guard.ts — see its comment for why ownership is
// re-derived from the real order rather than read off the workflow payload).
export const lookupCaseById = createTool({
  id: "lookup_case_by_id",
  description:
    "Look up a case by its case ID when the customer gives you one directly (\"what's happening with my case <their ID>\") instead of, or in addition to, an order number. Returns the order it belongs to and its status, so you can follow up the same way you would after check_escalation_status. Only works for a case that belongs to the current customer.",
  inputSchema: z.object({ caseId: z.string().describe("The case ID exactly as the customer gave it — six letters and digits. Never guess or fill one in yourself.") }),
  outputSchema: z.object({
    found: z.boolean(),
    orderId: z.string().optional(),
    status: z.enum(["pending", "approved", "denied", "unclear"]).optional(),
    refundAmount: z.number().optional(),
    reason: z.string().optional(),
    // Same fields, same meaning as check_escalation_status's own (see that tool's
    // comment) — a resolved case can pick up a disagreement ticket AFTER the fact, and
    // this tool needs to surface it too, not just the order-keyed lookup.
    ticketId: z.string().optional(),
    contactWindowHours: z.number().optional(),
    // Only meaningful for a pending case: it is waiting on the customer's reply to the specialist's question,
    // not on the specialist (same field as check_escalation_status).
    awaitingCustomerReply: z.boolean().optional(),
  }),
  execute: async ({ caseId }, context) => {
    const sessionCustomerId = getSessionCustomerId(context);
    const workflow = context.mastra?.getWorkflow("policyReviewWorkflow");
    if (!workflow) return { found: false };

    // Case IDs aren't case-sensitive to the customer typing them back — normalize the
    // same way order IDs already are (demo-data.ts's normalizeOrderId). Case IDs are
    // always generated uppercase (case-id.ts's ALPHABET), so this normalized form is
    // also the exact key any disagreement ticket for this case would be recorded under.
    const normalizedCaseId = caseId.trim().toUpperCase();
    const found = await findCaseForCustomer(workflow, normalizedCaseId, sessionCustomerId);
    if (!found) return { found: false };
    const { step, orderId, order } = found;
    markOrderTouched(context, order.id);

    // Takes priority over the resolution's own outcome below — see
    // check_escalation_status's identical check for the full reasoning (the ticket is
    // the CURRENT state of the matter once the customer has disagreed with it).
    if (step.status === "success") {
      const disagreementTicket = await getDisagreementTicket(normalizedCaseId);
      if (disagreementTicket) {
        return { found: true, orderId, status: "unclear" as const, ticketId: disagreementTicket.ticketId, contactWindowHours: getSupportTicketContactHours() };
      }
    }

    // The three results below carry the same fields, with the same meaning, as check_escalation_status's
    // equivalents (escalation-status.ts) — a customer reaches a case by its number or by its order, and must
    // be told the same thing either way. This lookup once answered
    // a case that ended as "escalated to support" with a bare "unclear", dropping the ticket it had opened,
    // and a pending case without saying it was waiting on the customer.
    if (step.status === "suspended") {
      const payload = step.suspendPayload;
      return {
        found: true,
        orderId,
        status: "pending" as const,
        awaitingCustomerReply: payload?.reasonCode === "awaiting-customer-response",
        ticketId: payload?.ticketId,
        contactWindowHours: payload?.ticketId ? getSupportTicketContactHours() : undefined,
      };
    }
    if (step.status === "success" && step.output?.action === "executed" && (step.output.detail?.status === "approved" || step.output.detail?.status === "issued")) {
      return { found: true, orderId, status: "approved" as const, refundAmount: step.output.detail?.amount };
    }
    if (step.status === "success" && step.output?.action === "denied") {
      return { found: true, orderId, status: "denied" as const, reason: step.output.detail?.reason };
    }
    // Resolved by an SLA timeout or a rep's own "escalate to support": the support ticket is the matter's state.
    if (step.status === "success" && step.output?.action === "escalated_to_support") {
      const ticketId = step.output.detail?.ticketId as string | undefined;
      return { found: true, orderId, status: "unclear" as const, ticketId, contactWindowHours: ticketId ? getSupportTicketContactHours() : undefined };
    }
    return { found: true, orderId, status: "unclear" as const };
  },
});
