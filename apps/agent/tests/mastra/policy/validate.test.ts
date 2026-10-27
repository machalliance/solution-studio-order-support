// v2 validation: structure that makes unsafe
// documents impossible to save.

import { test } from "node:test";
import assert from "node:assert/strict";
import { validatePolicyDocument } from "../../../src/mastra/policy/validate";
import { buildBaseDraft } from "../../../src/mastra/policy/base-draft";

const fresh = () => JSON.parse(JSON.stringify(buildBaseDraft(1)));
const messages = (doc: unknown) => validatePolicyDocument(doc).issues.map((i) => `${i.path}: ${i.message}`).join(" | ");

test("a decision must name the reasons it authorizes", () => {
  const doc = fresh();
  delete doc.rules.find((r: any) => r.id === "within-return-refund-ceiling").appliesTo;
  assert.equal(validatePolicyDocument(doc).valid, false);
});

test("a restriction can only escalate — it cannot approve or deny", () => {
  for (const decision of ["autonomous_approve", "autonomous_deny"]) {
    const doc = fresh();
    doc.rules.find((r: any) => r.id === "return-outside-window").outcome.decision = decision;
    assert.equal(validatePolicyDocument(doc).valid, false, decision);
  }
});

test("a decision can only approve or deny — it cannot escalate", () => {
  const doc = fresh();
  doc.rules.find((r: any) => r.id === "within-return-refund-ceiling").outcome.decision = "escalate";
  assert.equal(validatePolicyDocument(doc).valid, false);
});

test("the fallback can never be an automatic decision", () => {
  for (const decision of ["autonomous_approve", "autonomous_deny"]) {
    const doc = fresh();
    doc.fallback.decision = decision;
    assert.equal(validatePolicyDocument(doc).valid, false, decision);
  }
});

