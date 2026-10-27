import { caseStateLocks } from "../case-state";
import { POLICY_REVIEW_STEP_ID, policyReviewWorkflow } from "../workflows/policy-review-workflow";
import { getOrder, type Order } from "../../fixtures/demo-data";
import { getDisagreementTicket } from "../disagreement-tickets";

// Structural rather than the full `Mastra` type — a tool's execute context exposes
// `context.mastra` as a narrower MastraUnion that's missing some of Mastra's own
// private/internal members, so a parameter typed as the full class rejects it at the
// call site (the escalation tools all pass context.mastra). Only getStorage() is actually
// used here.
interface StorageCapableMastra {
  getStorage(): { getStore(domain: "workflows"): Promise<any> } | undefined;
}

function parseSnapshot(snapshot: unknown): any {
  return typeof snapshot === "string" ? JSON.parse(snapshot) : snapshot;
}

// One read of the case runs for a caller that asks several of the lookups in this file. Returns something with the
// same listWorkflowRuns shape, so every lookup accepts it in place of the workflow. Each lookup on its own re-reads
// every run from storage (a run can carry a customer's photo), so two or three of them in one tool call meant two
// or three full reads.
export async function readCaseRunsOnce(workflow: { listWorkflowRuns(args?: unknown): Promise<{ runs: unknown[] }> }): Promise<{ listWorkflowRuns(args?: unknown): Promise<{ runs: unknown[] }> }> {
  const result = await workflow.listWorkflowRuns({});
  return { listWorkflowRuns: async () => result };
}

// workflow.listWorkflowRuns() hands back updatedAt as a real Date instance, not a
// string — harmless everywhere it only ever gets sorted or JSON-serialized (Hono's
// c.json() calls Date#toJSON() for free), but a real, live-reproduced failure the one
// place it flows into a Zod-validated workflow input (relatedOpenCaseSuspendedAt):
// "WORKFLOW_SCHEMA_VALIDATION_FAILED: expected string, received Date" — thrown mid-run,
// after the new run had already been created and the OLDER case had already been
// patched to point at it, leaving that older case referencing a run stuck in "pending"
// forever. Normalized once, here, so every CaseRunMatch.updatedAt is honestly a string
// the moment it's read, not just wherever a caller happens to serialize it through JSON.
function toIso(value: unknown): string {
  return new Date(value as string | number | Date).toISOString();
}

export interface CaseRunMatch {
  runId: string;
  // The run's own last-updated time (createdAt for a case nobody has acted on yet,
  // bumped forward by any resume/re-suspend or by linkRelatedCase's own patch below) —
  // carried through so a caller can show "this case vs. that case, which is older" (see
  // relatedOpenCaseSuspendedAt) without a second lookup.
  updatedAt: string;
  step: any;
}

// "The most recent case for this order," for check_escalation_status's order-wide form. An
// order can rack up more than one case over time (a second issue, or a re-suspended
// "request more info" loop); the latest is the live one.
export async function findMostRecentCaseRun(workflow: { listWorkflowRuns(args?: unknown): Promise<{ runs: unknown[] }> }, orderId: string): Promise<CaseRunMatch | null> {
  const { runs } = await workflow.listWorkflowRuns({});
  const matches = (runs as any[])
    .map((run) => ({
      runId: run.runId as string,
      updatedAt: toIso(run.updatedAt),
      step: parseSnapshot(run.snapshot)?.context?.[POLICY_REVIEW_STEP_ID],
    }))
    .filter(({ step }) => step?.payload?.orderId === orderId)
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

  return matches.length > 0 ? { runId: matches[0].runId, updatedAt: matches[0].updatedAt, step: matches[0].step } : null;
}

