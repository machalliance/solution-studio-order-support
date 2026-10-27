// The pure policy evaluator — no I/O, no side effects, no payment/case creation ever
// happens here (a deny or an escalation can never execute a refund). Takes a
// validated PolicyDocument, a trusted PolicyContext (context.ts —
// the ONLY place real data enters), a case type, and one FROZEN evaluation timestamp
// (never re-read mid-evaluation — a `withinDays` check must give the same answer for
// the whole call).

import type { PolicyDocument, RestrictionRule, DecisionRule, Reason, Condition, ValueRef, FactDefinition } from "./schema";
import type { PolicyContext } from "./context";
import { readContextField, readContextCollection } from "./context";
import { findCollection } from "./catalog";

export type ResolvedValue = number | boolean | string | undefined;

export interface EvalDeps {
  context: PolicyContext;
  settings: PolicyDocument["settings"];
  facts: Map<string, ResolvedValue>;
  // Bound only while evaluating a collection filter — "item.<field>" resolves against
  // this, distinct from the outer context's own top-level fields.
  itemScope?: Record<string, unknown>;
}

function resolveValueRef(ref: ValueRef, deps: EvalDeps): ResolvedValue {
  if (typeof ref === "number" || typeof ref === "boolean" || typeof ref === "string") return ref;
  if ("field" in ref) {
    if (deps.itemScope && ref.field.startsWith("item.")) {
      const key = ref.field.slice("item.".length);
      return deps.itemScope[key] as ResolvedValue;
    }
    return readContextField(deps.context, ref.field) as ResolvedValue;
  }
  if ("setting" in ref) {
    const setting = deps.settings[ref.setting];
    if (!setting) throw new Error(`Unknown setting reference: ${ref.setting}`);
    return setting.value;
  }
  if ("fact" in ref) {
    if (!deps.facts.has(ref.fact)) throw new Error(`Fact "${ref.fact}" was referenced before it was computed — check declaration order.`);
    return deps.facts.get(ref.fact);
  }
  if ("op" in ref && "operands" in ref) {
    const values = ref.operands.map((operand) => requireNumber(resolveValueRef(operand, deps), `an operand of "${ref.op}"`));
    let result: number;
    switch (ref.op) {
      case "add":
        result = values.reduce((sum, v) => sum + v, 0);
        break;
      case "subtract":
        result = values.reduce((acc, v, i) => (i === 0 ? v : acc - v));
        break;
      case "multiply":
        result = values.reduce((product, v) => product * v, 1);
        break;
      case "divide":
        result = values.reduce((acc, v, i) => (i === 0 ? v : acc / v));
        break;
      default:
        throw new Error(`Unrecognized arithmetic operator: ${(ref as { op: string }).op}`);
    }
    return requireNumber(result, `the result of "${ref.op}"`);
  }
  throw new Error(`Unrecognized value reference: ${JSON.stringify(ref)}`);
}

// Whole days elapsed, not fractional — matches the hardcoded policies this evaluator
// replaced at cutover (the refund policy / the return refund policy both floor), so an
// order delivered 30.5 days ago is "30 days" to both, never inside the window in one and
// outside it in the other.
function daysBetween(iso: string, now: Date): number {
  return Math.floor((now.getTime() - new Date(iso).getTime()) / 86_400_000);
}

