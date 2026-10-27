// PARITY: the v2 engine + v2 base document must decide every request exactly as the legacy engine
// decides it on the policy that was live when the restructure began (tests/fixtures/legacy-live-v9.json —
// a frozen copy of data/policy/demo/policy.json at v9). This is the safety proof for the restructure: it is only possible because every non-fallback rule
// in that document escalates, so restriction-first evaluation changes no decision for it.
//
// Compared per case: decision, reasonCode, rep-facing explanation, customer reason, and WHICH RULE
// decided (by id — policy numbers are only lookup handles and are assigned fresh in the new document;
// the three per-section copies of the autonomy guard are now one rule with the same id).
//
// ONE documented wording difference: when autonomy is switched off, a plain return's customer reason
// was "Returns currently need a quick review…" (a per-section copy); the single shared autonomy rule
// uses the generic "A specialist will take a look…" for every reason.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { evaluatePolicy } from "../../../src/mastra/policy/evaluate";
import { legacyEvaluate, type LegacyDocument } from "../../fixtures/legacy-oracle";
import { buildBaseDraft } from "../../../src/mastra/policy/base-draft";
import { validatePolicyDocument } from "../../../src/mastra/policy/validate";
import type { PolicyDocument, Reason } from "../../../src/mastra/policy/schema";
import type { PolicyContext } from "../../../src/mastra/policy/context";

const here = dirname(fileURLToPath(import.meta.url));
const legacyDoc = JSON.parse(readFileSync(join(here, "../../fixtures/legacy-live-v9.json"), "utf-8")) as LegacyDocument;
const NOW = new Date("2026-10-07T12:00:00.000Z");

const CASE_TYPE_OF: Record<Reason, string> = { damaged_or_defective: "refund", not_wanted: "plain_return", not_delivered: "delivery_dispute" };

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 86_400_000).toISOString();
}

function withSettings<T extends { settings: Record<string, { value: number | boolean; description: string }> }>(doc: T, overrides: Record<string, number | boolean>): T {
  const copy = structuredClone(doc);
  for (const [key, value] of Object.entries(overrides)) copy.settings[key].value = value;
  return copy;
}

interface Inputs {
  days: number;
  orderAmount: number;
  alreadyRefunded: number;
  requestAmount: number;
  pending: number;
  vip: boolean;
  fault: "unknown" | "customer" | "notCustomer";
}

function context(i: Inputs): PolicyContext {
  return {
    order: { amount: i.orderAmount, deliveredDate: daysAgo(i.days), alreadyRefundedAmount: i.alreadyRefunded },
    request: { amount: i.requestAmount, faultKnown: i.fault !== "unknown", notCustomerFault: i.fault === "notCustomer" },
    customer: { vip: i.vip, completedRefundHistoryStartDate: "2026-01-01T00:00:00.000Z" },
    relatedCase: { pendingAmount: i.pending },
    collections: { "customer.completedRefunds": [] },
  };
}

const DAYS = [5, 29.9, 30.5, 31.2, 45];
const CEILINGS: Array<[number, number]> = [[60, 100], [100, 100], [100, 0], [0, 0], [50, 0], [100, 500]]; // [percent, amount]
const BOOLS = [true, false];

function* grid(reason: Reason): Generator<{ inputs: Inputs; settings: Record<string, number | boolean> }> {
  const base = { days: 5, orderAmount: 100, alreadyRefunded: 0, requestAmount: 45, pending: 0, vip: false, fault: "unknown" as const };
  if (reason === "damaged_or_defective") {
    for (const days of DAYS) for (const fault of ["unknown", "customer", "notCustomer"] as const) for (const vip of BOOLS)
      for (const refundsOn of BOOLS) for (const plainOn of BOOLS) for (const disputeOn of BOOLS)
        for (const alreadyRefunded of [0, 19.99]) for (const pending of [0, 45])
          yield { inputs: { ...base, days, fault, vip, alreadyRefunded, pending }, settings: { autonomousRefundsEnabled: refundsOn, autonomousPlainReturnsEnabled: plainOn, deliveryDisputesAlwaysEscalate: disputeOn } };
  } else if (reason === "not_wanted") {
    for (const days of DAYS) for (const orderAmount of [45, 100, 250]) for (const alreadyRefunded of [0, 19.99, 64.99, 100])
      for (const requestAmount of [10, 45, 99, 100, 101, 250]) for (const pending of [0, 45]) for (const [pct, amt] of CEILINGS)
        for (const refundsOn of BOOLS) for (const plainOn of BOOLS)
          yield { inputs: { ...base, days, orderAmount, alreadyRefunded, requestAmount, pending }, settings: { returnRefundPercentCeiling: pct, returnRefundCeiling: amt, autonomousRefundsEnabled: refundsOn, autonomousPlainReturnsEnabled: plainOn } };
  } else {
    for (const days of DAYS) for (const refundsOn of BOOLS) for (const plainOn of BOOLS) for (const disputeOn of BOOLS) for (const alreadyRefunded of [0, 19.99])
      yield { inputs: { ...base, days, alreadyRefunded }, settings: { autonomousRefundsEnabled: refundsOn, autonomousPlainReturnsEnabled: plainOn, deliveryDisputesAlwaysEscalate: disputeOn } };
  }
}

