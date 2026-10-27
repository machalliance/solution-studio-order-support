import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { getOrder, getCustomer, type Order, type Customer } from "../../fixtures/demo-data";
// The same live-policy entry point the workflow uses, so the pre-payment re-check asks
// the SAME policy that made the original decision (dynamic or hardcoded).
import { decideRefund, decideReturnRefund, decideDeliveryDispute, type PolicyRef } from "../policy/live-policy";
import { checkMaxAutonomousAmount } from "../system-authority";
import { alreadyRefundedItemIds, pendingAmountFromOtherOpenCases } from "../refund-ledger";
import { createKeyedLock } from "../keyed-lock";

// Fixture Stripe adapter — a JSON stub stands in behind the same interface a live Stripe
// test-mode adapter would use.
//
// This is the "privileged action" of the anti-coercion design:
// it independently re-checks the real policy inputs immediately before executing,
// regardless of what path or reasoning led to this call. Even if something upstream
// (the agent's own reasoning, a workflow bug, a bad manual call) got this wrong, the
// money doesn't move unless the fixture's own re-check passes.

export interface IssueRefundInput {
  orderId: string;
  amount: number;
  // "dispute-autonomous": a delivery dispute the active policy resolved on its own —
  // only reachable if the policy's own deliveryDisputesAlwaysEscalate guard is turned off.
  authorizedBy: "autonomous" | "return-autonomous" | "dispute-autonomous" | "escalation-approval";
  /**
   * Required when authorizedBy is "autonomous" — the same fault-attribution value the
   * caller used to decide this could run on its own, so the re-check compares against
   * the same claim rather than silently assuming one. This does NOT make fault
   * attribution independently verified (see the refund policy's caveat); it just makes
   * sure this re-check can't accidentally default to the favorable case.
   */
  notCustomerFault?: boolean;
  /**
   * The case (workflow run) this approval belongs to. Required: for every AUTOMATIC authorization the policy
   * re-check below recomputes the refund amount of every OTHER open case on the order itself, right before
   * authorizing, and needs to leave this one out. (It used to take that figure from the caller — the amount the
   * workflow was started with — so a case opened in between was invisible to the re-check.)
   */
  runId: string;
  /**
   * Which specific items this refund covers (a plain return's selection — see
   * present_return_item_picker) — undefined means "the whole order" (a damage claim's
   * raw amount, or a return with no picker involved). Used both to reject a repeat
   * refund on an item already covered by an earlier one (refund-ledger.ts) and, on
   * success, to record what this refund covered so a LATER call can make the same
   * check. Optional even for authorizedBy "return-autonomous"/"escalation-approval" —
   * omit it and this degrades to order-level double-refund checking only.
   */
  itemIds?: string[];
}

export interface IssueRefundResult {
  // "approved," not "issued" — this fixture Stripe adapter fires instantly, but real
  // refund EXECUTION is conceptually the OMS's job (an OMS auto-triggers refunds once
  // an RMA shipment is received) — WISMO only ever records an approval and hands off.
  // "issued" is a stronger claim than this app ever actually knows to be true;
  // "approved" is honest about what happened without needing a real OMS integration
  // to back it up.
  status: "approved" | "rejected";
  reason?: string;
  /**
   * Only set for a return-autonomous rejection over policy — a ready-to-relay,
   * customer-safe sentence (the return refund policy's own `customerReason`) explaining
   * WHY in general terms, deliberately never the exact ceiling numbers. `reason` above
   * stays the technical/debug version; this is what wismo-agent.ts's instructions tell
   * the model to actually say to the customer, verbatim, not something to paraphrase
   * or invent its own wording for.
   */
  customerReason?: string;
  /**
   * Set only when the POLICY re-check refused an automatic approval (not for an already-refunded item or a
   * backstop clamp): what the policy said instead. The calling workflow turns it into an ordinary escalation, so
   * a person decides — rather than the case ending as an error nobody sees.
   */
  recheck?: { reasonCode: string; explanation: string; customerReason?: string; policy?: PolicyRef };
  refundId?: string;
  amount?: number;
}