// A fact of 0 / 0 once passed validation, and every
// comparison against NaN is false — so the rules "didn't match" and the case fell through to
// an automatic-approval fallback. Any number this evaluator computes or compares must be a
// real, finite number; anything else is an evaluation error, which live-policy.ts turns into
// an escalation, never a silent non-match.
function requireNumber(value: ResolvedValue, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Policy evaluation error: ${what} is ${typeof value === "number" ? String(value) : JSON.stringify(value)}, not a finite number.`);
  }
  return value;
}

function compare(left: ResolvedValue, op: string, right: ResolvedValue, now: Date): boolean {
  switch (op) {
    case "eq":
      return left === right;
    case "neq":
      return left !== right;
    case "gt":
      return requireNumber(left, `the left side of "gt"`) > requireNumber(right, `the right side of "gt"`);
    case "gte":
      return requireNumber(left, `the left side of "gte"`) >= requireNumber(right, `the right side of "gte"`);
    case "lt":
      return requireNumber(left, `the left side of "lt"`) < requireNumber(right, `the right side of "lt"`);
    case "lte":
      return requireNumber(left, `the left side of "lte"`) <= requireNumber(right, `the right side of "lte"`);
    case "withinDays": {
      // The lower bound matters: checking only the upper bound let a FUTURE date (daysBetween negative)
      // satisfy "within N days" trivially for any N, but a record dated after `now` isn't "within the last N
      // days" in any meaningful sense (it hasn't happened yet, or is bad data). Requiring >= 0 too is the
      // correct meaning, and matches olderThanDays, which was never affected (a negative daysBetween
      // already fails "> right" for any positive right).
      const days = requireNumber(daysBetween(left as string, now), `the date on the left of "withinDays"`);
      return days >= 0 && days <= requireNumber(right, `the day count of "withinDays"`);
    }
    case "olderThanDays":
      return requireNumber(daysBetween(left as string, now), `the date on the left of "olderThanDays"`) > requireNumber(right, `the day count of "olderThanDays"`);
    default:
      throw new Error(`Unrecognized operator: ${op}`);
  }
}

export function evaluateCondition(condition: Condition, deps: EvalDeps, now: Date): boolean {
  if ("all" in condition) return condition.all.every((c) => evaluateCondition(c, deps, now));
  if ("any" in condition) return condition.any.some((c) => evaluateCondition(c, deps, now));
  if ("not" in condition) return !evaluateCondition(condition.not, deps, now);
  const left = resolveValueRef(condition.left, deps);
  const right = resolveValueRef(condition.right, deps);
  return compare(left, condition.op, right, now);
}

// customer.completedRefundHistoryStartDate is exposed on the catalog specifically so a policy's
// own lookback window can be checked against it, but nothing in the evaluator ever
// did — a fact requesting more days of history than are actually known to be complete
// (e.g. a 365-day window against a customer whose tracked history only reaches back
// 210 days) would silently UNDERCOUNT, with no error or warning anywhere. Best-effort,
// not full static analysis: only catches a withinDays bound that's a plain number
// literal (the common case) — a bound computed from a setting or fact reference can't
// be known without evaluating it, so those are left unchecked, matching validate.ts's
// own "obvious wrong-shape mistakes only" scope for the identical operator.
function maxWithinDaysLiteral(condition: Condition | undefined): number | undefined {
  if (!condition) return undefined;
  if ("all" in condition || "any" in condition) {
    const branches = "all" in condition ? condition.all : condition.any;
    const values = branches.map(maxWithinDaysLiteral).filter((v): v is number => v !== undefined);
    return values.length > 0 ? Math.max(...values) : undefined;
  }
  if ("not" in condition) return maxWithinDaysLiteral(condition.not);
  if (condition.op === "withinDays" && typeof condition.right === "number") return condition.right;
  return undefined;
}

export function evaluateFact(fact: FactDefinition, deps: EvalDeps, now: Date): ResolvedValue {
  if (fact.value !== undefined) return resolveValueRef(fact.value, deps);

  if (fact.source) {
    const collectionDescriptor = findCollection(fact.source);
    if (!collectionDescriptor) throw new Error(`Unknown collection source: ${fact.source}`);
    // Only "customer.completedRefunds" has a known-coverage-start-date concept today —
    // hardcoded here rather than a generic catalog-wide mechanism, since it's the one
    // real case that exists; a second collection needing this would be the moment to
    // generalize it, not before.
    if (fact.source === "customer.completedRefunds") {
      const requestedDays = maxWithinDaysLiteral(fact.filter);
      const coverageStart = readContextField(deps.context, "customer.completedRefundHistoryStartDate") as string | undefined;
      if (requestedDays !== undefined && coverageStart) {
        const coveredDays = (now.getTime() - new Date(coverageStart).getTime()) / 86_400_000;
        if (requestedDays > coveredDays) {
          throw new Error(
            `Fact "${fact.name}" requests ${requestedDays} days of customer.completedRefunds history, but only ${Math.floor(coveredDays)} days are known to be complete (customer.completedRefundHistoryStartDate) — the result would silently undercount. Shorten the window or confirm fuller history coverage first.`
          );
        }
      }
    }
    const items = readContextCollection(deps.context, fact.source);
    const matched = fact.filter ? items.filter((item) => evaluateCondition(fact.filter!, { ...deps, itemScope: item }, now)) : items;

    if (fact.aggregate === "count") return matched.length;
    if (fact.aggregate === "sum") {
      if (!fact.aggregateField) throw new Error(`Fact "${fact.name}" uses aggregate "sum" but declares no aggregateField.`);
      const key = fact.aggregateField.startsWith("item.") ? fact.aggregateField.slice("item.".length) : fact.aggregateField;
      return matched.reduce((sum, item) => sum + ((item[key] as number) ?? 0), 0);
    }
    throw new Error(`Fact "${fact.name}" declares a source but no aggregate.`);
  }

  throw new Error(`Fact "${fact.name}" declares neither a value nor a source — nothing to compute.`);
}

export interface RuleMatch {
  id: string;
  number?: string;
  kind: "restriction" | "decision";
  decision: string;
}

export interface EvaluationResult {
  decision: "autonomous_approve" | "autonomous_deny" | "escalate" | "always_escalate";
  reasonCode: string;
  explanation: string;
  customerReason?: string;
  recommendedAction?: string;
  // The rule that supplied the outcome (the FIRST match in document order — the one reported), if any.
  matchedRuleId?: string;
  number?: string;
  // Why this outcome: a restriction matched; a decision authorized it; nothing authorized anything
  // (fallback); or two decisions disagreed (conflict).
  basis: "restriction" | "decision" | "fallback" | "conflict";
  // EVERY rule that matched on the way to this outcome (all restrictions; or all decisions).
  matches: RuleMatch[];
  facts: Record<string, ResolvedValue>;
}

const CONFLICT_CUSTOMER_REASON = "This needs a quick review from our team before it's processed.";

function toMatch(rule: RestrictionRule | DecisionRule): RuleMatch {
  return { id: rule.id, number: rule.number, kind: rule.kind, decision: rule.outcome.decision };
}

// reason: why the customer wants money back — selects which rules apply (`appliesTo`; absent =
// every reason). now: the one frozen timestamp every date comparison in this call uses.
//
// 1. Evaluate EVERY applicable restriction. Any match → escalate, and nothing automatic is even
//    considered; document order only picks which match is reported first, never WHETHER the case
//    escalates, so position can never weaken a restriction.
// 2. Otherwise evaluate every applicable decision. Approve only → approve; deny only → deny; both →
//    escalate as a conflict (never resolved by document order); none → the fallback (a person).
export function evaluatePolicy(document: PolicyDocument, reason: Reason, context: PolicyContext, now: Date = new Date()): EvaluationResult {
  const deps: EvalDeps = { context, settings: document.settings, facts: new Map() };
  for (const fact of document.facts) {
    deps.facts.set(fact.name, evaluateFact(fact, deps, now));
  }
  const facts = Object.fromEntries(deps.facts);

  const applicable = document.rules.filter((rule) => !rule.appliesTo || rule.appliesTo.includes(reason));
  const holds = (rule: RestrictionRule | DecisionRule) => rule.when === undefined || evaluateCondition(rule.when, deps, now);

  // filter() visits every restriction — none is skipped because an earlier one matched.
  const restrictions = applicable.filter((rule): rule is RestrictionRule => rule.kind === "restriction").filter(holds);
  if (restrictions.length > 0) {
    const primary = restrictions[0];
    return { ...primary.outcome, matchedRuleId: primary.id, number: primary.number, basis: "restriction", matches: restrictions.map(toMatch), facts };
  }

  const decisions = applicable.filter((rule): rule is DecisionRule => rule.kind === "decision").filter(holds);
  const approvals = decisions.filter((rule) => rule.outcome.decision === "autonomous_approve");
  const denials = decisions.filter((rule) => rule.outcome.decision === "autonomous_deny");

  if (approvals.length > 0 && denials.length > 0) {
    return {
      decision: "escalate",
      reasonCode: "policy-conflict",
      explanation: `The policy contradicts itself for this request — ${approvals.map((r) => r.id).join(", ")} would approve it and ${denials.map((r) => r.id).join(", ")} would deny it — so a person must decide.`,
      customerReason: CONFLICT_CUSTOMER_REASON,
      basis: "conflict",
      matches: decisions.map(toMatch),
      facts,
    };
  }
  const chosen = approvals.length > 0 ? approvals : denials;
  if (chosen.length > 0) {
    const primary = chosen[0];
    return { ...primary.outcome, matchedRuleId: primary.id, number: primary.number, basis: "decision", matches: chosen.map(toMatch), facts };
  }

  return { ...document.fallback, number: document.fallback.number, basis: "fallback", matches: [], facts };
}
