// Derived from whatever hostname the browser actually used to reach this page (see
// apps/storefront/src/lib/api.ts for why a fixed "localhost" breaks from another device on the LAN).
const AGENT_PORT_DEFAULT = process.env.NEXT_PUBLIC_AGENT_PORT || "3006";

function resolveAgentUrl(): string {
  if (process.env.NEXT_PUBLIC_AGENT_URL) return process.env.NEXT_PUBLIC_AGENT_URL;
  if (typeof window !== "undefined") {
    return `${window.location.protocol}//${window.location.hostname}:${AGENT_PORT_DEFAULT}`;
  }
  return `http://localhost:${AGENT_PORT_DEFAULT}`;
}

const AGENT_URL = resolveAgentUrl();

export type Priority = "low" | "normal" | "high";

export interface TranscriptMessage {
  role: "customer" | "agent";
  text: string;
  // ISO string — a real per-message receipt time for a live conversation, or a
  // staggered synthetic one for a seeded demo scenario (see agent/mastra/demo-seed.ts).
  timestamp?: string;
  // A customer-submitted supporting photo, inlined as a data URL — stored directly in
  // the workflow run's own suspend payload (see policy-review-workflow.ts) rather than
  // a separately-hosted file, so it lives in the same audit trail as the rest of the case.
  imageDataUrl?: string;
}

// The queue list (GET /escalations) deliberately does NOT include transcript — a
// scenario with a damage photo embeds it as a base64 data URL right inside the
// transcript, and multiplying that across every case in the list is what made the queue
// take several real seconds to load (confirmed: a ~13MB response for 7 cases) despite the
// queue view never actually rendering a transcript. Only the single-case detail fetch
// (GET /escalations/:runId, see EscalationDetail below) needs it.
// The policy rule that decided a case — its P-number and plain-English wording as of that
// decision (agent side: live-policy.ts's PolicyRef).
export interface PolicyRef {
  number: string;
  version: number;
  text: string;
  // Audit record: EVERY rule that matched on the way to this outcome, and why it is what it is.
  matches?: Array<{ number?: string; id: string; kind: "restriction" | "decision" }>;
  basis?: "restriction" | "decision" | "fallback" | "conflict";
}

export interface EscalationSummary {
  // Absent on cases decided before policy numbers existed, or sent to a rep by the $
  // backstop rather than a policy rule.
  policy?: PolicyRef;
  runId: string;
  // Last-touched time (the run's own updatedAt) — used for the queue's own sort, and
  // bumped forward by a resume OR by linkRelatedCase's cross-reference patch. NOT the
  // same as createdAt below; see that field's own comment for why the distinction
  // matters.
  suspendedAt: string;
  reviewDeadlineIso?: string;
  // The case's true, immutable creation time — set once and never touched again (see
  // apps/agent's humanPolicyReviewInput createdAt comment). This is what "opened X ago"
  // and the related-case banner's "which one is first" should read, not suspendedAt.
  createdAt: string;
  title: string;
  orderId: string;
  customerId: string;
  customerName: string;
  vip: boolean;
  problemSummary: string;
  orderContext: string;
  reasonCode: string;
  explanation: string;
  recommendedAction: string;
  refundAmount: number;
  // ISO 4217 code refundAmount is denominated in (apps/agent's WISMO_CUR) — carried on
  // every case so this app never has to assume or hardcode which currency it's showing.
  currency: string;
  priority: Priority;
  threadId: string;
  // Set when this case's escalation tool found other already-open case(s) for the same
  // order that DON'T match this one — a different item, or a different caseType entirely
  // (see apps/agent's case-lookup.ts caseTypeOf) — two claims on one order that don't
  // match aren't assumed to be the same issue continuing, but they might still be
  // mutually exclusive, so every one of them surfaces here rather than silently
  // absorbing into this case. Each entry points at another case's runId (and its own
  // createdAt, so the banner can say which came first without a second fetch) for the
  // rep to open directly. Bidirectional: linkRelatedCase (apps/agent) patches every OTHER
  // open case to point back at a new one too, the moment it's created, so whichever case
  // a rep opens first shows the same notice. A list, not a single case, since an order
  // can legitimately carry more than one simultaneously-open case at a time.
  relatedOpenCaseIds?: { runId: string; createdAt: string }[];
}

