// Keeps a case's transcript current as the customer keeps talking. server.ts's onFinish calls
// these at the end of a chat turn:
//   - syncCaseTranscriptForOrder rewrites an OPEN case's transcript from the whole
//     conversation, flips "awaiting-customer-response" to "customer-responded" once the
//     customer has replied, and re-fires the response countdown (case-escalation-started);
//   - syncCreatedCaseTranscripts does the same rewrite, once, for a case that was created and
//     already finished in this turn (an automatic decision);
//   - freezeResolvedTranscript (called when a case resolves) writes the live transcript into
//     the case's record, so History keeps what was actually said.
// All of them edit the workflow's stored snapshot directly, because Mastra has no way to
// append to a suspended run.

import { caseStateLocks, newReviewDeadline, reviewDeadline } from "../case-state";
import type { Mastra } from "@mastra/core/mastra";
import { getOrder } from "../../fixtures/demo-data";
import { buildTranscript } from "./chat-transcript";
import { findOpenCasesForOrder } from "./case-lookup";
import { POLICY_REVIEW_STEP_ID, policyReviewWorkflow } from "../workflows/policy-review-workflow";
import { caseEvents, type CaseEscalationStartedEvent } from "../case-events";

export interface SyncResult {
  status: "updated" | "no_open_case" | "error";
  reason?: string;
}

// Escalating a case only captures the conversation up to that moment (see refund-policy-gate.ts
// / delivery-dispute.ts's buildTranscript calls) — if the customer keeps talking about
// the same order afterward, that's real information a reviewer should see too, and
// nothing else gets it there. Mastra has no "append to an already-suspended run"
// primitive, so this goes through the same documented storage domain the workflow engine
// itself persists through (getStore("workflows").loadWorkflowSnapshot /
// persistWorkflowSnapshot — @mastra/core/dist/storage/domains/workflows/base.d.ts), not
// raw SQL. Verified against a real suspended run before use: load, mutate, persist,
// reload, and resume all behaved exactly as documented — including that `workflowName`
// there is the workflow's own `id` ("policy-review-workflow"), not the
// mastra.getWorkflow() registration key ("policyReviewWorkflow") used everywhere else in
// this app; passing the registration key here silently finds nothing.
//
// A plain function, not an agent tool: having the model call it on its own judgment
// proved unreliable in real conversations (ordinary customer follow-ups, not adversarial
// testing). server.ts's onFinish handler calls it automatically for every order any tool
// actually touched this turn (see request-context.ts's markOrderTouched) — deterministic
// on which tools ran, not on the model remembering a bookkeeping step.
//
// Simplest correct strategy: don't try to diff/append — rebuild the whole transcript from
// the full conversation, which is always what the client resent for this turn plus the
// model's own just-finished reply (same source buildTranscript already reads for the
// initial escalation). That also means the case's record picks up the model's own real
// wrap-up text once the turn that created it has finished.
export async function syncCaseTranscriptForOrder(mastraInstance: Mastra, customerId: string, orderId: string, messages: unknown[], sessionId: string): Promise<SyncResult> {
  const order = getOrder(orderId);
  if (!order) return { status: "error", reason: `No such order: ${orderId}` };
  if (order.customerId !== customerId) return { status: "error", reason: `Order ${orderId} does not belong to customer ${customerId}.` };

  const workflow = mastraInstance.getWorkflow("policyReviewWorkflow");
  if (!workflow) return { status: "error", reason: "policyReviewWorkflow is not registered." };

  // An order can carry several open cases (different items or caseTypes), and they may belong to
  // entirely SEPARATE conversations (one item reported today, another last week). Overwriting every
  // open case's transcript with THIS turn's conversation clobbered an unrelated case. So only the
  // case(s) THIS session escalated are synced (sessionId, threaded through every case the way live-push
  // scoping uses it; see request-context.ts's SESSION_ID_KEY): several items discussed in one sitting
  // share a sessionId and all get the fresh transcript, while a separate later conversation has its own
  // sessionId and never touches the earlier case.
  const matches = (await findOpenCasesForOrder(workflow, order.id)).filter((match) => match.step?.suspendPayload?.sessionId === sessionId);
  if (matches.length === 0) return { status: "no_open_case" };

  const workflowsStore = await mastraInstance.getStorage()?.getStore("workflows");
  if (!workflowsStore) return { status: "error", reason: "Workflow storage unavailable." };

  for (const match of matches) {
    await caseStateLocks.withLock(match.runId, async () => {
    const snapshot: any = await workflowsStore.loadWorkflowSnapshot({ workflowName: policyReviewWorkflow.id, runId: match.runId });
    const stepData = snapshot?.context?.[POLICY_REVIEW_STEP_ID];
    if (stepData?.status !== "suspended" || !stepData.suspendPayload) return;
    stepData.suspendPayload.reviewDeadlineIso ??= reviewDeadline(stepData.suspendPayload);

    // See session-case-boundary.ts / policy-review-workflow.ts's own transcriptStartIndex
    // field — without this, a rebuild here (which always uses the FULL conversation,
    // unlike the scoped one refund-policy-gate.ts/delivery-dispute.ts built at creation
    // time) would drag an earlier, unrelated matter's messages right back in the moment
    // THIS case's own order gets touched again — a real, live-reproduced bug: onFinish's
    // own "sync any order touched this turn" call fires in the SAME turn a case is
    // created, immediately clobbering the properly-scoped transcript that was just built.
    const freshTranscript = buildTranscript(messages, stepData.suspendPayload.transcriptStartIndex);

    const previousTranscript = stepData.suspendPayload.transcript ?? [];
    // A case a rep sent back with "request more info" is stuck reading
    // "awaiting-customer-response" in the queue forever otherwise — nothing else ever
    // clears it, since the workflow itself has no way to know the customer replied until
    // someone resumes it again, and this sync is exactly what makes that reply visible.
    // Only flip it when a customer turn shows up in the NEWLY added portion since the
    // last sync — not "is the very last entry a customer message," which is never true
    // here: this sync runs from onFinish, after the model's OWN reply for this same turn
    // is already appended last (confirmed live — checking the last entry alone never
    // fired).
    const newEntries = freshTranscript.slice(previousTranscript.length);
    const customerReplied =
      stepData.suspendPayload.reasonCode === "awaiting-customer-response" &&
      newEntries.some((m) => m.role === "customer");

    stepData.suspendPayload.transcript = freshTranscript;
    if (customerReplied) {
      stepData.suspendPayload.reviewDeadlineIso = newReviewDeadline();
      stepData.suspendPayload.title = "Customer replied — ready for review";
      stepData.suspendPayload.reasonCode = "customer-responded";
      // The title and reason code already say the customer replied. The explanation is the case's own
      // policy or carrier finding (the Desk's "Policy Exception" box and the "System Info" half of
      // "Side by side"), so it stays as it was: replacing it with a note about the last message left the
      // rep without the finding they are deciding against.
    }
    await workflowsStore.persistWorkflowSnapshot({ workflowName: policyReviewWorkflow.id, runId: match.runId, snapshot });

    if (customerReplied) {
      // The case is back in front of a rep now, same as a fresh escalation — the
      // customer should see a live countdown again too, not the frozen/cleared one left
      // over from before the rep's question (see ChatWidget.tsx's ClearedSlaContext).
      // Reuses the exact same event the initial escalation fires, which is also what
      // /escalations/check-timeouts uses the fresh explicit review deadline.
      const sessionId: string | undefined = stepData.suspendPayload.sessionId;
      if (sessionId) {
        const event: CaseEscalationStartedEvent = {
          runId: match.runId,
          orderId: order.id,
          customerId,
          sessionId,
          deadlineIso: stepData.suspendPayload.reviewDeadlineIso,
        };
        caseEvents.emit("escalation-started", event);
      }
    }
    });
  }

  return { status: "updated" };
}

