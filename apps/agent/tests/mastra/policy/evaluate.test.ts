// The NEW semantics — what parity.test.ts deliberately
// does not cover: restrictions beat decisions wherever they sit, conflicts escalate, the fallback is a
// person, unknown reasons never auto-approve, and "one return per order" works for every reason.

import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluatePolicy } from "../../../src/mastra/policy/evaluate";
import { buildBaseDraft } from "../../../src/mastra/policy/base-draft";
import { validatePolicyDocument } from "../../../src/mastra/policy/validate";
import type { PolicyDocument, Reason, Rule } from "../../../src/mastra/policy/schema";
import type { PolicyContext } from "../../../src/mastra/policy/context";

const NOW = new Date("2026-10-07T12:00:00.000Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();

function ctx(over: { days?: number; orderAmount?: number; refunded?: number; amount?: number; pending?: number; vip?: boolean; fault?: "unknown" | "customer" | "notCustomer" } = {}): PolicyContext {
  const { days = 5, orderAmount = 100, refunded = 0, amount = 45, pending = 0, vip = false, fault = "unknown" } = over;
  return {
    order: { amount: orderAmount, deliveredDate: daysAgo(days), alreadyRefundedAmount: refunded },
    request: { amount, faultKnown: fault !== "unknown", notCustomerFault: fault === "notCustomer" },
    customer: { vip, completedRefundHistoryStartDate: "2026-01-01T00:00:00.000Z" },
    relatedCase: { pendingAmount: pending },
    collections: { "customer.completedRefunds": [] },
  };
}

const doc = () => buildBaseDraft(1); // includes one-return-per-order
const withRules = (rules: Rule[]): PolicyDocument => ({ ...doc(), rules });

test("the base document (with and without one-return-per-order) is valid", () => {
  for (const oneReturnPerOrder of [true, false]) {
    const result = validatePolicyDocument(buildBaseDraft(1, { oneReturnPerOrder }));
    assert.equal(result.valid, true, JSON.stringify(result.issues));
  }
});

test("one return per order — a first return is approved, a second is sent to a person", () => {
  const first = evaluatePolicy(doc(), "not_wanted", ctx(), NOW);
  assert.equal(first.decision, "autonomous_approve");
  assert.equal(first.basis, "decision");

  // The exact incident: $19.99 already refunded, a $45 return is under the $100 ceiling.
  const second = evaluatePolicy(doc(), "not_wanted", ctx({ refunded: 19.99, amount: 45 }), NOW);
  assert.equal(second.decision, "escalate");
  assert.equal(second.reasonCode, "one-return-per-order");
  assert.equal(second.basis, "restriction");
});

test("one return per order — another OPEN case on the order counts too", () => {
  const result = evaluatePolicy(doc(), "not_wanted", ctx({ pending: 45 }), NOW);
  assert.equal(result.reasonCode, "one-return-per-order");
});

test("one return per order — written once, it covers every reason (not just the one it was thought of for)", () => {
  for (const reason of ["damaged_or_defective", "not_wanted", "not_delivered"] as Reason[]) {
    const result = evaluatePolicy(doc(), reason, ctx({ refunded: 19.99, fault: "customer", vip: false }), NOW);
    assert.notEqual(result.decision, "autonomous_approve", reason);
    assert.notEqual(result.decision, "autonomous_deny", `${reason}: a customer must not be refused automatically on an order that already has a refund — a person decides`);
  }
  assert.equal(evaluatePolicy(doc(), "damaged_or_defective", ctx({ refunded: 19.99, fault: "customer" }), NOW).reasonCode, "one-return-per-order");
});

test("a restriction beats an approval wherever the approval sits in the list", () => {
  const base = doc();
  const approval = base.rules.find((r) => r.id === "within-return-refund-ceiling")!;
  const oneReturn = base.rules.find((r) => r.id === "one-return-per-order")!;
  // approval FIRST, restriction last — the order that would have let the second return through under first-match.
  const result = evaluatePolicy(withRules([approval, oneReturn]), "not_wanted", ctx({ refunded: 19.99 }), NOW);
  assert.equal(result.decision, "escalate");
  assert.equal(result.basis, "restriction");
});

test("reordering the rules never changes whether a case escalates, or what is decided", () => {
  const base = doc();
  // Deterministic shuffle (mulberry32) so a failure is reproducible.
  let seed = 20261007;
  const random = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const shuffle = <T,>(items: T[]) => { const a = [...items]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

  const samples: Array<[Reason, PolicyContext]> = [];
  for (const days of [5, 45]) for (const refunded of [0, 19.99]) for (const pending of [0, 45]) {
    samples.push(["not_wanted", ctx({ days, refunded, pending })], ["not_delivered", ctx({ days, refunded, pending })]);
    for (const fault of ["unknown", "customer", "notCustomer"] as const) for (const vip of [true, false]) samples.push(["damaged_or_defective", ctx({ days, refunded, pending, fault, vip })]);
  }
  for (let round = 0; round < 60; round++) {
    const shuffled = withRules(shuffle(base.rules));
    for (const [reason, context] of samples) {
      const a = evaluatePolicy(base, reason, context, NOW);
      const b = evaluatePolicy(shuffled, reason, context, NOW);
      assert.equal(b.decision === "always_escalate" ? "escalate" : b.decision, a.decision === "always_escalate" ? "escalate" : a.decision, `${reason} round ${round}: outcome changed with rule order`);
      assert.equal(b.basis, a.basis, `${reason} round ${round}: basis changed with rule order`);
      assert.deepEqual(b.matches.map((m) => m.id).sort(), a.matches.map((m) => m.id).sort(), `${reason} round ${round}: the set of matching rules changed`);
    }
  }
});

test("every matching restriction is recorded, the first in document order is the one reported", () => {
  const settingsOff = doc();
  settingsOff.settings.autonomousRefundsEnabled.value = false;
  const result = evaluatePolicy(settingsOff, "not_wanted", ctx({ days: 45, refunded: 19.99 }), NOW);
  assert.equal(result.basis, "restriction");
  const ids = result.matches.map((m) => m.id);
  for (const expected of ["one-return-per-order", "return-outside-window", "autonomous-refunds-disabled"]) assert.ok(ids.includes(expected), `missing ${expected} in ${ids.join(", ")}`);
  assert.equal(result.matchedRuleId, ids[0]);
  assert.equal(result.matchedRuleId, "one-return-per-order"); // first in the document
});

test("two decisions that disagree are never resolved by order — a person decides", () => {
  const base = doc();
  const deny = base.rules.find((r) => r.id === "customer-fault-non-vip")!;
  const approve: Rule = { kind: "decision", id: "approve-own-fault-small", description: "test", appliesTo: ["damaged_or_defective"], outcome: { decision: "autonomous_approve", reasonCode: "approve-own-fault-small", explanation: "test" } };
  for (const order of [[deny, approve], [approve, deny]]) {
    const result = evaluatePolicy(withRules(order), "damaged_or_defective", ctx({ fault: "customer", vip: false }), NOW);
    assert.equal(result.decision, "escalate");
    assert.equal(result.basis, "conflict");
    assert.equal(result.reasonCode, "policy-conflict");
    assert.equal(result.matches.length, 2);
  }
});

test("decisions that agree produce that outcome, and all of them are recorded", () => {
  const second: Rule = { kind: "decision", id: "approve-again", description: "test", appliesTo: ["not_wanted"], outcome: { decision: "autonomous_approve", reasonCode: "approve-again", explanation: "test" } };
  const result = evaluatePolicy(withRules([...buildBaseDraft(1).rules, second]), "not_wanted", ctx(), NOW);
  assert.equal(result.decision, "autonomous_approve");
  assert.equal(result.matches.length, 2);
});

test("with no explicit decision the answer is a person — never an automatic approval", () => {
  const noApproval = withRules(doc().rules.filter((r) => r.id !== "within-return-refund-ceiling"));
  const result = evaluatePolicy(noApproval, "not_wanted", ctx(), NOW);
  assert.equal(result.decision, "escalate");
  assert.equal(result.basis, "fallback");
  assert.equal(result.reasonCode, "needs-a-person");
});

test("a reason the policy has never heard of can never be approved automatically", () => {
  const result = evaluatePolicy(doc(), "wrong_item" as Reason, ctx(), NOW);
  assert.equal(result.decision, "escalate");
  assert.notEqual(result.basis, "decision");
});

test("a restriction with no condition always applies within its scope", () => {
  const result = evaluatePolicy(doc(), "not_delivered", ctx(), NOW);
  assert.equal(result.decision, "always_escalate");
});

test("a broken fact is an evaluation error (the caller escalates), never a silent non-match", () => {
  assert.throws(() => evaluatePolicy(doc(), "not_wanted", ctx({ orderAmount: 0 }), NOW), /finite number/);
});

test("the VIP courtesy recommendation travels with the rule, not with a reason-code string", () => {
  const result = evaluatePolicy(doc(), "damaged_or_defective", ctx({ fault: "customer", vip: true }), NOW);
  assert.equal(result.reasonCode, "customer-fault-vip");
  assert.equal(result.recommendedAction, "Approve full refund of {amount} (VIP courtesy)");
});

// ---- Delivery date (found 2026-10-08): a return on an order "delivered" in the FUTURE was approved ----------------
// The window restriction is `olderThanDays`, which a future date is never; the approval carried no eligibility of
// its own. The approval now requires `withinDays` (true only for a past date inside the window).

test("a plain return on an order not delivered yet (future delivery date) is never approved automatically", () => {
  for (const days of [-1 / 24, -1, -3, -365]) {
    const result = evaluatePolicy(doc(), "not_wanted", ctx({ days }), NOW);
    assert.equal(result.decision, "escalate", `delivered ${-days} days from now`);
    assert.equal(result.basis, "fallback", `delivered ${-days} days from now`);
    assert.equal(result.reasonCode, "needs-a-person");
  }
});

test("the approval states its own delivery-date requirement — it does not depend on the window restriction being there", () => {
  const withoutWindowRestriction = withRules(doc().rules.filter((r) => r.id !== "return-outside-window"));
  assert.equal(validatePolicyDocument(withoutWindowRestriction).valid, true);
  for (const days of [-1, 31, 45, 400]) {
    assert.notEqual(evaluatePolicy(withoutWindowRestriction, "not_wanted", ctx({ days }), NOW).decision, "autonomous_approve", `delivered ${days} days ago, window restriction deleted`);
  }
  // ...and a request that IS inside the window still approves with it deleted (the approval is not over-tightened).
  assert.equal(evaluatePolicy(withoutWindowRestriction, "not_wanted", ctx({ days: 5 }), NOW).decision, "autonomous_approve");
});

test("the window edges: delivered today and exactly 30 whole days ago are inside; 31 is outside", () => {
  assert.equal(evaluatePolicy(doc(), "not_wanted", ctx({ days: 0 }), NOW).decision, "autonomous_approve");
  assert.equal(evaluatePolicy(doc(), "not_wanted", ctx({ days: 30 }), NOW).decision, "autonomous_approve");
  assert.equal(evaluatePolicy(doc(), "not_wanted", ctx({ days: 30.5 }), NOW).decision, "autonomous_approve"); // whole days, as the legacy policy counted
  const outside = evaluatePolicy(doc(), "not_wanted", ctx({ days: 31 }), NOW);
  assert.equal(outside.decision, "escalate");
  assert.equal(outside.reasonCode, "return-outside-window"); // the specific reason, not the generic fallback
});

test("an invalid delivery date is an evaluation error (the caller escalates), never an approval", () => {
  const broken = ctx();
  broken.order.deliveredDate = "not-a-date";
  assert.throws(() => evaluatePolicy(doc(), "not_wanted", broken, NOW));
});
