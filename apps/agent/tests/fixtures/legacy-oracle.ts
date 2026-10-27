// TEST ORACLE ONLY — the evaluator the policy restructure replaced (first-match within one section chosen
// by case type, fallback when nothing matched). Kept so parity.test.ts can keep proving that the current engine
// decides exactly as the original did on the policy that was live when the restructure began
// (legacy-live-v9.json, next to this file). Nothing in the app imports this — it is test support only.

import { evaluateCondition, evaluateFact, type EvalDeps } from "../../src/mastra/policy/evaluate";
import type { PolicyContext } from "../../src/mastra/policy/context";
import type { Condition, FactDefinition } from "../../src/mastra/policy/schema";

interface LegacyOutcome {
  decision: "autonomous_approve" | "autonomous_deny" | "escalate" | "always_escalate";
  reasonCode: string;
  explanation: string;
  customerReason?: string;
}
interface LegacyRule { id: string; number?: string; when: Condition; outcome: LegacyOutcome }
export interface LegacyDocument {
  settings: Record<string, { value: number | boolean; description: string }>;
  facts: FactDefinition[];
  policies: Array<{ caseType: string; rules: LegacyRule[]; fallback: LegacyOutcome & { number?: string } }>;
}
export interface LegacyResult extends LegacyOutcome {
  matchedRuleId?: string;
  number?: string;
}

export function legacyEvaluate(document: LegacyDocument, caseType: string, context: PolicyContext, now: Date): LegacyResult {
  const deps: EvalDeps = { context, settings: document.settings, facts: new Map() };
  for (const fact of document.facts) deps.facts.set(fact.name, evaluateFact(fact, deps, now));
  const policy = document.policies.find((p) => p.caseType === caseType);
  if (!policy) throw new Error(`Policy document has no rules for case type "${caseType}".`);
  for (const rule of policy.rules) {
    if (evaluateCondition(rule.when, deps, now)) return { ...rule.outcome, matchedRuleId: rule.id, number: rule.number };
  }
  return { ...policy.fallback };
}
