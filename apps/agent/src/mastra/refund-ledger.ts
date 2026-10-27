// Refund/coverage facts derived LIVE from durable workflow-run history — deliberately
// no separate mutable ledger. A resolved run's own step output (`status:"approved"`,
// `refundId`, `amount`, the frozen `itemIds` input) already IS the refund record,
// durably, in the same LibSQLStore every workflow run lives in (index.ts), so there is
// exactly one copy of this data: nothing to keep in sync and nothing to lose on a
// restart. Every call site of the functions below (`issueRefund`, the workflow step's
// own `execute()`, server.ts's `/resume` route, `return-item-picker.ts`'s tool) is
// already inside an async function, so reading from storage costs just one more `await`.
//
// `resetDemoData()` needs no special-casing for this either — it deletes every
// existing workflow run, and once those are gone, every query below returns nothing
// for that order on its own.
//
// Performance: GET /escalations/history already fetches EVERY run once, and calling the async
// functions below once per row (buildResolvedEntry/buildOrderRefundHistory) made each one start its
// OWN listWorkflowRuns() scan, all at once: N+1 full scans of the run store (442MB then, with
// base64 damage photos), which caused a real "JavaScript heap out of memory" crash inside libsql.
// So the core logic is a pure, no-I/O `extractRefundRecordsForOrder(orderId, runs)` that a caller
// that ALREADY has the runs array (server.ts's History route) calls directly; the async exports
// below do one fetch of their own only for callers that don't (issueRefund, decideReturnRefund, the
// /resume route, the tools), none of which run in a per-row loop.

import { mastra } from "./index";
import { getOrder } from "../fixtures/demo-data";

// Mirrors policy-review-workflow.ts's own exported POLICY_REVIEW_STEP_ID. Duplicated
// as a literal, deliberately, rather than imported: policy-review-workflow.ts already
// imports this module (for the functions below), so importing the constant back would
// make a real two-file circular import out of a value that can never change anyway —
// every already-persisted workflow snapshot is keyed by this exact string.
const POLICY_REVIEW_STEP_ID = "human-policy-review";

function parseSnapshot(snapshot: unknown): any {
  return typeof snapshot === "string" ? JSON.parse(snapshot) : snapshot;
}

export interface RefundRecord {
  // A real, resolved list of objectIDs this refund covered — always resolved via the
  // same "itemIds omitted means the whole order" convention issueRefund (payment.ts)
  // applies, so this is never left ambiguous.
  itemIds: string[];
  amount: number;
  // "approved," not "issued" — same rename as payment.ts's own
  // status field, for the same reason: this app only ever knows a refund was approved,
  // never that a real OMS payment actually completed.
  approvedAt: string;
  // The same id the customer/rep actually saw — read straight from the step's own
  // resolved output, not a second identifier minted separately.
  refundId: string;
}

// Minimal shape of what listWorkflowRuns() returns — not importing @mastra/core's own
// WorkflowRun type here to keep this module's only real dependency on the framework
// confined to the mastra singleton import below.
export interface RawWorkflowRun {
  runId: string;
  snapshot: unknown;
  updatedAt: Date | string;
}

// Pure — no I/O. Extracts this order's approved-refund records from an ALREADY-FETCHED
// runs array. Callers that don't already have `runs` in hand should use the async
// wrappers below instead, which fetch it themselves; a caller that's iterating every
// run anyway (server.ts's History route) should call this directly with the same
// array it already fetched, rather than triggering a second, redundant full scan per
// row — see this file's own header comment for the real crash that taught this.
export function extractRefundRecordsForOrder(orderId: string, runs: RawWorkflowRun[]): RefundRecord[] {
  const order = getOrder(orderId);
  const records: RefundRecord[] = [];

  for (const run of runs) {
    const snapshot = parseSnapshot(run.snapshot);
    const stepResult = snapshot?.context?.[POLICY_REVIEW_STEP_ID];
    // Same resolved-vs-suspended shape buildResolvedEntry (server.ts) already relies
    // on — a suspended run has no `.output` at all, only a `.suspendPayload`.
    if (!stepResult || stepResult.status === "suspended" || !stepResult.output) continue;

    const input = stepResult.payload as { orderId?: string; itemIds?: string[] } | undefined;
    if (!input || input.orderId !== orderId) continue;

    const { action, detail } = stepResult.output as { action?: string; detail?: Record<string, unknown> };
    // Accepts the older "issued" value too (the status this app writes was renamed to
    // "approved") — found live, not hypothetical: every workflow run resolved BEFORE the
    // rename has "issued" permanently baked into its own persisted output, and this
    // derivation is the ONLY thing standing between a customer and a genuine
    // double-refund. Rejecting "issued" outright would have silently made every pre-rename
    // refund invisible to alreadyRefundedItemIds — confirmed live against a real
    // historical run that would otherwise have been refundable a second time. Never
    // written going forward — issueRefund (payment.ts) only ever produces "approved" now.
    if (action !== "executed" || (detail?.status !== "approved" && detail?.status !== "issued")) continue;

    const refundId = detail.refundId as string | undefined;
    const amount = detail.amount as number | undefined;
    if (!refundId || amount === undefined) continue;

    const resolvedItemIds = input.itemIds ?? order?.items.map((item) => item.objectID) ?? [];
    const approvedAt = run.updatedAt instanceof Date ? run.updatedAt.toISOString() : String(run.updatedAt);
    records.push({ itemIds: resolvedItemIds, amount, approvedAt, refundId });
  }

  return records.sort((a, b) => new Date(a.approvedAt).getTime() - new Date(b.approvedAt).getTime());
}

