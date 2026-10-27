// The ONE place a live case asks "what does policy say?":
// policy-review-workflow.ts (the initial decision) and payment.ts's issueRefund (the
// re-check right before money moves) both call these functions. The answer always comes
// from the "demo" namespace's ACTIVE policy document (the one fixed file,
// data/policy/demo/policy.json — never a draft or an archived version), evaluated by
// evaluate.ts against context.ts's trusted facts.
//
// Everything that decides a case lives in that document, including the three autonomy switches
// (autonomousRefundsEnabled, autonomousPlainReturnsEnabled, deliveryDisputesAlwaysEscalate),
// which are policy settings enforced by the document's own restriction rules; every restriction is
// checked before any automatic decision, wherever it sits in the list. The one limit still outside
// the document is system-authority.ts's maxAutonomousAmount, the backstop no policy can exceed,
// checked by the workflow after this answers.
//
// There is no hardcoded policy behind this and no switch back to one — the document is the
// only source of a decision.
//
// Fail-safe: if the policy can't produce an answer (no active version, a document missing
// this case type, an evaluation error), the case ESCALATES with reasonCode
// "policy-evaluation-error" — never falls back to autonomy.

import type { Order, Customer } from "../../fixtures/demo-data";
import { carrierRecordSummary } from "../tools/shipment-info";
import { getActiveVersion, LIVE_POLICY_NAMESPACE } from "./repository";
import { buildPolicyContext } from "./context";
import { evaluatePolicy, type EvaluationResult } from "./evaluate";
import type { Condition, PolicyDocument, Reason, ValueRef } from "./schema";
import { policyRuleText, scopeLabel, ALL_REASONS_LABEL } from "./synopsis";

// LIVE_POLICY_NAMESPACE ("demo") is the namespace the Escalation Desk's Policies page edits and the
// only one that decides live cases; it is defined in repository.ts (see the note there).

// What the workflow and payment.ts act on. "autonomous" = approve without a rep,
// "autonomous-reject" = deny without a rep (damage claims and disputes only),
// "escalate" = a rep decides. customerReason is the customer-safe wording (never the
// rep-facing explanation, which can carry exact figures).
// policy: the rule that decided — its P-number and its plain-English wording as of this
// decision, so the Escalation Desk can show "P9" with the rule on hover even after the
// policy later changes. Also the audit record: EVERY rule that matched on the way to the
// outcome, and why the outcome is what it is (a restriction, an explicit decision, nothing
// authorizing anything, or two decisions that disagreed). Absent when the $ backstop (not a
// policy rule) is what sent the case to a rep.
export interface PolicyRef {
  number: string;
  version: number;
  text: string;
  matches?: Array<{ number?: string; id: string; kind: "restriction" | "decision" }>;
  basis?: "restriction" | "decision" | "fallback" | "conflict";
}

export type RefundVerdict =
  | { outcome: "autonomous"; reasonCode: string; policy?: PolicyRef }
  | { outcome: "autonomous-reject"; reasonCode: string; explanation: string; customerReason: string; policy?: PolicyRef }
  | { outcome: "escalate"; reasonCode: string; explanation: string; policy?: PolicyRef; recommendedAction?: string };

export type ReturnRefundVerdict =
  | { outcome: "autonomous"; reasonCode: string; policy?: PolicyRef }
  | { outcome: "escalate"; reasonCode: string; explanation: string; customerReason: string; policy?: PolicyRef; recommendedAction?: string };

export interface RefundDecisionInput {
  order: Order;
  customer: Customer;
  refundAmount: number;
  // undefined = the customer's claim didn't establish fault either way — a real third
  // state the policy can escalate on, never read as "their fault".
  notCustomerFault: boolean | undefined;
  // The refund amounts of every OTHER open case on this order. REQUIRED, with no default: a flow that
  // doesn't know passes `undefined`, which is treated as "unavailable" and sends the case to a person —
  // never silently read as "no other cases".
  pendingFromOtherCase: number | undefined;
}

const EVALUATION_ERROR_EXPLANATION = "The live policy couldn't be evaluated, so this case needs a human decision";
const GENERIC_CUSTOMER_REASON = "This needs a quick review from our team before it's processed.";

