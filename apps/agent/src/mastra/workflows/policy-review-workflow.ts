import { newReviewDeadline } from "../case-state";
import { createWorkflow, createStep } from "@mastra/core/workflows";
import { z } from "zod";
import { getOrder, getCustomer, orderItemsSummary, type Order } from "../../fixtures/demo-data";
// Every initial decision comes from the active policy document, via live-policy.ts.
import { decideRefund, decideReturnRefund, decideDeliveryDispute } from "../policy/live-policy";
import { getHighPriorityAmountThreshold } from "../runtime-settings";
import { carrierRecordSummary } from "../tools/shipment-info";
import { issueRefund } from "../tools/payment";
import { alreadyRefundedItemIds } from "../refund-ledger";
import { escalateSupportTicket } from "../tools/escalate-support-ticket";
import { checkMaxAutonomousAmount } from "../system-authority";
import { config } from "../../config";
import { formatMoney } from "../../lib/money";

// The core HITL mechanism, built against Mastra's
// confirmed suspend/resume API (verified against the actual installed @mastra/core
// type definitions, not just the docs site). One step handles both the initial policy
// check and the resumed human decision, because Mastra re-runs the same step's
// execute() with resumeData populated on resume.
//
// The Escalation Desk discovers suspended runs via the real
// workflow.listWorkflowRuns() / getWorkflowRunById() APIs (see apps/agent/src/server.ts)
// — no separate queue store needed. An earlier pass here built a custom in-memory index
// because the public docs site didn't surface listWorkflowRuns clearly; checking the
// installed package's actual .d.ts files turned up the real API, so that workaround was
// removed.

const transcriptMessageSchema = z.object({
  role: z.enum(["customer", "agent"]),
  text: z.string(),
  // ISO string, always set — a real per-message receipt time for a live conversation
  // (chat-transcript.ts's buildTranscript / message-timestamps.ts), or a staggered synthetic
  // one for demo-seed.ts's hand-authored scenarios (there's no live conversation behind
  // those, so nothing real to derive one from).
  timestamp: z.string(),
  // A customer-submitted supporting photo (e.g. damage evidence), inlined as a data URL
  // rather than a file path or external URL — the transcript already lives inside the
  // workflow run's own suspend payload, which Mastra persists as part of that run's
  // snapshot, so this keeps the photo in the same place as the rest of the case's audit
  // trail instead of a separately-hosted asset that could drift or go missing.
  imageDataUrl: z.string().optional(),
});

