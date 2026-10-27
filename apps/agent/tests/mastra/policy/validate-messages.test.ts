import { test } from "node:test";
import assert from "node:assert/strict";
import { validatePolicyDocument } from "../../../src/mastra/policy/validate";
import { buildBaseDraft } from "../../../src/mastra/policy/base-draft";
import { describeCatalog } from "../../../src/mastra/policy/catalog";

// Live-reported 2026-10-06: the Policy Helper put {"op": "conditional", …} inside a fact's value
// and the operator saw only "facts.2.value: Invalid input". These pin the clearer messages, and
// the supported way to say the same thing.

function withExtraFact(value: unknown) {
  const doc = JSON.parse(JSON.stringify(buildBaseDraft()));
  doc.facts.push({ name: "orderRefundCount", type: "number", description: "test", value });
  return doc;
}

test("the base draft validates (the fixtures below start from a valid document)", () => {
  assert.equal(validatePolicyDocument(buildBaseDraft()).valid, true);
});

test("an invented 'conditional' inside a fact's value says what is unsupported, and where", () => {
  const conditional = { op: "conditional", condition: { left: { field: "order.alreadyRefundedAmount" }, op: "gt", right: 0 }, ifTrue: 1, ifFalse: 0 };
  const result = validatePolicyDocument(withExtraFact({ op: "add", operands: [conditional, 0] }));
  assert.equal(result.valid, false);
  const issue = result.issues[0];
  assert.equal(issue.path, "facts.2.value.operands.0.op");
  assert.match(issue.message, /Unknown operator "conditional"/);
  assert.match(issue.message, /"any" \/ "all" \/ "not"/);
  assert.doesNotMatch(issue.message, /^Invalid input/);
});

test("a comparison used as a value is called out as a comparison", () => {
  const result = validatePolicyDocument(withExtraFact({ op: "gt", operands: [1, 2] }));
  assert.equal(result.valid, false);
  assert.match(result.issues[0].message, /"gt" is a comparison/);
});

test("arithmetic with fewer than two operands is rejected at the operands list, with a readable reason", () => {
  const result = validatePolicyDocument(withExtraFact({ op: "add", operands: [1] }));
  assert.equal(result.valid, false);
  // zod's own message is already specific here ("Too small: expected array to have >=2 items"),
  // so it is left as is — only an unreadable "Invalid input" needed replacing.
  assert.match(result.issues[0].path, /operands$/);
  assert.match(result.issues[0].message, />=2 items|at least two/);
});

test("valid arithmetic is still accepted", () => {
  const result = validatePolicyDocument(withExtraFact({ op: "add", operands: [{ field: "order.alreadyRefundedAmount" }, { field: "relatedCase.pendingAmount" }] }));
  assert.equal(result.valid, true, JSON.stringify(result.issues));
});

test("the supported way to say 'this order already has a refund or an open case' validates — one rule, no fact", () => {
  const doc = JSON.parse(JSON.stringify(buildBaseDraft(1, { oneReturnPerOrder: false })));
  doc.rules.unshift({
    kind: "restriction",
    id: "one-refund-per-order",
    description: "An order may be refunded only once.",
    when: {
      any: [
        { left: { field: "order.alreadyRefundedAmount" }, op: "gt", right: 0 },
        { left: { field: "relatedCase.pendingAmount" }, op: "gt", right: 0 },
      ],
    },
    outcome: { decision: "escalate", reasonCode: "one-refund-per-order", explanation: "This order already has a refund or an open case.", customerReason: "This order already has a refund in progress, so a specialist needs to review this request." },
  });
  const result = validatePolicyDocument(doc);
  assert.equal(result.valid, true, JSON.stringify(result.issues));
});

test("the catalog the Helper is given lists the arithmetic operators", () => {
  assert.deepEqual([...describeCatalog().arithmetic], ["add", "subtract", "multiply", "divide"]);
});