async function evaluateLive(
  reason: Reason,
  orderId: string,
  request: { amount: number; notCustomerFault?: boolean; pendingFromOtherCase: number | undefined }
): Promise<{ result: EvaluationResult; document: PolicyDocument }> {
  // Unavailable is NOT zero. Throwing here is the evaluation-error path: the caller escalates.
  if (request.pendingFromOtherCase === undefined) {
    throw new Error("the amount pending on other open cases for this order could not be determined");
  }
  const document = await getActiveVersion(LIVE_POLICY_NAMESPACE);
  if (!document) throw new Error(`No active policy in namespace "${LIVE_POLICY_NAMESPACE}".`);
  if ((document as { schemaVersion?: number }).schemaVersion !== 2) {
    throw new Error(`The active policy is in an older format (no "schemaVersion": 2) and has to be re-created in the current one.`);
  }
  const context = await buildPolicyContext({
    orderId,
    requestAmount: request.amount,
    // context.ts models an omitted fault claim as two facts (known: false), so a policy
    // can escalate on "unknown" instead of reading a missing value as "their fault".
    faultKnown: request.notCustomerFault !== undefined,
    notCustomerFault: request.notCustomerFault ?? false,
    pendingFromOtherCase: request.pendingFromOtherCase,
  });
  return { result: evaluatePolicy(document, reason, context), document };
}

// Rep-facing only: a policy document's explanation is fixed text, so the facts the matched
// rule actually tested are appended to keep the real figures ("returnPercentOfOrder = 100")
// in front of the rep without per-rule code here. customerReason never gets this.
function withFigures(result: EvaluationResult, document: PolicyDocument): string {
  const rule = document.rules.find((r) => r.id === result.matchedRuleId);
  if (!rule || !rule.when) return result.explanation;
  const names = new Set<string>();
  collectFactRefs(rule.when, names);
  const figures = [...names]
    .map((name) => [name, result.facts[name]] as const)
    .filter(([, value]) => typeof value === "number")
    .map(([name, value]) => `${name} = ${Math.round((value as number) * 100) / 100}`);
  return figures.length > 0 ? `${result.explanation} (${figures.join(", ")})` : result.explanation;
}

function policyRef(result: EvaluationResult, document: PolicyDocument): PolicyRef | undefined {
  // A conflict has no single deciding rule — the first matching decision stands in as the handle.
  const number = result.number ?? result.matches[0]?.number;
  if (!number) return undefined;
  const rule = document.rules.find((r) => r.id === result.matchedRuleId);
  const outcome = rule ? rule.outcome : { decision: result.decision, explanation: result.explanation };
  const scope = rule ? scopeLabel(rule.appliesTo) : ALL_REASONS_LABEL;
  return {
    number,
    version: document.metadata.version,
    text: policyRuleText(scope, rule ? rule.description : "Otherwise", outcome),
    matches: result.matches.map((m) => ({ number: m.number, id: m.id, kind: m.kind })),
    basis: result.basis,
  };
}

function collectFactRefs(condition: Condition, into: Set<string>): void {
  if ("all" in condition) return condition.all.forEach((c) => collectFactRefs(c, into));
  if ("any" in condition) return condition.any.forEach((c) => collectFactRefs(c, into));
  if ("not" in condition) return collectFactRefs(condition.not, into);
  collectValueFactRefs(condition.left, into);
  collectValueFactRefs(condition.right, into);
}

function collectValueFactRefs(ref: ValueRef, into: Set<string>): void {
  if (typeof ref !== "object") return;
  if ("fact" in ref) into.add(ref.fact);
  if ("operands" in ref) ref.operands.forEach((operand) => collectValueFactRefs(operand, into));
}

// A damage / defect refund claim.
export async function decideRefund(input: RefundDecisionInput): Promise<RefundVerdict> {
  try {
    const { result, document } = await evaluateLive("damaged_or_defective", input.order.id, {
      amount: input.refundAmount,
      notCustomerFault: input.notCustomerFault,
      pendingFromOtherCase: input.pendingFromOtherCase,
    });
    const explanation = withFigures(result, document);
    const policy = policyRef(result, document);
    switch (result.decision) {
      case "autonomous_approve":
        return { outcome: "autonomous", reasonCode: result.reasonCode, policy };
      case "autonomous_deny":
        return { outcome: "autonomous-reject", reasonCode: result.reasonCode, explanation, customerReason: result.customerReason ?? GENERIC_CUSTOMER_REASON, policy };
      default:
        return { outcome: "escalate", reasonCode: result.reasonCode, explanation, policy, recommendedAction: result.recommendedAction };
    }
  } catch (error) {
    console.error(`[live-policy] refund evaluation failed for ${input.order.id}:`, error);
    return { outcome: "escalate", reasonCode: "policy-evaluation-error", explanation: `${EVALUATION_ERROR_EXPLANATION}: ${(error as Error).message}` };
  }
}