export interface EscalationDetail extends EscalationSummary {
  transcript: TranscriptMessage[];
  // The order's real timestamps (full ISO), read fresh from the order record — format with
  // lib/dates.ts, never by parsing orderContext's own UTC "YYYY-MM-DD" text, so this page
  // always shows the same day the storefront shows for the same order. Absent only if the
  // order record itself can't be found.
  orderItemsSummary?: string;
  orderDate?: string;
  deliveredDate?: string;
  // The step's own original caseType ("refund" | "delivery_dispute" | "plain_return") —
  // only present on the detail route. Absent on any case created before this field
  // existed.
  caseType?: string;
  // Real per-item name + price, resolved server-side from the order's own catalog data
  // (the exact items this case covers — the whole order if it isn't item-scoped) — only
  // present on the detail route, same reasoning as caseType above.
  items?: { name: string; price: number }[];
  // Whether the "ask the customer to send the item back" checkbox should start ticked —
  // computed server-side from the live setting + this case's dollar amount (damage
  // claims only). Only a default: the rep's own checkbox decides. Detail route only.
  suggestedRequestItemReturn?: boolean;
  // Present ONLY for an already-resolved run (server.ts's buildResolvedEntry) — when
  // set, the page renders a resolved summary instead of the decision-making UI. No
  // policy verdict is ever persisted once a run resolves (see that function's own
  // comment for why), so reasonCode/explanation/recommendedAction/priority/
  // suspendedAt above are NOT populated for a resolved run despite EscalationSummary
  // marking them required — always check `outcome` before reading any of those.
  // "escalated_to_support": the SLA window ran out before a rep acted — a support
  // ticket opened automatically and the case is done from the Desk's own point of
  // view (no refund decision was ever made), per explicit user decision that this
  // app no longer holds a case open just waiting on the clock.
  // "approved," not "issued" — this app only ever knows an
  // approval was recorded, never that a real OMS payment actually completed.
  outcome?: "approved" | "denied" | "error" | "escalated_to_support";
  outcomeReason?: string;
  refundId?: string;
  // Only set for outcome "escalated_to_support" — the ticket a rep can reference.
  ticketId?: string;
  resolvedAt?: string;
  // Who actually resolved this — "agent" for a genuinely autonomous approve, "rep" for
  // any human decision, "system" for the SLA sweep auto-ticketing a case nobody acted
  // on in time. Absent for the rare system/guard error outcomes.
  resolvedBy?: "agent" | "rep" | "system";
  // What the rep told the customer on an approve / modify — part of the resolution record.
  repComment?: string;
  // The rep's question, when it could not be delivered (the customer's chat tab was not connected) and a support ticket opened instead.
  repQuestion?: string;
  // True when the case was waiting on the customer's answer to a rep's question and the response window ran out.
  customerDidNotReply?: boolean;
  // The case's ORIGINAL claim amount — distinct from refundAmount (above, inherited
  // from EscalationSummary) once a "modify" decision approved a different amount than
  // requested. Only present on a resolved run; equal to refundAmount unless the case
  // was a partial approval. See server.ts's buildResolvedEntry for why these two can
  // diverge and why both need to survive to this page.
  requestedAmount?: number;
  // True for a case demo-seed.ts created directly (sessionId "seed") — no real chat
  // conversation ever happened, so there is genuinely no tool-call activity to show
  // beyond the one bare policy-decision row; the Activity section reads this to explain
  // that up front instead of looking broken.
  seeded?: boolean;
  // Whether the customer's chat tab is connected right now. When it is not, a question from a rep cannot reach them and the case ends in a support ticket instead.
  customerConnected?: boolean;
  // Every refund already approved on this order — present on BOTH a suspended and a
  // resolved case (an escalated case can just as easily involve an already-refunded
  // item as a resolved one), so a rep can see at a glance whether this request
  // overlaps something already approved, not just an aggregate dollar total buried in
  // policy-exception text. Live-reported: a rep reviewing an escalated case had no way
  // to tell it involved an already-refunded item at all — a real gap for something
  // explicitly fraud-relevant.
  orderRefundHistory?: { items: string[]; amount: number; refundId: string; approvedAt: string }[];
  // Every support ticket opened via a customer disagreeing with an EARLIER, already-
  // resolved case on this order (the storefront's offer_escalation_to_support card) —
  // present on both a suspended and a resolved case, same "give the rep the related
  // history, not just this one case" reasoning as orderRefundHistory above. A stub
  // record (no real ticketing system behind it yet — see mastra/disagreement-tickets.ts)
  // whose status never changes on its own once created; still worth surfacing so a rep
  // reviewing this order sees there's an open dispute elsewhere on it.
  disagreementTickets?: { caseId: string; ticketId: string; createdAt: string }[];
}