const humanPolicyReviewInput = z.object({
  orderId: z.string(),
  refundAmount: z.number(),
  // Optional, not defaulted anywhere upstream anymore (refund-policy-gate.ts) — an
  // omitted claim means genuinely unknown, not "assume the customer's fault." See
  // the refund policy's own new fault-unknown branch, which escalates rather than
  // silently denying on missing information (the old `?? false` default violated this same file's own documented
  // fail-safe principle: unverifiable should push toward escalation, never autonomy).
  notCustomerFault: z.boolean().optional(),
  problemSummary: z.string(),
  threadId: z.string(),
  // The chat tab that created this case (request-context.ts's SESSION_ID_KEY) — carried
  // through every suspend/resume so a live push only ever reaches that same tab, never
  // "any open chat for this customer." See case-events.ts's header comment.
  sessionId: z.string(),
  // The chat CONVERSATION (one thread of messages — request-context.ts's
  // CONVERSATION_ID_KEY) this case was opened in, as opposed to sessionId above, which is
  // the browser TAB. Only read from the frozen step input (never re-threaded through the
  // suspend payloads): case-lookup.ts's summarizeConversationCases needs it to answer
  // "does this chat still have an open case, and has anything in it been resolved?" for
  // the new-chat-after-resolution check, and a step's frozen `payload` is available for
  // a suspended AND a resolved run alike. Optional so a case created before this field
  // existed (or seeded directly, which has no conversation at all) still parses.
  conversationId: z.string().optional(),
  // Set once, by whichever escalation tool first calls run.start() for this case, and
  // never touched again — inputData itself is frozen from that original call for the
  // run's whole lifetime, so this stays the true creation time across every future
  // resume. Deliberately NOT the same thing as the run's own updatedAt (what server.ts's
  // suspendedAt / the queue's sort key track): updatedAt is "last touched," which
  // linkRelatedCase (case-lookup.ts) legitimately bumps forward when a newer case links
  // back to this one — using that for "when was this case opened" would make an old
  // case that just got cross-referenced look brand new. This field is what "opened X
  // ago" and the related-case banner's "which one is first" actually need.
  createdAt: z.string(),
  reviewDeadlineIso: z.string().optional(),
  // "refund" (default, unchanged behavior) runs the damage/fault policy below.
  // "delivery_dispute" is a structurally different claim — not fault for damage, but the
  // carrier record and the customer's account directly disagreeing — and always
  // escalates; see the delivery dispute policy for why that's not just "usually" true.
  // "plain_return" is a customer just returning an unwanted item — no fault claim, no
  // dispute — and unlike the other two, CAN reach an autonomous outcome; see
  // the return refund policy.
  caseType: z.enum(["refund", "delivery_dispute", "plain_return"]).default("refund"),
  // Included directly in the suspend payload rather than fetched from a live Mastra
  // Memory thread — see server.ts / seed.ts. Seeding triggers this workflow directly
  // (no live agent turn, so no API key required to seed demo data), so there's no real
  // multi-turn conversation in Memory to fetch yet. Wiring real Memory-backed threads
  // is follow-up work once the conversational agent side is built out.
  transcript: z.array(transcriptMessageSchema),
  // Only meaningful for caseType "plain_return" — which specific items (from
  // present_return_item_picker) this case covers; undefined means the whole order.
  // Carried through every suspend/resume (request_more_info's re-suspend, timeout's
  // ...resumeData.context spread) so approve/modify can record the refund against the
  // SAME items the customer actually picked, not silently the whole order — see
  // refund-ledger.ts and payment.ts's issueRefund.
  itemIds: z.array(z.string()).optional(),
  // Set by the escalation tool when it found other already-open case(s) for this order
  // that DON'T match this one (a different item, or a different caseType entirely — see
  // case-lookup.ts's caseTypeOf / findOpenCasesForOrder) — two claims on the same order
  // that don't match aren't necessarily the same issue continuing, but they might still
  // be mutually exclusive (e.g. "never delivered" vs. an existing "arrived damaged"
  // claim), which isn't something to resolve by guessing. Carried into the suspend
  // payload so a human reviewer sees every other open case instead of finding out only
  // after already acting on this one. A list, not a single case, since an order can
  // legitimately carry more than one simultaneously-open case at a time.
  relatedOpenCaseIds: z.array(z.object({ runId: z.string(), createdAt: z.string() })).optional(),
  // Only meaningful for caseType "plain_return" — the SUM of every other open case's own
  // refundAmount (case-lookup.ts's refundAmountOf), so the plain_return branch below can
  // project what this order's cumulative total would be if THIS return and every other
  // currently-open case were all approved (the return refund policy's
  // pendingFromOtherCase), the same narrowed check escalate_for_return_refund's own
  // tool-level counterpart (payment_issue_return_refund) already ran before deciding
  // this needed a case at all. Without re-deriving it here too, an order that reaches
  // this branch via escalate_for_return_refund some OTHER way (skipping
  // payment_issue_return_refund entirely) would only ever see relatedOpenCaseIds' bare
  // presence, not whether it actually conflicts — reintroducing the coarse "any open
  // case blocks" behavior this was narrowed away from, just on a different path.
  relatedOpenCaseRefundAmount: z.number().optional(),
  // How many leading entries of the FULL conversation this case's own transcript
  // (above) already excludes — see session-case-boundary.ts. Recorded once, at
  // creation, and carried through every suspend/re-suspend below so a LATER
  // case-sync.ts rebuild of this exact case's transcript re-applies the same cut
  // instead of falling back to the full, unscoped conversation (a real, live-
  // reproduced bug: a case created right after an earlier, unrelated matter resolved
  // in the same session had its own properly-scoped transcript immediately clobbered
  // by the very next onFinish resync, which knew nothing about this boundary).
  transcriptStartIndex: z.number().optional(),
});

// The policy rule that decided (its P-number + plain-English wording at the time) — see
// live-policy.ts's PolicyRef. Stored on the case so the Escalation Desk can show it.
const policyRefSchema = z.object({
  number: z.string(),
  version: z.number(),
  text: z.string(),
  // Audit record: every rule that matched on the way to the outcome, and why it is what it is.
  matches: z.array(z.object({ number: z.string().optional(), id: z.string(), kind: z.enum(["restriction", "decision"]) })).optional(),
  basis: z.enum(["restriction", "decision", "fallback", "conflict"]).optional(),
});

