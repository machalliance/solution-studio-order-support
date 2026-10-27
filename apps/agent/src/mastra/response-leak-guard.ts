import type { ToolHooks } from "@mastra/core/tools";
import { ALPHABET, LENGTH } from "./case-id";
import { liveReasonCodes } from "./policy/repository";

// A deterministic, non-LLM safety net over respond_to_customer's `message` field. It intercepts the
// same way refund-policy-gate.ts intercepts payment tools, so a detected leak is swapped for a safe
// fallback BEFORE it reaches the customer, not just logged afterwards. There is no race: a tool call
// resolves atomically, unlike streamed raw text, which can't be taken back once shown.
//
// SCOPE LIMIT, stated plainly: this reliably catches only LITERAL internal-identifier leakage (a
// tool's id or registration key, or a real reasonCode appearing verbatim in the message). The two
// leaks actually observed were different: natural-language narration of the agent's own decision
// process ("this is a single-item order, so I don't need to show the item picker") with no
// identifier in it, a semantic pattern rather than a lexical one. A regex can't tell that from
// ordinary customer-service prose without false positives, and an ever-growing phrase blacklist
// wouldn't have caught either leak. The reasoning/message split itself (respond-to-customer.ts) is
// the defense against that pattern; this filter is a complementary net, not a substitute.
//
// The case-ID pattern is built from case-id.ts's exported alphabet and length rather than a second
// hand-typed copy, so the two can't drift apart.
const CASE_ID_PATTERN = new RegExp(`\\b[${ALPHABET}]{${LENGTH}}\\b`, "g"); // Crockford base32 — see case-id.ts. Legitimate, customer-facing; never flagged HERE as a leak (whether a stated ID is a REAL case is case-id-guard.ts's job).
const URL_PATTERN = /https?:\/\/\S+/g; // return-label / tracking links — legitimate.
const REFUND_ID_PATTERN = /\bre_[a-z0-9_]+\b/gi; // payment.ts's own refundId shape — legitimate when relayed.

// Real, structural signals for "this looks like an internal identifier, not English
// prose" — checked against the message with the legitimate patterns above stripped out
// first, so a real tracking link or refund id embedded in an otherwise-clean sentence
// never trips this.
const SNAKE_CASE_PATTERN = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+){1,}\b/g; // e.g. payment_issue_return_refund, fault_requires_photo_review

// These two used to be generic shape heuristics (any word with an internal capital; any token with
// 2+ hyphens). Ordinary customer-service sentences broke both ("Thanks for the update on your iPhone
// case" flagged 'iPhone'; "That item is currently out-of-stock" flagged 'out-of-stock'; likewise
// "true-to-size", "up-to-date"), silently discarding clean replies. Unlike snake_case (underscores
// don't occur in natural English), camelCase and multi-hyphen tokens do, so shape can't separate
// "code-shaped" from "English". Since this file's scope is LITERAL identifier leakage, it matches the
// finite set of real identifiers instead: every tool's camelCase registration key (wismo-agent.ts's
// `tools: {...}` keys) and every real reasonCode in the policy/workflow layer. Keep both lists in sync
// with their source, as touched-orders-from-history.ts's ORDER_ARG_TOOL_NAMES must be with
// wismo-agent.ts: add here the moment a tool or reasonCode is added.
const TOOL_REGISTRATION_KEYS = [
  "commerceGetOrder",
  "commerceGetCustomer",
  "commerceGetProductsForOrder",
  "commerceListOrdersForCustomer",
  "shippingGetTrackingInfo",
  "shippingGenerateReturnLabel",
  "paymentIssueRefund",
  "paymentIssueReturnRefund",
  "escalateForDeliveryDispute",
  "presentReturnItemPicker",
  "checkEscalationStatus",
  "lookupCaseById",
  "respondToCustomer",
];
// reasonCode literals the customer must never see. This FIXED list holds the codes that CODE produces
// (live-policy.ts, system-authority.ts, evaluate.ts, case-sync.ts, server.ts, the review workflow), the
// codes of the shipped policy, and retired ones. The codes of the policy that is LIVE are added on every
// check from policy.json itself (liveReasonCodes in policy/repository.ts), so a rule added on the Policies
// page, or accepted from the Policy Helper, is covered with no change here. Only a code produced by CODE
// needs adding to this list by hand, and tests/mastra/response-leak-guard.test.ts fails if one is missing.
//
// Only multi-word codes belong: a single plain word (a test fixture uses "review") would block any reply
// that happens to contain it. Some entries are no longer produced by anything (within-policy,
// autonomous-reject, escalation-approval, return-autonomous and the two delivery-dispute-
// signature/no-delivery-record codes came from the retired hardcoded policies) — they stay, because a
// case decided before they were retired can still carry one.
export const REASON_CODES = [
  // Also produced by the live policy document, the system limit, the policy
  // evaluator's fail-safe, and the disagreement route.
  "autonomous-refunds-disabled",
  "autonomous-plain-returns-disabled",
  "delivery-dispute-requires-investigation",
  "exceeds-max-autonomous-amount",
  "policy-evaluation-error",
  "customer-disagreement",
  "fault-unknown",
  "one-return-per-order",
  "needs-a-person",
  "policy-conflict",
  "within-policy",
  "damage-outside-return-window",
  "fault-requires-photo-review",
  "customer-fault-vip",
  "customer-fault-non-vip",
  "awaiting-customer-response",
  "customer-responded",
  "within-return-refund-ceiling",
  "return-outside-window",
  "return-refunds-disabled",
  "exceeds-return-refund-ceiling",
  "delivery-dispute-signature-mismatch",
  "delivery-dispute-no-delivery-record",
  "autonomous-reject",
  "escalation-approval",
  "return-autonomous",
];
const CAMEL_CASE_PATTERN = new RegExp(`\\b(?:${TOOL_REGISTRATION_KEYS.join("|")})\\b`, "g");
const KEBAB_REASONCODE_PATTERN = new RegExp(`\\b(?:${REASON_CODES.join("|")})\\b`, "gi");