export interface TraceSpan {
  spanId: string;
  name: string;
  spanType: string;
  status: string;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  input: unknown;
  output: unknown;
  error: unknown;
}

export type Decision =
  | { decision: "approve"; comment?: string; requestItemReturn?: boolean }
  | { decision: "reject"; reason?: string }
  | { decision: "modify"; modifiedAmount: number; comment?: string; requestItemReturn?: boolean }
  | { decision: "request_more_info"; question: string }
  // A rep's own proactive call that this case is beyond what the Escalation Desk can
  // resolve. Deliberately no `context` field here — the server fetches the
  // live SuspendPayload itself and injects it before validation (see server.ts's
  // /resume route); the client never holds a legitimate copy of it.
  | { decision: "escalate_to_support"; note?: string };

export async function listEscalations(): Promise<EscalationSummary[]> {
  const res = await fetch(`${AGENT_URL}/escalations`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to load escalations (${res.status})`);
  const data = await res.json();
  return data.runs;
}

// A run that's already resolved — autonomous approvals and rep decisions alike, now that
// every attempt (not just the ones that needed a human) creates a real workflow run.
// Its own shape, not EscalationSummary: a run that resolved WITHOUT ever suspending
// never had a SuspendPayload built for it, so there's no priority/reasonCode/
// recommendedAction here — see GET /escalations/history's own comment for why.
export interface HistorySummary {
  runId: string;
  resolvedAt: string;
  createdAt: string;
  outcome: "approved" | "denied" | "error" | "escalated_to_support";
  outcomeReason?: string;
  refundId?: string;
  // Only set for outcome "escalated_to_support".
  ticketId?: string;
  refundAmount: number;
  // See EscalationDetail's own copy of this field — only diverges from refundAmount
  // when a "modify" decision approved less than the customer originally asked for.
  requestedAmount?: number;
  currency: string;
  orderId: string;
  customerId: string;
  customerName: string;
  vip: boolean;
  problemSummary: string;
  orderContext: string;
  caseType: string;
  relatedOpenCaseIds?: { runId: string; createdAt: string }[];
  // Who actually resolved this — "agent" for a genuinely autonomous approve, "rep" for
  // any human decision (including a rejection, which has no autonomous path at all),
  // "system" for the SLA sweep auto-ticketing a case nobody acted on in time. Absent
  // for the rare system/guard error outcomes, where it isn't a meaningful question —
  // see server.ts's buildResolvedEntry for where this is set.
  resolvedBy?: "agent" | "rep" | "system";
  // What the rep told the customer on an approve / modify — part of the resolution record.
  repComment?: string;
}

export async function listEscalationHistory(): Promise<HistorySummary[]> {
  const res = await fetch(`${AGENT_URL}/escalations/history`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to load history (${res.status})`);
  const data = await res.json();
  return data.runs;
}

export async function getEscalation(runId: string): Promise<EscalationDetail> {
  const res = await fetch(`${AGENT_URL}/escalations/${runId}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to load run ${runId} (${res.status})`);
  return res.json();
}

