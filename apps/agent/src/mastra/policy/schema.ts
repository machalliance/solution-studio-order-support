// The canonical policy document schema — settings, facts, ONE ordered rule list and a
// fallback. This is the one canonical schema every other module (catalog, evaluate,
// validate, repository, the Policy Helper, the Escalation Desk editor) is generated
// against or validates
// through — structural (Zod) validation only; validate.ts layers semantic checks
// (unknown source/operator, dependency cycles, envelope constraints) on top.
//
// Kept deliberately small: workflow orchestration, cross-cutting guards, SLA handling,
// and approval side effects all stay in TypeScript (refund-policy-gate.ts,
// policy-review-workflow.ts) rather than being reproduced as configuration — this
// schema only ever describes WHICH decision a case reaches and WHY, never HOW that
// decision gets carried out.

import { z } from "zod";

// A reference to a registered capability-catalog field (e.g. "order.amount",
// "customer.vip") — resolved against the trusted context (context.ts) at evaluation
// time, never against anything the customer or the LLM supplied directly.
const fieldRefSchema = z.object({ field: z.string() });
// A reference to a named, operator-tunable setting (runtime-settings.ts-style values,
// but declared inside the policy document itself — see PolicyDocument.settings below).
const settingRefSchema = z.object({ setting: z.string() });
// A reference to another fact defined earlier in this same policy document — evaluated
// in dependency order (validate.ts's job to detect a cycle before this ever runs).
const factRefSchema = z.object({ fact: z.string() });
// A plain literal — a number, string, or boolean written directly into the condition.
const literalSchema = z.union([z.string(), z.number(), z.boolean()]);

// Generic scalar arithmetic, needed for cumulative totals and percentages. Recursive
// (an operand may
// itself be another expression), so "percent of order" (divide, then multiply by 100)
// composes from the same primitive as a plain three-way sum.
// The one list of arithmetic operators — the schema below, the capability catalog (what the
// Policy Helper is told exists) and validate.ts's error messages all read it, so they can't
// drift apart. Anything else inside a value (an "if", a "min", a comparison) is not supported.
export const ARITHMETIC_OPS = ["add", "subtract", "multiply", "divide"] as const;
export interface ArithmeticExpr {
  op: (typeof ARITHMETIC_OPS)[number];
  operands: ValueRef[];
}
const arithmeticExprSchema: z.ZodType<ArithmeticExpr> = z.lazy(() =>
  z.object({
    op: z.enum(ARITHMETIC_OPS),
    operands: z.array(valueRefSchema).min(2),
  })
);

const valueRefSchema: z.ZodType<ValueRef> = z.lazy(() =>
  z.union([literalSchema, fieldRefSchema, settingRefSchema, factRefSchema, arithmeticExprSchema])
);
export type ValueRef = string | number | boolean | { field: string } | { setting: string } | { fact: string } | ArithmeticExpr;

// withinDays/olderThanDays: `left` must resolve to an ISO date string; `right` is a
// plain number of days, compared against ONE frozen evaluation timestamp (never
// `Date.now()` re-read mid-evaluation — evaluate.ts's `now` parameter is exactly this
// freeze).
const comparisonOpSchema = z.enum(["eq", "neq", "gt", "gte", "lt", "lte", "withinDays", "olderThanDays"]);

// Condition tree — a typed recursive structure (not `z.any()`), so an invalid shape is
// rejected by Zod itself before semantic validation ever runs.
export interface ConditionLeaf {
  left: ValueRef;
  op: z.infer<typeof comparisonOpSchema>;
  right: ValueRef;
}
export type Condition = ConditionLeaf | { all: Condition[] } | { any: Condition[] } | { not: Condition };

const conditionLeafSchema: z.ZodType<ConditionLeaf> = z.object({
  left: valueRefSchema,
  op: comparisonOpSchema,
  right: valueRefSchema,
});

const conditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    conditionLeafSchema,
    z.object({ all: z.array(conditionSchema).min(1) }),
    z.object({ any: z.array(conditionSchema).min(1) }),
    z.object({ not: conditionSchema }),
  ])
);

// A fact is either a direct value reference (a thin rename/derivation of one field or
// setting) or a collection aggregate — sum/count over a registered collection source
// (catalog.ts), each item optionally filtered by a condition tree whose leaves
// reference "item.<field>" (the collection's own per-record fields, distinct from the
// outer context's fields like "customer.vip").
const factDefinitionSchema = z.object({
  name: z.string().min(1),
  type: z.enum(["number", "boolean", "string"]),
  description: z.string().min(1),
  // Direct form: just resolve this value reference.
  value: valueRefSchema.optional(),
  // Aggregate form: sum/count over a named collection source, each item optionally
  // filtered first. aggregateField is required for "sum" (which field to add up),
  // meaningless for "count".
  source: z.string().optional(),
  filter: conditionSchema.optional(),
  aggregate: z.enum(["sum", "count"]).optional(),
  aggregateField: z.string().optional(),
});
export type FactDefinition = z.infer<typeof factDefinitionSchema>;