function describeCase(reason: Reason, inputs: Inputs, settings: Record<string, unknown>) {
  return `${reason} ${JSON.stringify(inputs)} ${JSON.stringify(settings)}`;
}

for (const reason of ["damaged_or_defective", "not_wanted", "not_delivered"] as Reason[]) {
  test(`parity — ${reason}: the v2 engine decides every request exactly as the legacy engine`, () => {
    const v2Base = buildBaseDraft(1, { oneReturnPerOrder: false });
    assert.equal(validatePolicyDocument(v2Base).valid, true, JSON.stringify(validatePolicyDocument(v2Base).issues));

    let count = 0;
    const seenDecisions = new Set<string>();
    for (const { inputs, settings } of grid(reason)) {
      const legacy = legacyEvaluate(withSettings(legacyDoc, settings), CASE_TYPE_OF[reason], context(inputs), NOW);
      const next = evaluatePolicy(withSettings(v2Base, settings), reason, context(inputs), NOW);
      const label = describeCase(reason, inputs, settings);

      assert.equal(next.decision, legacy.decision, `decision differs — ${label}`);
      assert.equal(next.reasonCode, legacy.reasonCode, `reasonCode differs — ${label}`);
      assert.equal(next.explanation, legacy.explanation, `explanation differs — ${label}`);

      const wordingDifference = legacy.reasonCode === "autonomous-refunds-disabled" && reason === "not_wanted";
      if (!wordingDifference) assert.equal(next.customerReason, legacy.customerReason, `customerReason differs — ${label}`);

      // The same RULE decided. A legacy rule keeps its id; a legacy FALLBACK (which had no id) is now the
      // explicit rule whose id is that outcome's reason code (customer-fault-non-vip, within-return-refund-ceiling,
      // delivery-dispute-requires-investigation).
      assert.equal(next.matchedRuleId, legacy.matchedRuleId ?? legacy.reasonCode, `a different rule decided — ${label}`);

      seenDecisions.add(`${next.decision}/${next.reasonCode}`);
      count++;
    }
    // The grid must actually exercise the interesting outcomes, not just agree on one.
    console.log(`  ${reason}: ${count} cases identical; ${seenDecisions.size} distinct outcomes: ${[...seenDecisions].sort().join(", ")}`);
    assert.ok(count > 50);
    assert.ok(seenDecisions.size >= 2);
  });
}

test("parity — the legacy fixture really is the policy the v2 base draft was translated from", () => {
  // Rules the translation keeps one-to-one must carry identical conditions and outcomes.
  const v2 = buildBaseDraft(1, { oneReturnPerOrder: false });
  const legacyById = new Map<string, LegacyDocument["policies"][number]["rules"][number]>();
  for (const policy of legacyDoc.policies) for (const rule of policy.rules) if (!legacyById.has(rule.id)) legacyById.set(rule.id, rule);
  for (const id of ["fault-unknown", "damage-outside-return-window", "fault-requires-photo-review", "customer-fault-vip", "return-outside-window", "return-refunds-disabled", "exceeds-return-refund-ceiling", "autonomous-plain-returns-disabled"]) {
    const was = legacyById.get(id)!;
    const now = v2.rules.find((r) => r.id === id)!;
    assert.deepEqual(now.when, was.when, `${id}: condition changed in translation`);
    assert.equal(now.outcome.reasonCode, was.outcome.reasonCode, `${id}: reason code changed`);
  }
});
