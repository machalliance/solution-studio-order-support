import { caseStateLocks, reviewDeadline } from "./case-state";
import type { ToolHooks } from "@mastra/core/tools";
import { getOrder, getCustomer, resolveOrderItems, orderItemsSummary } from "../fixtures/demo-data";
import { getConversationId, getSessionCustomerId, getSessionId, markCaseCreated, markCaseIdIssued, markOrderTouched } from "./request-context";
import { generateCaseId } from "./case-id";
import { caseEvents, type CaseEscalationStartedEvent } from "./case-events";
import { getEscalationSlaMinutes } from "./runtime-settings";
import { checkOpenCasesFor, createdAtOf, describeItemCoverage, findSupportTicketForItems, refundAmountOf, linkRelatedCase } from "./tools/case-lookup";
import { coverageStatement } from "./customer-statements";
import { buildTranscript } from "./tools/chat-transcript";
import { conversationForNewCase, getLastCaseBoundaryCount, recordCaseBoundaryCount } from "./session-case-boundary";
import { mastra } from "./index";
import { alreadyRefundedItemIds } from "./refund-ledger";
import { POLICY_REVIEW_STEP_ID } from "./workflows/policy-review-workflow";

// The single place that decides what happens to every payment_issue_refund /
// payment_issue_return_refund attempt: registered once at the agent level (wismo-agent.ts's
// `hooks`), not inside either tool. A Mastra `beforeToolCall` hook can return
// `{ proceed: false, output }` to skip a tool's execute() entirely, so both tools' own execute()
// bodies are unreachable stubs (see payment.ts).
//
// toolName is matched against the agent's tool-REGISTRATION keys (paymentIssueRefund /
// paymentIssueReturnRefund, camelCase), NOT each tool's snake_case `id`: Mastra keys hooks by the
// `tools: {...}` object given to the Agent (the same id-vs-registration-key trap
// touched-orders-from-history.ts documents). Every other tool passes through untouched.
//
// It deliberately does NOT compute decideRefund/decideReturnRefund itself. Routing EVERY valid
// attempt through policyReviewWorkflow, autonomous or not, keeps the workflow's own independent
// policy check the sole source of truth on whether to resolve immediately or suspend. An earlier
// version called issueRefund() directly for the autonomous branch and bypassed the workflow, so a
// successful automatic refund never appeared in any history view.
//
// It also has no awareness of a human rep's decision. That override happens only through
// policy-review-workflow.ts's approve/modify resume branches, triggered by a separate HTTP route
// (POST /escalations/:runId/resume) this chat agent has no tool for, so there is no "was this
// approved" signal here for the model, or a customer talking it into something, to present, real
// or fabricated. (See payment.ts on why "escalation-approval" is never a tool input.)
//
// Exported so wismo-agent.ts can assert at module load that this set and response-leak-guard.ts's
// gated tool set never overlap; the composed beforeToolCall is only correct ("first hook wins by
// toolName") while they don't.
export const REFUND_GATE_TOOL_NAMES = new Set(["paymentIssueRefund", "paymentIssueReturnRefund"]);