const suspendPayloadSchema = z.object({
  title: z.string(),
  orderId: z.string(),
  customerId: z.string(),
  customerName: z.string(),
  problemSummary: z.string(),
  orderContext: z.string(),
  reasonCode: z.string(),
  explanation: z.string(),
  recommendedAction: z.string(),
  refundAmount: z.number(),
  // ISO 4217 code — config.currency at the moment this case was created, carried forward
  // through every suspend/resume (the "timeout" branch's ...resumeData.context spread) so
  // a rep or the storefront can format refundAmount correctly without a separate lookup.
  currency: z.string(),
  priority: z.enum(["low", "normal", "high"]),
  threadId: z.string(),
  sessionId: z.string(),
  // See humanPolicyReviewInput's own createdAt field — same value, carried straight
  // through every suspend/resume so the Desk can show a stable "opened X ago" even
  // after this case's own updatedAt has been bumped by an unrelated resume or a
  // linkRelatedCase patch.
  createdAt: z.string(),
  reviewDeadlineIso: z.string().optional(),
  transcript: z.array(transcriptMessageSchema),
  // Only set once a "timeout" resume has opened a support ticket for this case (see the
  // "timeout" branch below) — the case is still open and still needs a real decision, a
  // ticket existing doesn't change that. Carried here so a rep sees it without the
  // check-timeouts scan needing to recompute or look it up separately.
  ticketId: z.string().optional(),
  // See humanPolicyReviewInput's own itemIds field — same meaning, carried straight
  // through so a rep still sees which items this case is actually about.
  itemIds: z.array(z.string()).optional(),
  // See humanPolicyReviewInput's own relatedOpenCaseIds field — same meaning, carried
  // straight through so the Escalation Desk can flag it for the reviewer.
  relatedOpenCaseIds: z.array(z.object({ runId: z.string(), createdAt: z.string() })).optional(),
  // See humanPolicyReviewInput's own relatedOpenCaseRefundAmount field.
  relatedOpenCaseRefundAmount: z.number().optional(),
  // Only ever set for caseType "plain_return" (the return refund policy's own verdict
  // shape is the only one with this field) — a ready-to-relay, customer-safe sentence
  // explaining the escalation without the exact dollar/percent threshold. Threaded
  // through here (rather than only ever computed by the tool that used to call
  // decideReturnRefund before escalating) so refund-policy-gate.ts's single
  // workflow call can read it straight back off the suspend result instead of
  // re-deriving the same verdict a second time just to get this string.
  customerReason: z.string().optional(),
  // See humanPolicyReviewInput's own transcriptStartIndex field — same meaning,
  // carried straight through every suspend/re-suspend so case-sync.ts can find it.
  transcriptStartIndex: z.number().optional(),
  policy: policyRefSchema.optional(),
});

const humanDecisionSchema = z.discriminatedUnion("decision", [
  // requestItemReturn (optional, approve/modify only): the rep's per-case choice to ALSO
  // ask the customer to send the item back — server.ts's resumeAndNotify reads it off the
  // decision (not the workflow's result) to generate the return label and tell the
  // customer. A request only: issueRefund below runs exactly as it always does, the case
  // resolves immediately, and nothing here waits for the item — whether it ever arrives
  // is the OMS's concern, not this app's.
  // policy (on approve/reject/modify/request_more_info): the case's own policy reference,
  // read live by server.ts's /resume route — carried into the resolved result so History
  // still shows which policy sent the case to a rep. Never trusted from the client.
  z.object({ decision: z.literal("approve"), comment: z.string().optional(), requestItemReturn: z.boolean().optional(), policy: policyRefSchema.optional() }),
  z.object({ decision: z.literal("reject"), reason: z.string().optional(), policy: policyRefSchema.optional() }),
  // .positive(): closes a code-review finding — a $0/negative modify couldn't
  // let a rep overpay (server.ts's own value-cap check already prevents that), but it
  // could still get permanently recorded as a "refund" covering those items (see
  // refund-ledger.ts's derived-from-history redesign — that record is now the durable
  // truth, not a wipeable cache), locking the customer out of a real refund for them and
  // skewing the cumulative total other cases on the order get checked against. Enforced
  // right here because server.ts:889 runs humanDecisionSchema.safeParse(body) before the
  // workflow or issueRefund is ever touched — this alone is real server-side
  // enforcement, not just a UI nicety.
  z.object({ decision: z.literal("modify"), modifiedAmount: z.number().positive(), comment: z.string().optional(), requestItemReturn: z.boolean().optional(), policy: policyRefSchema.optional() }),
  // The request_more_info variant carries fields the server reads LIVE from storage right before
  // resuming, because this step's inputData is frozen from the original run.start() and never reflects
  // what case-sync.ts patched into storage since:
  //   - transcript (optional): the live transcript (a customer chatting on before the rep's first action
  //     is the common case). Falls back to inputData.transcript, so the decision stays valid for a
  //     caller that omits it (a script or test), just without that protection.
  //   - ticketId (optional): whether the case already has a support ticket. The branch below rebuilds the
  //     suspend payload from scratch (unlike "timeout"'s, which spreads the prior payload), so without
  //     this a case that already timed out loses its ticket the moment a rep asks a follow-up, then
  //     times out into a SECOND ticket.
  //   - explanation (optional): the case's own deterministic policy/carrier finding (what the Desk's
  //     "Policy Exception" box and "System shows" column read). Without it the branch set explanation to
  //     the REP'S OWN QUESTION, so a dispute asked "what?" replaced "Carrier record shows it delivered...".
  //   - problemSummary (optional): the case's summary as it stands now, including the questions asked so far.
  //     The branch rebuilds the payload from the step's frozen input, so without this a second question was
  //     appended to the ORIGINAL summary and the first question dropped out of "Customer Info".
  //   - customerUnreachable (optional): set by server.ts when the case's sessionId has no live SSE
  //     connection when the rep submits, so there is no chat tab for the question to reach. The branch
  //     then opens a support ticket and resolves the case instead of re-suspending into a wait nobody is
  //     there to answer.
  z.object({
    decision: z.literal("request_more_info"),
    policy: policyRefSchema.optional(),
    question: z.string(),
    transcript: z.array(transcriptMessageSchema).optional(),
    ticketId: z.string().optional(),
    explanation: z.string().optional(),
    problemSummary: z.string().optional(),
    customerUnreachable: z.boolean().optional(),
  }),
  // Not a human decision — the SLA-scan endpoint (server.ts's POST
  // /escalations/check-timeouts) resumes with this when a case has sat past
  // config.escalationSlaMinutes with no rep action. context carries the exact same
  // SuspendPayload the Escalation Desk was already showing for this case: the scan
  // endpoint already has it in hand from finding the run in the first place, so there's
  // no need to recompute it from scratch inside the step.
  z.object({ decision: z.literal("timeout"), context: suspendPayloadSchema }),
  // A rep's own proactive call that this case is beyond what the Escalation Desk can
  // resolve — it needs a higher tier of support. Shaped
  // exactly like "timeout" above (same context: suspendPayloadSchema, same terminal
  // outcome) since the mechanism is identical — the only real difference is WHO
  // triggered it (resolvedBy: "rep" vs. "system") and that a rep may leave a note
  // explaining why. Like "timeout", the client never legitimately holds a full
  // SuspendPayload of its own — server.ts's /resume route fetches it live and injects
  // it before validation, the same way check-timeouts already does for "timeout".
  z.object({ decision: z.literal("escalate_to_support"), note: z.string().optional(), context: suspendPayloadSchema }),
]);