// Serializes issueRefund's check-then-decide sequence per order. alreadyRefundedItemIds reads DURABLE
// history (persisted workflow runs), but this function's own decision only BECOMES part of that history
// once Mastra persists the calling workflow step's result, and this function never writes anything
// itself (see refund-ledger.ts), so there is no second copy of the data to lock. Two overlapping calls
// for the SAME order could both read "not yet covered" and both approve: a double refund. createKeyedLock
// (this app is single-process; see docs/production-considerations.md) serializes the whole
// check-through-decide sequence per order. It can't extend through Mastra's later persistence of the
// step's result (that would need the workflow to hold the lock, which Mastra's public API has no hook
// for), so it closes the overwhelmingly likely case, two calls overlapping across this function's own
// awaits, without claiming the airtight guarantee a transactional ledger would give.
const orderLocks = createKeyedLock();

// Plain function, not just a tool's execute — called from inside
// policy-review-workflow.ts's own step, for BOTH the autonomous branch (every attempt,
// via refund-policy-gate.ts always routing through the workflow now — see that file's
// own header comment) and the human-approval resume branch. Neither
// payment_issue_refund nor payment_issue_return_refund calls this directly anymore;
// their own execute() bodies are unreachable stubs below.
export async function issueRefund({ orderId, amount, authorizedBy, notCustomerFault, runId, itemIds }: IssueRefundInput): Promise<IssueRefundResult> {
  const order = getOrder(orderId);
  if (!order) return { status: "rejected", reason: `No such order: ${orderId}` };
  const customer = getCustomer(order.customerId);
  if (!customer) return { status: "rejected", reason: `No such customer for order: ${orderId}` };

  return orderLocks.withLock(order.id, () => issueRefundLocked({ order, customer, amount, authorizedBy, notCustomerFault, runId, itemIds }));
}

async function issueRefundLocked({
  order,
  customer,
  amount,
  authorizedBy,
  notCustomerFault,
  runId,
  itemIds,
}: {
  order: Order;
  customer: Customer;
  amount: number;
  authorizedBy: IssueRefundInput["authorizedBy"];
  notCustomerFault?: boolean;
  runId: string;
  itemIds?: string[];
}): Promise<IssueRefundResult> {
  const orderId = order.id;
  // The one real choke point money moves through, for automatic AND rep-approved refunds alike. It is
  // checked here even on the escalation-approval path (not just the workflow's own policy re-check) so a
  // case resumed twice, or two overlapping cases, can't pay out the same item twice. Every refund
  // resolves to a concrete list of real items: omitting itemIds means "the whole order" (the convention
  // present_return_item_picker, refund-policy-gate.ts and this app all share), so it resolves to that list.
  //
  // Coverage is resolved unconditionally for every authorizedBy. It used to require explicit itemIds for
  // "escalation-approval" before recording ANY item-level coverage, so a rep-approved return of a
  // single-item order (which never sets itemIds) recorded only a dollar amount and no per-item coverage:
  // the customer could return the same item again and get a vague "looks large combined with a prior
  // refund" escalation instead of a flat "you already returned this".
  // De-duped as cheap insurance: the real fix is upstream (resolveOrderItems in demo-data.ts rejects a
  // duplicate-containing selection before an amount is computed), but this protects the ledger's
  // bookkeeping from any future caller that bypasses it.
  const resolvedItemIds = [...new Set(itemIds ?? order.items.map((item) => item.objectID))];

  const alreadyCovered = await alreadyRefundedItemIds(order.id);
  const overlap = resolvedItemIds.filter((id) => alreadyCovered.has(id));
  if (overlap.length > 0) {
    return {
      status: "rejected",
      reason: `Already refunded: ${overlap.join(", ")} — refusing to approve a second refund for the same item(s).`,
    };
  }

  if (authorizedBy !== "escalation-approval") {
    // The re-check does not take "autonomous" on faith from its caller — and neither does it take the amount of
    // the OTHER open cases from it. That is read here, inside the order lock, immediately before the policy is
    // asked, so a case that opened after the workflow started (and after the caller worked out its own figure)
    // still counts. Excludes this run's own ask.
    const pendingFromOtherCase = await pendingAmountFromOtherOpenCases(order.id, runId);

    // A policy refusal is returned with what the policy said (`recheck`), so the workflow can send the case to a
    // person instead of ending it as an error.
    const refuse = (verdict: { outcome: string; reasonCode: string; explanation: string; customerReason?: string; policy?: PolicyRef }): IssueRefundResult => ({
      status: "rejected",
      reason: `Policy re-check failed at the point of execution (${verdict.outcome}: ${verdict.reasonCode}) — refusing to approve without a human decision on record.`,
      customerReason: verdict.customerReason,
      recheck: { reasonCode: verdict.reasonCode, explanation: verdict.explanation, customerReason: verdict.customerReason, policy: verdict.policy },
    });

    if (authorizedBy === "autonomous") {
      // No `?? false` — a code-review finding: an omitted claim is genuinely unknown, not the customer's
      // fault by default. decideRefund's own fault-unknown branch escalates rather than autonomously denying on
      // missing information. (Unreachable for damage claims today regardless — every notCustomerFault claim
      // already requires human review — but shouldn't silently reintroduce the same bug if that ever changes.)
      const verdict = await decideRefund({ order, customer, refundAmount: amount, notCustomerFault, pendingFromOtherCase });
      if (verdict.outcome !== "autonomous") return refuse(verdict);
    } else if (authorizedBy === "return-autonomous") {
      // Same re-validation discipline, for a plain return instead of a damage/fault claim.
      const verdict = await decideReturnRefund(order, amount, pendingFromOtherCase);
      if (verdict.outcome !== "autonomous") return refuse(verdict);
    } else if (authorizedBy === "dispute-autonomous") {
      // Same re-validation discipline for a delivery dispute — re-asks the same live policy (including its
      // deliveryDisputesAlwaysEscalate guard) right before money moves.
      const verdict = await decideDeliveryDispute(order, amount, pendingFromOtherCase);
      if (verdict.outcome !== "autonomous") return refuse(verdict);
    }
  }
  // authorizedBy === "escalation-approval": a human already made the call via the
  // Escalation Desk (run.resume()) — that decision is what's being executed here,
  // not re-derived.

  // The System Authority backstop, re-checked at the last moment for every AUTOMATIC
  // approval — the workflow already checked it, but the awaits above (refund history, the
  // policy re-check) leave a window where the ceiling can be lowered, including to 0 as an
  // emergency brake. A rep's own approval isn't capped by it.
  if (authorizedBy !== "escalation-approval") {
    const clamp = checkMaxAutonomousAmount(amount);
    if (clamp.blocked) {
      return { status: "rejected", reason: `${clamp.explanation} (checked again at the point of approval)` };
    }
  }

  const refundId = `re_${orderId}_${Date.now()}`;

  // No separate record-write here anymore —
  // this return value becomes the workflow step's own `detail`, which Mastra persists
  // as that run's resolved output the moment execute() returns. refund-ledger.ts's
  // derived queries read it straight back from there (durable, in LibSQLStore),
  // resolving the same "itemIds omitted means the whole order" convention against the
  // step's own frozen input — there's nothing left for a second write to keep in sync.
  return { status: "approved", refundId, amount };
}