test("a plain return can't be denied automatically", () => {
  const doc = fresh();
  doc.rules.find((r: any) => r.id === "customer-fault-non-vip").appliesTo = ["damaged_or_defective", "not_wanted"];
  assert.match(messages(doc), /plain return.*can't be denied automatically/);
});

test("a rule about fault must be scoped to damage claims, or it would fire on every plain return", () => {
  const doc = fresh();
  delete doc.rules.find((r: any) => r.id === "fault-unknown").appliesTo;
  assert.match(messages(doc), /fault-unknown.*only mean something for a damage claim/);

  const widened = fresh();
  widened.rules.find((r: any) => r.id === "fault-unknown").appliesTo = ["damaged_or_defective", "not_wanted"];
  assert.equal(validatePolicyDocument(widened).valid, false);
});

test("a restriction with no scope is valid — it applies to every reason", () => {
  const doc = fresh();
  assert.equal(doc.rules.find((r: any) => r.id === "one-return-per-order").appliesTo, undefined);
  assert.equal(validatePolicyDocument(doc).valid, true);
});

test("an unknown reason in appliesTo is rejected", () => {
  const doc = fresh();
  doc.rules.find((r: any) => r.id === "fault-unknown").appliesTo = ["wrong_item"];
  assert.equal(validatePolicyDocument(doc).valid, false);
});

test("rule ids and policy numbers are unique across the whole document", () => {
  const dupId = fresh();
  dupId.rules[1].id = dupId.rules[0].id;
  assert.match(messages(dupId), /Duplicate rule id/);

  const dupNumber = fresh();
  dupNumber.rules[1].number = dupNumber.rules[0].number;
  assert.match(messages(dupNumber), /already used/);

  const dupFallback = fresh();
  dupFallback.fallback.number = dupFallback.rules[0].number;
  assert.match(messages(dupFallback), /already used/);
});

test("an automatic denial needs a customer-safe reason", () => {
  const doc = fresh();
  delete doc.rules.find((r: any) => r.id === "customer-fault-non-vip").outcome.customerReason;
  assert.match(messages(doc), /customer-safe reason/);
});

test("rule conditions are still checked against the catalog, settings and facts", () => {
  const doc = fresh();
  doc.rules.find((r: any) => r.id === "return-outside-window").when.right = { setting: "noSuchSetting" };
  assert.match(messages(doc), /undefined setting/);
});

test("a rule with no kind is rejected with a readable message", () => {
  const doc = fresh();
  delete doc.rules[0].kind;
  const result = validatePolicyDocument(doc);
  assert.equal(result.valid, false);
  console.log("  missing-kind message:", messages(doc).slice(0, 220));
});

test("a document without schemaVersion 2 is rejected", () => {
  const doc = fresh();
  delete doc.schemaVersion;
  assert.equal(validatePolicyDocument(doc).valid, false);
});

test("a valid document comes back canonical — unknown fields never reach the saved document", () => {
  const result = validatePolicyDocument({ ...fresh(), unused: "must not reach saved document" });
  assert.equal(result.valid, true);
  assert.equal("unused" in result.document!, false);
});

test("duplicate fact names are rejected", () => {
  const doc = fresh();
  doc.facts.push(structuredClone(doc.facts[0]));
  assert.match(messages(doc), /Duplicate fact name/);
});

// ---- Damage-only fields reached through a named fact (found 2026-10-08) --------------------------------------------
// The scope check looked only for request.faultKnown / request.notCustomerFault written in the rule itself, so a
// calculated fact built on one of them let an UNSCOPED rule use it — and fault is always "unknown" for returns
// and disputes, so the rule would fire on those.

const factOnFault = (name: string, value: unknown) => ({ name, type: "boolean", description: `Derived from fault (${name}).`, value });
const restrictionOn = (factName: string, appliesTo?: string[]) => ({
  kind: "restriction", id: `uses-${factName}`, description: "Test rule.",
  ...(appliesTo ? { appliesTo } : {}),
  when: { left: { fact: factName }, op: "eq", right: false },
  outcome: { decision: "escalate", reasonCode: "test-reason", explanation: "Test.", customerReason: "A specialist will take a look." },
});

test("an unscoped rule can't reach a damage-only field through a named fact", () => {
  const doc = fresh();
  doc.facts.push(factOnFault("faultStated", { field: "request.faultKnown" }));
  doc.rules.push(restrictionOn("faultStated"));
  assert.match(messages(doc), /uses-faultStated.*damage claim/);
});

test("…nor through a chain of facts, or arithmetic inside one", () => {
  const doc = fresh();
  doc.facts.push(factOnFault("faultStated", { field: "request.notCustomerFault" }));
  doc.facts.push({ name: "faultScore", type: "number", description: "Arithmetic over the chained fact.", value: { op: "add", operands: [{ fact: "faultStated" }, 1] } });
  doc.facts.push({ name: "faultScoreAgain", type: "number", description: "A fact on a fact.", value: { fact: "faultScore" } });
  doc.rules.push({ ...restrictionOn("faultScoreAgain"), when: { left: { fact: "faultScoreAgain" }, op: "gt", right: 1 } });
  assert.match(messages(doc), /uses-faultScoreAgain.*damage claim/);
});

test("…but a rule scoped to damage claims may use such a fact", () => {
  const doc = fresh();
  doc.facts.push(factOnFault("faultStated", { field: "request.faultKnown" }));
  doc.rules.push(restrictionOn("faultStated", ["damaged_or_defective"]));
  assert.equal(validatePolicyDocument(doc).valid, true, messages(doc));
});

test("an unscoped rule on a fact that has nothing to do with fault is still fine", () => {
  const doc = fresh();
  doc.facts.push({ name: "orderIsBig", type: "boolean", description: "Order value derived fact.", value: { field: "order.amount" } });
  doc.rules.push({ ...restrictionOn("orderIsBig"), when: { left: { fact: "orderIsBig" }, op: "gt", right: 1000 } });
  assert.equal(validatePolicyDocument(doc).valid, true, messages(doc));
});