// A policy's reasonCode can be any non-empty string (policy/schema.ts). One is worth blocking when it is an
// identifier nobody writes by accident: letters and digits joined by - _ . : (kebab, snake, dotted, namespaced),
// or camelCase / PascalCase. A single plain word ("review", "fault") or an all-caps one ("VIP") reads as ordinary
// prose and would block normal replies, so it is ignored; so is anything with a space or another character.
const CODE_SHAPE = /^[A-Za-z0-9]+(?:[-_.:][A-Za-z0-9]+)*$/;
const isDistinctiveCode = (code: string) => CODE_SHAPE.test(code) && (/[-_.:]/.test(code) || /[a-z][A-Z]/.test(code));
const escapeForRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The fixed pattern, or one that also covers the given extra codes (the live policy's). Matching ignores case,
// so "Exceeds-Limit" and "EXCEEDS-LIMIT" are caught as well as the code as written.
function reasonCodePattern(extraReasonCodes: readonly string[]): RegExp {
  const extras = [...new Set(extraReasonCodes)].filter((code) => isDistinctiveCode(code) && !REASON_CODES.includes(code));
  if (extras.length === 0) return KEBAB_REASONCODE_PATTERN;
  return new RegExp(`\\b(?:${[...REASON_CODES, ...extras.map(escapeForRegExp)].join("|")})\\b`, "gi");
}

function stripLegitimatePatterns(message: string): string {
  return message.replace(URL_PATTERN, " ").replace(CASE_ID_PATTERN, " ").replace(REFUND_ID_PATTERN, " ");
}

// Returns a short description of what was found, or null if the message looks clean.
// Exported standalone (not just as a hook) so it's directly unit-testable / callable
// from a scratch script without needing a full agent turn.
export function detectIdentifierLeak(message: string, extraReasonCodes: readonly string[] = []): string | null {
  const stripped = stripLegitimatePatterns(message);
  const snakeMatch = stripped.match(SNAKE_CASE_PATTERN);
  if (snakeMatch) return `snake_case-shaped token: "${snakeMatch[0]}"`;
  const camelMatch = stripped.match(CAMEL_CASE_PATTERN);
  if (camelMatch) return `known tool name: "${camelMatch[0]}"`;
  const kebabMatch = stripped.match(reasonCodePattern(extraReasonCodes));
  if (kebabMatch) return `known reasonCode: "${kebabMatch[0]}"`;
  return null;
}

// Also used by case-id-guard.ts, so the two guards fail the same way in front of the customer.
export const SAFE_FALLBACK_MESSAGE = "Let me get that sorted out for you — one moment.";

// Exported for the same reason refund-policy-gate.ts exports REFUND_GATE_TOOL_NAMES — lets
// wismo-agent.ts assert once, at module load, that this set and refundPolicyGate's own
// never overlap.
export const LEAK_GUARD_TOOL_NAMES = new Set(["respondToCustomer"]);

// Registered on respondToCustomer specifically (wismo-agent.ts's composed hooks) —
// see that file's own comment on why beforeToolCall composition is needed alongside
// refundPolicyGate. A factory only so a test can hand it a different source of reason codes; the
// exported guard below reads the live policy.
export function createResponseLeakGuard(
  getReasonCodes: () => Promise<readonly string[]>
): NonNullable<ToolHooks<any, any, any>["beforeToolCall"]> {
  return async ({ toolName, input }) => {
    if (!LEAK_GUARD_TOOL_NAMES.has(toolName)) return;
    const { message } = input as { reasoning?: string; message?: unknown };
    // The model occasionally calls respond_to_customer with no `message` at all. This hook runs
    // BEFORE the tool's own input validation, so it used to throw on `undefined.replace`, and
    // wismo-agent.ts's catch turned that into a customer-visible "I'm having trouble
    // responding right now" bubble (with a logged TypeError). Nothing
    // to scan is not a leak: let the tool's own validation reject the call, which the app
    // already handles (the model retries, and nothing reaches the customer). Same check
    // case-id-guard.ts makes.
    if (typeof message !== "string") return;
    const leak = detectIdentifierLeak(message, await getReasonCodes());
    if (!leak) return;
    // Loud, not silent — this should be rare; if it isn't, that's worth knowing about
    // immediately rather than discovering it later by reading a customer transcript.
    console.error(`[response-leak-guard] Blocked a customer-facing message containing ${leak}. Original: ${JSON.stringify(message)}`);
    return { proceed: false as const, output: { message: SAFE_FALLBACK_MESSAGE } };
  };
}

export const responseLeakGuard = createResponseLeakGuard(() => liveReasonCodes());