export function orderContextLine(order: Order): string {
  return `${orderItemsSummary(order)} — ordered ${order.orderDate.slice(0, 10)}, delivered ${order.deliveredDate.slice(0, 10)}`;
}

// Queue priority for an escalated refund/return: "high" above the Settings page's
// highPriorityAmountThreshold, else "normal"; 0 turns amount-based flagging off. Queue
// sorting only — deliberately not policy, it never changes a decision. (Delivery disputes
// are always "high", set in their own branch.)
function queuePriority(refundAmount: number): "high" | "normal" {
  const threshold = getHighPriorityAmountThreshold();
  return threshold > 0 && refundAmount > threshold ? "high" : "normal";
}

// What the Desk recommends the rep do. It is an attribute of the RULE that sent the case to a person
// (outcome.recommendedAction, "{amount}" replaced by the formatted request amount) — the workflow no longer
// decides it by checking a reason-code string. `fallback` is the plain default when the rule has none.
function recommendedActionText(fromRule: string | undefined, amount: number, fallback: string): string {
  return fromRule ? fromRule.replaceAll("{amount}", formatMoney(amount, config.currency)) : fallback;
}

// The rep's optional message on an approve / modify — shown to the customer (the chat push and the email), so it is trimmed
// and capped here, once, wherever it is read. Undefined when blank.
export const REP_COMMENT_MAX = 1000;
export function repComment(raw: string | undefined): string | undefined {
  const text = raw?.trim();
  return text ? text.slice(0, REP_COMMENT_MAX) : undefined;
}