// The same end-of-turn rebuild, for a case this turn CREATED that is already terminal when the turn
// ends: an automatic return or refund, which never suspends. syncCaseTranscriptForOrder only touches
// SUSPENDED cases, so such a case kept the transcript built at creation, before the turn's own replies
// (the one announcing the outcome and handing over the label) existed, and showed a rep nothing the
// agent had said. Rebuilt from the full conversation plus this turn's replies, scoped by the same
// stored boundary.
//
// Only cases created in THIS turn (the caller passes them), and only once: a resolved case's record is
// the conversation that led to its outcome, so chatter after it ("anything else?" / "no") is not
// appended turn after turn. A case still suspended is left to syncCaseTranscriptForOrder, which also
// does the countdown bookkeeping.
export async function syncCreatedCaseTranscripts(mastraInstance: Mastra, caseIds: string[], messages: unknown[]): Promise<void> {
  if (caseIds.length === 0) return;
  const workflowsStore = await mastraInstance.getStorage()?.getStore("workflows");
  if (!workflowsStore) return;
  for (const runId of caseIds) {
    await caseStateLocks.withLock(runId, async () => {
      const snapshot: any = await workflowsStore.loadWorkflowSnapshot({ workflowName: policyReviewWorkflow.id, runId });
      const stepData = snapshot?.context?.[POLICY_REVIEW_STEP_ID];
      if (!stepData?.payload || stepData.status === "suspended") return;
      stepData.payload.transcript = buildTranscript(messages, stepData.payload.transcriptStartIndex);
      await workflowsStore.persistWorkflowSnapshot({ workflowName: policyReviewWorkflow.id, runId, snapshot });
    });
  }
}

// A case's history is a RECORD of what the rep saw when they decided — not the conversation as it stood the instant the
// case was CREATED. While a case is open, the end-of-turn sync (above) keeps its LIVE transcript current in the
// suspend payload: the customer's photo, their replies to a rep's question, the agent's last message. But the moment a
// case ends (a rep's decision, an escalation to support, a timeout) that suspend payload is gone, and a resolved case's
// record reads the transcript frozen at creation — so everything said since was lost from History (for example,
// a photo sent after the case was opened vanished from the resolved case). The caller reads the live transcript BEFORE
// resuming and hands it here AFTER: it becomes the resolved record's transcript, exactly as the rep last saw it.
// A re-suspend ("request more info") is not an ending and is left alone. The caller must already hold the case's lock
// (caseStateLocks is not re-entrant, so this does not take it itself) — the resume route and the SLA sweep both do.
export async function freezeResolvedTranscript(mastraInstance: Mastra, runId: string, transcript: unknown[]): Promise<void> {
  if (transcript.length === 0) return;
  const workflowsStore = await mastraInstance.getStorage()?.getStore("workflows");
  if (!workflowsStore) return;
  const snapshot: any = await workflowsStore.loadWorkflowSnapshot({ workflowName: policyReviewWorkflow.id, runId });
  const stepData = snapshot?.context?.[POLICY_REVIEW_STEP_ID];
  if (!stepData?.payload || stepData.status === "suspended") return;
  stepData.payload.transcript = transcript;
  await workflowsStore.persistWorkflowSnapshot({ workflowName: policyReviewWorkflow.id, runId, snapshot });
}