// Merged output shape for payment_issue_refund and payment_issue_return_refund. "approved": resolved
// automatically (whether the item ever comes back, or the OMS ever executes the payment, is out of
// scope and not something Wismo claims to know; see the "approved, not issued" note above).
// "escalated": a real case now sits in the Escalation Desk queue awaiting a human decision. "denied": a
// deterministic, automatic rejection: the claim was reviewed against policy and declined, nothing broke,
// nothing needs a human. "error": an invalid request that never became a case (a bad order, itemIds, or
// a genuine duplicate). "denied" is its own status, not folded into "error", because wismo-agent.ts
// treats "error" as "something was invalid, nothing happened" and would tell the customer the wrong
// thing about a final policy decision. refund-policy-gate.ts decides between these and is the only
// caller of this tool's real logic.
const paymentOutputSchema = z.object({
  status: z.enum(["approved", "escalated", "denied", "error"]),
  reason: z.string().optional(),
  customerReason: z.string().optional(),
  refundId: z.string().optional(),
  amount: z.number().optional(),
  runId: z.string().optional(),
  slaMinutes: z.number().optional(),
});

// Agent-facing on purpose only ever produces the autonomous-or-escalated outcome —
// "escalation-approval" is not reachable from any tool input, here or anywhere else.
// That value may only ever come from a real human decision recorded via the Escalation
// Desk (policy-review-workflow.ts's resume branch, which calls issueRefund() the plain
// function directly). If this tool exposed authorizedBy as a parameter, nothing would
// stop the agent — whether by its own reasoning or a customer talking it into it —
// from just calling it with "escalation-approval" and skipping the human entirely;
// that's not a hypothetical, it's exactly what a live test against this agent did
// before this was locked down.
//
// execute() below is unreachable in normal operation: refund-policy-gate.ts's
// beforeToolCall hook (wired in wismo-agent.ts's agent-level `hooks`) matches this
// tool's registration key and always returns `{proceed: false, output}` for a validly-
// owned request, before Mastra ever calls execute(). Left in place — a short,
// commented stub — only because createTool requires an execute function; if this ever
// actually runs, something upstream (most likely the gate's own toolName match, or the
// agent's `hooks` wiring) is broken.
export const paymentIssueRefund = createTool({
  id: "payment_issue_refund",
  description:
    "Attempt a damage/fault refund — autonomous when fully within policy, otherwise creates a real case in the Escalation Desk queue automatically. One call handles both outcomes; there is no separate escalation step. Pass itemIds (from present_return_item_picker's output) so the refund is scoped to the item(s) actually reported damaged, not the whole order — omit only for a single-item order. Pass a short, neutral problemSummary for a human reviewer in case this needs one.",
  inputSchema: z.object({
    orderId: z.string(),
    notCustomerFault: z
      .boolean()
      .optional()
      .describe("Whether the customer says the damage isn't their fault. The customer's OWN fault (pass false) means they described something THEY did — dropped it, cut or snagged it, spilled something, washed or altered it wrongly, misuse. Damage that appeared during ordinary use (a tear, split, seam, zipper or sole giving way while wearing or using it) is NOT their fault (pass true), however they word it, and so is anything that arrived damaged; \"it happened after it arrived\" alone is not their fault either way. When unsure, or when the customer says they don't know how it happened, omit this — a person decides; a wrong false is a final automatic denial. This is their claim, not a verified fact — it can never authorize an autonomous refund on its own, only shape what a human reviews if this escalates."),
    problemSummary: z.string().describe("A short, neutral summary of the issue, for a human reviewer in case this needs escalation. Use only what the customer actually said — never add a detail (when, where or how it happened) they did not give."),
    itemIds: z
      .array(z.string())
      .optional()
      .describe("The objectID of each item reported damaged, from present_return_item_picker. Omit for a single-item order."),
  }),
  outputSchema: paymentOutputSchema,
  execute: async () => ({
    status: "error" as const,
    reason:
      "payment_issue_refund's own execute() should be unreachable — refund-policy-gate.ts's beforeToolCall hook always intercepts this tool name before Mastra calls execute(). If you're seeing this, the gate isn't wired up (wismo-agent.ts's `hooks` option) or its toolName check no longer matches this tool's registration key.",
  }),
});