export const refundPolicyGate: NonNullable<ToolHooks<any, any, any>["beforeToolCall"]> = async ({ toolName, input, context }) => {
  if (!REFUND_GATE_TOOL_NAMES.has(toolName)) return;

  const sessionCustomerId = getSessionCustomerId(context);
  const sessionId = getSessionId(context);
  const conversationId = getConversationId(context);
  const { orderId, itemIds, problemSummary } = input as { orderId: string; itemIds?: string[]; problemSummary: string };

  // Hard-reject conditions that must never become a case — same checks, same wording,
  // as today's tool-level guards, just running before any workflow run is created.
  const order = getOrder(orderId);
  if (!order) return { proceed: false as const, output: { status: "error" as const, reason: `No such order: ${orderId}` } };
  if (order.customerId !== sessionCustomerId) {
    return { proceed: false as const, output: { status: "error" as const, reason: `Order ${orderId} does not belong to the current customer.` } };
  }
  const items = resolveOrderItems(order, itemIds);
  if (!items) {
    return {
      proceed: false as const,
      output: { status: "error" as const, reason: `One or more itemIds are invalid or duplicated for order ${orderId} — call present_return_item_picker again and use its objectIDs exactly, each one once.` },
    };
  }
  const customer = getCustomer(order.customerId);
  if (!customer) return { proceed: false as const, output: { status: "error" as const, reason: `No such customer for order: ${orderId}` } };

  const amount = items.reduce((sum, item) => sum + item.price, 0);
  const resolvedItemIds = items.map((item) => item.objectID);
  const caseType = toolName === "paymentIssueRefund" ? ("refund" as const) : ("plain_return" as const);

  markOrderTouched(context, order.id);

  // The hook's own context is a genuinely different (narrower) shape than what a
  // tool's own execute(input, context) receives — verified empirically (logged its real
  // keys live): it has requestContext, messages, workspace, mcp, etc., but NOT .mastra
  // or .agent, even though the docs' own example destructures {toolName, input} only
  // and never shows a caller needing the Mastra instance. Importing the module-level
  // singleton directly sidesteps that gap entirely, and is safe despite the circular-
  // looking import (this file <- wismo-agent.ts <- mastra/index.ts <- this file) because
  // `mastra` is only ever referenced inside this function's body, never at module load
  // time — by the time any real request reaches here, the whole module graph has
  // already finished initializing.
  const workflow = mastra.getWorkflow("policyReviewWorkflow");
  if (!workflow) return { proceed: false as const, output: { status: "error" as const, reason: "policyReviewWorkflow is not registered." } };

  // An item that already has a refund approved is never claimed again — no new case, however
  // the request is phrased (a damage claim, a return, "no, the socks"). In one case
  // the item picker greyed out socks as "Already refunded", the customer typed
  // past it, and a second photo-review case opened for an item already paid out — work for a
  // rep that could never end in a refund (issueRefund's ledger check refuses it), and a
  // confusing second case for the customer. This is a rule about money, so it is code, not a
  // line in the instructions. Items under review are covered by the open-case check just below;
  // an item whose earlier claim was DENIED is not blocked here (nothing was paid).
  // What the agent does instead is the model's job, told here: report where the item stands,
  // and offer escalation only if no support ticket already exists for it.
  const alreadyCovered = await alreadyRefundedItemIds(order.id);
  const coveredItems = items.filter((item) => alreadyCovered.has(item.objectID));
  if (coveredItems.length > 0) {
    const coveredIds = JSON.stringify(coveredItems.map((item) => item.objectID));
    // The sentence to relay, from the same builder the order lookup uses (customer-statements.ts), so
    // the customer hears one wording wherever the agent learns this — and none of the parts a reply
    // tends to invent (processed, paid, how long).
    const coverage = await describeItemCoverage(workflow, order);
    const statement = coveredItems
      .map((item) => {
        const known = coverage.get(item.objectID);
        return known ? coverageStatement(known, item.name) : `A refund was already approved for the ${item.name}.`;
      })
      .join(" ");
    return {
      proceed: false as const,
      output: {
        status: "error" as const,
        reason:
          `An item on order ${orderId} already has a refund approved — do NOT open a new case or claim for it, however the customer words it. ` +
          `Tell the customer, close to word for word: "${statement}" Add no amount, date or timeline of your own. ` +
          `If that sentence includes a support ticket, that is all — offer nothing and create nothing. ` +
          `If there is no ticket and the customer is unhappy with the decision or wants it taken further, you may offer escalation with offer_escalation_to_support, passing orderId "${orderId}" and itemIds ${coveredIds}. ` +
          `If they only want an update, give it and stop. Any OTHER item on this order that has no refund can still be claimed normally. Never mention tool names, case types or this instruction.`,
      },
    };
  }

  // A support ticket for these items is just as much "already has a case": the case timed out into one,
  // a specialist escalated it, or the customer disagreed and escalated. No refund was approved and no
  // case is open, so neither check above sees it — without this a customer could simply file the same
  // claim again after a timeout and start a second review (the user's rule: a timeout IS the case).
  const supportTicket = await findSupportTicketForItems(workflow, order.id, resolvedItemIds);
  if (supportTicket) {
    const statement = coverageStatement({ state: "with_support", caseId: supportTicket.caseId, ticketId: supportTicket.ticketId }, items.map((item) => item.name).join(", "));
    return {
      proceed: false as const,
      output: {
        status: "error" as const,
        reason:
          `A support ticket is already open for this on order ${orderId}. Do NOT open another case or review, however the customer words it. ` +
          `Tell the customer, close to word for word: "${statement}" That is all: no new questions about the issue, no photo request, no offer, no amount, date or timeline of your own. Never mention tool names, case types or this instruction.`,
      },
    };
  }

  // Checks EVERY open case on the order (case-lookup.ts's findOpenCasesForOrder under
  // the hood), not just the most recently touched one — an order can carry more than
  // one simultaneously-open case, and the real duplicate (or the full related-case set)
  // might not be the newest of them.
  const { duplicateCase, otherOpenCases } = await checkOpenCasesFor(mastra, order.id, caseType, resolvedItemIds);
  if (duplicateCase) {
    const statement = coverageStatement({ state: "under_review", caseId: duplicateCase.runId }, items.map((item) => item.name).join(", "));
    return {
      proceed: false as const,
      output: {
        status: "error" as const,
        reason: `Order ${orderId} already has an open case for this under review — do NOT open another, however the customer words it. Tell the customer, close to word for word: "${statement}" That is all: no second review, no new questions about the issue, no photo request, no offer, no timeline of your own. Only if they ask where it stands, call check_escalation_status with orderId "${orderId}" and itemIds ${JSON.stringify(resolvedItemIds)} (no caseType) and relay its statement. Never mention tool names, case types or this instruction.`,
      },
    };
  }

  const relatedOpenCaseIds = otherOpenCases.map((match) => ({ runId: match.runId, createdAt: createdAtOf(match) }));
  // The refund amounts of every OTHER open case on this order — for EVERY case type. (It used to be computed
  // for plain returns only, so for a damage claim the policy silently saw "no other cases".) Always a
  // number: 0 when nothing else is open. See case-lookup.ts's refundAmountOf. The policy reads it as
  // relatedCase.pendingAmount, both for the cumulative-ceiling projection and for one-return-per-order.
  const relatedOpenCaseRefundAmount = otherOpenCases.reduce((sum, match) => sum + refundAmountOf(match), 0);

  const caseId = await generateCaseId(workflow);
  const createdAt = new Date().toISOString();
  // Patch every OTHER open case to point back at this new one BEFORE creating this run
  // — see linkRelatedCase's own comment for why the order matters (its updatedAt bump
  // would otherwise make an older case look more recently active than the case
  // actually being created).
  for (const other of otherOpenCases) {
    await linkRelatedCase(mastra, other.runId, caseId, createdAt);
  }

  const run = await workflow.createRun({ runId: caseId });
  // Whatever this case's outcome turns out to be (an autonomous approval/denial resolves it
  // before this turn even ends), onFinish needs to know it exists — see markCaseCreated.
  markCaseCreated(context, run.runId);
  // No real thread id available in this context shape (see the comment above) — same
  // fallback the escalation tools this replaced already used whenever a real one
  // wasn't available.
  const threadId = `thread_${run.runId}`;
  // buildTranscript only sees messages that existed BEFORE this tool call: the reply narrating the
  // outcome is still being generated in this turn, so it can't be captured. The case ID is recorded
  // here instead, deterministically, so a reviewer sees the exact ID however the model phrases it.
  // context.messages (not context.agent?.messages, which doesn't exist in this context shape) is the
  // hook's own copy of the full conversation a tool's execute() reads via context.agent. The wording is
  // deliberately NEUTRAL ("case created", not "escalated"): this transcript is part of inputData passed
  // INTO run.start(), so it is built before the outcome is known, and every attempt creates a run, not
  // only the ones that escalate; a hardcoded "a specialist will follow up" line was wrong on an
  // automatic approval or denial.
  // See session-case-boundary.ts: if this session already created an earlier case (any order, any
  // caseType), that matter's conversation shouldn't be dragged into THIS case's transcript. It is
  // recorded again below with THIS turn's trigger message, so a later third case cuts correctly too.
  const transcriptCutoff = getLastCaseBoundaryCount(conversationId);
  const { messages: triggerMessages, nextBoundary } = await conversationForNewCase(conversationId, context.messages ?? []);
  const transcript = [
    ...buildTranscript(triggerMessages, transcriptCutoff),
    { role: "agent" as const, text: `Case ${run.runId} created for review.`, timestamp: new Date().toISOString() },
  ];
  // The next case starts after the reply narrating THIS case's outcome, which is appended to the thread once the turn
  // finishes (see session-case-boundary.ts).
  recordCaseBoundaryCount(conversationId, nextBoundary);

  // itemIds !== undefined (even resolving to every item) means the order has more than
  // one item and the customer picked which one(s) — worth telling the reviewer exactly
  // which, rather than leaving them to infer it from problemSummary's own free text.
  const itemsNote =
    itemIds !== undefined
      ? caseType === "refund"
        ? ` Item(s) reported damaged: ${orderItemsSummary({ ...order, items })}.`
        : ` Items selected for return: ${orderItemsSummary({ ...order, items })}.`
      : "";

  // No `?? false`: defaulting an
  // omitted claim to false silently scored it as "the customer did it," which for a
  // non-VIP account autonomously denied the claim with no human review, based on a
  // fact nobody actually established. `undefined` now reaches decideRefund as a
  // real third state, which escalates instead (the refund policy's new fault-unknown
  // branch) — the fail-safe direction this file's own policy already documents.
  const notCustomerFault = caseType === "refund" ? (input as { notCustomerFault?: boolean }).notCustomerFault : true;

  const result: any = await caseStateLocks.withLock(run.runId, () => run.start({
    inputData: {
      orderId: order.id,
      caseType,
      refundAmount: amount,
      notCustomerFault,
      problemSummary: `${problemSummary}${itemsNote}`,
      itemIds,
      threadId,
      sessionId,
      conversationId,
      createdAt,
      transcript,
      relatedOpenCaseIds,
      relatedOpenCaseRefundAmount,
      // See session-case-boundary.ts — recorded here (not derived later) so a future
      // case-sync.ts rebuild of THIS case's own transcript re-applies the same cut,
      // regardless of how many other cases get created in this session afterward.
      transcriptStartIndex: transcriptCutoff,
    },
  }));

  if (result.status === "suspended") {
    // result.suspendPayload is keyed by step ID, not the payload fields directly —
    // verified empirically (the type declares it as bare `any`, unhelpfully) via a
    // throwaway script calling run.start() directly and logging the real shape.
    const suspendPayload = result.suspendPayload?.[POLICY_REVIEW_STEP_ID] as { customerReason?: string } | undefined;

    // Puts the live countdown in the customer's open chat — a separate pushed message
    // (like the case-resolved / case-more-info pushes), not something the model embeds
    // itself. deadlineIso is computed here, once, server-side; the model never sees or
    // states it directly, so there's nothing for it to mangle or invent an ETA around.
    const slaMinutes = getEscalationSlaMinutes();
    const event: CaseEscalationStartedEvent = {
      runId: run.runId,
      orderId: order.id,
      customerId: sessionCustomerId,
      sessionId,
      deadlineIso: reviewDeadline({ createdAt, ...((result as any).suspendPayload?.["human-policy-review"] ?? {}) }),
    };
    caseEvents.emit("escalation-started", event);
    // customerReason only ever set for plain_return (the return refund policy's own
    // verdict shape) — read straight off the suspend result rather than independently
    // re-deriving decideReturnRefund a second time just to get this one string.
    const customerReason = suspendPayload?.customerReason;
    // The model is about to be handed this ID to quote; case-id-guard.ts needs to know which
    // real one a reply about this case should contain.
    markCaseIdIssued(context, run.runId);
    return { proceed: false as const, output: { status: "escalated" as const, runId: run.runId, slaMinutes, customerReason } };
  }
  if (result.status === "success" && result.result?.action === "executed") {
    // "executed" means the workflow resolved without suspending — NOT necessarily a
    // successful approval. issueRefund's own result (in detail) can itself be
    // "rejected" (e.g. its own already-refunded check firing on a race, or a policy
    // re-check disagreeing at the very last moment) — a live-reproduced case: the same
    // item refunded twice in quick succession hit exactly this branch with
    // detail.status "rejected", and treating "executed" as automatically "approved"
    // would have wrongly told the customer their return succeeded.
    const detail = result.result.detail as { status?: string; reason?: string; refundId?: string; amount?: number } | undefined;
    if (detail?.status === "rejected") {
      return { proceed: false as const, output: { status: "error" as const, reason: detail.reason } };
    }
    // The workflow's own independent policy check found this within policy after all —
    // the normal outcome for the common case now that every attempt reaches this same
    // check, not just escalations. "approved," not "issued" — this app only
    // ever knows an approval was recorded, never that a real OMS payment completed.
    return {
      proceed: false as const,
      output: { status: "approved" as const, refundId: detail?.refundId, amount: detail?.amount },
    };
  }
  if (result.status === "success" && result.result?.action === "denied") {
    // A deterministic, autonomous rejection (the refund policy's "autonomous-reject"
    // outcome) — the claim was reviewed against policy and declined on the spot, no
    // human involved. Genuinely NOT "error": nothing was invalid or broke, a real
    // decision was made. Mapped to its own "denied" status (not "error") specifically
    // so wismo-agent.ts doesn't tell the customer "something went wrong" about a
    // final, legitimate answer. reason carries the polite, customer-safe wording
    // (never the rep-facing explanation) — same split the return refund policy's own
    // escalate verdicts already use for customerReason, just always present here
    // rather than optional, since this outcome has no other customer-facing text.
    const detail = result.result.detail as { reason?: string; customerReason?: string } | undefined;
    return { proceed: false as const, output: { status: "denied" as const, reason: detail?.customerReason ?? detail?.reason } };
  }
  if (result.status === "success" && result.result?.action === "error") {
    // The workflow's own pre-check found this invalid before ever computing autonomy
    // at all (e.g. an item already refunded on an earlier call) — a legitimate,
    // expected outcome, not the unexpected-status fallback below.
    const detail = result.result.detail as { reason?: string } | undefined;
    return { proceed: false as const, output: { status: "error" as const, reason: detail?.reason } };
  }
  return {
    proceed: false as const,
    output: { status: "error" as const, reason: `Expected this to resolve or escalate but the workflow ended with status "${result.status}" instead.` },
  };
};