export async function getEscalationTrace(runId: string): Promise<TraceSpan[]> {
  const res = await fetch(`${AGENT_URL}/escalations/${runId}/trace`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to load activity for run ${runId} (${res.status})`);
  const data = await res.json();
  return data.spans;
}

export interface ResumeResult {
  // Set whenever server.ts's resumeAndNotify actually sent a customer notification for
  // this decision (every decision that reaches a customer does, per notifications.ts —
  // absent only if, say, the order/customer couldn't be resolved). Surfaced here so a
  // rep can see it actually happened, not just trust that it did.
  notification?: { channel: string; sentTo: string };
}

export async function resumeEscalation(runId: string, decision: Decision): Promise<ResumeResult> {
  const res = await fetch(`${AGENT_URL}/escalations/${runId}/resume`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(decision),
  });
  if (!res.ok) {
    // server.ts's own rejection routes (amount_exceeds_item_value, already_refunded)
    // both return a real, rep-facing `message` explaining exactly why — a real,
    // pre-existing gap found while adding the second of those: this always threw a
    // generic "(400)" instead, so neither ever actually reached a rep's screen. The
    // client-side pre-checks (modifyAmountTooHigh, etc.) mean the common case never
    // hits the server at all, which is exactly why this went unnoticed until a case
    // with no client-side pre-check (already_refunded) needed it.
    const body = await res.json().catch(() => null);
    throw new Error(typeof body?.message === "string" ? body.message : `Failed to resume run ${runId} (${res.status})`);
  }
  return res.json();
}

export interface CheckTimeoutsResult {
  checked: number;
  timedOut: number;
  runs: Array<{ runId: string; orderId: string }>;
}

// See server.ts's POST /escalations/check-timeouts — auto-resolves any case that's sat
// past the current SLA with no rep decision. Same route a real cron job would hit on the
// same interval instead of this app's own client-side poll (see TimeoutPoller.tsx).
export async function checkTimeouts(): Promise<CheckTimeoutsResult> {
  const res = await fetch(`${AGENT_URL}/escalations/check-timeouts`, { method: "POST" });
  if (!res.ok) throw new Error(`Failed to check timeouts (${res.status})`);
  return res.json();
}

// Business-policy settings and demo-data reset — moved here from the storefront (which
// now only shows the demo customer's identity/orders, renamed Account) per explicit user
// instruction: these are ops levers a rep tunes, not something a customer-facing app
// should surface. Same agent endpoints (GET/POST /settings, POST /demo/reset), just
// called from this app instead.
export interface Settings {
  escalationSlaMinutes: number;
  supportTicketContactHours: number;
  // The System Authority backstop — the one autonomy limit outside the policy document:
  // no automatic approval above this, whatever the policy says. Everything else that
  // decides a case (return limits, damaged-item defaults, the autonomy on/off switches)
  // is a setting inside the policy document, edited on the Policies page.
  maxAutonomousAmount: number;
  // Queue sorting, not policy: an escalated refund/return above this is flagged "high" and
  // sorts first. 0 turns amount-based flagging off (disputes are always high).
  highPriorityAmountThreshold: number;
  currency: string;
}

// The rep shown as "logged in" — WISMO_REP_NAME from .env, served by the agent (see lib/rep.ts).
export async function getRep(): Promise<{ name: string }> {
  const res = await fetch(`${AGENT_URL}/rep`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to load the rep (${res.status})`);
  return res.json();
}

export async function getSettings(): Promise<Settings> {
  const res = await fetch(`${AGENT_URL}/settings`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to load settings (${res.status})`);
  return res.json();
}

export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  const res = await fetch(`${AGENT_URL}/settings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  const data = await res.json();
  if (!res.ok || !data.ok) throw new Error(data.message || `Failed to update settings (${res.status})`);
  return data;
}

export interface ResetDemoDataResult {
  ok: boolean;
  deletedRuns?: number;
  createdCases?: number;
  error?: string;
}

export async function resetDemoData(): Promise<ResetDemoDataResult> {
  const res = await fetch(`${AGENT_URL}/demo/reset`, { method: "POST" });
  const data = await res.json();
  if (!res.ok || !data.ok) throw new Error(data.error || `Failed to reset demo data (${res.status})`);
  return data;
}

// --- Dynamic policy (validate/activate + Policy Helper authoring) ---
//
// Loosely typed on purpose: the real document shape (mastra/policy/schema.ts) is a
// recursive condition tree the frontend never needs to construct or deeply pattern-
// match — it only ever displays it (a raw JSON preview, not a structural editor yet)
// and passes it straight back to the agent for validate and save. A full visual
// rule editor is future work; this is the minimum viable authoring surface.
export interface PolicyDocument {
  schemaVersion: number;
  metadata: { name: string; version: number; createdAt: string; description?: string; baseVersion?: number };
  settings: Record<string, { value: number | boolean; description: string }>;
  facts: Array<Record<string, unknown>>;
  // ONE ordered list. Each rule is a "restriction" (sends a request to a person) or a "decision" (the only
  // way anything is decided automatically); `appliesTo` scopes it to reasons, omitted = every reason.
  rules: Array<Record<string, unknown>>;
  // Always a person.
  fallback: Record<string, unknown>;
}

export interface PolicyVersionSummary {
  version: number;
  createdAt: string;
  description?: string;
}

export interface PolicyCatalog {
  fields: Array<{ field: string; type: string; description: string; provenance: string }>;
  collections: Array<{ source: string; description: string; provenance: string; itemFields: Array<{ field: string; type: string; description: string }> }>;
  operators: readonly string[];
  arithmetic?: readonly string[];
  reasons?: readonly string[];
  ruleKinds?: readonly string[];
  restrictionOutcomes?: readonly string[];
  decisionOutcomes?: readonly string[];
  aggregates: readonly string[];
}

// Plain-English rendering of a document — purely descriptive, generated deterministically
// from the same `description`/`explanation` fields already authored on every setting/
// fact/rule (mastra/policy/synopsis.ts). Never consulted by the evaluator; read-only.
export interface SynopsisRuleEntry {
  number?: string; // the rule's policy number (P1, P2, …) — a lookup handle
  kind: "restriction" | "decision" | "fallback";
  appliesTo: string; // who it applies to, e.g. "Every refund or return"
  when: string;
  then: string;
  decision: string;
  decisionLabel: string;
}
export interface SynopsisGroup {
  title: string; // who the rules in this group apply to
  rules: SynopsisRuleEntry[];
}
export interface SynopsisSetting {
  name: string;
  value: number | boolean;
  description: string;
}
export interface PolicySynopsis {
  name: string;
  version: number;
  description?: string;
  settings: SynopsisSetting[];
  restrictions: SynopsisGroup[]; // any one sends a request to a person
  decisions: SynopsisGroup[]; // the only rules that decide anything automatically
  fallback: SynopsisRuleEntry; // always a person
}

export interface PolicyNamespaceState {
  active: PolicyDocument | null;
  versions: PolicyVersionSummary[];
  catalog: PolicyCatalog;
  activeSynopsis: PolicySynopsis | null;
}

export async function getPolicyNamespace(namespace: string): Promise<PolicyNamespaceState> {
  const res = await fetch(`${AGENT_URL}/policy/${encodeURIComponent(namespace)}`, { cache: "no-store", signal: AbortSignal.timeout(20000) });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.message || `Failed to load policy namespace "${namespace}" (${res.status})`);
  return data;
}