// Pure — no I/O. The refund amount of every OTHER case still open (suspended) on this order — the same
// definition case-lookup.ts's findOpenCasesForOrder + refundAmountOf use for the gate's own figure (a
// contract test keeps the two in step), duplicated here only because case-lookup.ts imports the workflow
// that imports this module. `excludeRunId` is the case the caller is acting FOR: its own ask is the
// request being decided, never "another case".
export function extractOpenCaseAmountForOrder(orderId: string, runs: RawWorkflowRun[], excludeRunId?: string): number {
  let total = 0;
  for (const run of runs) {
    if (excludeRunId !== undefined && run.runId === excludeRunId) continue;
    const step = parseSnapshot(run.snapshot)?.context?.[POLICY_REVIEW_STEP_ID];
    if (step?.status !== "suspended" || step.payload?.orderId !== orderId) continue;
    total += step.payload?.refundAmount ?? 0;
  }
  return total;
}

// Read LIVE, at the moment of the call — issueRefund (payment.ts) uses this right before it authorizes an
// automatic refund, so the policy re-check sees the cases open NOW, not the figure the workflow was started
// with (a case can open in between).
export async function pendingAmountFromOtherOpenCases(orderId: string, excludeRunId?: string): Promise<number> {
  const workflow = mastra.getWorkflow("policyReviewWorkflow");
  if (!workflow) throw new Error("policyReviewWorkflow is not registered — cannot read the open cases on an order.");
  const { runs } = await workflow.listWorkflowRuns({});
  return extractOpenCaseAmountForOrder(orderId, runs, excludeRunId);
}

// Fetches its own single scan — only for a caller that doesn't already have `runs` in
// hand. Never call this from inside a loop over runs already fetched elsewhere; use
// extractRefundRecordsForOrder directly against that same array instead.
async function resolvedRefundRecordsForOrder(orderId: string): Promise<RefundRecord[]> {
  const workflow = mastra.getWorkflow("policyReviewWorkflow");
  if (!workflow) return [];
  const { runs } = await workflow.listWorkflowRuns({});
  return extractRefundRecordsForOrder(orderId, runs);
}

// Every refund actually approved for this order, oldest first — the real audit trail
// behind alreadyRefundedItemIds/totalRefundedForOrder below, surfaced directly to a
// rep (server.ts) rather than only ever folded into an aggregate number or a bare
// pass/fail check.
export async function refundRecordsForOrder(orderId: string): Promise<RefundRecord[]> {
  return resolvedRefundRecordsForOrder(orderId);
}

// Every objectID already covered by a prior refund on this order.
export async function alreadyRefundedItemIds(orderId: string): Promise<Set<string>> {
  const records = await resolvedRefundRecordsForOrder(orderId);
  const covered = new Set<string>();
  for (const record of records) {
    for (const id of record.itemIds) covered.add(id);
  }
  return covered;
}

// The cumulative dollar total already refunded for this order — what a fresh
// decideReturnRefund call folds in alongside the new request, so two separate
// under-ceiling requests can't add up to an over-ceiling total between them.
export async function totalRefundedForOrder(orderId: string): Promise<number> {
  const records = await resolvedRefundRecordsForOrder(orderId);
  return records.reduce((sum, record) => sum + record.amount, 0);
}