// A rule's policy number (P1, P2, …) — its stable, human-facing ID, shown to reps as the
// policy that decided a case. Optional in a document: repository.ts's activatePolicy fills
// in any missing one on save (the next number above the highest in use) and never changes
// an existing one — removing a rule leaves a gap, nothing is renumbered.
const policyNumberSchema = z.string().regex(/^P[1-9]\d*$/, "Policy numbers look like P1, P2, P3, …");

const settingDefinitionSchema = z.object({
  value: z.union([z.number(), z.boolean()]),
  description: z.string().min(1),
});

const policyMetadataSchema = z.object({
  name: z.string().min(1),
  version: z.number().int().nonnegative(),
  createdAt: z.string(),
  description: z.string().optional(),
  // The version this draft was edited FROM — repository.ts's activation check rejects
  // activating a draft based on a version that's no longer the current active one
  // (a stale base-version update).
  baseVersion: z.number().int().nonnegative().optional(),
});

// ===================================================================================
// The policy document: restriction-first evaluation, ONE rule list scoped by reason.
// ===================================================================================

// Why a customer wants money back. The flow the agent chose supplies it (same trust as the
// case type today — a customer claim, never verified); it is an evaluator PARAMETER, not a
// catalog field, so there is exactly one way to say "this reason": a rule's `appliesTo`.
export const REASONS = ["damaged_or_defective", "not_wanted", "not_delivered"] as const;
const reasonSchema = z.enum(REASONS);
export type Reason = (typeof REASONS)[number];

// A restriction only ever sends a case to a person: escalate (or always_escalate, which the
// evaluator treats identically). It never denies the customer — that is a decision, below.
const restrictionOutcomeSchema = z.object({
  decision: z.enum(["escalate", "always_escalate"]),
  reasonCode: z.string().min(1),
  explanation: z.string().min(1), // rep-facing — may name exact numbers
  customerReason: z.string().min(1), // customer-safe — never the exact threshold
  // What the Desk recommends the rep do; "{amount}" is replaced with the formatted request amount.
  // Replaces the workflow's old check for the reason code "customer-fault-vip".
  recommendedAction: z.string().optional(),
});

// A decision explicitly authorizes an automatic outcome. Only reachable when no restriction matched.
const decisionOutcomeSchema = z.object({
  decision: z.enum(["autonomous_approve", "autonomous_deny"]),
  reasonCode: z.string().min(1),
  explanation: z.string().min(1),
  customerReason: z.string().optional(), // validate.ts requires one for autonomous_deny
});

const appliesToSchema = z.array(reasonSchema).min(1);

// Omitted `appliesTo` = every reason. That is the SAFE default for a restriction (forgetting to
// scope one can only cause extra human review); a decision must name its reasons (below).
const restrictionRuleSchema = z.object({
  kind: z.literal("restriction"),
  id: z.string().min(1),
  number: policyNumberSchema.optional(),
  description: z.string().min(1),
  appliesTo: appliesToSchema.optional(),
  // Omitted = applies whenever the rule is in scope (e.g. "a delivery dispute always needs a person").
  when: conditionSchema.optional(),
  outcome: restrictionOutcomeSchema,
});

const decisionRuleSchema = z.object({
  kind: z.literal("decision"),
  id: z.string().min(1),
  number: policyNumberSchema.optional(),
  description: z.string().min(1),
  // REQUIRED: an authorization must say exactly what it authorizes.
  appliesTo: appliesToSchema,
  // States only what ADDITIONALLY qualifies — eligibility limits live in the restrictions and are
  // not restated. Omitted = qualifies whenever reached.
  when: conditionSchema.optional(),
  outcome: decisionOutcomeSchema,
});

const ruleSchema = z.discriminatedUnion("kind", [restrictionRuleSchema, decisionRuleSchema]);
export type Rule = z.infer<typeof ruleSchema>;
export type RestrictionRule = z.infer<typeof restrictionRuleSchema>;
export type DecisionRule = z.infer<typeof decisionRuleSchema>;

// Always a person: "no restriction matched, but nothing explicitly authorized an automatic outcome".
const fallbackSchema = restrictionOutcomeSchema.extend({ number: policyNumberSchema.optional() });

export const policyDocumentSchema = z.object({
  schemaVersion: z.literal(2),
  metadata: policyMetadataSchema,
  settings: z.record(z.string(), settingDefinitionSchema),
  facts: z.array(factDefinitionSchema),
  rules: z.array(ruleSchema),
  fallback: fallbackSchema,
});
export type PolicyDocument = z.infer<typeof policyDocumentSchema>;
