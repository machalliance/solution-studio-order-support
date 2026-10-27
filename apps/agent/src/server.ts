import { type ReplayEvent } from "./mastra/event-history";
import { caseStateLocks, reviewDeadline } from "./mastra/case-state";
import { parsePolicyJson } from "../../../shared/parse-policy-json";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { handleChatStream } from "@mastra/ai-sdk";
import { RequestContext } from "@mastra/core/request-context";
import { computeTraceStatus } from "@mastra/core/storage";
import { createUIMessageStreamResponse, readUIMessageStream } from "ai";
import { mastra } from "./mastra";
import { config } from "./config";
import { humanDecisionSchema, POLICY_REVIEW_STEP_ID, orderContextLine, type SuspendPayload, type HumanDecision, repComment } from "./mastra/workflows/policy-review-workflow";
import { SESSION_CUSTOMER_ID_KEY, SESSION_ID_KEY, CONVERSATION_ID_KEY, getTouchedOrderIds, getCreatedCaseIds, setTurnFacts } from "./mastra/request-context";
import { turnToolText } from "./mastra/claim-grounding-guard";
import { getShipmentInfo, orderIdFromTrackingNumber, generateReturnLabel, getReturnLabelInfo, orderIdFromReturnTrackingNumber, itemIdsFromReturnTrackingNumber } from "./mastra/tools/shipping";
import { caseEventHistory, caseEvents, type CaseResolvedEvent, type CaseMoreInfoEvent, type CaseEscalationStartedEvent } from "./mastra/case-events";
import { syncCaseTranscriptForOrder, syncCreatedCaseTranscripts, freezeResolvedTranscript } from "./mastra/tools/case-sync";
import { findAwaitingCustomerOrderIdsForSession, findMostRecentResolvedCaseForConversation } from "./mastra/tools/case-lookup";
import { escalateSupportTicket } from "./mastra/tools/escalate-support-ticket";
import { touchedOrderIdsFromHistory } from "./mastra/touched-orders-from-history";
import { resetDemoData } from "./mastra/demo-seed";
import { notifyCustomer } from "./mastra/notifications";
import { detectIdentifierLeak } from "./mastra/response-leak-guard";
import { markSessionConnected, markSessionDisconnected, isSessionConnected } from "./mastra/active-sessions";
import { formatMoney } from "./lib/money";
import {
  getEscalationSlaMinutes,
  setEscalationSlaMinutes,
  getSupportTicketContactHours,
  setSupportTicketContactHours,
  getMaxAutonomousAmount,
  setMaxAutonomousAmount,
  getHighPriorityAmountThreshold,
  setHighPriorityAmountThreshold,
} from "./mastra/runtime-settings";
import { livePolicySetting } from "./mastra/policy/live-policy";
import { customers, getCustomer, getOrder, getOrdersForCustomer, products, resolveOrderItems, orderItemsSummary, type Order } from "./fixtures/demo-data";
import { refundRecordsForOrder, alreadyRefundedItemIds, extractRefundRecordsForOrder, type RawWorkflowRun } from "./mastra/refund-ledger";
import { getActiveVersion, activatePolicy, listVersions, rollbackTo, liveReasonCodes } from "./mastra/policy/repository";
import { runPolicyHelper } from "./mastra/policy/helper";
import { validatePolicyDocument } from "./mastra/policy/validate";
import { describeCatalog } from "./mastra/policy/catalog";
import { buildPolicySynopsis } from "./mastra/policy/synopsis";
import type { PolicyDocument } from "./mastra/policy/schema";
import { createKeyedLock } from "./mastra/keyed-lock";
import { classifyChatError } from "./mastra/chat-errors";
import { cleanText, sanitizeIncomingMessage } from "./mastra/chat-input";
import { beginTurn, endTurn, recordNotice } from "./mastra/turn-notices";
import { MAX_THREAD_MESSAGES, appendToThread, getThread, lastUserText, saveThread, historyForRetry, withThreadLock, type StoredMessage } from "./mastra/conversation-threads";
import { caseMoreInfoMessage, caseResolvedMessage } from "../../../shared/case-notices";
import { getDisagreementTicket, recordDisagreementTicket, getDisagreementTicketsForOrder } from "./mastra/disagreement-tickets";

// The one backend both frontends talk to: the Escalation Desk queries/resumes
// suspended runs (every read goes straight to Mastra's own workflow-run storage — no
// separate queue/database, see policy-review-workflow.ts's header comment), and the
// storefront streams a live conversation with wismoAgent via /chat/:agentId. One
// Mastra instance, one process, two HTTP clients — deliberately not two separate
// Mastra instances each with their own storage connection.

// Guards against two chat turns running concurrently for the SAME session. A turn can keep
// working in the background well after its reply is visible, so the customer's next click can
// start a second request while the first is still running, and two streams writing into one
// client-side thread render out of order. ChatWidget.tsx's own guard (appendIfIdle, which checks
// isRunning) is not enough on its own: isRunning flickers false in the gaps between a turn's
// hidden internal steps. This is the server-side backstop: a session already mid-turn gets a
// clean 429 turn_in_progress instead of a second, genuinely concurrent generation.
const activeChatTurns = new Map<string, { token: symbol; timeout: ReturnType<typeof setTimeout> }>();
function releaseChatTurn(sessionId: string, token: symbol | undefined): void {
  const current = activeChatTurns.get(sessionId);
  if (!current || current.token !== token) return;
  clearTimeout(current.timeout);
  activeChatTurns.delete(sessionId);
}
// Longest sessionId / conversationId accepted: they key the stored thread and the turn lock.
const MAX_ID_CHARS = 128;

// Why a chat request was turned away before the model was called; the browser shows `message` and offers no retry.
interface ChatRefusal {
  status: 400 | 403 | 409;
  error: string;
  message: string;
}

// A turn's reply is written to the conversation's thread after the stream ends; the next request for the same conversation
// waits on this first, so it never reads a thread that is missing the previous reply.
const pendingThreadWrites = new Map<string, Promise<void>>();

// The tools whose output IS the reply (a card the widget renders on its own), as opposed to a tool that does or looks something up.
const SILENT_TOOL_NAMES = new Set(["presentReturnItemPicker", "commerceListOrdersForCustomer", "offerNewChat", "offerEscalationToSupport"]);
const isReplyToolName = (toolName: string): boolean => toolName === "respondToCustomer" || SILENT_TOOL_NAMES.has(toolName);
const app = new Hono();

// The notices the chat shows when a rep acts on a case or asks a question (shared/case-notices.ts, the same words the widget
// shows) are also written into that session's stored thread. The model is only ever given the server's thread, so without
// this it would not know what the customer was just told: a customer answering a rep's follow-up question, for one, would
// be answering a question the model never saw. One listener covers every place these events are emitted.
caseEvents.on("resolved", (event: CaseResolvedEvent) => {
  void recordNotice(event.sessionId, caseResolvedMessage(event, formatMoney));
});
caseEvents.on("more-info-requested", (event: CaseMoreInfoEvent) => {
  void recordNotice(event.sessionId, caseMoreInfoMessage(event));
});

// Both frontends are separate Next.js origins that call this API directly from the browser,
// so CORS has to allow them (curl never enforces CORS, so a curl check won't catch a gap).
//
// Allowed by PORT, not by hostname: the frontends derive the agent's address from whatever host
// the browser used to reach them (see each app's lib/api.ts) — localhost, a LAN IP, anything —
// so a fixed origin list would need editing every time; matching the port never does.
const ESCALATION_DESK_PORT = process.env.DESK_PORT || "3005";
const STOREFRONT_PORT = process.env.STOREFRONT_PORT || "3007";

app.use(
  "*",
  cors({
    origin: (origin) => {
      if (!origin) return undefined;
      try {
        const { port } = new URL(origin);
        return [ESCALATION_DESK_PORT, STOREFRONT_PORT].includes(port) ? origin : undefined;
      } catch {
        return undefined;
      }
    },
    allowMethods: ["GET", "POST"],
  })
);

function getWorkflow() {
  const workflow = mastra.getWorkflow("policyReviewWorkflow");
  if (!workflow) throw new Error("policyReviewWorkflow is not registered on this Mastra instance");
  return workflow;
}

function parseSnapshot(snapshot: unknown): any {
  return typeof snapshot === "string" ? JSON.parse(snapshot) : snapshot;
}

// relatedOpenCaseIds is frozen into a case's own suspend payload at link time
// (case-lookup.ts's linkRelatedCase) and never touched again by THIS case's own
// suspend/resume cycle — but the OTHER case it points at can resolve on its own at any
// time, with no mechanism to reach back and update every case still pointing at it.
// Without this, the related-case banner (GET /escalations/:runId's suspended branch,
// below) can claim a case is "open" long after it's actually resolved — live-reported
// on a case that was itself still open, pointing at a related case that had already
// been decided. Checked fresh on every read rather than cached, since a related case
// can resolve at any moment relative to this one being viewed.
async function filterStillOpenCases(
  related: { runId: string; createdAt: string }[] | undefined
): Promise<{ runId: string; createdAt: string }[]> {
  if (!related || related.length === 0) return [];
  const workflow = getWorkflow();
  const checked = await Promise.all(
    related.map(async (entry) => {
      const state = await workflow.getWorkflowRunById(entry.runId);
      const stepResult = state?.steps?.[POLICY_REVIEW_STEP_ID] as any;
      return stepResult?.status === "suspended" ? entry : null;
    })
  );
  return checked.filter((entry): entry is { runId: string; createdAt: string } => entry !== null);
}

app.get("/health", (c) => c.json({ ok: true }));

// The storefront's "logged in" identity and their orders — no login flow, always this
// one demo customer.
app.get("/me", (c) => {
  const customer = customers.cust_demo_01;
  return c.json({ customer, orders: getOrdersForCustomer(customer.id) });
});

// The name the Escalation Desk shows for the rep who is "logged in" — read from WISMO_REP_NAME in .env at run time (so it
// works the same under Docker as under npm, with nothing baked into the Desk's build). Cosmetic: there is no real auth.
app.get("/rep", (c) => c.json({ name: config.repName }));

