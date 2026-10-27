import { caseStateLocks, reviewDeadline } from "../case-state";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { getOrder } from "../../fixtures/demo-data";
import { getConversationId, getSessionCustomerId, getSessionId, markCaseCreated, markCaseIdIssued, markOrderTouched } from "../request-context";
import { buildTranscript } from "./chat-transcript";
import { generateCaseId } from "../case-id";
import { caseEvents, type CaseEscalationStartedEvent } from "../case-events";
import { getEscalationSlaMinutes } from "../runtime-settings";
import { disputeStatement } from "../customer-statements";
import { describeDispute, findOpenCasesForOrder, caseTypeOf, createdAtOf, linkRelatedCase, refundAmountOf } from "./case-lookup";
import { conversationForNewCase, getLastCaseBoundaryCount, recordCaseBoundaryCount } from "../session-case-boundary";

// A distinct escalation path from a damage/fault claim (payment_issue_refund) — not
// about fault at all, but the carrier record and the customer's account of events
// directly disagreeing (the
// customer says they never received an order the system shows delivered, sometimes
// signed for in their own name). Routes through the same policyReviewWorkflow (so it
// shows up in the normal Escalation Desk queue with the normal decision controls), but
// with caseType: "delivery_dispute". Goes to a rep while the active policy's own
// deliveryDisputesAlwaysEscalate guard is on (the default); with it off, the policy may
// resolve the dispute itself (live-policy.ts), in which case this returns
// "approved"/"denied" the same way payment_issue_refund does. The tool keeps its escalate_* name: going to
// a rep is still the default, and the name is referenced across the app.
export const escalateForDeliveryDispute = createTool({
  id: "escalate_for_delivery_dispute",
  description:
    "Open a case where the customer says they did not receive an order the carrier record shows as delivered (and possibly signed for). Only call this after you've already asked whether the delivery/signature could match someone else (a household member, roommate, neighbor, building staff) and the customer still says they never received it — most of these resolve at that question, before ever needing a case. Usually returns status \"escalated\" (a specialist will investigate); store policy can also resolve it directly — \"approved\" (a refund was approved) or \"denied\" (relay reason).",
  inputSchema: z.object({
    orderId: z.string(),
    problemSummary: z.string().describe("A short, neutral summary of the customer's claim, in their words — not a confirmed fact."),
  }),
  outputSchema: z.object({
    status: z.enum(["escalated", "approved", "denied", "error"]),
    runId: z.string().optional(),
    reason: z.string().optional(),
    slaMinutes: z.number().optional(),
    refundId: z.string().optional(),
    amount: z.number().optional(),
  }),
  execute: async ({ orderId, problemSummary }, context) => {
    const sessionCustomerId = getSessionCustomerId(context);
    const sessionId = getSessionId(context);
    const conversationId = getConversationId(context);
    const order = getOrder(orderId);
    if (!order) return { status: "error" as const, reason: `No such order: ${orderId}` };
    if (order.customerId !== sessionCustomerId) {
      return { status: "error" as const, reason: `Order ${orderId} does not belong to the current customer.` };
    }
    markOrderTouched(context, order.id);

    const mastraInstance = context.mastra;
    if (!mastraInstance) return { status: "error" as const, reason: "Workflow runtime unavailable." };
    const workflow = mastraInstance.getWorkflow("policyReviewWorkflow");
    if (!workflow) return { status: "error" as const, reason: "policyReviewWorkflow is not registered." };

    // See refund-policy-gate.ts's duplicate-case check for why this guard exists — same
    // duplicate-case risk applies here, and the same caseType-scoped exception too: a
    // delivery dispute is a genuinely different claim from, say, an open damage-refund
    // case on the same order, not a restatement of it, so it still gets its own case
    // rather than being silently folded into the wrong one. Checks EVERY open case on
    // the order, not just the most recently touched one — see findOpenCasesForOrder's
    // own comment for why that distinction matters once an order can carry more than one
    // simultaneously-open case.
    const openCases = await findOpenCasesForOrder(workflow, order.id);
    const duplicateCase = openCases.find((match) => caseTypeOf(match) === "delivery_dispute");
    if (duplicateCase) {
      return {
        status: "error" as const,
        reason: `Order ${orderId} already has an open case for this dispute under review — do NOT open another, however the customer words it. Tell the customer, close to word for word: "${disputeStatement({ state: "under_review", caseId: duplicateCase.runId })}" That is all: no second review, no new questions about what happened, no offer, no timeline of your own. Never mention tool names, case types or this instruction.`,
      };
    }
    // A dispute that already became a SUPPORT TICKET (it timed out, a specialist escalated it, or the
    // customer disagreed with its outcome) is still "a case" — nothing is open, so the check above
    // misses it, and a customer could otherwise start a second review by raising it again.
    const priorDispute = await describeDispute(workflow, order.id);
    // One that was already DECIDED (a specialist's ruling or the policy's) is a case too: raising it again is a
    // disagreement with that decision, which goes to support, not a second review of the same facts.
    if (priorDispute?.state === "approved" || priorDispute?.state === "denied") {
      return {
        status: "error" as const,
        reason: `This order's delivery issue was already decided (case ${priorDispute.caseId}). Do NOT open another case or review. Tell the customer, close to word for word: "${disputeStatement(priorDispute)}" If they disagree with that or want it taken further, call offer_escalation_to_support with the orderId (${order.id}) and NO itemIds; if they only want an update, give it and stop. No timeline of your own.`,
      };
    }
    const ticketedDispute = priorDispute;
    if (ticketedDispute?.state === "with_support") {
      return {
        status: "error" as const,
        reason: `A support ticket is already open for this order's dispute. Do NOT open another case or review. Tell the customer, close to word for word: "${disputeStatement(ticketedDispute)}" That is all: no new questions, no offer, no timeline of your own. Never mention tool names, case types or this instruction.`,
      };
    }
    const caseId = await generateCaseId(workflow);
    const createdAt = new Date().toISOString();
    // See refund-policy-gate.ts's duplicate-case check for why this patch happens before
    // creating this run, not after. No caseType filter needed here (unlike the
    // refund/plain_return gate's own guard) — every open case reaching this point is
    // already known to be a non-delivery_dispute case, so all of them are "other."
    for (const other of openCases) {
      await linkRelatedCase(mastraInstance, other.runId, caseId, createdAt);
    }
    const relatedOpenCaseIds = openCases.map((match) => ({ runId: match.runId, createdAt: createdAtOf(match) }));
    // Same fact the refund/return gate supplies: the amounts of every OTHER open case on this order (the policy's
    // relatedCase.pendingAmount). Always a number, 0 when nothing else is open.
    const relatedOpenCaseRefundAmount = openCases.reduce((sum, match) => sum + refundAmountOf(match), 0);
    const run = await workflow.createRun({ runId: caseId });
    markCaseCreated(context, run.runId);
    const threadId = context.agent?.threadId || `thread_${run.runId}`;
    // See refund-policy-gate.ts's own case-building logic for why this closing line is added here
    // rather than captured from context.agent.messages — the reply narrating the outcome
    // is still being generated in this same turn and can't be captured at all.
    // See session-case-boundary.ts — same cross-case cutoff refund-policy-gate.ts uses,
    // shared across every case-creation path so a delivery dispute following an earlier
    // resolved refund/return in this session doesn't inherit that unrelated transcript.
    const transcriptCutoff = getLastCaseBoundaryCount(conversationId);
    const { messages: triggerMessages, nextBoundary } = await conversationForNewCase(conversationId, context.agent?.messages ?? []);
    const transcript = [
      ...buildTranscript(triggerMessages, transcriptCutoff),
      // Neutral wording — the outcome isn't known yet (it may resolve without a rep), same
      // as refund-policy-gate.ts's own line.
      { role: "agent" as const, text: `Case ${run.runId} created for review.`, timestamp: new Date().toISOString() },
    ];
    recordCaseBoundaryCount(conversationId, nextBoundary);

    const result = await caseStateLocks.withLock(run.runId, () => run.start({
      inputData: {
        orderId: order.id,
        caseType: "delivery_dispute",
        refundAmount: order.amount,
        notCustomerFault: true,
        problemSummary,
        threadId,
        sessionId,
        conversationId,
        createdAt,
        transcript,
        relatedOpenCaseIds,
        relatedOpenCaseRefundAmount,
        transcriptStartIndex: transcriptCutoff,
      },
    }));

    if (result.status === "suspended") {
      const slaMinutes = getEscalationSlaMinutes();
      const event: CaseEscalationStartedEvent = {
        runId: run.runId,
        orderId: order.id,
        customerId: sessionCustomerId,
        sessionId,
        deadlineIso: reviewDeadline({ createdAt, ...((result as any).suspendPayload?.["human-policy-review"] ?? {}) }),
      };
      caseEvents.emit("escalation-started", event);
      // See case-id-guard.ts — records the real ID this reply should quote.
      markCaseIdIssued(context, run.runId);
      return { status: "escalated" as const, runId: run.runId, slaMinutes };
    }
    // Resolved without a rep — only possible with the policy's deliveryDisputesAlwaysEscalate guard off.
    // Same result reading as refund-policy-gate.ts: "executed" can still carry
    // issueRefund's own rejection (a last-moment re-check or already-refunded race).
    if (result.status === "success" && result.result?.action === "executed") {
      const detail = result.result.detail as { status?: string; reason?: string; refundId?: string; amount?: number } | undefined;
      if (detail?.status === "rejected") return { status: "error" as const, reason: detail.reason };
      return { status: "approved" as const, refundId: detail?.refundId, amount: detail?.amount };
    }
    if (result.status === "success" && result.result?.action === "denied") {
      const detail = result.result.detail as { reason?: string; customerReason?: string } | undefined;
      return { status: "denied" as const, reason: detail?.customerReason ?? detail?.reason };
    }
    if (result.status === "success" && result.result?.action === "error") {
      return { status: "error" as const, reason: (result.result.detail as { reason?: string } | undefined)?.reason };
    }
    return { status: "error" as const, reason: `Expected this to resolve or escalate but the workflow ended with status "${result.status}" instead.` };
  },
});