// Same RefundVerdict shape as decideRefund — a dispute resolved by policy is paid or
// declined exactly like a damage claim. refundAmount is the order's own value (what the
// dispute tool always sends). The carrier record is facts, not policy, so it's appended to
// a rep's explanation whenever the case goes to one.
export async function decideDeliveryDispute(order: Order, refundAmount: number, pendingFromOtherCase: number | undefined): Promise<RefundVerdict> {
  const carrier = `Carrier record: ${carrierRecordSummary(order.id)}`;
  try {
    const { result, document } = await evaluateLive("not_delivered", order.id, { amount: refundAmount, pendingFromOtherCase });
    const explanation = withFigures(result, document);
    const policy = policyRef(result, document);
    switch (result.decision) {
      case "autonomous_approve":
        return { outcome: "autonomous", reasonCode: result.reasonCode, policy };
      case "autonomous_deny":
        return { outcome: "autonomous-reject", reasonCode: result.reasonCode, explanation, customerReason: result.customerReason ?? GENERIC_CUSTOMER_REASON, policy };
      default:
        return { outcome: "escalate", reasonCode: result.reasonCode, explanation: `${explanation} ${carrier}`, policy, recommendedAction: result.recommendedAction };
    }
  } catch (error) {
    console.error(`[live-policy] delivery-dispute evaluation failed for ${order.id}:`, error);
    return { outcome: "escalate", reasonCode: "policy-evaluation-error", explanation: `${EVALUATION_ERROR_EXPLANATION}: ${(error as Error).message} ${carrier}` };
  }
}

// A plain return — the customer simply doesn't want the item.
export async function decideReturnRefund(order: Order, requestedAmount: number, pendingFromOtherCase: number | undefined): Promise<ReturnRefundVerdict> {
  try {
    const { result, document } = await evaluateLive("not_wanted", order.id, { amount: requestedAmount, pendingFromOtherCase });
    const policy = policyRef(result, document);
    if (result.decision === "autonomous_approve") return { outcome: "autonomous", reasonCode: result.reasonCode, policy };
    // A plain return has no autonomous-deny path in the workflow (nothing to deny a
    // return FOR once it's in window) — a document that says so escalates instead, the
    // fail-safe direction, rather than inventing an outcome the workflow can't carry out.
    // (validate.ts rejects such a document; this is the belt to that braces.)
    const explanation =
      result.decision === "autonomous_deny"
        ? `The active policy returned an autonomous denial (${result.reasonCode}), which isn't supported for a plain return — escalated for a human decision. ${withFigures(result, document)}`
        : withFigures(result, document);
    return { outcome: "escalate", reasonCode: result.reasonCode, explanation, customerReason: result.customerReason ?? GENERIC_CUSTOMER_REASON, policy, recommendedAction: result.recommendedAction };
  } catch (error) {
    console.error(`[live-policy] plain-return evaluation failed for ${order.id}:`, error);
    return {
      outcome: "escalate",
      reasonCode: "policy-evaluation-error",
      explanation: `${EVALUATION_ERROR_EXPLANATION}: ${(error as Error).message}`,
      customerReason: GENERIC_CUSTOMER_REASON,
    };
  }
}

// A policy-document setting that isn't a rule input — e.g. the rep's default "ask the
// customer to send the item back" box on a damage claim. A document missing the setting
// (or holding the wrong type), or an unreadable one, gets the caller's safe default.
export async function livePolicySetting<T extends number | boolean>(name: string, fallback: T): Promise<T> {
  try {
    const value = (await getActiveVersion(LIVE_POLICY_NAMESPACE))?.settings[name]?.value;
    return typeof value === typeof fallback ? (value as T) : fallback;
  } catch (error) {
    console.error(`[live-policy] couldn't read setting "${name}":`, error);
    return fallback;
  }
}