// Same shape as payment_issue_refund, for a plain return instead of a damage claim —
// no notCustomerFault input, since there's no fault attribution to make. See
// paymentIssueRefund's own comment above for why execute() here is an unreachable stub
// too — refund-policy-gate.ts handles both tools identically once it resolves the
// order/items, branching only on caseType ("refund" vs "plain_return") from there.
export const paymentIssueReturnRefund = createTool({
  id: "payment_issue_return_refund",
  description:
    "Attempt a plain return (no damage claim, no dispute) — autonomous when fully within policy, otherwise creates a real case in the Escalation Desk queue automatically. One call handles both outcomes; there is no separate escalation step. Refunds the order's own full amount by default; pass itemIds (from present_return_item_picker's output) to refund only the item(s) the customer selected there. If this escalates, customerReason is a ready-to-say sentence explaining why — say it to the customer verbatim (or very close to it), don't invent your own explanation or state the specific dollar/percent thresholds. Pass a short, neutral problemSummary for a human reviewer in case this needs one.",
  inputSchema: z.object({
    orderId: z.string(),
    problemSummary: z.string().describe("A short, neutral summary of why the customer is returning it, in their own words, for a human reviewer in case this needs escalation."),
    itemIds: z.array(z.string()).optional().describe("The objectID of each item the customer chose to return, from present_return_item_picker. Omit for a full-order return."),
  }),
  outputSchema: paymentOutputSchema,
  execute: async () => ({
    status: "error" as const,
    reason:
      "payment_issue_return_refund's own execute() should be unreachable — refund-policy-gate.ts's beforeToolCall hook always intercepts this tool name before Mastra calls execute(). If you're seeing this, the gate isn't wired up (wismo-agent.ts's `hooks` option) or its toolName check no longer matches this tool's registration key.",
  }),
});