const humanPolicyReview = createStep({
  id: "human-policy-review",
  inputSchema: humanPolicyReviewInput,
  resumeSchema: humanDecisionSchema,
  suspendSchema: suspendPayloadSchema,
  outputSchema: z.object({
    action: z.enum(["executed", "denied", "error", "escalated_to_support"]),
    detail: z.record(z.string(), z.unknown()).optional(),
  }),
  execute: async ({ inputData, resumeData, suspend, runId }) => {
    // Always re-fetch from the system of record — never trust anything about the
    // order or customer that arrived via the conversation.
    const order = getOrder(inputData.orderId);
    const customer = order ? getCustomer(order.customerId) : undefined;
    if (!order || !customer) {
      return { action: "error" as const, detail: { reason: "order or customer not found" } };
    }

    if (!resumeData) {
      const reviewDeadlineIso = newReviewDeadline();
      if (inputData.caseType === "delivery_dispute") {
        // Goes to a rep unless the active policy resolves the dispute itself — the demo
        // policy's own deliveryDisputesAlwaysEscalate guard rule makes sure it doesn't.
        // An automatic approval still has to clear the $ backstop, same as a damage claim
        // below. refundAmount is the order's own value — what's at stake, not a
        // recommendation.
        let verdict = await decideDeliveryDispute(order, inputData.refundAmount, inputData.relatedOpenCaseRefundAmount);
        if (verdict.outcome === "autonomous") {
          const clamp = checkMaxAutonomousAmount(inputData.refundAmount);
          if (clamp.blocked) {
            verdict = { outcome: "escalate", reasonCode: clamp.reasonCode, explanation: `${clamp.explanation} Carrier record: ${carrierRecordSummary(order.id)}` };
          } else {
            const result = await issueRefund({ orderId: order.id, amount: inputData.refundAmount, authorizedBy: "dispute-autonomous", runId });
            if (result.status === "rejected" && result.recheck) {
              // The policy, asked again right before the money moved, no longer approves — a person decides.
              verdict = { outcome: "escalate", reasonCode: result.recheck.reasonCode, explanation: `${result.recheck.explanation} Carrier record: ${carrierRecordSummary(order.id)}`, policy: result.recheck.policy };
            } else {
              return { action: "executed" as const, detail: { ...(result as unknown as Record<string, unknown>), resolvedBy: "agent" as const, policy: verdict.policy } };
            }
          }
        } else if (verdict.outcome === "autonomous-reject") {
          return { action: "denied" as const, detail: { reason: verdict.explanation, customerReason: verdict.customerReason, resolvedBy: "agent" as const, policy: verdict.policy } };
        }
        return await suspend({
          title: "Delivery dispute",
          orderId: order.id,
          customerId: customer.id,
          customerName: customer.name,
          problemSummary: inputData.problemSummary,
          orderContext: orderContextLine(order),
          reasonCode: verdict.reasonCode,
          explanation: verdict.outcome === "escalate" ? verdict.explanation : "",
          policy: verdict.policy,
          recommendedAction: "Investigate with carrier before any refund or reship",
          refundAmount: inputData.refundAmount,
          currency: config.currency,
          priority: "high",
          threadId: inputData.threadId,
          sessionId: inputData.sessionId,
          transcript: inputData.transcript,
          createdAt: inputData.createdAt,
          reviewDeadlineIso,
          relatedOpenCaseIds: inputData.relatedOpenCaseIds,
          relatedOpenCaseRefundAmount: inputData.relatedOpenCaseRefundAmount,
          transcriptStartIndex: inputData.transcriptStartIndex,
        });
      }

      if (inputData.caseType === "plain_return") {
        // Same double-refund guard as escalate_for_return_refund's own tool-level
        // check — this is the safety net for a case created some other way (a script,
        // a future caller that skips the tool). Checked here even before the policy
        // verdict below: no point computing autonomy for an item that's already paid
        // out either way.
        const alreadyCovered = await alreadyRefundedItemIds(order.id);
        const overlap = (inputData.itemIds ?? order.items.map((item) => item.objectID)).filter((id) => alreadyCovered.has(id));
        if (overlap.length > 0) {
          return { action: "error" as const, detail: { reason: `Already refunded: ${overlap.join(", ")} — refusing to open a case for an item already refunded.` } };
        }

        // Unlike the two branches above, this one CAN come back autonomous — a plain
        // return has no fault attribution to verify, so nothing here is permanently
        // blocked on a human the way a damage claim is. Independently re-derived here
        // (not trusted from whatever payment_issue_return_refund already decided) for the
        // same reason the "refund" branch below re-runs decideRefund itself: this is
        // the safety net if the agent skipped straight to escalating. Folds in
        // relatedOpenCaseRefundAmount (an open, DIFFERENT case's own pending ask) the
        // same way payment_issue_return_refund's own tool-level check already does —
        // without that, an order reaching this branch via escalate_for_return_refund
        // some OTHER way (skipping the autonomous attempt entirely) would only ever see
        // relatedOpenCaseIds' bare presence, not whether it actually conflicts.
        let verdict = await decideReturnRefund(order, inputData.refundAmount, inputData.relatedOpenCaseRefundAmount);
        if (verdict.outcome === "autonomous") {
          // The $ backstop (mastra/system-authority.ts) gets the final word on whether an
          // automatic approval may go through, whatever the policy computed. When it's
          // blocked, the verdict becomes the SAME escalate shape a policy-level escalation
          // uses — a rep reviewing this case sees an ordinary escalation either way.
          const clamp = checkMaxAutonomousAmount(inputData.refundAmount);
          if (clamp.blocked) {
            verdict = {
              outcome: "escalate",
              reasonCode: clamp.reasonCode,
              explanation: clamp.explanation,
              customerReason: "This return needs a quick review from our team before it's processed.",
            };
          } else {
            // Whether the item actually makes it back is an OMS-level concern, out of
            // scope for this app (per explicit user decision) — a within-policy return
            // pays out immediately, same as every other autonomous outcome. This used to
            // wait for a rep to mark the item received (suspendForItemReturn) before
            // firing the refund; removed entirely, for damage claims and plain returns
            // alike, along with the settings that gated it (requireReturnItemBack /
            // requireDamagedItemReturn) and the "awaiting-item-return" case state.
            const result = await issueRefund({
              orderId: order.id,
              amount: inputData.refundAmount,
              authorizedBy: "return-autonomous",
              runId,
              itemIds: inputData.itemIds,
            });
            if (result.status === "rejected" && result.recheck) {
              // The policy, asked again right before the money moved (with the open cases as they are NOW), no
              // longer approves — a person decides, like any other escalation here.
              verdict = { outcome: "escalate", reasonCode: result.recheck.reasonCode, explanation: result.recheck.explanation, customerReason: result.recheck.customerReason ?? "This return needs a quick review from our team before it's processed.", policy: result.recheck.policy };
            } else {
              // resolvedBy: who actually made this happen — "agent" for the two autonomous
              // branches (this one and the damage-claim one below), "rep" for every branch
              // reached via the resumeData switch (a human decision). Surfaced to the
              // Escalation Desk's History/detail views so a rep can tell an autonomous
              // resolution apart from one someone actually reviewed. "denied" needs no
              // parallel case here — there's no autonomous-reject path anywhere in this
              // workflow, so a denied outcome is unambiguously always a rep's own reject.
              return { action: "executed" as const, detail: { ...(result as unknown as Record<string, unknown>), resolvedBy: "agent" as const, policy: verdict.policy } };
            }
          }
        }
        const { reasonCode, explanation, customerReason, policy } = verdict;
        const priority = queuePriority(inputData.refundAmount);
        return await suspend({
          title: "Return refund requires review",
          orderId: order.id,
          customerId: customer.id,
          customerName: customer.name,
          problemSummary: inputData.problemSummary,
          orderContext: orderContextLine(order),
          reasonCode,
          explanation,
          customerReason,
          policy,
          recommendedAction: recommendedActionText(verdict.recommendedAction, inputData.refundAmount, `Refund ${formatMoney(inputData.refundAmount, config.currency)}`),
          refundAmount: inputData.refundAmount,
          currency: config.currency,
          priority,
          threadId: inputData.threadId,
          sessionId: inputData.sessionId,
          transcript: inputData.transcript,
          itemIds: inputData.itemIds,
          createdAt: inputData.createdAt,
          reviewDeadlineIso,
          relatedOpenCaseIds: inputData.relatedOpenCaseIds,
          relatedOpenCaseRefundAmount: inputData.relatedOpenCaseRefundAmount,
          transcriptStartIndex: inputData.transcriptStartIndex,
        });
      }

      let verdict = await decideRefund({
        order,
        customer,
        refundAmount: inputData.refundAmount,
        notCustomerFault: inputData.notCustomerFault,
        pendingFromOtherCase: inputData.relatedOpenCaseRefundAmount,
      });

      // Same $ backstop as the plain_return branch above: an automatic approval over the
      // limit becomes an ordinary escalation and falls through to the ONE shared suspend()
      // below. The demo policy never approves a damage claim automatically today (every
      // not-their-fault claim needs photo review) — clamped anyway so nothing needs
      // revisiting the day a policy does.
      if (verdict.outcome === "autonomous") {
        const clamp = checkMaxAutonomousAmount(inputData.refundAmount);
        if (clamp.blocked) {
          verdict = { outcome: "escalate", reasonCode: clamp.reasonCode, explanation: clamp.explanation };
        } else {
          const result = await issueRefund({
            orderId: order.id,
            amount: inputData.refundAmount,
            authorizedBy: "autonomous",
            notCustomerFault: inputData.notCustomerFault,
            runId,
            itemIds: inputData.itemIds,
          });
          if (result.status === "rejected" && result.recheck) {
            verdict = { outcome: "escalate", reasonCode: result.recheck.reasonCode, explanation: result.recheck.explanation, policy: result.recheck.policy };
          } else {
            return { action: "executed" as const, detail: { ...(result as unknown as Record<string, unknown>), resolvedBy: "agent" as const, policy: verdict.policy } };
          }
        }
      }

      if (verdict.outcome === "autonomous-reject") {
        // Deterministic, no human needed — resolves immediately, just denying instead of
        // approving. A denial moves no money, so the $ backstop doesn't apply; whether
        // automatic denials happen at all is the policy's own autonomousRefundsEnabled
        // guard rule. reason stays the rep-facing explanation (for History/the case-detail
        // Resolution box); customerReason is the polite, no-blame-language version
        // refund-policy-gate.ts relays to the customer.
        return {
          action: "denied" as const,
          detail: { reason: verdict.explanation, customerReason: verdict.customerReason, resolvedBy: "agent" as const, policy: verdict.policy },
        };
      }

      const priority = queuePriority(inputData.refundAmount);
      return await suspend({
        title: "Refund requires review",
        orderId: order.id,
        customerId: customer.id,
        customerName: customer.name,
        problemSummary: inputData.problemSummary,
        orderContext: orderContextLine(order),
        reasonCode: verdict.reasonCode,
        explanation: verdict.explanation,
        policy: verdict.policy,
        recommendedAction: recommendedActionText(verdict.recommendedAction, inputData.refundAmount, `Refund ${formatMoney(inputData.refundAmount, config.currency)}`),
        refundAmount: inputData.refundAmount,
        currency: config.currency,
        priority,
        threadId: inputData.threadId,
        sessionId: inputData.sessionId,
        transcript: inputData.transcript,
        itemIds: inputData.itemIds,
        createdAt: inputData.createdAt,
          reviewDeadlineIso,
        relatedOpenCaseIds: inputData.relatedOpenCaseIds,
        relatedOpenCaseRefundAmount: inputData.relatedOpenCaseRefundAmount,
        transcriptStartIndex: inputData.transcriptStartIndex,
      });
    }

    // The policy that sent this case to a rep — carried into whatever this decision resolves
    // to (and into a request_more_info re-suspend), so History still shows it.
    const priorPolicy = "context" in resumeData ? resumeData.context.policy : resumeData.policy;
    switch (resumeData.decision) {
      case "approve": {
        const result = await issueRefund({
          orderId: order.id,
          amount: inputData.refundAmount,
          authorizedBy: "escalation-approval",
          runId,
          itemIds: inputData.itemIds,
        });
        // server.ts's own /resume route already blocks an already-refunded approval
        // before ever reaching here — this is the defense-in-depth layer for a genuine
        // race (e.g. two overlapping resumes) that check couldn't catch. Without it, a
        // rejection from issueRefund's own internal guard (payment.ts) was previously
        // reported as "executed" regardless — a live-reproduced bug: the customer got
        // a false "your case was approved" push/email with no dollar amount at all.
        if (result.status === "rejected") {
          return { action: "error" as const, detail: { reason: result.reason } };
        }
        return { action: "executed" as const, detail: { ...(result as unknown as Record<string, unknown>), resolvedBy: "rep" as const, policy: priorPolicy, ...(repComment(resumeData.comment) ? { comment: repComment(resumeData.comment) } : {}) } };
      }
      case "reject":
        return { action: "denied" as const, detail: { reason: resumeData.reason, resolvedBy: "rep" as const, policy: priorPolicy } };
      case "modify": {
        const result = await issueRefund({
          orderId: order.id,
          amount: resumeData.modifiedAmount,
          authorizedBy: "escalation-approval",
          runId,
          itemIds: inputData.itemIds,
        });
        // See the "approve" case above — same defense-in-depth reasoning.
        if (result.status === "rejected") {
          return { action: "error" as const, detail: { reason: result.reason } };
        }
        return { action: "executed" as const, detail: { ...(result as unknown as Record<string, unknown>), resolvedBy: "rep" as const, policy: priorPolicy, ...(repComment(resumeData.comment) ? { comment: repComment(resumeData.comment) } : {}) } };
      }
      case "request_more_info": {
        const followUpPayload = {
          title: "Awaiting more information from customer",
          orderId: order.id,
          customerId: customer.id,
          customerName: customer.name,
          problemSummary: `${resumeData.problemSummary ?? inputData.problemSummary} — rep asked: "${resumeData.question}"`,
          orderContext: orderContextLine(order),
          reasonCode: "awaiting-customer-response",
          // The response window starts when the question is SENT. Without its own deadline the sweep fell back to the case's
          // creation time, so a question asked a few minutes in could be ticketed almost at once.
          reviewDeadlineIso: newReviewDeadline(),
          // The case's real policy/carrier finding, read live rather than assumed —
          // never the rep's own question (see this decision's own schema comment for
          // the bug this replaced).
          explanation: resumeData.explanation ?? inputData.problemSummary,
          recommendedAction: `Refund ${formatMoney(inputData.refundAmount, config.currency)}`,
          refundAmount: inputData.refundAmount,
          currency: config.currency,
          priority: "normal" as const,
          threadId: inputData.threadId,
          sessionId: inputData.sessionId,
          transcript: [
            ...(resumeData.transcript ?? inputData.transcript),
            { role: "agent" as const, text: `A specialist has a follow-up question: "${resumeData.question}"`, timestamp: new Date().toISOString() },
          ],
          itemIds: inputData.itemIds,
          policy: priorPolicy,
          // See humanDecisionSchema's request_more_info comment — the caller fetches
          // this live (server.ts), since the workflow's own inputData was frozen long
          // before any timeout ever happened.
          ticketId: resumeData.ticketId,
          createdAt: inputData.createdAt,
          relatedOpenCaseIds: inputData.relatedOpenCaseIds,
          relatedOpenCaseRefundAmount: inputData.relatedOpenCaseRefundAmount,
          transcriptStartIndex: inputData.transcriptStartIndex,
        };
        if (resumeData.customerUnreachable) {
          // The customer's chat tab isn't connected to receive this live (server.ts
          // checks its own activeSessions registry before resuming) — email is the
          // only channel left, exactly what a support ticket already represents in
          // this app's fixture model. Resolves the case, per explicit user decision,
          // instead of re-suspending into "awaiting-customer-response" on a channel
          // nobody's listening to — that reasonCode is deliberately exempt from the
          // SLA sweep (see check-timeouts's own comment), so it would otherwise sit
          // open forever with no path back to a rep's attention. Reuses the exact
          // same payload the live-question suspend below builds, so the rep's own
          // question and the live carrier/policy finding both still make it into
          // the ticket — not lost just because nobody was there to see it asked.
          const ticket = escalateSupportTicket(followUpPayload);
          // A rep DID act here, so this is recorded as theirs, not as a timeout, and with the question they asked: the case page,
          // History, the customer's notice and the saved conversation all say what happened.
          return { action: "escalated_to_support" as const, detail: { ticketId: ticket.ticketId, resolvedBy: "rep" as const, question: resumeData.question, policy: priorPolicy } };
        }
        // Loop: re-suspend the same case with the rep's question attached. This
        // reappears in the Escalation Desk once the customer responds and the case
        // is resumed again — see the flow diagram's "requests more info" loop.
        return await suspend(followUpPayload);
      }
      case "timeout": {
        // A genuine terminal resolution now, not a re-suspend — per explicit user
        // decision, a case that times out is DONE from the Escalation Desk's own
        // point of view: a support ticket opens, the customer is notified (still
        // handled by resumeAndNotify/server.ts exactly as before), and the case moves
        // straight to History. Nobody made an actual refund decision, so this is its
        // own outcome (resolvedBy "system"), distinct from an agent's or a rep's own
        // "executed"/"denied" — the support-ticket process, not this app, owns
        // following up with the customer from here, the same OMS-boundary reasoning
        // already applied to physical item returns.
        const ticket = escalateSupportTicket(resumeData.context);
        // A case that was waiting on the customer's answer to a rep's question: the customer is the one who did not respond in time.
        const waitingOnCustomer = resumeData.context.reasonCode === "awaiting-customer-response";
        return { action: "escalated_to_support" as const, detail: { ticketId: ticket.ticketId, resolvedBy: "system" as const, ...(waitingOnCustomer ? { awaitingCustomer: true } : {}), policy: priorPolicy } };
      }
      case "escalate_to_support": {
        // A rep decided, unprompted by any timeout, that this case is beyond what the
        // Escalation Desk can resolve — same terminal shape as "timeout" above (same
        // escalateSupportTicket call against a live suspend payload, same case-closes-
        // to-History result), just resolvedBy "rep" instead of "system" so the
        // customer-facing copy (server.ts's resumeAndNotify) and the case-detail page
        // can tell "a specialist looked at this and it needs a higher tier of support" apart from "nobody
        // responded in time." When the rep left a note, fold it into the ticket's own
        // record the same way request_more_info already folds a rep's question into
        // the transcript — the support team sees WHY this was escalated, not just that
        // it was.
        const context = resumeData.note
          ? {
              ...resumeData.context,
              problemSummary: `${resumeData.context.problemSummary} — escalated to support: "${resumeData.note}"`,
              transcript: [
                ...resumeData.context.transcript,
                { role: "agent" as const, text: `A specialist has escalated this case to our support team: "${resumeData.note}"`, timestamp: new Date().toISOString() },
              ],
            }
          : resumeData.context;
        const ticket = escalateSupportTicket(context);
        return { action: "escalated_to_support" as const, detail: { ticketId: ticket.ticketId, resolvedBy: "rep" as const, policy: priorPolicy } };
      }
    }
  },
});

export const policyReviewWorkflow = createWorkflow({
  id: "policy-review-workflow",
  inputSchema: humanPolicyReviewInput,
  outputSchema: z.object({
    action: z.enum(["executed", "denied", "error", "escalated_to_support"]),
    detail: z.record(z.string(), z.unknown()).optional(),
  }),
})
  .then(humanPolicyReview)
  .commit();

export const POLICY_REVIEW_STEP_ID = "human-policy-review";
export type SuspendPayload = z.infer<typeof suspendPayloadSchema>;
export type HumanDecision = z.infer<typeof humanDecisionSchema>;
export { humanDecisionSchema };