// Wipes every existing case (pending or resolved) and reseeds the demo scenarios —
// the storefront's Settings-page "Reset demo data" button, and the same routine
// `npm run agent:seed` runs from the CLI (see mastra/demo-seed.ts). Can take a while
// when OPENAI_API_KEY is set, since it generates a real damage photo per scenario that
// needs one — that's expected, not a hang.
app.post("/demo/reset", async (c) => {
  try {
    const summary = await resetDemoData(mastra);
    return c.json({ ok: true, ...summary });
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

// The storefront's decorative "shop the collection" strip — not a real browsable
// catalog (the storefront is deliberately minimal), just the
// product records behind the seeded orders, for visual richness.
app.get("/products", (c) => c.json({ products: Object.values(products) }));

const PRIORITY_RANK: Record<SuspendPayload["priority"], number> = { high: 0, normal: 1, low: 2 };

// Queue view: every currently-suspended run, highest priority first, newest-within-that-
// priority first — a case a rep hasn't seen yet needs to be visible, not buried under
// every older case at the same priority level. A case that's already been auto-ticketed
// via SLA timeout never appears here at all anymore (policy-review-workflow.ts's
// "timeout" branch resolves it straight to History) — there's no "already ticketed,
// still needs a decision" backlog tier left to sink, unlike before.
app.get("/escalations", async (c) => {
  const workflow = getWorkflow();
  const { runs } = await workflow.listWorkflowRuns({});

  const pending = runs
    .map((run) => {
      const snapshot = parseSnapshot(run.snapshot);
      const stepResult = snapshot?.context?.[POLICY_REVIEW_STEP_ID];
      if (!stepResult || stepResult.status !== "suspended") return null;
      const payload = stepResult.suspendPayload as SuspendPayload | undefined;
      if (!payload) return null;
      // transcript deliberately omitted — a damage-claim scenario embeds its supporting
      // photo as a base64 data URL right inside the transcript, and the queue view never
      // renders a transcript at all (only the single-case detail route does). Including
      // it here bloated this response to ~13MB for just 7 cases, which is most of why the
      // queue took several real seconds to load — confirmed live.
      const { transcript: _transcript, ...payloadWithoutTranscript } = payload;
      return {
        runId: run.runId,
        suspendedAt: run.updatedAt,
        reviewDeadlineIso: reviewDeadline(payload),
        // Looked up fresh, not stored on SuspendPayload itself — VIP status is a
        // customer-level fact, not something decided at escalation time, so this always
        // reflects current fixture data rather than whatever was true when the case
        // first suspended.
        vip: getCustomer(payload.customerId)?.vip ?? false,
        ...payloadWithoutTranscript,
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    .sort((a, b) => {
      return (
        PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
        new Date(b.suspendedAt).getTime() - new Date(a.suspendedAt).getTime()
      );
    });

  return c.json({ runs: pending });
});

// Every refund actually approved on this order, resolved to real item names — on a case's
// detail response (open and resolved) so a rep sees what has already been approved, not just an
// aggregate dollar figure. itemIds always resolves, but resolveOrderItems can return nothing for
// a stale or renamed catalog entry; it falls back to the raw ids rather than dropping the record.
//
// excludeRefundId: for a RESOLVED case that itself approved a refund (buildResolvedEntry passes
// its own refundId), so the case doesn't list its own refund as an "Already refunded" warning.
// Always undefined for an open case, which has no refundId yet.
// allRuns: an already-fetched runs array that a caller iterating every run anyway (the History
// route) should pass through, so this reuses that scan instead of starting its own — see
// refund-ledger.ts for the memory crash that N full scans caused. Omit it only when no such
// array is at hand (the single-case route).
async function buildOrderRefundHistory(order: Order, excludeRefundId?: string, allRuns?: RawWorkflowRun[]) {
  const records = allRuns ? extractRefundRecordsForOrder(order.id, allRuns) : await refundRecordsForOrder(order.id);
  return records
    .filter((record) => record.refundId !== excludeRefundId)
    .map((record) => ({
      items: resolveOrderItems(order, record.itemIds)?.map((item) => item.name) ?? record.itemIds,
      amount: record.amount,
      refundId: record.refundId,
      approvedAt: record.approvedAt,
    }));
}

// Builds a History/detail row for a run that has already resolved (not suspended), whether an
// automatic decision or a rep's decision (every attempt creates a real workflow run). Shared by
// GET /escalations/history (list, no transcript) and GET /escalations/:runId.
// Its own row shape, not the suspended branch's payload spread: once a run resolves, its step
// snapshot keeps only {payload, status, output, startedAt, endedAt} — the suspend payload is
// gone — so there is no policy verdict text (reasonCode, explanation, recommendedAction,
// priority) left to recover. What it returns comes from the step's frozen input plus a fresh
// lookup of the order and customer facts that input never carried.
// allRuns: passed straight through to buildOrderRefundHistory; only the History route, which
// already has every run in hand, supplies it.
async function buildResolvedEntry(runId: string, updatedAt: Date | string, stepResult: any, includeTranscript: boolean, allRuns?: RawWorkflowRun[]) {
  if (!stepResult || stepResult.status === "suspended" || !stepResult.output) return null;

  const input = stepResult.payload as
    | {
        orderId: string;
        refundAmount: number;
        problemSummary: string;
        caseType?: string;
        createdAt: string;
        itemIds?: string[];
        transcript?: unknown;
        relatedOpenCaseIds?: { runId: string; createdAt: string }[];
        sessionId?: string;
      }
    | undefined;
  if (!input) return null;
  const order = getOrder(input.orderId);
  if (!order) return null;
  const customer = getCustomer(order.customerId);

  // The step snapshot's own resolved output — a DIFFERENT shape/field than
  // run.start()'s top-level return value (refund-policy-gate.ts's own
  // result.result), which is the workflow's outer WorkflowResult wrapper, not this
  // per-step snapshot entry. Confirmed empirically (a throwaway script logging a
  // real "success" step's full JSON) rather than assumed from the outer shape — a
  // real, live mismatch caught here: history returned zero rows until this was fixed.
  const { action, detail } = stepResult.output as { action: "executed" | "denied" | "error" | "escalated_to_support"; detail?: Record<string, unknown> };
  // "approved," not "issued" — this app only ever knows an
  // approval was recorded, never that a real OMS payment actually completed (see
  // payment.ts's own "approved, not issued" comment for the full reasoning).
  let outcome: "approved" | "denied" | "error" | "escalated_to_support";
  let outcomeReason: string | undefined;
  let refundId: string | undefined;
  let approvedAmount: number | undefined;
  let ticketId: string | undefined;
  // Set by policy-review-workflow.ts at every terminal branch it controls — "agent"
  // for the two genuinely-autonomous branches, "rep" for anything reached via a human
  // decision (including "denied", which has no autonomous-reject path at all), "system"
  // for a case the SLA sweep itself auto-ticketed (nobody — agent or rep — actually
  // made a refund decision). Absent only for the system/guard error branches
  // (already-refunded, missing live amount), where "who resolved it" isn't really a
  // meaningful question.
  const resolvedBy = detail?.resolvedBy as "agent" | "rep" | "system" | undefined;
  // Also accepts the pre-rename "issued" value (see refund-ledger.ts's own comment on
  // this exact issue, found live) — a run resolved before the rename has "issued"
  // permanently in its own persisted output; without this, every such case would now
  // render as outcome "error" here instead of its real, correct "approved" outcome.
  if (action === "executed" && (detail?.status === "approved" || detail?.status === "issued")) {
    outcome = "approved";
    refundId = detail.refundId as string | undefined;
    approvedAmount = detail.amount as number | undefined;
  } else if (action === "executed") {
    // issueRefund's own last-moment guard rejected it (e.g. already refunded) even
    // though the workflow's own policy check said to proceed — a real, if rare,
    // race outcome, not a rep decision.
    outcome = "error";
    outcomeReason = detail?.reason as string | undefined;
  } else if (action === "denied") {
    outcome = "denied";
    outcomeReason = detail?.reason as string | undefined;
  } else if (action === "escalated_to_support") {
    // No refund decision was ever made — the SLA window ran out before a rep acted, or
    // a rep asked a question the customer could not receive (detail.question), or a rep
    // escalated it themselves, so a support ticket opened and the case is done from the Desk's
    // own point of view (per explicit user decision: the support-ticket process, not
    // this app, owns following up with the customer from here).
    outcome = "escalated_to_support";
    ticketId = detail?.ticketId as string | undefined;
  } else {
    outcome = "error";
    outcomeReason = detail?.reason as string | undefined;
  }

  const items = resolveOrderItems(order, input.itemIds)?.map((item) => ({ name: item.name, price: item.price })) ?? [];

  return {
    runId,
    resolvedAt: updatedAt instanceof Date ? updatedAt.toISOString() : updatedAt,
    createdAt: input.createdAt,
    outcome,
    outcomeReason,
    refundId,
    // Only set for outcome "escalated_to_support" — the ticket a rep or the customer
    // can reference, same field name the still-suspended case's own SuspendPayload
    // already carries for the same concept.
    ticketId,
    // The policy rule that decided this case (P-number + its wording at the time) — set
    // by the workflow on every automatic outcome and carried through a rep's decision.
    // Absent on cases decided before policy numbers existed, or sent to a rep by the $
    // backstop rather than a policy rule.
    policy: detail?.policy as { number: string; version: number; text: string } | undefined,
    refundAmount: approvedAmount ?? input.refundAmount,
    // The case's ORIGINAL claim amount, frozen from this step's inputData at run.start(). A later
    // "modify" changes only the live suspend payload and the amount issueRefund moves, never this.
    // Kept distinct from refundAmount above (the amount actually approved) so a partial approval —
    // a rep modifying a $48 claim down to $30 — doesn't read as if the claim itself were only ever
    // worth $30.
    requestedAmount: input.refundAmount,
    currency: config.currency,
    orderId: input.orderId,
    customerId: order.customerId,
    customerName: customer?.name ?? "Unknown customer",
    vip: customer?.vip ?? false,
    problemSummary: input.problemSummary,
    orderContext: `${orderItemsSummary(order)} — ordered ${order.orderDate.slice(0, 10)}, delivered ${order.deliveredDate.slice(0, 10)}`,
    // See the suspended branch of GET /escalations/:runId for why these are sent as
    // separate real timestamps, not left for the Desk to parse out of orderContext.
    orderItemsSummary: orderItemsSummary(order),
    orderDate: order.orderDate,
    deliveredDate: order.deliveredDate,
    caseType: input.caseType ?? "refund",
    relatedOpenCaseIds: input.relatedOpenCaseIds ?? [],
    resolvedBy,
    // What the rep told the customer on an approve / modify (the Desk's "Message to the customer" box) — part of the resolution.
    repComment: typeof detail?.comment === "string" ? detail.comment : undefined,
    // The rep's question, when it could not be delivered (the customer's chat tab was not connected) and a support ticket opened instead.
    repQuestion: typeof detail?.question === "string" ? detail.question : undefined,
    // True when the case was waiting on the customer's answer to a rep's question and the response window ran out.
    customerDidNotReply: detail?.awaitingCustomer === true ? true : undefined,
    items,
    // "seed" is demo-seed.ts's own sentinel for a case created directly, with no real
    // chat conversation ever behind it — surfaced so the Desk can say so explicitly
    // (its own Activity section otherwise reads as broken, showing just the one bare
    // policy-decision row with no explanation) instead of leaving a rep to wonder why.
    seeded: input.sessionId === "seed",
    orderRefundHistory: await buildOrderRefundHistory(order, refundId, allRuns),
    // Same "give the rep visibility into related history on this order, not just this
    // one case" reasoning as orderRefundHistory above, for the customer-initiated
    // disagreement flow (offer_escalation_to_support / mastra/disagreement-tickets.ts) —
    // no exclude-self case here, since a case can't have its own disagreement ticket
    // until AFTER it's resolved, and this field itself only ever describes tickets
    // opened about OTHER, earlier resolutions on the same order.
    disagreementTickets: await getDisagreementTicketsForOrder(order.id),
    ...(includeTranscript ? { transcript: input.transcript ?? [] } : {}),
  };
}

// History view: every resolved run, newest-resolved-first (run.updatedAt), same
// tie-breaker as the queue. transcript deliberately omitted, same "don't bloat the
// list response" reasoning as the queue's own payloadWithoutTranscript spread — a
// damage-claim scenario embeds its supporting photo as a base64 data URL right inside
// transcript.
app.get("/escalations/history", async (c) => {
  const workflow = getWorkflow();
  const { runs } = await workflow.listWorkflowRuns({});

  const resolved = (
    await Promise.all(
      runs.map((run) => {
        const snapshot = parseSnapshot(run.snapshot);
        const stepResult = snapshot?.context?.[POLICY_REVIEW_STEP_ID];
        // Reuses the SAME `runs` array this route already fetched above, instead of
        // each row independently re-scanning the whole workflow-run store — the fix
        // for the real OOM crash (N resolved cases used to mean N+1 concurrent full
        // scans of a 442MB store). See refund-ledger.ts's own header comment.
        return buildResolvedEntry(run.runId, run.updatedAt, stepResult, false, runs);
      })
    )
  )
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    .sort((a, b) => new Date(b.resolvedAt).getTime() - new Date(a.resolvedAt).getTime());

  return c.json({ runs: resolved });
});

// Detail view: everything a reviewer needs for one case — transcript, order context,
// policy exception, recommended action — read straight from the suspended step.
app.get("/escalations/:runId", async (c) => {
  const runId = c.req.param("runId");
  const workflow = getWorkflow();
  const state = await workflow.getWorkflowRunById(runId);
  if (!state) return c.json({ error: "not_found" }, 404);

  const stepResult = state.steps?.[POLICY_REVIEW_STEP_ID] as any;
  if (!stepResult) return c.json({ error: "not_found" }, 404);

  if (stepResult.status !== "suspended") {
    // Resolved (autonomous or rep-decided) — reuse the same reconstruction History
    // uses, this time with the transcript included (this route always serves exactly
    // one case, unlike the list route's own "don't bloat the response" reasoning).
    // See buildResolvedEntry's own comment for why this is a genuinely different
    // shape from the suspended branch below, not just a shorter version of it.
    const resolvedEntry = await buildResolvedEntry(runId, state.updatedAt, stepResult, true);
    if (resolvedEntry) return c.json(resolvedEntry);
    return c.json({ error: "not_suspended", status: state.status }, 409);
  }

  const payload = stepResult.suspendPayload as SuspendPayload;
  // Not part of SuspendPayload itself — the step's own original input (frozen for the
  // run's whole lifetime, unchanged by any resume — see policy-review-workflow.ts's
  // humanPolicyReviewInput), same field case-lookup.ts's caseTypeOf() already reads
  // (`step.payload.caseType`, via a differently-shaped lookup but the same underlying
  // step snapshot) — needed client-side to gate the "require item back" checkbox to
  // damage/fault claims only.
  const caseType: string | undefined = stepResult.payload?.caseType;
  // Not part of SuspendPayload itself (it's the run's own metadata, not something the
  // workflow step decided) — same field name and source (run.updatedAt) as the queue
  // list's own suspendedAt, so the Desk can show "opened X ago" on both views.
  // vip: same "looked up fresh, not frozen at escalation time" reasoning as the queue
  // list's own copy of this.
  const vip = getCustomer(payload.customerId)?.vip ?? false;
  // Real per-item name + price for the Desk's "Customer & Order" tab — resolveOrderItems
  // already exists for this (the same trusted-server-side resolution every refund/return
  // tool uses), just never surfaced on this route before. Falls back to every item on the
  // order when itemIds is unset (a whole-order claim, not an item-scoped return).
  const order = getOrder(payload.orderId);
  const items = order ? resolveOrderItems(order, payload.itemIds)?.map((item) => ({ name: item.name, price: item.price })) ?? [] : [];
  // Overrides payload's own (possibly stale) relatedOpenCaseIds — see
  // filterStillOpenCases's own comment for why this can't just be trusted frozen.
  const relatedOpenCaseIds = await filterStillOpenCases(payload.relatedOpenCaseIds);
  // See buildResolvedEntry's own comment on its copy of this field.
  const seeded = payload.sessionId === "seed";
  // See buildOrderRefundHistory's own comment — a still-open case can involve an
  // already-refunded item just as easily as a resolved one (that's exactly the
  // live-reported bug this surfaces), so this isn't resolved-only.
  const orderRefundHistory = order ? await buildOrderRefundHistory(order) : [];
  // See buildResolvedEntry's own comment on its copy of this field — a still-open case
  // can involve an order that already has an unrelated disagreement ticket from an
  // EARLIER, already-resolved case, and a rep deciding this one benefits from knowing
  // that too.
  const disagreementTickets = order ? await getDisagreementTicketsForOrder(order.id) : [];
  // Pre-ticks the Desk's "ask the customer to send the item back" checkbox for a damage
  // claim: the policy's setting is on AND this case is worth at least the dollar floor (a
  // cheap item usually isn't worth shipping back). Both are settings in the active policy
  // document (Policies page), read via live-policy.ts's livePolicySetting — a document
  // missing them leaves the box unticked. Only ever a suggestion — the rep's own checkbox on the decision is
  // what actually decides. Damage claims only: a plain return already always gets its
  // label, and a delivery dispute has no item to return.
  const suggestedRequestItemReturn =
    caseType === "refund" &&
    (await livePolicySetting("requestDamagedItemReturn", false)) &&
    payload.refundAmount >= (await livePolicySetting("damagedItemReturnThreshold", 0));
  // The order's real timestamps, sent separately rather than left inside orderContext's
  // text (which bakes in a UTC "YYYY-MM-DD" — the server can't know the viewer's
  // timezone). The Desk formats these in the viewer's local time, exactly as the
  // storefront already does for the same order, so the two apps always show the same
  // day. Read fresh from the order record, not the case's frozen payload — the same
  // "system of record" the storefront reads.
  const orderDates = order ? { orderItemsSummary: orderItemsSummary(order), orderDate: order.orderDate, deliveredDate: order.deliveredDate } : {};
  // Whether the customer's chat tab is connected right now, the check the resume route makes before a rep's question: when it is not,
  // the question has nobody to reach and the case ends in a support ticket, so the Desk says so BEFORE the rep submits.
  const customerConnected = typeof payload.sessionId === "string" && isSessionConnected(payload.sessionId);
  return c.json({ runId, status: state.status, suspendedAt: state.updatedAt, caseType, vip, items, suggestedRequestItemReturn, ...payload, reviewDeadlineIso: reviewDeadline(payload), relatedOpenCaseIds, seeded, customerConnected, orderRefundHistory, disagreementTickets, ...orderDates });
});

// A tool call the agent made during some chat turn — extracted from a UIMessage's own
// `parts` array (see extractToolCallsFromMessages's own comment for why this is the
// only place this data exists at all in this app's current tracing setup).
type ExtractedToolCall = {
  toolName: string;
  toolCallId: string;
  input: unknown;
  output: unknown;
  error: unknown;
  success: boolean;
};

// The tool calls a turn's own `input` already CONTAINS: every "tool-<name>" part in the
// UIMessage history the client resent at the start of that turn. That is only ever
// EARLIER turns' calls — the turn's own calls happen after its input was captured — so
// this is the fallback source for the Activity list, not the primary one (each turn's
// own child `tool: '<name>'` spans are; see the trace route's own comment below).
function extractToolCallsFromMessages(messages: unknown): ExtractedToolCall[] {
  const calls: ExtractedToolCall[] = [];
  if (!Array.isArray(messages)) return calls;
  for (const message of messages as any[]) {
    for (const part of message?.parts ?? []) {
      if (typeof part?.type !== "string" || !part.type.startsWith("tool-")) continue;
      const toolName = part.type.slice("tool-".length);
      calls.push({
        toolName,
        toolCallId: typeof part.toolCallId === "string" ? part.toolCallId : `${toolName}-${calls.length}`,
        input: part.input ?? null,
        output: part.output ?? null,
        error: part.errorText ?? null,
        success: part.state !== "output-error" && part.errorText === undefined,
      });
    }
  }
  return calls;
}

// Activity trace for one case: the tool calls and model interactions that led to this
// escalation, read straight from Mastra's observability storage (see mastra/index.ts).
// SensitiveDataFilter has already redacted PII by the time spans land here.
//
// Where the rows come from. The case's own workflow spans carry the case's runId, but the
// agent's chat-turn spans carry a per-turn random runId unrelated to it, so the route also takes
// the case's conversationId (sessionId for older cases) from the step's frozen input — each
// turn's agent run is tagged with it by /chat/:agentId — and reads every turn of that chat.
// A turn's tool calls exist only as CHILD spans (one `tool: '<name>'` span per call, spanType
// tool_call, attributes.toolCallId) in the same trace as its "agent run" root, and this store's
// listTraces returns ROOT spans only (libsql filters `parentSpanId IS NULL`) and pages at 10, so
// each turn needs getTrace(traceId). Those spans are the primary source (exact start time,
// duration and per-turn grouping). Rows derived from each turn's `input` history
// (extractToolCallsFromMessages) are the fallback: that input is the conversation as of the
// START of the turn, so on its own it misses the calls the turn itself made.
//
// Rows are filtered to calls that mention this case's orderId — an approximation (chat-scoped,
// not a hard per-case link), but it keeps a chat that touched several orders from bleeding into
// one case's trail. Seeded demo cases (sessionId "seed", shared by all of them, never a real
// tab) are skipped, as in case-lookup.ts.
app.get("/escalations/:runId/trace", async (c) => {
  const runId = c.req.param("runId");
  const observabilityStore = await mastra.getStorage()?.getStore("observability");
  if (!observabilityStore) return c.json({ spans: [] });

  const workflow = getWorkflow();
  const state = await workflow.getWorkflowRunById(runId);
  const stepResult = state?.steps?.[POLICY_REVIEW_STEP_ID] as any;
  // The key this case's chat turns were tagged with (see runChatTurn's chatExecutionRunId):
  // the conversation it was opened in, falling back to the tab's sessionId for a case
  // that predates conversation ids. Seeded cases carry sessionId "seed" and no conversation.
  const chatRunKey: string | undefined = stepResult?.payload?.conversationId ?? stepResult?.payload?.sessionId;
  const orderId: string | undefined = stepResult?.payload?.orderId;

  // Only ever the case's ROOT spans: a case started on its own (a seeded demo case) has
  // one, but a case a chat turn opened has none — its workflow spans are children of that
  // turn's escalate tool call (see workflowActivity below).
  const { spans: caseRootSpans } = await observabilityStore.listTraces({ filters: { runId } });

  // One root ("agent run") span per chat turn. listTraces pages at 10, newest first — a
  // conversation longer than that would silently lose its oldest turns, which is
  // exactly where a case-creating turn tends to be — so walk every page.
  const listRootSpans = async (key: string) => {
    const roots: Awaited<ReturnType<typeof observabilityStore.listTraces>>["spans"] = [];
    for (let page = 0; ; page++) {
      const result = await observabilityStore.listTraces({ filters: { runId: key }, pagination: { page, perPage: 100 } });
      roots.push(...result.spans);
      if (!result.pagination?.hasMore) return roots;
    }
  };
  const agentSpans = chatRunKey && chatRunKey !== "seed" ? await listRootSpans(chatRunKey) : [];

  // Plain JSON shape for this response — deliberately NOT reusing Mastra's own Span type
  // for spanType/status (both nominal enums there), since the synthetic tool-call rows
  // below aren't real Mastra spans at all, just reshaped data extracted from one.
  type ActivityRow = {
    spanId: string;
    name: string;
    spanType: string;
    status: string;
    startedAt: Date | string;
    endedAt: Date | string | null | undefined;
    durationMs: number | null;
    input: unknown;
    output: unknown;
    error: unknown;
  };

  const sortedAgentSpans = [...agentSpans].sort(
    (a: { startedAt: Date }, b: { startedAt: Date }) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime()
  );
  const seenToolCallIds = new Set<string>();
  const toolCallActivity: ActivityRow[] = [];
  const bareOrderId = orderId?.replace(/^order_/, "");
  const mentionsOrder = (call: ExtractedToolCall) => {
    if (!orderId) return true;
    const haystack = JSON.stringify([call.input, call.output]);
    return haystack.includes(orderId) || haystack.includes(bareOrderId!);
  };

  // One row's worth of a tool call plus where/when it happened — the same shape whether
  // it came from a turn's own child span or from history a later turn resent.
  type TurnToolCall = {
    call: ExtractedToolCall;
    spanId: string;
    startedAt: Date | string;
    endedAt: Date | string | null | undefined;
    durationMs: number | null;
  };
  // Turns `calls` — all from ONE turn (or one turn's resent history) — into Activity
  // rows. A tool call can turn up more than once (see the history pass below), so dedupe
  // by toolCallId across every call to this function: whichever source runs first owns
  // the row, and a call it scoped OUT stays out — the marked-seen id is what stops the
  // looser history pass from resurrecting it.
  const addToolCallRows = (calls: TurnToolCall[]) => {
    // respond_to_customer's own text often doesn't mention the order number ("let me pull up that
    // order"), so the substring filter below would under-match it, but exempting it from order
    // scoping entirely lets every reply from the whole chat bleed into every case's trail. Middle
    // ground: a respond_to_customer call is included when the SAME turn also made another tool call
    // that does mention this order.
    const turnMentionsOrder = orderId ? calls.some(({ call }) => call.toolName !== "respondToCustomer" && mentionsOrder(call)) : true;
    for (const { call, spanId, startedAt, endedAt, durationMs } of calls) {
      if (seenToolCallIds.has(call.toolCallId)) continue;
      seenToolCallIds.add(call.toolCallId);
      if (orderId && call.toolName !== "respondToCustomer" && !mentionsOrder(call)) continue;
      if (orderId && call.toolName === "respondToCustomer" && !turnMentionsOrder) continue;
      toolCallActivity.push({
        spanId,
        name: `tool call: '${call.toolName}'`,
        spanType: "tool_call",
        status: call.success ? "success" : "error",
        startedAt,
        endedAt,
        durationMs,
        input: call.input,
        output: call.output,
        error: call.error,
      });
    }
  };

  // Primary source: the tool calls each turn MADE, from that turn's own trace. Runs
  // first so these rows — real start time and duration, and grouped by the exact turn
  // that made them — win the dedupe over the history-derived copy of the same call.
  // Turns are already oldest-first, and getTrace returns each trace's spans startedAt
  // ASC, so rows come out in the order the calls actually happened. Fetched in parallel:
  // one local read per turn, and this route is loaded once per page view, not polled.
  // The case's own root trace (a seeded case) is read the same way, for its "(resumed)"
  // children; it has no tool spans, so it adds no tool rows.
  const traceIds = [...new Set([...sortedAgentSpans, ...caseRootSpans].map((span: { traceId: string }) => span.traceId))];
  const traces = await Promise.all(traceIds.map((traceId) => observabilityStore.getTrace({ traceId })));

  // The case's own "workflow run: 'policy-review-workflow'" row — plus one "(resumed)"
  // row per resume — are the spans carrying THIS case's runId, wherever they sit. For a
  // case a chat turn opened that is inside that turn's own trace (a child of the escalate
  // tool's span, since the trace context flows into workflow.run.start()), which a
  // roots-only listTraces can't see: such a case used to have no workflow row at all
  // until it got one some other way. Status is derived the way listTraces derives it
  // (getTrace's raw spans don't carry one).
  const workflowActivity: ActivityRow[] = traces
    .flatMap((trace) => trace?.spans ?? [])
    .filter((span) => span.runId === runId && (span.spanType as string) === "workflow_run")
    .map((span) => ({
      spanId: span.spanId,
      name: span.name,
      spanType: span.spanType as string,
      status: computeTraceStatus(span) as string,
      startedAt: span.startedAt,
      endedAt: span.endedAt,
      durationMs: span.endedAt ? new Date(span.endedAt).getTime() - new Date(span.startedAt).getTime() : null,
      input: span.input ?? null,
      output: span.output ?? null,
      error: span.error ?? null,
    }));

  for (const trace of traces) {
    const toolSpans = (trace?.spans ?? []).filter((span) => (span.spanType as string) === "tool_call");
    addToolCallRows(
      toolSpans.map((span) => {
        const toolCallId = span.attributes?.toolCallId;
        return {
          call: {
            toolName: span.entityName ?? span.name,
            toolCallId: typeof toolCallId === "string" ? toolCallId : span.spanId,
            input: span.input ?? null,
            output: span.output ?? null,
            error: span.error ?? null,
            success: span.error == null && span.attributes?.success !== false,
          },
          spanId: span.spanId,
          startedAt: span.startedAt,
          endedAt: span.endedAt,
          durationMs: span.endedAt ? new Date(span.endedAt).getTime() - new Date(span.startedAt).getTime() : null,
        };
      })
    );
  }

  // Fallback source: every chat turn resends the full conversation history, so a tool
  // call also shows up inside every LATER turn's own agent_run input — the only place it
  // was ever read from before the pass above existed. Anything a span already covered is
  // skipped by the dedupe; what's left is a turn whose trace had no usable tool spans.
  // Its time is the resending turn's, not the call's own — approximate, but only ever
  // used when there is no span to say better.
  for (const span of sortedAgentSpans) {
    addToolCallRows(
      extractToolCallsFromMessages(span.input).map((call) => ({
        call,
        spanId: `${span.spanId}:${call.toolCallId}`,
        startedAt: span.startedAt,
        endedAt: span.endedAt,
        durationMs: null,
      }))
    );
  }

  // The case's DECISION (who resolved it, and how) as its own row. A resume DOES create a
  // span — a "workflow run: ... (resumed)" child of the original, in the same trace,
  // carrying the decision as its input and the workflow's result as its output (verified
  // live for both a rep's reject and the SLA sweep's timeout) — and workflowActivity
  // above now returns it. An earlier version of this comment said resumes never create
  // one, "confirmed empirically" by comparing the trace before/after a resume; that
  // comparison used listTraces, which only returns ROOT spans, so it could not have seen
  // a child — the same blind spot as the missing tool-call rows. This row stays anyway:
  // the resumed span says a decision was submitted, not what it came to (resolvedBy,
  // the refund id, the amount actually decided), and an AUTONOMOUS resolution never
  // resumes at all. Reuses buildResolvedEntry, the exact same outcome/resolvedBy/refundId
  // derivation the Resolution box and History already read, so this can't drift out of
  // sync with what the rest of the page says happened.
  const resolvedEntry = state ? await buildResolvedEntry(runId, state.updatedAt, stepResult, false) : null;
  const decisionActivity: ActivityRow[] = [];
  if (resolvedEntry) {
    const who = resolvedEntry.resolvedBy === "agent" ? "the agent" : resolvedEntry.resolvedBy === "rep" ? "a specialist" : "the system";
    const label =
      resolvedEntry.outcome === "approved"
        ? `case resolved: approved, by ${who}`
        : resolvedEntry.outcome === "denied"
          ? `case resolved: denied, by ${who}`
          : `case resolved: error`;
    decisionActivity.push({
      spanId: `${runId}:decision`,
      name: label,
      spanType: "case_decision",
      status: resolvedEntry.outcome === "error" ? "error" : "success",
      startedAt: resolvedEntry.resolvedAt,
      endedAt: resolvedEntry.resolvedAt,
      durationMs: null,
      input: null,
      output: {
        outcome: resolvedEntry.outcome,
        resolvedBy: resolvedEntry.resolvedBy ?? null,
        refundId: resolvedEntry.refundId ?? null,
        refundAmount: resolvedEntry.refundAmount,
        reason: resolvedEntry.outcomeReason ?? null,
      },
      error: null,
    });
  }

  const activity = [...workflowActivity, ...toolCallActivity, ...decisionActivity].sort(
    (a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime()
  );

  return c.json({ spans: activity });
});

// Shared by the rep-driven /resume route below and the SLA scanner
// (/escalations/check-timeouts) — both end in the exact same "resume, then tell an open
// chat what happened" shape, just triggered by a different actor (a rep's own decision
// vs. the clock running out on one). One resume path, one place the live-push logic can
// drift out of sync with what the workflow actually returns.
async function resumeAndNotify(runId: string, decisionData: HumanDecision): Promise<{ notification?: { channel: string; sentTo: string } }> {
  const workflow = getWorkflow();
  // What the case's transcript is RIGHT NOW (kept current by the end-of-turn sync while the case is open) — read before
  // resuming, because the suspend payload that holds it is gone once the case ends. See freezeResolvedTranscript.
  const before: any = await workflow.getWorkflowRunById(runId);
  const liveTranscript = (before?.steps?.[POLICY_REVIEW_STEP_ID] as any)?.suspendPayload?.transcript;
  const run = await workflow.createRun({ runId });
  const result: any = await run.resume({ step: POLICY_REVIEW_STEP_ID, resumeData: decisionData });
  // A question that could not be delivered ends the case (a support ticket opens), so it joins the saved conversation the way it
  // would have joined a live one.
  const undeliveredQuestion = decisionData.decision === "request_more_info" && result?.result?.action === "escalated_to_support" ? decisionData.question : undefined;
  if (Array.isArray(liveTranscript)) {
    try {
      const kept = undeliveredQuestion !== undefined
        ? [...liveTranscript, { role: "agent", text: `A specialist has a follow-up question: "${undeliveredQuestion}"`, timestamp: new Date().toISOString() }]
        : liveTranscript;
      await freezeResolvedTranscript(mastra, runId, kept);
    } catch (error) {
      // The decision is already made and recorded; failing to keep the conversation must not undo or hide it.
      console.error(`[history] Could not keep the conversation on case ${runId} after it was decided:`, error);
    }
  }
  // Surfaced back to the caller (the Escalation Desk's own resume response, and the
  // route below) so a rep can actually see the notification fired — notifyCustomer's
  // result previously went nowhere but the server console, invisible to the one person
  // who'd want to know it worked.
  let notification: { channel: string; sentTo: string } | undefined;

  // orderId comes back on the resume result's own `input` (the workflow's original
  // inputData, unchanged by resuming, and present whether this resume resolved the case
  // or re-suspended it) — verified directly against a real resume() call, both branches.
  // customerId isn't part of that (only the
  // step itself looks it up), so it's re-fetched here the same way every other gating fact
  // in this app is — never assumed.
  // sessionId comes back on the same `result.input` as orderId — it's part of the
  // workflow's original inputData (policy-review-workflow.ts), unchanged by resuming.
  // Only this exact chat tab's own SSE connection gets the push (server.ts's
  // /chat/:agentId/events) — see request-context.ts's SESSION_ID_KEY for why.
  const orderId: string | undefined = result?.input?.orderId;
  const sessionId: string | undefined = result?.input?.sessionId;
  const action = result?.result?.action;
  if (orderId && sessionId && (action === "executed" || action === "denied")) {
    // A genuinely decided case — worth pushing into an open chat as an outcome.
    const order = getOrder(orderId);
    if (order) {
      // A plain-return approval always gets its label generated right here, not left for
      // the customer to ask for separately — same "just give it to them" rule as the
      // autonomous same-turn path (wismo-agent.ts's instructions).
      const isPlainReturn = result?.input?.caseType === "plain_return";
      // A damage/fault claim doesn't automatically need the item shipped back, so it gets
      // a label only when the rep asked for it on this specific decision (the Desk's
      // per-case checkbox) — a request, never a hold: the refund already fired and the
      // case is already resolved either way. A delivery dispute never gets one.
      const repRequestedItemBack = (decisionData.decision === "approve" || decisionData.decision === "modify") && decisionData.requestItemReturn === true;
      const label = action === "executed" && (isPlainReturn || repRequestedItemBack) ? generateReturnLabel(orderId, result?.input?.itemIds) : undefined;
      const refundAmount = action === "executed" ? result.result.detail?.amount : undefined;
      const denyReason = action === "denied" ? result.result.detail?.reason : undefined;
      const event: CaseResolvedEvent = {
        runId,
        orderId,
        customerId: order.customerId,
        sessionId,
        action,
        refundAmount,
        currency: action === "executed" ? config.currency : undefined,
        reason: denyReason,
        returnLabelUrl: label?.labelUrl,
        returnTrackingNumber: label?.returnTrackingNumber,
        comment: action === "executed" && (decisionData.decision === "approve" || decisionData.decision === "modify") ? repComment(decisionData.comment) : undefined,
      };
      caseEvents.emit("resolved", event);
      // A final decision ALWAYS goes through a durable notification — never only the
      // live push above, which silently reaches nobody the moment that exact browser
      // tab is closed. Per explicit user instruction: this fires unconditionally, not
      // as a fallback gated on whether the push above actually landed anywhere.
      const shortOrderId = orderId.replace(/^order_/, "");
      if (action === "executed") {
        const amountLine = refundAmount !== undefined ? ` A ${formatMoney(refundAmount, config.currency)} refund has been approved.` : "";
        const labelLine = label ? ` Please send the item back using this return label: ${label.labelUrl}` : "";
        const noteLine = event.comment ? ` The specialist added: “${event.comment}”` : "";
        notification = notifyCustomer(order.customerId, `Your case for order #${shortOrderId} has been approved`, `Good news — a specialist reviewed your case for order #${shortOrderId} and approved it.${amountLine}${noteLine}${labelLine}`);
      } else {
        const reasonLine = denyReason ? ` Reason given: ${denyReason}` : "";
        notification = notifyCustomer(order.customerId, `Update on your case for order #${shortOrderId}`, `A specialist reviewed your case for order #${shortOrderId} and wasn't able to approve it.${reasonLine}`);
      }
    }
  } else if (orderId && sessionId && action === "escalated_to_support") {
    // Checked BEFORE decisionData.decision === "request_more_info" below, and
    // deliberately keyed on `action` (what the workflow actually did) rather than
    // `decisionData.decision` (what the rep submitted) — the two now diverge for a
    // request_more_info the workflow silently turned into a ticket-and-resolve
    // instead of a re-suspend (customerUnreachable — see active-sessions.ts), and
    // ground truth has to win, or this would incorrectly push "a specialist has a
    // question" for a case that's actually already closed. Covers a genuine SLA
    // timeout, an unreachable request_more_info, AND a rep's own proactive "escalate
    // to support" decision alike (policy-review-workflow.ts's "timeout" and
    // "escalate_to_support" branches) — the case is done from the Desk's own point of
    // view either way, moved to History; the support-ticket process owns following up
    // with the customer from here. ticketId comes from the terminal result's own
    // detail, not a re-suspend's suspendPayload (there isn't one anymore for any
    // branch that reaches this).
    const order = getOrder(orderId);
    const ticketId = result?.result?.detail?.ticketId as string | undefined;
    // "system" (an SLA timeout) vs. "rep" (a rep's own proactive "escalate to support"
    // decision, or a question that could not be delivered) — the two need
    // different copy: nothing "took too long" when a rep actively looked at the case
    // and decided it needs a higher tier of support, so the timeout wording would be
    // actively misleading.
    const resolvedBy = result?.result?.detail?.resolvedBy as "system" | "rep" | undefined;
    // Set only when a rep's question could not be delivered because the customer's chat tab was not connected.
    const question = result?.result?.detail?.question as string | undefined;
    // Set when the case was waiting on the customer's answer and the window ran out.
    const customerDidNotReply = result?.result?.detail?.awaitingCustomer === true;
    if (order && ticketId) {
      const contactWindowHours = getSupportTicketContactHours();
      const event: CaseResolvedEvent = {
        runId,
        orderId,
        customerId: order.customerId,
        sessionId,
        action: "escalated_to_support",
        ticketId,
        contactWindowHours,
        resolvedBy,
        question,
        customerDidNotReply: customerDidNotReply || undefined,
      };
      caseEvents.emit("resolved", event);
      const shortOrderId = orderId.replace(/^order_/, "");
      notification =
        question
          ? notifyCustomer(
              order.customerId,
              `A specialist has a question about order #${shortOrderId}`,
              `A specialist reviewing your case for order #${shortOrderId} asked: "${question}" We couldn't reach you in the chat, so we've opened a support ticket (${ticketId}), and someone will reach out within ${contactWindowHours} hours.`
            )
          : customerDidNotReply
          ? notifyCustomer(
              order.customerId,
              `We've opened a support ticket for order #${shortOrderId}`,
              `A specialist asked you a question about order #${shortOrderId} and we haven't heard back, so we've opened a support ticket (${ticketId}), and someone will reach out within ${contactWindowHours} hours.`
            )
          : resolvedBy === "rep"
          ? notifyCustomer(
              order.customerId,
              `Your case for order #${shortOrderId} has been escalated to our support team`,
              `A specialist reviewed your case for order #${shortOrderId} and determined it needs additional support from our team. We've opened a support ticket (${ticketId}), and someone will reach out within ${contactWindowHours} hours.`
            )
          : notifyCustomer(
              order.customerId,
              `We've opened a support ticket for order #${shortOrderId}`,
              `We're sorry — reviewing your case for order #${shortOrderId} is taking a little longer than usual. We've opened a support ticket (${ticketId}), and our team will reach out within ${contactWindowHours} hours.`
            );
    }
  } else if (orderId && sessionId && decisionData.decision === "request_more_info") {
    // Only reached when the case above did NOT resolve via escalated_to_support —
    // i.e. the customer's chat tab genuinely is connected (or this isn't a
    // request_more_info at all, which the outer condition already rules out). Still
    // re-suspended, not resolved — worth pushing, since this is the rep's own
    // question and the customer needs to see and answer it live. The question text
    // comes straight from the decision this route already parsed and validated, not
    // from `result` (which carries no `result.result` for a re-suspend branch —
    // confirmed empirically against a real re-suspending resume()).
    const order = getOrder(orderId);
    if (order) {
      const event: CaseMoreInfoEvent = {
        runId,
        orderId,
        customerId: order.customerId,
        sessionId,
        question: decisionData.question,
      };
      caseEvents.emit("more-info-requested", event);
      // Same "always notify" rule as a final decision — a follow-up question is exactly
      // the kind of thing that otherwise sits unanswered because nobody's watching the
      // chat tab anymore.
      const shortOrderId = orderId.replace(/^order_/, "");
      notification = notifyCustomer(
        order.customerId,
        `A specialist has a question about order #${shortOrderId}`,
        `A specialist reviewing your case for order #${shortOrderId} needs more information: "${decisionData.question}" — reply in your chat with WISMO whenever you get a chance.`
      );
    }
  }

  // Deliberately NOT the raw Mastra `result` — that's the workflow's own full run
  // snapshot, including every step's frozen inputData.transcript, which embeds a
  // base64 damage photo as a data URL for several seeded scenarios. Spreading that
  // into the response here made a plain approve/reject take several real seconds and
  // an 8MB+ response (confirmed live) for a decision the Desk only ever reads
  // `notification` back from (api.ts's ResumeResult) — the exact same "don't bloat
  // the response with a transcript nothing renders" lesson the queue/history list
  // routes already learned, just never applied to this one. The other caller
  // (check-timeouts, below) discards this return value entirely, so trimming it here
  // is safe for both callers.
  return { notification };
}

// Resume with a schema-validated decision — approve / reject / modify / request_more_info,
// matching the Escalation Desk's four rep actions one for one. ("timeout" is a fifth
// decision the schema accepts, but only /escalations/check-timeouts below ever sends
// it — it's not one of the Desk's own buttons.)
app.post("/escalations/:runId/resume", async (c) => {
  const runId = c.req.param("runId");
  const body = await c.req.json().catch(() => null);
  return caseStateLocks.withLock(runId, async () => {
  const current = await getWorkflow().getWorkflowRunById(runId);
  if ((current?.steps?.[POLICY_REVIEW_STEP_ID] as any)?.status !== "suspended") return c.json({ error: "case_not_open", message: "This case is no longer open for a decision." }, 409);

  // "escalate_to_support" carries a full SuspendPayload as `context` — same shape as
  // "timeout" (below), and for the same reason: the workflow step trusts context
  // completely (it becomes the support ticket's own record), so it must never come
  // from the client. Unlike "timeout" (triggered by the scan route, which already has
  // the payload in hand), a rep's own click only ever sends {decision, note} — this
  // fetches the live suspend payload here and injects it BEFORE schema validation, so
  // the schema itself can stay identical to "timeout"'s (context required, never
  // optional-and-trusted). A case with nothing live to fetch (unknown runId, already
  // resolved) is caught here as a clear 404 instead of a confusing schema-validation
  // failure or a raw Mastra error deeper in.
  if (body && typeof body === "object" && (body as { decision?: unknown }).decision === "escalate_to_support") {
    const workflow = getWorkflow();
    const state = await workflow.getWorkflowRunById(runId);
    const liveSuspendPayload = (state?.steps?.[POLICY_REVIEW_STEP_ID] as any)?.suspendPayload;
    if (!liveSuspendPayload) {
      return c.json({ error: "case_not_suspended", message: "This case is not currently open for a decision." }, 404);
    }
    (body as Record<string, unknown>).context = liveSuspendPayload;
  }

  const parsed = humanDecisionSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid_decision", issues: parsed.error.flatten() }, 400);
  }

  let decisionData = parsed.data;
  // The case's own policy reference (which P-number sent it to a rep), read live and
  // passed through resumeData so the workflow can keep it on the resolved result — the
  // step's resolved output is all History ever sees. Never taken from the client.
  if (decisionData.decision === "approve" || decisionData.decision === "reject" || decisionData.decision === "modify" || decisionData.decision === "request_more_info") {
    const state = await getWorkflow().getWorkflowRunById(runId);
    const livePolicy = (state?.steps?.[POLICY_REVIEW_STEP_ID] as any)?.suspendPayload?.policy;
    decisionData = { ...decisionData, policy: livePolicy && typeof livePolicy.number === "string" ? livePolicy : undefined };
  }
  if (decisionData.decision === "request_more_info") {
    // See policy-review-workflow.ts's humanDecisionSchema comment — without this, the
    // re-suspend the workflow is about to do would silently drop any conversation the
    // customer had after escalating but before this, their first rep action.
    const workflow = getWorkflow();
    const state = await workflow.getWorkflowRunById(runId);
    const liveSuspendPayload = (state?.steps?.[POLICY_REVIEW_STEP_ID] as any)?.suspendPayload;
    const liveTranscript = liveSuspendPayload?.transcript;
    if (Array.isArray(liveTranscript)) decisionData = { ...decisionData, transcript: liveTranscript };
    // Same reasoning, for ticketId: the workflow step's own request_more_info branch
    // rebuilds the suspend payload from scratch (unlike "timeout"'s, which spreads the
    // whole prior payload) — without threading this through the same way, a case that
    // already had a support ticket silently loses that fact the moment a rep asks a
    // follow-up, and a SECOND, different ticket gets opened if it times out again later.
    // A real, live-confirmed bug, not a hypothetical.
    if (typeof liveSuspendPayload?.ticketId === "string") decisionData = { ...decisionData, ticketId: liveSuspendPayload.ticketId };
    // Same reasoning again, for explanation: the case's own deterministic policy/carrier
    // finding (the Desk's "Policy Exception" box and "System shows" comparison column) —
    // without threading this through, the workflow's own rebuilt-from-scratch payload had
    // nothing else to fall back on and used the rep's own question instead, live-confirmed
    // to replace a real carrier finding with literally "what?".
    if (typeof liveSuspendPayload?.explanation === "string") decisionData = { ...decisionData, explanation: liveSuspendPayload.explanation };
    // And the summary: the questions asked so far live in it, so a second question has to be added to
    // the live text, not to the frozen original input.
    if (typeof liveSuspendPayload?.problemSummary === "string") decisionData = { ...decisionData, problemSummary: liveSuspendPayload.problemSummary };
    // Whether the customer's own chat tab is even there to receive this live — see
    // active-sessions.ts. Per explicit user decision: if it isn't, email is the only
    // channel left, so this should open a ticket and resolve the case rather than
    // re-suspending into a wait nobody's watching.
    const liveSessionId = liveSuspendPayload?.sessionId;
    if (typeof liveSessionId === "string" && !isSessionConnected(liveSessionId)) {
      decisionData = { ...decisionData, customerUnreachable: true };
    }
  } else if (decisionData.decision === "approve" || decisionData.decision === "modify") {
    const workflow = getWorkflow();
    const state = await workflow.getWorkflowRunById(runId);
    const liveSuspendPayload = (state?.steps?.[POLICY_REVIEW_STEP_ID] as any)?.suspendPayload;
    const order = typeof liveSuspendPayload?.orderId === "string" ? getOrder(liveSuspendPayload.orderId) : undefined;
    const coveredItems = order ? resolveOrderItems(order, liveSuspendPayload?.itemIds) : null;

    // Stop a rep approving (or modifying) a case whose covered item(s) already have a
    // refund on record — live-reproduced: issueRefund's own internal guard
    // (payment.ts) correctly refused to pay out twice, but the workflow's approve/
    // modify branches reported "executed" regardless of that rejection, so the
    // customer got a false "your case was approved" push/email with no dollar amount
    // at all, and the rep had no idea their approval silently did nothing. Checked
    // here, before the workflow is ever touched, so a blocked attempt leaves the case
    // fully intact and the rep sees a clear reason instead of a misleadingly "resolved"
    // case they'd only discover was wrong by separately checking History.
    const alreadyCovered = order ? await alreadyRefundedItemIds(order.id) : new Set<string>();
    const overlapNames = (coveredItems ?? []).filter((item) => alreadyCovered.has(item.objectID)).map((item) => item.name);
    if (overlapNames.length > 0) {
      return c.json(
        {
          error: "already_refunded",
          message: `Already refunded: ${overlapNames.join(", ")} — this case can't be approved for the same item(s) again. Consider rejecting it instead.`,
        },
        400
      );
    }

    if (decisionData.decision === "modify") {
      // Stop an over-value refund at the door — never even call the workflow (so the
      // case stays exactly as it was, still fully actionable) if a rep's typed amount
      // exceeds what the covered item(s) are actually worth. The Escalation Desk's own
      // UI also blocks this before a rep can submit at all (see runs/[runId]/page.tsx),
      // but this is the real, unbypassable enforcement — never trust the client, same
      // discipline every other gating fact in this app already follows.
      const coveredItemsValue = coveredItems?.reduce((sum, item) => sum + item.price, 0);
      if (coveredItemsValue !== undefined && decisionData.modifiedAmount > coveredItemsValue) {
        return c.json(
          {
            error: "amount_exceeds_item_value",
            message: `Modified amount (${decisionData.modifiedAmount}) exceeds the value of the covered item(s) (${coveredItemsValue}).`,
            maxAmount: coveredItemsValue,
          },
          400
        );
      }
    }
  }

  const result = await resumeAndNotify(runId, decisionData);
  return c.json(result);
  });
});

// Auto-resolves (opens a support ticket AND moves the case to History — see
// policy-review-workflow.ts's "timeout" branch, a genuine terminal outcome, not a
// re-suspend) any case that's sat past the current SLA (getEscalationSlaMinutes() —
// runtime-settings.ts, adjustable from the storefront's Settings page) with no rep
// decision. Meant to be polled periodically; nothing here depends on what's doing the
// polling. Today that's the Escalation Desk itself, every 30s while its queue page is
// open (see apps/escalation-desk's queue page) — production-appropriate replacement is
// a real cron job hitting this same route on the same interval, no code change needed
// on this side either way.
app.post("/escalations/check-timeouts", async (c) => {
  const workflow = getWorkflow();
  const { runs } = await workflow.listWorkflowRuns({});
  const now = Date.now();

  const expired = runs
    .map((run) => {
      const snapshot = parseSnapshot(run.snapshot);
      const stepResult = snapshot?.context?.[POLICY_REVIEW_STEP_ID];
      if (!stepResult || stepResult.status !== "suspended") return null;
      const payload = stepResult.suspendPayload as SuspendPayload | undefined;
      if (!payload) return null;
      // A case waiting on the customer's answer to a rep's question is swept like any other: the same window,
      // counted from when the question was sent (the workflow gives that re-suspend its own deadline), so a customer
      // who never answers does not leave it open for ever.
      if (now < new Date(reviewDeadline(payload)).getTime()) return null;
      return { runId: run.runId as string, payload };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

  const timedOut: Array<{ runId: string; orderId: string }> = [];
  for (const { runId } of expired) {
    await caseStateLocks.withLock(runId, async () => {
      const current = await workflow.getWorkflowRunById(runId);
      const step = (current?.steps?.[POLICY_REVIEW_STEP_ID] as any);
      const live = step?.suspendPayload as SuspendPayload | undefined;
      if (step?.status !== "suspended" || !live || Date.now() < new Date(reviewDeadline(live)).getTime()) return;
      await resumeAndNotify(runId, { decision: "timeout", context: live });
      timedOut.push({ runId, orderId: live.orderId });
    });
  }

  return c.json({ checked: runs.length, timedOut: timedOut.length, runs: timedOut });
});

// Runtime-adjustable settings (runtime-settings.ts), read/written by the Escalation Desk's
// Settings page without a redeploy — only what lives OUTSIDE the policy document: the two
// response-window timings, the queue's high-priority threshold (sorting, not policy), and
// the System Authority backstop (maxAutonomousAmount).
// Everything that decides a case — return ceilings, the damaged-item "ask for it back"
// default, the autonomy on/off switches — is in the active policy document instead,
// edited on the Policies page.
// currency is config-only, not runtime-adjustable (POST doesn't accept it) — it's returned
// here purely so a frontend formatting a raw amount (a case's refundAmount, an order price)
// never has to hardcode which currency that number is actually in.
app.get("/settings", (c) =>
  c.json({
    escalationSlaMinutes: getEscalationSlaMinutes(),
    supportTicketContactHours: getSupportTicketContactHours(),
    maxAutonomousAmount: getMaxAutonomousAmount(),
    highPriorityAmountThreshold: getHighPriorityAmountThreshold(),
    currency: config.currency,
  })
);

// Validate every provided field FIRST, deferring each write as a closure, and only apply them once
// every one has passed. An earlier version validated-then-set field by field, so a valid earlier field
// was already applied by the time a later invalid field aborted the request with a 400, leaving the
// operator with a "failed save" that had actually partially mutated their settings. No behavior
// change for an all-valid request.
app.post("/settings", async (c) => {
  const body = await c.req.json().catch(() => null);
  const updates: Array<() => void> = [];

  if (body?.escalationSlaMinutes !== undefined) {
    const minutes = Number(body.escalationSlaMinutes);
    if (!Number.isFinite(minutes) || minutes <= 0) {
      return c.json({ error: "invalid_value", message: "escalationSlaMinutes must be a positive number" }, 400);
    }
    updates.push(() => setEscalationSlaMinutes(minutes));
  }

  if (body?.supportTicketContactHours !== undefined) {
    const hours = Number(body.supportTicketContactHours);
    if (!Number.isFinite(hours) || hours <= 0) {
      return c.json({ error: "invalid_value", message: "supportTicketContactHours must be a positive number" }, 400);
    }
    updates.push(() => setSupportTicketContactHours(hours));
  }

  if (body?.maxAutonomousAmount !== undefined) {
    const amount = Number(body.maxAutonomousAmount);
    if (!Number.isFinite(amount) || amount < 0) {
      return c.json({ error: "invalid_value", message: "maxAutonomousAmount must be a non-negative number" }, 400);
    }
    updates.push(() => setMaxAutonomousAmount(amount));
  }

  if (body?.highPriorityAmountThreshold !== undefined) {
    const amount = Number(body.highPriorityAmountThreshold);
    if (!Number.isFinite(amount) || amount < 0) {
      return c.json({ error: "invalid_value", message: "highPriorityAmountThreshold must be a non-negative number" }, 400);
    }
    updates.push(() => setHighPriorityAmountThreshold(amount));
  }

  // Every provided field validated — now, and only now, apply them all.
  for (const apply of updates) apply();

  return c.json({
    ok: true,
    escalationSlaMinutes: getEscalationSlaMinutes(),
    supportTicketContactHours: getSupportTicketContactHours(),
    maxAutonomousAmount: getMaxAutonomousAmount(),
    highPriorityAmountThreshold: getHighPriorityAmountThreshold(),
    currency: config.currency,
  });
});

// Releases the concurrent-turn lock once the turn's stream has fully closed — including a
// turn that ended on an error chunk, where onFinish may never fire. A client disconnect
// (cancel) is left to onFinish / the 90s safety net, since the agent loop can keep running
// server-side after the browser goes away.
function releaseTurnWhenStreamEnds(sessionId: string, token: symbol | undefined, beforeRelease?: Promise<unknown>): TransformStream<any, any> {
  return new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(chunk);
    },
    async flush() {
      // The reply is written to the thread before the browser sees the stream end, so its next message finds it there.
      try {
        await beforeRelease;
      } finally {
        releaseChatTurn(sessionId, token);
      }
    },
  });
}

// Only complete parts of the assistant's message are kept: text, tool calls that finished (with their results) and the step
// markers between them. A turn that failed midway keeps what it already did (a tool that moved money must stay visible to the
// next turn); a half-streamed tool call is dropped, since the model API rejects a tool call with no result.
function finalizeAssistantParts(parts: any[]): any[] {
  const kept = parts.filter((part) => {
    if (part?.type === "text") return typeof part.text === "string" && part.text.trim().length > 0;
    if (typeof part?.type === "string" && (part.type.startsWith("tool-") || part.type === "dynamic-tool")) return part.state === "output-available" || part.state === "output-error";
    return part?.type === "step-start";
  });
  while (kept.length > 0 && kept[kept.length - 1].type === "step-start") kept.pop();
  return kept;
}

// Rebuilds the assistant's message from the stream the browser receives (the same chunks, so the same message the browser
// builds for itself) and appends it to the conversation's thread. Never rejects: a failed write is logged, and the customer's
// reply has already been delivered.
async function storeAssistantReply(stream: ReadableStream<unknown>, conversationId: string): Promise<void> {
  try {
    let last: { id: string; parts: any[] } | undefined;
    for await (const message of readUIMessageStream({ stream: stream as any })) last = message as any;
    if (!last) return;
    const parts = finalizeAssistantParts(last.parts ?? []);
    if (parts.length === 0) return;
    await appendToThread(conversationId, { id: last.id, role: "assistant", parts });
  } catch (error) {
    console.error(`[chat] Could not store the reply for conversation ${conversationId}:`, error);
  }
}

// respond_to_customer's `reasoning` field is documented as private and never rendered, but that
// only ever covered the render path (ChatWidget.tsx reads only the tool's OUTPUT). The AI SDK's
// UIMessage stream protocol independently echoes a tool call's full INPUT to the client as it
// streams (`reasoning` text arrives in `tool-input-delta` events before the tool executes), so
// it reached the browser's network layer whatever the widget does with it. This transform closes
// that at the one place that holds for every client: the outgoing stream itself. Mastra's own
// tracing is untouched (onFinish reads a separate internal event, not this HTTP response), so
// `reasoning` still shows up in the Escalation Desk's Activity trail.
function redactReasoningFromClientStream(): TransformStream<any, any> {
  const toolNameByCallId = new Map<string, string>();
  return new TransformStream({
    transform(chunk, controller) {
      if (chunk?.type === "tool-input-start" && typeof chunk.toolCallId === "string" && typeof chunk.toolName === "string") {
        toolNameByCallId.set(chunk.toolCallId, chunk.toolName);
        controller.enqueue(chunk);
        return;
      }
      // tool-input-delta carries raw, partially-assembled JSON text (no toolName field
      // of its own) — respond_to_customer writes `reasoning` before `message` in that
      // JSON, so any prefix of it can contain live reasoning text. Dropped outright
      // rather than rewritten: RespondToCustomer (ChatWidget.tsx) is a custom-rendered
      // tool-UI component that only ever reads the tool's final result, never these
      // incremental deltas, so nothing client-visible depends on seeing them at all.
      if (chunk?.type === "tool-input-delta" && toolNameByCallId.get(chunk.toolCallId) === "respondToCustomer") {
        return;
      }
      if ((chunk?.type === "tool-input-available" || chunk?.type === "tool-input-error") && chunk?.toolName === "respondToCustomer" && chunk.input && typeof chunk.input === "object") {
        controller.enqueue({ ...chunk, input: { message: (chunk.input as { message?: unknown }).message } });
        return;
      }
      controller.enqueue(chunk);
    },
  });
}

// The storefront's chat widget streams here — one route per agent, framework-agnostic
// (this is the documented "use outside Mastra's own apiRoutes" form of the same
// mechanism `chatRoute()` wraps, chosen so it can live on this existing Hono app
// instead of standing up a second, Mastra-managed server).
//
// A thin wrapper around the real handler (runChatTurn) — catches anything that goes
// wrong BEFORE or WHILE setting up the stream (malformed request JSON, handleChatStream
// itself rejecting during setup, an unexpected bug anywhere in between) and turns it
// into a clean, generic JSON error instead of Hono's own raw 500. A real, live-
// reproduced gap this closes: a genuine network failure reaching the LLM API left the
// customer looking at total silence — no typing indicator, no message, no error, no
// case, nothing — because nothing anywhere in this pipeline had ever been asked what
// to show the customer when something breaks. This layer, `onError` below (mid-stream
// failures — an LLM outage, once the stream has already started), and the
// beforeToolCall hooks' own try/catch (wismo-agent.ts — a bug in a hook, or a
// workflow/storage error) are the three places a failure can actually originate;
// ChatWidget.tsx's new `<MessagePrimitive.Error>` render is what actually shows the
// customer something for the middle one, and this route's own non-2xx response is what
// a client-side fetch failure for the other two ultimately surfaces as.
app.post("/chat/:agentId", async (c) => {
  try {
    return await runChatTurn(c);
  } catch (error) {
    console.error(`[chat] Unexpected error setting up the chat stream:`, error);
    return c.json({ error: "chat_unavailable", message: "I'm sorry, something went wrong on our end. Please try again in a moment." }, 500);
  }
});

async function runChatTurn(c: Context) {
  const agentId = c.req.param("agentId");
  // Always present in practice (the route itself is registered as "/chat/:agentId"),
  // but Context's own generic type — genuinely unaware of that path once this handler
  // is a standalone function rather than an inline route callback — widens this to
  // `string | undefined`. A real guard, not just a type-narrowing formality: this whole
  // function exists to make chat failures graceful, and a missing param is exactly the
  // kind of thing that should return a clean error instead of an unexplained crash a
  // few lines later.
  if (!agentId) return c.json({ error: "missing_agent_id", message: "I'm sorry, something went wrong on our end. Please try again in a moment." }, 400);
  const body: unknown = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return c.json({ error: "invalid_request", message: "I couldn't read that request. Please try again.", retryable: false }, 400);
  }
  // `params` is read here and NEVER handed to the agent. handleChatStream spreads whatever object it is given over the
  // server's own agent options (a client's `instructions` replaces the whole prompt, `providerOptions` can switch on extended
  // thinking, a plain-object `requestContext` replaces the server's), so only the fields built below are passed on.
  const params = body as { messages?: unknown; sessionId?: unknown; conversationId?: unknown; trigger?: unknown };

  // Generated client-side once per ChatWidget mount (ChatWidget.tsx) and sent as part of every /chat request's body: it
  // scopes live pushes to the exact tab that created a case, and (with the conversationId) it owns the stored thread. A
  // request without one has no thread to belong to and is refused.
  const sessionId: string = typeof params.sessionId === "string" ? params.sessionId : "";
  if (!sessionId || sessionId.length > MAX_ID_CHARS) {
    return c.json({ error: "missing_session", message: "I couldn't tell which chat this belongs to. Please reload the page and try again.", retryable: false }, 400);
  }
  const rawConversationId = typeof params.conversationId === "string" && params.conversationId ? params.conversationId : sessionId;
  if (rawConversationId.length > MAX_ID_CHARS) {
    return c.json({ error: "invalid_conversation", message: "I couldn't tell which chat this belongs to. Please reload the page and try again.", retryable: false }, 400);
  }

  if (activeChatTurns.has(sessionId)) {
    return c.json({ error: "turn_in_progress", message: "I'm sorry, I'm still working on your last message — please wait a moment before sending another." }, 429);
  }
  // Safety-net release in case neither onFinish nor onError below ever fires for this
  // turn (a genuinely anomalous case, e.g. a client disconnect mid-stream) — without
  // this, one stuck turn would permanently lock the customer out of this chat tab.
  const turnToken = Symbol(sessionId);
  const safetyNet = setTimeout(() => releaseChatTurn(sessionId, turnToken), 90_000);
  activeChatTurns.set(sessionId, { token: turnToken, timeout: safetyNet });

  // Which CONVERSATION (one thread of messages) this turn belongs to, as opposed to which
  // tab it came from — see request-context.ts's CONVERSATION_ID_KEY. The storefront sends a
  // new one each time it starts a fresh chat after a resolution (ChatWidget.tsx); a client
  // that doesn't send one is treated as one conversation per tab, i.e. the sessionId.
  try {
  const conversationId: string = rawConversationId;

  // Tags this turn's own agent-execution observability span (Mastra's "agent run:
  // 'wismo-agent'" spans, one per chat turn) with the SAME id across every turn in this
  // conversation — nothing else in this app's tracing setup ties a turn's tool calls back
  // to a case at all otherwise (see GET /escalations/:runId/trace's own header comment).
  const chatExecutionRunId = conversationId;

  // The history the model is given comes from the server's own thread (conversation-threads.ts), never from the browser's
  // copy: only the newest message is taken from the request, cleaned (chat-input.ts), and appended. "Try again" arrives as
  // trigger "regenerate-message" with the failed reply already removed; it reruns on the customer message that is already
  // stored instead of storing it twice, and keeps what the failed turn already did (historyForRetry), so a refund or case it
  // recorded is not forgotten and attempted again. A previous turn's reply may still be being written, so wait for it first.
  const regenerate = params.trigger === "regenerate-message";
  await pendingThreadWrites.get(conversationId);
  const prepared = await withThreadLock(conversationId, async (): Promise<{ refusal: ChatRefusal } | { history: StoredMessage[] }> => {
    const existing = await getThread(conversationId);
    // A thread is the session's that started it AND the trusted customer's: the stored customer is checked as well as the
    // browser-supplied session id, which on its own proves nothing.
    if (existing && (existing.sessionId !== sessionId || existing.customerId !== customers.cust_demo_01.id)) {
      return { refusal: { status: 403 as const, error: "conversation_not_yours", message: "I couldn't open that chat. Please reload the page and start again." } };
    }
    // "Try again" names the customer message it retries: the last one the browser sends. If the server never stored that message
    // (the send did not arrive: a dropped connection), there is nothing to rerun, so it is sent now as a new message. Without this
    // the retry reran the PREVIOUS stored message and its reply showed up under the new one. A retry that names no message reruns
    // the stored one.
    const clientMessages = Array.isArray(params.messages) ? params.messages : [];
    const lastFromBrowser = clientMessages[clientMessages.length - 1] as { id?: unknown; role?: unknown } | undefined;
    const browserId = typeof lastFromBrowser?.id === "string" && lastFromBrowser.id.length <= MAX_ID_CHARS ? lastFromBrowser.id : undefined;
    const storedLastCustomerMessage = [...(existing?.messages ?? [])].reverse().find((m) => m.role === "user");
    const retryNamesUnstoredMessage = regenerate && lastFromBrowser?.role === "user" && browserId !== undefined && storedLastCustomerMessage?.clientId !== browserId;
    let history: StoredMessage[];
    if (regenerate && !retryNamesUnstoredMessage) {
      const trimmed = existing ? historyForRetry(existing.messages, isReplyToolName) : undefined;
      if (!trimmed) return { refusal: { status: 400 as const, error: "nothing_to_retry", message: "There's nothing to retry yet. Please send your message again." } };
      history = trimmed;
    } else {
      const incoming = sanitizeIncomingMessage(lastFromBrowser);
      if (!incoming.ok) return { refusal: { status: incoming.status, error: incoming.error, message: incoming.message } };
      if ((existing?.messages.length ?? 0) >= MAX_THREAD_MESSAGES) {
        return { refusal: { status: 409 as const, error: "conversation_too_long", message: "This conversation has gotten very long. Please start a new chat to keep going." } };
      }
      history = [...(existing?.messages ?? []), { ...incoming.message, ...(browserId ? { clientId: browserId } : {}) }];
    }
    await saveThread({ conversationId, sessionId, customerId: customers.cust_demo_01.id, messages: history });
    // From here until the reply is stored, a notice for this chat waits for it (turn-notices.ts). endTurn runs on every way out.
    beginTurn(conversationId);
    return { history };
  });
  if ("refusal" in prepared) {
    releaseChatTurn(sessionId, turnToken);
    return c.json({ error: prepared.refusal.error, message: prepared.refusal.message, retryable: false }, prepared.refusal.status);
  }

  // Session-bound identity (the anti-coercion rule): the
  // storefront has exactly one "logged in" customer and no real auth (same as /me).
  // The REAL binding is requestContext below, which tools read directly in code
  // (see request-context.ts / commerce.ts) — that's what actually closes the "check
  // order #999 instead" class of attack, not this message. This system message is only
  // a conversational courtesy so replies read naturally; it grants no capability the
  // requestContext binding doesn't already enforce on its own.
  //
  // A system-role message needs Mastra's CoreMessage shape ({role, content: string}) —
  // unlike user/assistant turns, it does NOT take the UIMessage `parts` array; passing
  // `parts` here throws "Invalid system message format" (verified against the real
  // running server, not just inferred from the types).
  const identityMessage = {
    role: "system" as const,
    content: `You're already talking to an authenticated, logged-in customer — never ask them for their own customer ID. If they mention an order, you can look it up by order ID; your tools already know who this customer is.`,
  };
  // Captured before the identity message is prepended — onFinish below needs the real
  // conversation only (the identity message is server plumbing, not something that
  // belongs in a case's transcript).
  const conversationMessages = prepared.history;
  // The only thing the agent is given from this request: the server's own history behind the identity message.
  const agentParams: any = { messages: [identityMessage, ...conversationMessages.map((m) => ({ id: m.id, role: m.role, parts: m.parts }))] };

  const requestContext = new RequestContext([
    [SESSION_CUSTOMER_ID_KEY, customers.cust_demo_01.id],
    [SESSION_ID_KEY, sessionId],
    [CONVERSATION_ID_KEY, conversationId],
  ]);

  // A respond_to_customer call with invalid input doesn't throw: @mastra/core's tool wrapper
  // returns the Zod validation-error object AS the tool's "successful" result —
  // {error: true, message: "Tool input validation failed ...", validationErrors: [...]}. Its
  // `message` is a string, like a genuine reply's {message: string} (respond-to-customer.ts's
  // outputSchema), so "toolName matches and message is a string" can't tell them apart. Mistaking
  // one for a reply showed the raw error text to the customer and made prepareStep relax
  // toolChoice to "auto", freeing the model to stream unguarded raw text (the reply guards only
  // fire on a real tool call). `error === true` is the one field that separates the two: the
  // declared outputSchema never produces an `error` field on success.
  const isGenuineRespondToCustomerResult = (result: any): boolean => result != null && typeof result === "object" && result.error !== true && typeof result.message === "string";

  // The tool-result value inside a prepareStep/stopWhen `steps` entry. That parameter is Mastra's
  // INTERNAL agentic-loop accumulator, a different shape from handleChatStream's onFinish event
  // (which uses {payload: {toolName, result}}): each toolResults[] entry is a raw AI-SDK-v5
  // "tool-result" part, {type: "tool-result", toolCallId, toolName, output: {type: "json"|"text"|
  // "error-json"|"error-text", value}}, with no `.payload` wrapper and no `.result` or `.args`
  // field at all. The real result is at `.output.value`.
  //
  // This once read `.result`, which was always undefined, so respondToCustomerCallInStep was
  // always false: stopWhen never stopped a turn and prepareStep never relaxed toolChoice after a
  // reply, so the model was forced to keep calling a tool and filled turns with repeated
  // respond_to_customer filler. Anything that reads these steps must go through this helper.
  const extractToolResultValue = (toolResult: any): unknown => {
    const output = toolResult?.output;
    return output?.type === "json" || output?.type === "text" ? output.value : undefined;
  };
  const respondToCustomerCallInStep = (step: any): boolean =>
    (step?.toolResults ?? []).some((toolResult: any) => {
      return toolResult?.toolName === "respondToCustomer" && isGenuineRespondToCustomerResult(extractToolResultValue(toolResult));
    });

  // wismo-agent.ts's own ground rules name exactly two tools the model is told to call
  // WITHOUT any accompanying respond_to_customer narration — the tool's own result
  // renders a self-explanatory card (a return-item checkbox picker, a clickable order
  // list) and the turn is meant to end right there, waiting on the customer's next
  // action. prepareStep below (do not force a reply after one) and stopWhen (end the turn
  // at once) both need to recognize these as a legitimate stopping point
  // too, not just a respondToCustomer call — live-caught during testing: without this,
  // the very first return flow tried (present_return_item_picker, then nothing) got
  // forced into an awkward, unwanted extra respondToCustomer call with an EMPTY message
  // right after the picker rendered, breaking the "card speaks for itself" design this
  // exists to preserve.
  // Only a card that actually RENDERED ends the turn: an errored call (offer_escalation_to_support
  // refusing because a ticket already exists, the item picker refusing a single-item order) is a
  // result too — error output shapes appear in toolResults — but nothing was shown, so counting it
  // left the customer with silence: the offer tool refused, the step was read
  // as "the card is the reply", the model had no reason to continue, and the turn ended with only
  // an earlier "let me look into that". extractToolResultValue is undefined for an error output.
  const stepEndsTurnWithoutReply = (step: any): boolean =>
    (step?.toolResults ?? []).some((toolResult: any) => SILENT_TOOL_NAMES.has(toolResult?.toolName) && extractToolResultValue(toolResult) !== undefined);
  // True if the step ran a tool that is neither the reply tool nor a card: a lookup, a policy check, a payment, an escalation.
  // A call that errored counts too (it may have left no result). Its result is still to be told. A reply in the same step, usually
  // the opening "Let me check on that" line, was written before that result existed, so it cannot be the answer.
  const stepRanOtherTools = (step: any): boolean =>
    [...(step?.toolCalls ?? []), ...(step?.toolResults ?? [])].some((call: any) => call?.toolName && call.toolName !== "respondToCustomer" && !SILENT_TOOL_NAMES.has(call.toolName));

  // The real remaining reliability risk with maxSteps at 20 isn't the model going silent
  // (prepareStep's toolChoice enforcement re-arms a reply) but a RETRY LOOP: the same tool called
  // again without progress, which a well-behaved turn never needs (the first result is already in
  // context). The signature is tool name + RESULT, not arguments: this step shape carries no call
  // arguments, and two calls with the same outcome are as unproductive to repeat as two with the
  // same input, while a genuinely different lookup (another order) gives a different result.
  const stepCallSignature = (step: any): string =>
    (step?.toolResults ?? [])
      .map((toolResult: any) => `${toolResult?.toolName}:${JSON.stringify(extractToolResultValue(toolResult) ?? null)}`)
      .sort()
      .join("|");

  const isRepeatedIdenticalStep = (steps: any[]): boolean => {
    if (steps.length < 2) return false;
    const last = stepCallSignature(steps[steps.length - 1]);
    const secondToLast = stepCallSignature(steps[steps.length - 2]);
    return last.length > 0 && last === secondToLast;
  };

  // Broader than the back-to-back check above. The model can ALTERNATE between two individually
  // legitimate tools (commerceGetOrder, checkEscalationStatus) for the same order 10+ times after
  // already giving the customer a real answer; every consecutive pair looks "different", so
  // isRepeatedIdenticalStep never fires. This catches the wider shape: has this exact call (tool
  // name + result) already happened anywhere earlier in the turn? A well-behaved turn never needs
  // the same fact twice, so any repeat, adjacent or not, means no progress.
  const hasSeenCallBefore = (steps: any[]): boolean => {
    const seen = new Set<string>();
    for (const step of steps) {
      for (const toolResult of step?.toolResults ?? []) {
        const sig = `${toolResult?.toolName}:${JSON.stringify(extractToolResultValue(toolResult) ?? null)}`;
        if (seen.has(sig)) return true;
        seen.add(sig);
      }
    }
    return false;
  };

  // The model produces no raw assistant text: every customer-facing utterance goes through
  // respond_to_customer (wismo-agent.ts), so onFinish's own `text` is always empty. This rebuilds
  // "what the agent said this turn" from each respond_to_customer call's `message`, in order.
  // `event.steps` is a non-optional array in Mastra's onFinish type; the `[event]` fallback covers
  // a turn where no step completed (an error before the first one finished), where `event`
  // itself still carries an aggregate `toolResults`.
  const extractCustomerText = (event: any): string => {
    const steps = Array.isArray(event?.steps) && event.steps.length > 0 ? event.steps : [event];
    const messages: string[] = [];
    for (const step of steps) {
      for (const toolResult of step?.toolResults ?? []) {
        const payload = toolResult?.payload ?? toolResult;
        // isGenuineRespondToCustomerResult (above) excludes a Zod validation-error
        // result — without it, a failed call's own diagnostic text ("Tool input
        // validation failed for respondToCustomer...") would be recorded into the
        // durable case transcript as if the agent had actually said it to the customer.
        if (payload?.toolName === "respondToCustomer") {
          if (isGenuineRespondToCustomerResult(payload?.result)) {
            // Skip a flat empty message — live-reproduced alongside the sticky-loop fix
            // (prepareStep, below): once a genuine retry loop is detected and locked to
            // respond_to_customer for the rest of the turn, a model with nothing left to
            // say still has to call it on every remaining step, and several came back
            // with `message: ""`. Recording that into the durable case transcript would
            // just be blank noise a rep gains nothing from reading.
            if (payload.result.message.trim()) messages.push(payload.result.message);
          } else if (payload?.result?.error === true) {
            // Visibility for this failure mode — logged so a
            // recurrence is visible in server logs, not silently swallowed. The model
            // should self-correct on its own next attempt (the validation error text
            // is fed back into its context); prepareStep also no longer treats this as
            // "a reply was delivered," so it re-forces a real tool call next step.
            console.error(`[chat] respond_to_customer call failed input validation for session ${sessionId} — not treated as a customer reply:`, payload.result.message);
          }
        }
      }
      // A respond_to_customer call that errored instead of resolving streams as a
      // separate 'tool-error' part (never landing in toolResults above) — code review
      // caught that this silently vanished with zero trace. Can't recover the intended
      // message, but at least surfaces that one went missing instead of leaving no
      // record anywhere that a reply was dropped.
      for (const part of step?.content ?? []) {
        if (part?.type === "tool-error" && part?.toolName === "respondToCustomer") {
          console.error(`[chat] respond_to_customer call errored instead of resolving — a customer-facing reply was dropped this turn:`, part?.error);
        }
      }
    }
    return messages.join("\n\n");
  };

  const onFinish = async (event: { text: string }) => {
    // Releases the concurrent-turn lock the moment this turn has GENUINELY finished
    // (every hidden step included, not just the customer-visible reply) — unconditional
    // and first, so a later throw in onFinishInner can never leave it held.
    releaseChatTurn(sessionId, turnToken);
    // The customer's own reply has already fully streamed by the time this runs (it's
    // everything AFTER that: transcript sync, live-push bookkeeping) — an exception in
    // here shouldn't be able to crash the request or surface as a customer-visible
    // failure for a turn that, from the customer's point of view, already succeeded.
    // Logged, not swallowed silently: a real sync failure still needs to be visible
    // somewhere for debugging, just never as an unhandled rejection.
    try {
      await onFinishInner(event);
    } catch (error) {
      console.error(`[chat] onFinish failed for session ${sessionId} — the customer's reply already sent, but transcript sync/live-push bookkeeping for this turn did not complete:`, error);
    }
  };

  const onFinishInner = async (event: { text: string }) => {
    const extracted = extractCustomerText(event);
    // The model should never fall back to raw text (wismo-agent.ts's ground rule routes
    // every utterance through respond_to_customer), but if it ever does, that text
    // bypassed response-leak-guard.ts entirely (a beforeToolCall hook only fires on a
    // real tool call) — code review flagged this as a real gap. Can't un-stream tokens
    // already sent to the live customer, but at least don't let an unfiltered leak
    // propagate further into the stored case transcript a rep reads later.
    let text = extracted;
    if (!extracted && event.text) {
      const leak = detectIdentifierLeak(event.text, await liveReasonCodes());
      if (leak) {
        console.error(`[chat] Model produced raw text instead of calling respond_to_customer, AND it contained ${leak} — this should never happen. Original: ${JSON.stringify(event.text)}`);
        text = "";
      } else {
        console.error(`[chat] Model produced raw text instead of calling respond_to_customer — this should never happen (no leak detected in it). Original: ${JSON.stringify(event.text)}`);
        text = event.text;
      }
    }
    // Keeps any open case's transcript current with the conversation, automatically (case-sync.ts
    // explains why this isn't an agent tool). Fires once per turn, after the model's full reply is
    // known. Only orders a tool actually validated ownership for (markOrderTouched in
    // request-context.ts) are synced, so an unrelated order's case never gets overwritten with
    // this conversation's content.
    // This turn's own tool calls (request-context.ts) plus every order any EARLIER turn
    // in this same conversation looked up (touched-orders-from-history.ts, scanning the
    // resent message history's own tool-call parts) — covers a casual follow-up where
    // the model doesn't re-call anything because it already "knows" the answer from
    // earlier, not just an explicit re-check this turn.
    const touchedOrderIds = new Set([...getTouchedOrderIds(requestContext), ...touchedOrderIdsFromHistory(conversationMessages)]);
    // Plus any case THIS session escalated that's still waiting on a reply — live-
    // reproduced gap: a customer's answer to a specialist's follow-up question ("could
    // anyone else have signed?") very often needs no tool call at all, so neither source
    // above catches it, the sync never fires, and the countdown sits frozen forever
    // instead of refreshing. See case-lookup.ts's findAwaitingCustomerOrderIdsForSession.
    const policyReviewWorkflow = mastra.getWorkflow("policyReviewWorkflow");
    if (policyReviewWorkflow) {
      for (const orderId of await findAwaitingCustomerOrderIdsForSession(policyReviewWorkflow, sessionId)) {
        touchedOrderIds.add(orderId);
      }
    }
    // No real circuit-breaker exists beyond the step count itself (code review flagged
    // this) — surfacing it loudly, at least, the moment a turn actually uses the entire
    // budget, since that's the one concrete signal available that a turn may have
    // truncated mid-task rather than naturally finishing early.
    if (Array.isArray((event as any)?.steps) && (event as any).steps.length >= 20) {
      console.error(`[chat] Turn for session ${sessionId} used the full maxSteps budget (20) — it may have been cut off mid-task rather than finishing naturally.`);
    }
    // Cases this turn itself created — see syncCreatedCaseTranscripts for why a case that
    // already resolved needs its own end-of-turn rebuild.
    const createdCaseIds = getCreatedCaseIds({ requestContext });
    if (touchedOrderIds.size === 0 && createdCaseIds.length === 0) return;
    // Sync even when this turn produced no visible reply (e.g. it hit maxSteps mid-task,
    // or was purely investigative) — code review caught that bailing out here on empty
    // text (before touchedOrderIds was even computed) meant the CUSTOMER's own newest
    // message could also silently fail to reach the case transcript until some later
    // turn happened to produce text. Only append a synthetic reply message when there
    // actually was one.
    const fullConversation = text?.trim() ? [...conversationMessages, { role: "assistant" as const, parts: [{ type: "text" as const, text }] }] : conversationMessages;
    for (const orderId of touchedOrderIds) {
      const result = await syncCaseTranscriptForOrder(mastra, customers.cust_demo_01.id, orderId, fullConversation, sessionId);
      if (result.status === "error") {
        console.error(`[chat] transcript sync failed for ${orderId}:`, result.reason);
      }
    }
    await syncCreatedCaseTranscripts(mastra, createdCaseIds, fullConversation);
  };

  // Nothing else stops the model ending a turn with plain text (or silence) instead of calling
  // respond_to_customer, which would bypass the reasoning/message split and response-leak-guard.ts.
  // A blanket `toolChoice: "required"` for the whole turn is wrong: an ordinary one-reply turn runs
  // ONE extra empty step after respondToCustomer resolves (no tool call, nothing left to say,
  // finishReason "stop"), and forcing that step would force a spurious tool call every turn. So
  // prepareStep sets toolChoice per step: "required" whenever the MOST RECENT completed step did NOT
  // end with a respondToCustomer call, and Mastra's default ("auto") for exactly the one step right
  // after one did. It checks only the last step, not "has it fired at all this turn", because the
  // failure it exists to prevent is several silent tool-call steps in a row after an early reply
  // ("let me process that return", then cut off mid-task). Checking the last step re-forces a reply
  // the moment the model goes silent again.
  //
  // STICKY once tripped. Forcing respond_to_customer for only the step after a detected repeat let
  // the model go straight back to the same broken call (present_return_item_picker retried against
  // a single-item order despite a clear thrown error: 18 repeats in one turn, the full 20-step
  // budget used, nothing rendered). Once `loopDetected` flips true, toolChoice is forced to
  // respond_to_customer for the REST of the turn. toolChoice can't block one specific tool+args
  // combination while allowing others, so removing every other tool is the only way to guarantee
  // the poisoned call is never retried. The worst case is a few short repeated closing replies
  // before maxSteps ends the turn, which is far cheaper than silence or an unguarded text dump.
  let loopDetected = false;
  const prepareStep = ({ steps }: { steps: any[] }) => {
    // Before every step: this turn's completed tool results, for claim-grounding-guard.ts (see turnToolText).
    setTurnFacts({ requestContext }, turnToolText(steps));
    if (loopDetected || isRepeatedIdenticalStep(steps) || hasSeenCallBefore(steps)) {
      if (!loopDetected) console.error(`[chat] Detected a repeated tool call for session ${sessionId} — forcing respond_to_customer for the remainder of this turn instead of letting the loop continue.`);
      loopDetected = true;
      return { toolChoice: { type: "tool" as const, toolName: "respondToCustomer" } };
    }
    const lastStep = steps[steps.length - 1];
    // After a reply or a card the next step is free. Not after a step that ALSO did real work: its result is still to be told, and
    // a free step let a model that went quiet leave the customer at "Let me check on that for you."
    if (lastStep && !stepRanOtherTools(lastStep) && (respondToCustomerCallInStep(lastStep) || stepEndsTurnWithoutReply(lastStep))) return undefined;
    return { toolChoice: "required" as const };
  };

  // A genuine HARD STOP, not another toolChoice nudge. Once the model has replied, prepareStep's
  // "one free step, then re-force" cycle doesn't reliably let it finish: given that free step it
  // often calls a tool that doesn't exist, or calls respond_to_customer again with an empty
  // message, is ratcheted back into "must call a tool", and burns the whole maxSteps budget (the
  // customer watching the typing indicator for 50+ seconds after a complete reply). toolChoice only
  // influences WHICH tool is picked next; it cannot say "stop here". `stopWhen` can, and Mastra
  // combines it with the step ceiling ([stepCountIs(maxSteps), ...stopWhen]) rather than replacing it.
  //
  // It fires only once the customer has ALREADY had a genuine reply this turn (so it never
  // suppresses the first one), and only on an unambiguous sign that continuing adds nothing:
  //   - a hard stream error (hadUnrecoverableStepIssue, set from onError below): a hallucinated tool
  //     name (ToolNotFoundError, which Mastra routes through onError, not a per-step part) or a
  //     real upstream failure, where retrying against a dead call helps no one. (A tool that only
  //     THREW is not one: its error goes back to the model as the tool's result.)
  //   - the retry-loop breaker above already tripped (loopDetected);
  //   - respond_to_customer resolved with an empty message this step, judged with
  //     isGenuineRespondToCustomerResult so "a real reply" means the same thing everywhere.
  let hadUnrecoverableStepIssue = false;
  // When to stop. Stopping after ANY reply is wrong: the model sometimes narrates before acting
  // ("You're right, I apologize. Let me check your account..."), which breaks wismo-agent.ts's
  // "never narrate before a tool call" rule, and ending the turn there would strand the customer
  // with an incomplete answer, since only a new customer message starts another turn. But a turn
  // must still stop once the model has genuinely said everything. So three narrower signals:
  //   1. An explicit closing question ("anything else" / "what else"): the phrase wismo-agent.ts
  //      TEACHES the model to use when it is done and waiting on the customer. A narrow convention,
  //      not a guess at arbitrary filler wording.
  //   2. A flat-empty reply: never useful.
  //   3. TWO genuine replies in a row with no real work in between: the shape the original
  //      "chatter" bug took (a string of differently worded, equally content-free replies). A single
  //      reply, even a premature one, gets the benefit of the doubt: prepareStep relaxes toolChoice
  //      to "auto" for the next step, so a model that is done simply stops, and one that narrated
  //      prematurely is free to call the tool it just promised. Reaching a second reply in a row
  //      means the model chose to say something else instead of working or stopping.
  //      "Real work" is judged per STEP, and a step routinely holds a reply AND work (narrate +
  //      escalate_for_delivery_dispute in one step), so both steps must be reply-ONLY
  //      (stepDidRealWork): a step that also did work has a result still to narrate. Without that,
  //      4 of 5 delivery-dispute escalations stopped right after the escalate call and the customer
  //      never got the case ID.
  const looksLikeClosingQuestion = (message: string): boolean => /anything else|what else/i.test(message);
  // True if the step called anything other than respond_to_customer — a lookup, a policy
  // check, an escalation, a payment. Looks at the calls as well as the results, so a call
  // that errored (and may have left no result) still counts as work.
  const stepDidRealWork = (step: any): boolean =>
    [...(step?.toolCalls ?? []), ...(step?.toolResults ?? [])].some((call: any) => call?.toolName && call.toolName !== "respondToCustomer");
  const genuineReplyMessage = (step: any): string | undefined => {
    for (const toolResult of step?.toolResults ?? []) {
      if (toolResult?.toolName !== "respondToCustomer") continue;
      const value = extractToolResultValue(toolResult) as { message?: string } | undefined;
      if (isGenuineRespondToCustomerResult(value)) return value!.message;
    }
    return undefined;
  };
  const stopWhen = ({ steps }: { steps: any[] }): boolean => {
    if (steps.length === 0) return false;
    // A card tool (order list, item picker, the two offer cards) whose result is in IS the whole reply: the customer
    // acts on the card next. Without this the model gets one more full step for nothing (a ~9s model call), and the
    // chat sits locked with no typing dots for all of it, because the stream is still open.
    // Only when the card was the whole step: if the same step also ran a lookup (the model can call tools in
    // parallel), that result still has to be read, so the model keeps its next step.
    const lastStep = steps[steps.length - 1];
    if (stepEndsTurnWithoutReply(lastStep) && !stepRanOtherTools(lastStep)) return true;
    if (!steps.some(respondToCustomerCallInStep)) return false;
    if (loopDetected || hadUnrecoverableStepIssue) {
      console.error(`[chat] Stopping turn early for session ${sessionId} after a real reply — no further steps are likely to add anything the customer needs.`);
      return true;
    }
    const lastMessage = genuineReplyMessage(steps[steps.length - 1]);
    if (lastMessage === undefined) return false;
    if (!lastMessage.trim()) {
      console.error(`[chat] Stopping turn early for session ${sessionId} — the model's reply was flat empty, not more useful work.`);
      return true;
    }
    if (looksLikeClosingQuestion(lastMessage)) {
      console.error(`[chat] Stopping turn for session ${sessionId} — the model just asked a closing question, which ends the turn regardless of what it might otherwise do next.`);
      return true;
    }
    if (steps.length >= 2) {
      const previousStep = steps[steps.length - 2];
      const lastStep = steps[steps.length - 1];
      if (genuineReplyMessage(previousStep) !== undefined && !stepDidRealWork(previousStep) && !stepDidRealWork(lastStep)) {
        console.error(`[chat] Stopping turn for session ${sessionId} — two replies in a row with no real work in between; further replies are unlikely to add anything new.`);
        return true;
      }
    }
    return false;
  };

  const stream = await handleChatStream({
    mastra,
    agentId,
    params: agentParams,
    version: "v7",
    defaultOptions: {
      requestContext,
      onFinish,
      prepareStep,
      // Mastra's own default is stepCountIs(5) when this is left unset (confirmed
      // against the installed package, not assumed) — comfortably enough for the old
      // design, where narration was free text interleaved with tool calls, but not for
      // this one: respond_to_customer is now itself a tool call, so a single ordinary
      // turn (narrate, look up the order, check for a duplicate, narrate again, call
      // the real payment tool, narrate the final result) can need 6-7 steps on its own
      // before anything unusual happens. Live-reproduced at the default: a turn hit
      // exactly 5 steps (narrate, commerceGetOrder, commerceGetProductsForOrder,
      // checkEscalationStatus, narrate again) and the model's own turn was cut off
      // mid-task, right after promising "let me process that return for you" and
      // before ever calling payment_issue_return_refund — confirmed via a raw stream
      // capture, not guessed from symptoms. 20 gives real headroom for a multi-step
      // flow (a picker round, a duplicate check, a payment call, a label call, several
      // narration turns) without being unbounded.
      maxSteps: 20,
      stopWhen,
      ...(chatExecutionRunId ? { runId: chatExecutionRunId } : {}),
    },
    // Mastra's agent loop already catches an upstream LLM failure (a network timeout,
    // a rate limit, the provider being down) and turns it into a real "error" chunk in
    // the stream rather than crashing it outright — confirmed by reading its own
    // internals (agent-*.js's runState.setState({..., deferredErrorChunk: {type:
    // "error", ...}})) after this exact failure mode showed up live. Without this
    // option, that chunk still carries the raw APICallError text — technical, and per
    // @mastra/ai-sdk's own docs, only stripped of a few specifically-sensitive fields
    // (request body values), not rewritten into something a customer should read.
    // ChatWidget.tsx's new `<MessagePrimitive.Error>` renders a fixed apology
    // regardless of what text arrives here, so this string is really only for
    // anything that ever bypasses that (a different client) or gets logged — kept
    // customer-safe either way, same "never surface internals" rule as everywhere
    // else in this app.
    // Deliberately does NOT release the turn lock: onError also fires for a recoverable
    // mid-turn error (a hallucinated tool name) after which the turn keeps running
    // unless a reply already went out — releasing here let a second, concurrent turn
    // start. The stream closing (releaseTurnWhenStreamEnds below) is the real end.
    onError: (error) => {
      console.error(`[chat] Stream error for session ${sessionId}:`, error);
      // Feeds stopWhen above — a hard stream-level error (a hallucinated/nonexistent
      // tool call, an upstream API failure) is an unambiguous "don't keep going" signal
      // once the customer has already gotten a real reply this turn. A tool that merely THREW (a mistyped order number, an order
      // that is not the customer's) is not: the model is handed the error as that tool's result and can tell the customer, and
      // ending the turn here left them with only the opening line. Mastra marks those errors TOOL_EXECUTION_FAILED.
      const toolThrew = (error as any)?.id === "TOOL_EXECUTION_FAILED" && (error as any)?.domain === "TOOL";
      if (!toolThrew) hadUnrecoverableStepIssue = true;
      // A JSON string, because this is all the browser receives: the customer-safe sentence plus whether "Try again" can
      // help (chat-errors.ts). The widget parses it, and falls back to a generic apology if it ever isn't JSON.
      return JSON.stringify(classifyChatError(error));
    },
  });
  // What the browser receives is copied: one copy goes to the browser, the other is read to the end on the server to rebuild
  // the assistant's message (text, tool calls and their results) and write it to the thread. The browser's copy is not closed
  // until that write is done, so the next message always finds the reply in the thread. If the browser disconnects, the
  // server's copy is still read to the end, and the next request waits for the write (pendingThreadWrites).
  const [toBrowser, toThread] = stream.pipeThrough(redactReasoningFromClientStream()).tee();
  const written = storeAssistantReply(toThread, conversationId);
  // The turn is over once the reply is stored AND the notices that arrived meanwhile are written after it.
  const turnFinished: Promise<void> = written.then(() => endTurn(conversationId)).catch((error) => console.error("[chat] Could not finish the turn's notices:", error));
  pendingThreadWrites.set(conversationId, turnFinished);
  void turnFinished.then(() => {
    if (pendingThreadWrites.get(conversationId) === turnFinished) pendingThreadWrites.delete(conversationId);
  });
  return createUIMessageStreamResponse({ stream: toBrowser.pipeThrough(releaseTurnWhenStreamEnds(sessionId, turnToken, written)) });
  } catch (error) {
    releaseChatTurn(sessionId, turnToken);
    // A turn that failed before there was a reply: any notice that waited is written now.
    void endTurn(rawConversationId).catch((endError) => console.error("[chat] Could not finish the turn's notices:", endError));
    throw error;
  }
}

// The customer-facing half of "Escalate to support" (the Escalation Desk's own button is
// POST /escalations/:runId/resume). A customer who disagrees with a decision escalates it to the
// support ticket system. The storefront calls this ONLY after the customer confirms the
// "Escalate to support?" card the agent renders via offer_escalation_to_support
// (mastra/tools/offer-escalation.ts) — never straight off the tool call, the same "ask first"
// rule offer_new_chat follows for a consequential action.
//
// It re-derives "is there actually a resolved case to disagree with" from durable storage
// instead of trusting the client, the same "never trust the caller for a fact that gates a real
// action" rule every money and policy path follows. It is not a workflow resume (the run is
// already terminal, and Mastra can't resume a completed run): it calls the same stub
// escalateSupportTicket as every other path, since there is no real ticketing system.
//
// Idempotent: a repeat request for the same case (a retry or a double-click) returns the SAME
// ticketId instead of opening a second one. A bare get-then-set is not enough, because two
// CONCURRENT requests could both read "nothing recorded yet" across the awaits in between, so
// the whole check-through-record sequence runs under `disagreementLocks`, the same shared
// createKeyedLock used by payment.ts's per-order lock and repository.ts's per-namespace lock.
//
// The record is durable (mastra/disagreement-tickets.ts: a JSON file under data/, cleared on
// /demo/reset), not an in-memory Map, so it survives a restart and can be queried later. A
// customer who escalated and returns in a LATER conversation for a status would otherwise get
// the original, superseded outcome recited back. check_escalation_status and lookup_case_by_id
// both check it, so a status check reports "a support ticket is already open".
const disagreementLocks = createKeyedLock();

app.post("/chat/:agentId/escalate-disagreement", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const conversationId = typeof body.conversationId === "string" ? body.conversationId : "";
    const caseId = typeof body.caseId === "string" ? body.caseId : "";
    // The customer's words in the support ticket come from the server's own thread when it has one; the browser's copy is
    // only a fallback for a conversation with no stored thread.
    const clientMessage = typeof body.message === "string" ? cleanText(body.message) : "";
    const storedThread = conversationId ? await getThread(conversationId) : undefined;
    const ownThread = storedThread && storedThread.customerId === customers.cust_demo_01.id ? storedThread : undefined;
    const message = (ownThread ? lastUserText(ownThread.messages) : "") || clientMessage;
    if (!conversationId && !caseId) {
      return c.json({ error: "missing_conversation", message: "Couldn't identify this conversation." }, 400);
    }

    // The card names the decided case it was built for (offer_escalation_to_support's caseId) —
    // that is what lets a decision from an EARLIER conversation be escalated. Never trusted: it
    // must be a real, already-resolved case whose order belongs to this customer (the same
    // ownership check every other route here makes), else it falls back to "the most recent
    // resolved case in this conversation", exactly as before this existed.
    let match: Awaited<ReturnType<typeof findMostRecentResolvedCaseForConversation>> = null;
    if (caseId) {
      const state: any = await getWorkflow().getWorkflowRunById(caseId);
      const step = state?.steps?.[POLICY_REVIEW_STEP_ID];
      const caseOrder = step?.payload?.orderId ? getOrder(step.payload.orderId) : undefined;
      if (step?.status === "success" && caseOrder && caseOrder.customerId === customers.cust_demo_01.id) {
        match = { runId: caseId, updatedAt: state.updatedAt, step };
      }
    }
    if (!match && conversationId) match = await findMostRecentResolvedCaseForConversation(getWorkflow(), conversationId);
    if (!match) {
      return c.json({ error: "no_resolved_case", message: "There's no resolved case in this conversation to escalate." }, 404);
    }

    // Everything from the idempotency check through recording the new ticket is
    // serialized per-case — see disagreementLocks' own comment above.
    const result = await disagreementLocks.withLock(match.runId, async () => {
      const existing = await getDisagreementTicket(match.runId);
      if (existing) {
        return { ticketId: existing.ticketId, contactWindowHours: getSupportTicketContactHours() };
      }

      const input = match.step?.payload as
        | { orderId: string; refundAmount: number; problemSummary: string; createdAt: string; threadId?: string; sessionId?: string; transcript?: { role: "customer" | "agent"; text: string; timestamp: string }[] }
        | undefined;
      const order = input ? getOrder(input.orderId) : undefined;
      const customer = order ? getCustomer(order.customerId) : undefined;
      if (!input || !order || !customer) {
        return { notFound: true as const };
      }

      // This used to pass input.refundAmount straight through: the customer's ORIGINAL request amount,
      // frozen at case creation and never updated by a later "modify" decision, so a disagreement about a
      // rep's $30 modified refund would have reported the disputed amount to support as the original $48
      // ask. buildResolvedEntry's action/detail derivation (the same one History/Resolution read) gives the
      // ACTUAL decided amount instead of duplicating that logic here; it falls back to the original ask for a
      // denied, errored or escalated case, where there is no approved amount.
      const resolvedEntry = await buildResolvedEntry(match.runId, match.updatedAt, match.step, false);
      const disputedAmount = resolvedEntry?.refundAmount ?? input.refundAmount;

      const problemSummary = message ? `${input.problemSummary} — customer disagreed with the resolution: "${message}"` : input.problemSummary;
      const ticket = escalateSupportTicket({
        title: "Customer disagreement with a resolved case",
        orderId: order.id,
        customerId: customer.id,
        customerName: customer.name,
        problemSummary,
        orderContext: orderContextLine(order),
        reasonCode: "customer-disagreement",
        explanation: "Customer explicitly rejected the outcome of a resolved case and asked for it to be escalated.",
        recommendedAction: "Review the original decision with the customer",
        refundAmount: disputedAmount,
        currency: config.currency,
        priority: "high",
        threadId: input.threadId ?? "",
        sessionId: input.sessionId ?? "",
        createdAt: input.createdAt,
        transcript: [
          ...(input.transcript ?? []),
          ...(message ? [{ role: "customer" as const, text: message, timestamp: new Date().toISOString() }] : []),
        ],
      });
      await recordDisagreementTicket(match.runId, { ticketId: ticket.ticketId, orderId: order.id, customerId: customer.id, createdAt: new Date().toISOString() });
      return { ticketId: ticket.ticketId, contactWindowHours: getSupportTicketContactHours() };
    });

    if ("notFound" in result) {
      return c.json({ error: "no_resolved_case", message: "There's no resolved case in this conversation to escalate." }, 404);
    }
    return c.json(result);
  } catch (error) {
    console.error("[escalate-disagreement] Unexpected error:", error);
    return c.json({ error: "escalate_failed", message: "I'm sorry, something went wrong on our end. Please try again in a moment." }, 500);
  }
});

// A live channel for the storefront's open chat widget — the one thing the plain
// request/response chat route above can't do on its own: tell the customer something
// happened without them asking. Opened once per chat session and held open; when a rep
// resolves a case in the Escalation Desk (the /resume route above), that event is
// pushed down here the moment it happens, and the chat widget turns it into a real
// message in the thread.
//
// Filtered by customerId AND sessionId — not just customerId. With a single shared demo
// customer identity, filtering by customerId alone meant ANY open tab for that customer
// received EVERY update, including ones for a case a completely different tab (or a
// throwaway test script) created — confirmed live, and confusing. sessionId (query
// param here, generated once per ChatWidget mount) scopes a push to the exact tab that
// created the case; a case whose tab has since closed just has no live connection to
// push into, same as a closed real chat window — it's still fully live in Mastra's own
// records either way (see policy-review-workflow.ts).
app.get("/chat/:agentId/events", (c) => {
  const customerId = customers.cust_demo_01.id;
  const sessionId = c.req.query("sessionId");
  if (!sessionId) return c.json({ error: "session_required" }, 400);
  const cursor = c.req.header("Last-Event-ID") || c.req.query("cursor");

  return streamSSE(c, async (stream) => {
    let closed = false;
    let pending = Promise.resolve();
    markSessionConnected(sessionId);
    const send = (event: ReplayEvent) => {
      if (event.data.customerId !== customerId || event.data.sessionId !== sessionId) return;
      pending = pending.then(async () => {
        if (!closed) await stream.writeSSE({ id: event.id, event: event.type, data: JSON.stringify(event.data) });
      }).catch(() => { cleanup(); });
    };
    const cleanup = () => {
      if (closed) return;
      closed = true;
      markSessionDisconnected(sessionId);
      caseEvents.off("replayable", send);
    };
    stream.onAbort(cleanup);
    // Registration and history capture are synchronous; live events queue after replay.
    caseEvents.on("replayable", send);
    // The response headers leave the server with the first byte. With nothing to replay the stream would send none for up to 25 s,
    // leaving the browser's connection without a response (a refresh then cancels it, which Firefox logs as a CORS failure).
    // Queued ahead of the replay, so the order of events is unchanged; the widget ignores ping events.
    pending = pending.then(() => stream.writeSSE({ event: "ping", data: "" })).catch(() => { cleanup(); });
    for (const event of caseEventHistory.since(customerId, sessionId, cursor)) send(event);
    try {
      while (!closed && !stream.aborted && !stream.closed) {
        await stream.sleep(25000);
        if (closed || stream.aborted || stream.closed) break;
        await pending;
        await stream.writeSSE({ event: "ping", data: "" });
      }
    } finally {
      cleanup();
    }
  });
});

// The storefront's own tracking landing page (apps/storefront/src/app/track/[trackingNumber])
// fetches from here. Deliberately no session/ownership check — unlike every other route
// here, a tracking number is meant to work like a real carrier's: whoever has the number
// (from an email, a chat reply, a package label) can look up its status, no login
// required. That's a real-world UX convention, not an oversight.
app.get("/tracking/:trackingNumber", (c) => {
  const orderId = orderIdFromTrackingNumber(c.req.param("trackingNumber"));
  const info = getShipmentInfo(orderId);
  if (!info) return c.json({ error: "not_found" }, 404);
  return c.json(info);
});

// The storefront's return-label landing page (apps/storefront/src/app/return-label/
// [trackingNumber]) fetches from here — same shape and same "no login required, the
// number itself is the capability" reasoning as /tracking/:trackingNumber above. Backs
// the returns.waybound.com cosmetic link generateReturnLabel (shipping.ts) hands out.
app.get("/returns/:trackingNumber", (c) => {
  const trackingNumber = c.req.param("trackingNumber");
  const orderId = orderIdFromReturnTrackingNumber(trackingNumber);
  const itemIds = itemIdsFromReturnTrackingNumber(trackingNumber);
  const info = getReturnLabelInfo(orderId, itemIds);
  if (!info) return c.json({ error: "not_found" }, 404);
  return c.json(info);
});

// --- Policy validation/activation + Policy Helper authoring ---
//
// NAMESPACED throughout (repository.ts's own header comment explains why): the
// Escalation Desk's own Policies page always uses "demo", and "demo"'s active version
// DECIDES every live case (policy/live-policy.ts) — so activating there changes real
// behavior at once. Anything verifying a Policy-Helper-generated draft end to end should
// use a distinct namespace, which live cases never read.

app.get("/policy/:namespace", async (c) => {
  const namespace = c.req.param("namespace");
  try {
    const [active, versions] = await Promise.all([getActiveVersion(namespace), listVersions(namespace)]);
    // Computed here (not by the frontend) so there's exactly one place that knows how
    // to render a policy document as prose — buildPolicySynopsis is pure and cheap, no
    // reason to duplicate the template logic client-side.
    const activeSynopsis = active ? buildPolicySynopsis(active) : null;
    return c.json({ active, versions, catalog: describeCatalog(), activeSynopsis });
  } catch (err) {
    return c.json({ error: "policy_namespace_error", message: err instanceof Error ? err.message : String(err) }, 500);
  }
});

// The Policy Helper only ever PROPOSES — it never activates anything itself. Its proposal
// is built from the ACTIVE version (there are no saved drafts); the operator reviews it in
// the Desk's draft editor and activates it via /activate (the editor's Validate & Save).
app.post("/policy/:namespace/helper", async (c) => {
  const namespace = c.req.param("namespace");
  const body = await c.req.json().catch(() => null);
  if (typeof body?.request !== "string" || !body.request.trim()) {
    return c.json({ error: "invalid_request", message: "Body must include a non-empty \"request\" string." }, 400);
  }
  const current = await getActiveVersion(namespace);
  if (!current) return c.json({ error: "no_base_document", message: `Namespace "${namespace}" has no active policy to edit yet.` }, 409);

  try {
    const result = await runPolicyHelper(body.request, current);
    return c.json({ ...result, baseDocument: current });
  } catch (err) {
    return c.json({ error: "policy_helper_failed", message: err instanceof Error ? err.message : String(err) }, 500);
  }
});


app.post("/policy/:namespace/validate", async (c) => {
  let body: any;
  try { body = parsePolicyJson(await c.req.text()); } catch (error) {
    return c.json({ ok: false, valid: false, issues: [{ path: "$", message: error instanceof Error ? error.message : "Invalid JSON" }] }, 400);
  }
  if (!body?.document) return c.json({ error: "invalid_request", message: "Body must include a \"document\"." }, 400);
  return c.json(validatePolicyDocument(body.document));
});

app.post("/policy/:namespace/activate", async (c) => {
  const namespace = c.req.param("namespace");
  let body: any;
  try { body = parsePolicyJson(await c.req.text()); } catch (error) {
    return c.json({ ok: false, valid: false, issues: [{ path: "$", message: error instanceof Error ? error.message : "Invalid JSON" }] }, 400);
  }
  if (!body?.document) return c.json({ error: "invalid_request", message: "Body must include a \"document\"." }, 400);
  const result = await activatePolicy(namespace, body.document as PolicyDocument);
  if (!result.ok) return c.json(result, 400);
  return c.json(result);
});

app.post("/policy/:namespace/rollback", async (c) => {
  const namespace = c.req.param("namespace");
  let body: any;
  try { body = parsePolicyJson(await c.req.text()); } catch (error) {
    return c.json({ ok: false, valid: false, issues: [{ path: "$", message: error instanceof Error ? error.message : "Invalid JSON" }] }, 400);
  }
  if (typeof body?.version !== "number") return c.json({ error: "invalid_request", message: "Body must include a numeric \"version\"." }, 400);
  const result = await rollbackTo(namespace, body.version);
  if (!result.ok) return c.json(result, 400);
  return c.json(result);
});

export { app };