// Turns whatever the model passed as "itemIds" into REAL objectIDs for this order: an objectID as-is,
// else a product name (exact, ignoring case, else one containing the other). The model has been seen
// passing names ("Adventure Merino Crew Socks") and invented codes in this slot — these lookups are
// read-only and the answer is only ever about the customer's own order, so being forgiving here is
// safe in a way the money-moving tools' strict resolveOrderItems rightly is not. Anything that
// matches nothing is dropped; undefined means "no usable item filter" (the caller then goes order-wide).
export function resolveItemRefs(order: Order, refs: string[] | undefined): string[] | undefined {
  if (!refs || refs.length === 0) return undefined;
  const resolved = new Set<string>();
  for (const ref of refs) {
    const wanted = ref.trim().toLowerCase();
    if (!wanted) continue;
    const item =
      order.items.find((candidate) => candidate.objectID.toLowerCase() === wanted) ??
      order.items.find((candidate) => candidate.name.toLowerCase() === wanted) ??
      order.items.find((candidate) => candidate.name.toLowerCase().includes(wanted) || wanted.includes(candidate.name.toLowerCase()));
    if (item) resolved.add(item.objectID);
  }
  return resolved.size > 0 ? [...resolved] : undefined;
}

// The most recent case — ANY status, open or resolved — about specific item(s) on an order.
// findMostRecentCaseRun above is order-wide and so the wrong answer to "where does my SOCKS
// refund stand?" on a multi-item order: the newest case on the order may be about the pants.
// A delivery dispute is about the whole order, not an item, so it never matches here; a case
// with no item list (a whole-order claim) overlaps every item (returnScopesOverlap).
export async function findCasesForItems(
  workflow: { listWorkflowRuns(args?: unknown): Promise<{ runs: unknown[] }> },
  orderId: string,
  itemIds: string[]
): Promise<CaseRunMatch[]> {
  const { runs } = await workflow.listWorkflowRuns({});
  return (runs as any[])
    .map((run) => ({
      runId: run.runId as string,
      updatedAt: toIso(run.updatedAt),
      step: parseSnapshot(run.snapshot)?.context?.[POLICY_REVIEW_STEP_ID],
    }))
    .filter((match) => match.step?.payload?.orderId === orderId && caseTypeOf(match) !== "delivery_dispute" && returnScopesOverlap(itemIdsOf(match), itemIds))
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

// Delivery disputes on an order that have been DECIDED (by the policy on its own, or by a rep), newest first. A
// dispute is about the whole order, so findCasesForItems never returns one (right for an item-level status check, where
// a socks refund must not surface the order's dispute). A customer disagreeing with a dispute's outcome still needs it
// found, which is what this is for: offer_escalation_to_support uses it for a whole-order matter.
export async function findDecidedDisputes(
  workflow: { listWorkflowRuns(args?: unknown): Promise<{ runs: unknown[] }> },
  orderId: string
): Promise<CaseRunMatch[]> {
  const { runs } = await workflow.listWorkflowRuns({});
  return (runs as any[])
    .map((run) => ({
      runId: run.runId as string,
      updatedAt: toIso(run.updatedAt),
      step: parseSnapshot(run.snapshot)?.context?.[POLICY_REVIEW_STEP_ID],
    }))
    .filter((match) => match.step?.payload?.orderId === orderId && caseTypeOf(match) === "delivery_dispute" && match.step?.status === "success")
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

export async function findMostRecentCaseForItems(
  workflow: { listWorkflowRuns(args?: unknown): Promise<{ runs: unknown[] }> },
  orderId: string,
  itemIds: string[]
): Promise<CaseRunMatch | null> {
  return (await findCasesForItems(workflow, orderId, itemIds))[0] ?? null;
}

// Is there already a SUPPORT ticket for these item(s) — whichever case it hangs off? Three ways one
// exists: the customer disagreed with a decision and escalated (a disagreement ticket, recorded
// against the ORIGINAL case's id — so a newer case about the same item must not hide it), a
// specialist's own "escalate to support", or the SLA sweep opening one on a timeout (both leave a
// ticketId on the resolved case's own output). This is the one place "is there a support case for
// this item?" is decided, shared by check_escalation_status (what to tell the customer) and
// offer_escalation_to_support (whether offering a new one is allowed at all).
export async function findSupportTicketForItems(
  workflow: { listWorkflowRuns(args?: unknown): Promise<{ runs: unknown[] }> },
  orderId: string,
  itemIds: string[]
): Promise<{ caseId: string; ticketId: string } | undefined> {
  for (const match of await findCasesForItems(workflow, orderId, itemIds)) {
    const disagreement = await getDisagreementTicket(match.runId);
    if (disagreement) return { caseId: match.runId, ticketId: disagreement.ticketId };
    if (match.step?.status === "success" && match.step.output?.action === "escalated_to_support") {
      const ticketId = match.step.output.detail?.ticketId as string | undefined;
      if (ticketId) return { caseId: match.runId, ticketId };
    }
  }
  return undefined;
}

// Per item on an order: does it already have a case, and where does it stand? Surfaced in
// commerce_get_order's result, so the model knows when a customer picks the order — long before any
// claim — that, say, the belt already has a $45 refund approved, instead of finding out (or not) at
// the moment it tries to file. Facts only; what to SAY is the model's job and what is ALLOWED is the
// payment gate's (refund-policy-gate.ts), which does not trust this. Only items with a case appear.
//   under_review    a case on it is still open with a specialist (wins over anything older)
//   refund_approved a refund was approved for it
//   with_support    no refund was approved, but a SUPPORT TICKET exists for it — the case timed out
//                   into one, a specialist escalated it, or the customer disagreed and escalated
//   declined        its only claims so far were refused (nothing was paid; it can be claimed again)
// ticketId: a support ticket exists for it (see findSupportTicketForItems for the three ways).
export interface ItemCoverage {
  state: "under_review" | "refund_approved" | "with_support" | "declined";
  caseId: string;
  refundAmount?: number;
  ticketId?: string;
}

export async function describeItemCoverage(
  workflow: { listWorkflowRuns(args?: unknown): Promise<{ runs: unknown[] }> },
  order: Order
): Promise<Map<string, ItemCoverage>> {
  const { runs } = await workflow.listWorkflowRuns({});
  const matches = (runs as any[])
    .map((run) => ({
      runId: run.runId as string,
      updatedAt: toIso(run.updatedAt),
      step: parseSnapshot(run.snapshot)?.context?.[POLICY_REVIEW_STEP_ID],
    }))
    .filter((match) => match.step?.payload?.orderId === order.id && caseTypeOf(match) !== "delivery_dispute")
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

  const coverage = new Map<string, ItemCoverage>();
  for (const item of order.items) {
    const about = matches.filter((match) => returnScopesOverlap(itemIdsOf(match), [item.objectID]));
    if (about.length === 0) continue;

    let ticketId: string | undefined;
    for (const match of about) {
      const disagreement = await getDisagreementTicket(match.runId);
      ticketId = disagreement?.ticketId ?? (match.step?.status === "success" && match.step.output?.action === "escalated_to_support" ? (match.step.output.detail?.ticketId as string | undefined) : undefined);
      if (ticketId) break;
    }

    const open = about.find((match) => match.step?.status === "suspended");
    const approved = about.find((match) => match.step?.status === "success" && match.step.output?.action === "executed" && (match.step.output.detail?.status === "approved" || match.step.output.detail?.status === "issued"));
    const declined = about.find((match) => match.step?.status === "success" && match.step.output?.action === "denied");
    if (open) coverage.set(item.objectID, { state: "under_review", caseId: open.runId, ticketId });
    else if (approved) coverage.set(item.objectID, { state: "refund_approved", caseId: approved.runId, refundAmount: approved.step.output.detail?.amount, ticketId });
    else if (ticketId) coverage.set(item.objectID, { state: "with_support", caseId: about[0].runId, ticketId });
    else if (declined) coverage.set(item.objectID, { state: "declined", caseId: declined.runId });
  }
  return coverage;
}

// The same question for a DELIVERY DISPUTE, which is about the whole order rather than any item:
// is one still open, did it already become a support ticket (it timed out, a specialist escalated
// it, or the customer disagreed with its outcome and escalated), or was it already decided? In every case the
// customer already has a case, so a new one is never opened — they are reminded of the case number (or the
// ticket, or the decision) and, for a decision they dispute, offered escalation to support.
export interface DisputeCoverage {
  state: "under_review" | "with_support" | "approved" | "denied";
  caseId: string;
  ticketId?: string;
  refundAmount?: number; // approved only: what was actually approved (a rep's "modify" can differ from the order total)
}

export async function describeDispute(
  workflow: { listWorkflowRuns(args?: unknown): Promise<{ runs: unknown[] }> },
  orderId: string
): Promise<DisputeCoverage | undefined> {
  const { runs } = await workflow.listWorkflowRuns({});
  const matches = (runs as any[])
    .map((run) => ({
      runId: run.runId as string,
      updatedAt: toIso(run.updatedAt),
      step: parseSnapshot(run.snapshot)?.context?.[POLICY_REVIEW_STEP_ID],
    }))
    .filter((match) => match.step?.payload?.orderId === orderId && caseTypeOf(match) === "delivery_dispute")
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

  const open = matches.find((match) => match.step?.status === "suspended");
  if (open) return { state: "under_review", caseId: open.runId, ticketId: open.step.suspendPayload?.ticketId };
  for (const match of matches) {
    const disagreement = await getDisagreementTicket(match.runId);
    const ticketId = disagreement?.ticketId ?? (match.step?.status === "success" && match.step.output?.action === "escalated_to_support" ? (match.step.output.detail?.ticketId as string | undefined) : undefined);
    if (ticketId) return { state: "with_support", caseId: match.runId, ticketId };
  }
  // A dispute that was DECIDED (by a specialist or the policy) and has no ticket: the customer was told the outcome, so
  // raising it again is a disagreement with that decision, not a new matter. Newest first, like everything above.
  for (const match of matches) {
    if (match.step?.status !== "success") continue;
    const output = match.step.output;
    if (output?.action === "denied") return { state: "denied", caseId: match.runId };
    if (output?.action === "executed" && (output.detail?.status === "approved" || output.detail?.status === "issued")) return { state: "approved", caseId: match.runId, refundAmount: output.detail?.amount as number | undefined };
  }
  return undefined;
}

// Guards all three escalation tools (escalate_for_policy_review, _delivery_dispute, _return_refund)
// against creating a second live case for an order that already has one suspended. Without it, a
// customer reply that restates their issue (answering a rep's "can you send a photo?" almost always
// does) reads like a fresh damage claim: the model retries payment_issue_refund, is rejected again,
// and escalates a second time, orphaning the original case (its countdown is never paused or
// refreshed again) while an unrelated second countdown appears. The fix is here, not in the workflow,
// because the workflow only ever sees one run at a time; only a cross-run lookup can catch it. It
// re-queries and filters to suspended runs BEFORE picking the most recent, rather than reusing
// findMostRecentCaseRun: "most recent" there spans all statuses, so a newer resolved case would hide
// an older, genuinely open one.
//
// Returns EVERY open case on the order, not just the most recent: since escalation is caseType and
// item scoped, an order can carry several at once (a return on one item beside a damage claim on
// another). Looking only at the latest let a THIRD item's return create a duplicate case for an item
// that already had one. The duplicate-case check must compare against all of them, and the
// related-case cross-link must notify every other open case.
export async function findOpenCasesForOrder(workflow: { listWorkflowRuns(args?: unknown): Promise<{ runs: unknown[] }> }, orderId: string): Promise<CaseRunMatch[]> {
  const { runs } = await workflow.listWorkflowRuns({});
  return (runs as any[])
    .map((run) => ({
      runId: run.runId as string,
      updatedAt: toIso(run.updatedAt),
      step: parseSnapshot(run.snapshot)?.context?.[POLICY_REVIEW_STEP_ID],
    }))
    .filter(({ step }) => step?.payload?.orderId === orderId && step?.status === "suspended")
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

// Cross-references a case that ALREADY existed when a new one was opened against it
// (see the escalate_* tools' relatedOpenCaseIds handling below) — otherwise only the NEW
// case ever points at the old one, and a rep who opens the older case first (it's been
// sitting longer, so the queue's own priority/age sort surfaces it first) has no idea a
// second, possibly-conflicting claim landed on the same order afterward. Call this
// BEFORE creating the new case, not after — persisting a snapshot bumps that run's own
// updatedAt to now, and findOpenCasesForOrder's own sort would otherwise put the
// just-linked OLD case ahead of the brand-new one. Patching the OLD case(s) first, then
// creating the new one, keeps the new case's own updatedAt the most recent of the group.
// Same direct-snapshot-patch pattern as case-sync.ts (see its own comment for the
// workflowName gotcha: policyReviewWorkflow.id, not the "policyReviewWorkflow"
// registration key). Appends to the old case's own relatedOpenCaseIds list rather than
// overwriting a single field — an order can carry more than two simultaneously-open
// cases, and every one of them deserves to know about every other, not just whichever
// linked most recently.
export async function linkRelatedCase(mastraInstance: StorageCapableMastra, existingRunId: string, newRunId: string, newRunCreatedAt: string): Promise<void> {
  return caseStateLocks.withLock(existingRunId, async () => {
  const workflowsStore = await mastraInstance.getStorage()?.getStore("workflows");
  if (!workflowsStore) return;
  const snapshot: any = await workflowsStore.loadWorkflowSnapshot({ workflowName: policyReviewWorkflow.id, runId: existingRunId });
  const stepData = snapshot?.context?.[POLICY_REVIEW_STEP_ID];
  if (stepData?.status !== "suspended" || !stepData.suspendPayload) return;
  const existing: { runId: string; createdAt: string }[] = stepData.suspendPayload.relatedOpenCaseIds ?? [];
  stepData.suspendPayload.relatedOpenCaseIds = [...existing.filter((entry) => entry.runId !== newRunId), { runId: newRunId, createdAt: newRunCreatedAt }];
  await workflowsStore.persistWorkflowSnapshot({ workflowName: policyReviewWorkflow.id, runId: existingRunId, snapshot });
  });
}

// caseType defaults to "refund" at the schema level (humanPolicyReviewInput), but a
// case created before that field existed — or read via this any-typed step snapshot —
// might not have it set explicitly, so callers comparing case types read it through
// here rather than each re-deriving the same fallback.
export function caseTypeOf(match: CaseRunMatch): string {
  return match.step?.payload?.caseType ?? "refund";
}

// The case's true creation time (humanPolicyReviewInput's own createdAt, frozen for the
// run's whole lifetime) — deliberately NOT the same as CaseRunMatch.updatedAt above,
// which tracks "last touched" and gets bumped by an unrelated resume or a
// linkRelatedCase patch. A caller wanting "when did this case actually open" (the
// related-case banner's "which one is first") needs this, not updatedAt. A case
// created before this field existed falls back to updatedAt as its best guess.
export function createdAtOf(match: CaseRunMatch): string {
  return match.step?.payload?.createdAt ?? match.updatedAt;
}

// Only meaningful for caseType "plain_return" — undefined means "the whole order" (see
// humanPolicyReviewInput's own itemIds comment), which is why the overlap check below
// treats a missing list on either side as covering everything rather than nothing.
export function itemIdsOf(match: CaseRunMatch): string[] | undefined {
  return match.step?.payload?.itemIds;
}

// The dollar amount this case is asking for, not yet decided either way — used to
// project what an order's cumulative refund total WOULD be if this case and a new
// return both got approved (the return refund policy's pendingFromOtherCase), so an
// obviously-independent return doesn't need to wait on a human just because something
// else is open on the same order, while one that really could push the order over its
// ceiling together with the open case still does.
export function refundAmountOf(match: CaseRunMatch): number {
  return match.step?.payload?.refundAmount ?? 0;
}

// Two plain-return claims on the same order are "the same issue continuing" only if
// they're actually about the same item(s) — a second, different item is a genuinely
// separate return, not a restatement, even though both share caseType "plain_return".
// undefined on either side means "the whole order" (no itemIds picker used), which
// overlaps with anything by definition.
export function returnScopesOverlap(a: string[] | undefined, b: string[] | undefined): boolean {
  if (!a || !b) return true;
  return a.some((id) => b.includes(id));
}

// Same narrow shape as StorageCapableMastra above, for the one other Mastra member a
// caller here needs — a tool's execute context (and a Mastra tool-hook's own context,
// which is the identical object passed straight through) exposes context.mastra as a
// MastraUnion missing some private members, so the full `Mastra` class type rejects it
// at the call site.
interface WorkflowCapableMastra {
  getWorkflow(id: string): { listWorkflowRuns(args?: unknown): Promise<{ runs: unknown[] }> } | undefined;
}

export interface OpenCaseCheck {
  // Set when an existing open case of the SAME caseType already covers one or more of
  // the requested itemIds — the caller should reject outright, never build a new case.
  duplicateCase?: CaseRunMatch;
  // Every OTHER open case on the order (any type) — empty when duplicateCase is set,
  // since a duplicate short-circuits before this is meaningful. Callers derive whatever
  // they need from this: relatedOpenCaseIds (both case types, via createdAtOf), and —
  // only for plain_return, via refundAmountOf — the combined-ceiling projection amount.
  otherOpenCases: CaseRunMatch[];
}

// Shared by refund-policy-gate.ts for BOTH autonomous-eligible case types ("refund" and
// "plain_return") — one function instead of a bespoke duplicate-check per case type, so
// a third autonomous-eligible case type later just calls this with its own caseType.
// caseType "delivery_dispute" isn't item-scoped at all (see returnScopesOverlap's own
// "undefined on either side means the whole order" fallback — passing itemIds:undefined
// for that caseType degrades correctly to an order-wide match, matching
// delivery-dispute.ts's own always-order-wide duplicate check, though that tool doesn't
// use this helper since it has no autonomous path to gate). Checks EVERY open case on
// the order (findOpenCasesForOrder), not just the most recently touched one — see that
// function's own comment for why.
export async function checkOpenCasesFor(mastraInstance: WorkflowCapableMastra | undefined, orderId: string, caseType: string, itemIds: string[] | undefined): Promise<OpenCaseCheck> {
  const workflow = mastraInstance?.getWorkflow("policyReviewWorkflow");
  if (!workflow) return { otherOpenCases: [] };
  const openCases = await findOpenCasesForOrder(workflow, orderId);
  const duplicateCase = openCases.find((match) => caseTypeOf(match) === caseType && returnScopesOverlap(itemIdsOf(match), itemIds));
  if (duplicateCase) return { duplicateCase, otherOpenCases: [] };
  return { otherOpenCases: openCases };
}

// server.ts's onFinish only syncs an order's transcript (and refreshes the countdown of a case
// awaiting the customer) when SOME tool call touched that order this turn or an earlier one
// (request-context.ts's markOrderTouched / touched-orders-from-history.ts). That breaks exactly
// where it matters: a customer answering a specialist's follow-up ("could anyone else have
// signed?") often needs no tool call at all, so the sync never fires and the countdown sits frozen.
// This closes the gap unconditionally: any case THIS session escalated that is still waiting on a
// reply is synced every turn, whatever tools ran, since any message in the chat could be the answer.
export async function findAwaitingCustomerOrderIdsForSession(
  workflow: { listWorkflowRuns(args?: unknown): Promise<{ runs: unknown[] }> },
  sessionId: string
): Promise<string[]> {
  const { runs } = await workflow.listWorkflowRuns({});
  const orderIds = new Set<string>();
  for (const run of runs as any[]) {
    const step = parseSnapshot(run.snapshot)?.context?.[POLICY_REVIEW_STEP_ID];
    const payload = step?.suspendPayload;
    if (step?.status === "suspended" && payload?.reasonCode === "awaiting-customer-response" && payload?.sessionId === sessionId && typeof payload?.orderId === "string") {
      orderIds.add(payload.orderId);
    }
  }
  return [...orderIds];
}

export interface ConversationCaseSummary {
  // Cases this conversation opened that are still waiting on somebody — suspended in the
  // Escalation Desk, whether for a rep's decision or for the customer's own reply.
  open: number;
  // Cases this conversation opened that have reached a final outcome — a refund approved or
  // denied (by the agent on its own or by a rep), or handed to a support ticket on a
  // timeout. An autonomous refund counts: every attempt creates a workflow run now
  // (refund-policy-gate.ts), so "resolved in this chat" is one query, not two.
  resolved: number;
}

// The deterministic guard behind offer_new_chat (mastra/tools/offer-new-chat.ts) — a
// chat may only be broken into a fresh one when it has something resolved AND nothing
// still open, checked here from the durable workflow runs, so the AGENT's own
// conversational judgment can never talk a conversation with a pending case into
// starting over (the customer would lose the thread the specialist's follow-up
// question lands in). A run whose step is anything other than "suspended" or
// "success" (a failed or half-written run) counts as neither.
//
// Reads the step's frozen `payload` (its input) for conversationId, so it works for a
// suspended and a finished run alike — see humanPolicyReviewInput's conversationId
// comment. Scans every run like findOpenCasesForOrder does; only called from
// offer_new_chat's own execute(), which only ever runs when the model has already
// decided to call it, so this is not on the path of an ordinary message.
export async function summarizeConversationCases(
  workflow: { listWorkflowRuns(args?: unknown): Promise<{ runs: unknown[] }> },
  conversationId: string
): Promise<ConversationCaseSummary> {
  const { runs } = await workflow.listWorkflowRuns({});
  const summary: ConversationCaseSummary = { open: 0, resolved: 0 };
  for (const run of runs as any[]) {
    const step = parseSnapshot(run.snapshot)?.context?.[POLICY_REVIEW_STEP_ID];
    if (step?.payload?.conversationId !== conversationId) continue;
    if (step.status === "suspended") summary.open++;
    else if (step.status === "success") summary.resolved++;
  }
  return summary;
}

// Used by BOTH halves of the customer-facing disagreement flow: offer_escalation_to_
// support's own execute() (mastra/tools/offer-escalation.ts — deciding whether to
// render the card at all) and server.ts's POST /chat/:agentId/escalate-disagreement
// (deriving what to actually put in the ticket once the customer clicks it).
// Deliberately re-derived independently by each rather than trusted from what the
// other already found: the same "never trust the caller for a fact that gates a real
// action" discipline every money/policy path in this app already follows, applied to
// "does a resolved case actually exist to escalate." Same scan/filter shape as
// findOpenCasesForOrder, just scoped by conversationId and filtered to "success"
// (resolved) instead of "suspended" — an order/conversation can only ever disagree
// with its MOST RECENT resolution, so this returns one match, not every resolved case
// ever opened in the conversation.
export async function findMostRecentResolvedCaseForConversation(
  workflow: { listWorkflowRuns(args?: unknown): Promise<{ runs: unknown[] }> },
  conversationId: string
): Promise<CaseRunMatch | null> {
  const { runs } = await workflow.listWorkflowRuns({});
  const matches = (runs as any[])
    .map((run) => ({
      runId: run.runId as string,
      updatedAt: toIso(run.updatedAt),
      step: parseSnapshot(run.snapshot)?.context?.[POLICY_REVIEW_STEP_ID],
    }))
    .filter(({ step }) => step?.payload?.conversationId === conversationId && step?.status === "success")
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

  return matches.length > 0 ? { runId: matches[0].runId, updatedAt: matches[0].updatedAt, step: matches[0].step } : null;
}

// "Is this case ID a real case, and does it belong to this customer?" — the ID IS the
// workflow's own runId (case-id.ts), so this is one getWorkflowRunById(), not a search.
// Shared by lookup_case_by_id (the customer asked about an ID) and case-id-guard.ts (the agent
// is about to state one), so both answer the question the same way.
//
// getWorkflowRunById's step data carries no customerId once a case is resolved (only
// .payload.orderId survives resolution — verified against a real resolved run; .suspendPayload,
// which does carry customerId, only exists while still suspended) — so ownership is checked
// the way every other tool here does it: re-fetch the real order and compare, never trust
// anything on the workflow payload itself. Returns null for "no such case" and for "someone
// else's case" alike, so a caller can't be used to probe which IDs exist.
export interface CustomerCase {
  step: any;
  orderId: string;
  order: Order;
}

export async function findCaseForCustomer(
  workflow: { getWorkflowRunById(runId: string): Promise<unknown> },
  caseId: string,
  customerId: string
): Promise<CustomerCase | null> {
  const run: any = await workflow.getWorkflowRunById(caseId);
  const step = run?.steps?.[POLICY_REVIEW_STEP_ID];
  const orderId: string | undefined = step?.payload?.orderId;
  if (!step || !orderId) return null;
  const order = getOrder(orderId);
  if (!order || order.customerId !== customerId) return null;
  return { step, orderId, order };
}