export interface ValidationIssue {
  path: string;
  message: string;
}
export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
}

export interface PolicyHelperResult {
  baseDocument?: PolicyDocument;
  understood: boolean;
  explanation: string;
  proposedDocument?: PolicyDocument;
  validation?: ValidationResult;
  proposedSynopsis?: PolicySynopsis;
}

// Only ever proposes — never saves a draft or activates anything on its own. The
// operator reviews the result and explicitly saves/activates it via the functions
// below.
export async function askPolicyHelper(namespace: string, request: string): Promise<PolicyHelperResult> {
  const res = await fetch(`${AGENT_URL}/policy/${encodeURIComponent(namespace)}/helper`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ request }),
    signal: AbortSignal.timeout(120000),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.message || `Policy Helper request failed (${res.status})`);
  return data;
}

// Standalone, non-mutating check — the same deterministic validator every other path
// (the Policy Helper's own result, and activatePolicyDraft's own re-check) already
// runs, exposed directly for a hand-edited document that never went through the
// Helper at all. `namespace` isn't actually read by this particular route (validation
// has nothing to do with which namespace's history it might later be activated into)
// but is taken here anyway to keep this function's own signature consistent with
// every other one on this page.
export async function validatePolicyDraft(namespace: string, document: PolicyDocument): Promise<ValidationResult> {
  const res = await fetch(`${AGENT_URL}/policy/${encodeURIComponent(namespace)}/validate`, {
    method: "POST",
    signal: AbortSignal.timeout(20000),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ document }),
  });
  return res.json();
}

export type ActivationResult = { ok: true; version: number } | { ok: false; issues: ValidationIssue[] };

// Both success (200) and rejection (400 — invalid, or a stale base-version) return a
// real JSON body worth reading; this always parses the body rather than branching on
// HTTP status alone.
export async function activatePolicyDraft(namespace: string, document: PolicyDocument): Promise<ActivationResult> {
  const res = await fetch(`${AGENT_URL}/policy/${encodeURIComponent(namespace)}/activate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ document }),
  });
  return res.json();
}

// Revert to an archived version (agent side: repository.ts's rollbackTo). History-keeping:
// the old content becomes a NEW live version, and both the version replaced and the one
// reverted to stay in history — nothing is deleted. Same always-parse-the-body contract as
// activatePolicyDraft.
export async function revertPolicyVersion(namespace: string, version: number): Promise<ActivationResult> {
  const res = await fetch(`${AGENT_URL}/policy/${encodeURIComponent(namespace)}/rollback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ version }),
  });
  return res.json();
}
