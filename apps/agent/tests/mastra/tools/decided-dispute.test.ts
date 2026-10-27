// A delivery dispute that a specialist already ruled on must not be opened a second time. Found on a fresh install: a rep
// rejected a dispute (order #3401); the customer opened a NEW chat and said "didn't get it - already asked for refund";
// the order lookup and the dispute status check both said there was no case (they only knew about open or ticketed
// disputes), so the agent opened a second dispute for the same order instead of telling the customer what had been decided
// and offering to take it to support.
//
// Real workflow runs, tools and route against a throwaway database, tickets file and policy folder; no model is called.
// Run with: npx tsx --test --test-force-exit tests/mastra/tools/decided-dispute.test.ts (from apps/agent)

import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RequestContext } from "@mastra/core/request-context";

const dir = mkdtempSync(join(tmpdir(), "wismo-decideddispute-"));
process.env.AGENT_DB_URL = `file:${join(dir, "test.db")}`;
process.env.WISMO_POLICY_DIR = join(dir, "policy");
process.env.WISMO_TICKETS_FILE = join(dir, "disagreement-tickets.json");

const { mastra } = await import("../../../src/mastra/index");
const { app } = await import("../../../src/server");
const { ensureSeeded } = await import("../../../src/mastra/policy/repository");
const { buildBaseDraft } = await import("../../../src/mastra/policy/base-draft");
await ensureSeeded("demo", buildBaseDraft());
const { SESSION_CUSTOMER_ID_KEY, SESSION_ID_KEY } = await import("../../../src/mastra/request-context");
const { commerceGetOrder, commerceListOrdersForCustomer } = await import("../../../src/mastra/tools/commerce");
const { checkEscalationStatus } = await import("../../../src/mastra/tools/escalation-status");
const { escalateForDeliveryDispute } = await import("../../../src/mastra/tools/delivery-dispute");
const { offerEscalationToSupport } = await import("../../../src/mastra/tools/offer-escalation");

function toolContext() {
  const requestContext = new RequestContext();
  requestContext.setRaw(SESSION_CUSTOMER_ID_KEY, "cust_demo_01");
  requestContext.setRaw(SESSION_ID_KEY, "decided-dispute-test-session");
  return { requestContext, mastra } as any;
}

const resume = (runId: string, body: object) =>
  app.request(`/escalations/${runId}/resume`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function disputeRuns(orderId: string): Promise<number> {
  const { runs } = await mastra.getWorkflow("policyReviewWorkflow")!.listWorkflowRuns({});
  return (runs as any[]).filter((run) => {
    const snapshot = typeof run.snapshot === "string" ? JSON.parse(run.snapshot) : run.snapshot;
    const payload = snapshot?.context?.["human-policy-review"]?.payload;
    return payload?.orderId === orderId && payload?.caseType === "delivery_dispute";
  }).length;
}

// The agent opens a dispute through the real tool, as it did in the chat.
async function openDispute(orderId: string): Promise<string> {
  const result: any = await escalateForDeliveryDispute.execute!({ orderId, problemSummary: "never arrived" } as any, toolContext());
  assert.equal(result.status, "escalated", JSON.stringify(result));
  return result.runId as string;
}

describe("a delivery dispute that was already decided", () => {
  after(() => rmSync(dir, { recursive: true, force: true }));

  let rejectedCase = "";
  let approvedCase = "";
  let modifiedCase = "";

  test("setup: one dispute is rejected by a rep (#3401), one approved (#1181), one approved for a different amount (#4203)", async () => {
    rejectedCase = await openDispute("order_3401");
    assert.equal((await resume(rejectedCase, { decision: "reject", reason: "The carrier shows it delivered and signed for." })).status, 200);
    approvedCase = await openDispute("order_1181");
    assert.equal((await resume(approvedCase, { decision: "approve" })).status, 200);
    modifiedCase = await openDispute("order_4203");
    assert.equal((await resume(modifiedCase, { decision: "modify", modifiedAmount: 100, comment: "A partial refund." })).status, 200);
  });

  test("the order lookup reports the decision, with the sentence to relay", async () => {
    const order: any = await commerceGetOrder.execute!({ orderId: "order_3401" }, toolContext());
    assert.equal(order.existingDispute.state, "denied");
    assert.equal(order.existingDispute.caseId, rejectedCase);
    assert.match(order.existingDispute.statement, new RegExp(`${rejectedCase}.*not approved`));
    const approved: any = await commerceGetOrder.execute!({ orderId: "order_1181" }, toolContext());
    assert.equal(approved.existingDispute.state, "approved");
    assert.match(approved.existingDispute.statement, /refund of \$165\.00 was approved/);
    assert.doesNotMatch(approved.existingDispute.statement, /processed|paid|sent/i, "approved is all this system knows");
  });

  test("a rep's modify is a decision too: it is reported as approved, with the amount actually approved", async () => {
    const order: any = await commerceGetOrder.execute!({ orderId: "order_4203" }, toolContext());
    assert.equal(order.existingDispute.state, "approved");
    assert.equal(order.existingDispute.caseId, modifiedCase);
    assert.equal(order.existingDispute.refundAmount, 100);
    assert.match(order.existingDispute.statement, /refund of \$100\.00 was approved/);
    const status: any = await checkEscalationStatus.execute!({ orderId: "order_4203", caseType: "delivery_dispute" }, toolContext());
    assert.equal(status.status, "approved");
    assert.equal(status.refundAmount, 100);
    const again: any = await escalateForDeliveryDispute.execute!({ orderId: "order_4203", problemSummary: "still not here" } as any, toolContext());
    assert.equal(again.status, "error");
  });

  test("the order list (what the customer sees first) reports it too", async () => {
    const raw = await commerceListOrdersForCustomer.execute!({}, toolContext());
    const checked: any = await commerceListOrdersForCustomer.outputSchema!["~standard"].validate(raw);
    assert.equal(checked.issues, undefined, JSON.stringify(checked.issues));
    const order = checked.value.orders.find((o: any) => o.id === "order_3401");
    assert.equal(order.existingDispute.state, "denied");
    assert.equal(order.existingDispute.caseId, rejectedCase);
  });

  test("the pre-filing status check no longer answers 'found: false'", async () => {
    const result: any = await checkEscalationStatus.execute!({ orderId: "order_3401", caseType: "delivery_dispute" }, toolContext());
    assert.equal(result.found, true);
    assert.equal(result.status, "denied");
    assert.equal(result.caseId, rejectedCase);
  });

  test("opening another dispute for it is refused, creates no case, and points at the escalation offer", async () => {
    const before = await disputeRuns("order_3401");
    const result: any = await escalateForDeliveryDispute.execute!({ orderId: "order_3401", problemSummary: "didn't get it" } as any, toolContext());
    assert.equal(result.status, "error");
    assert.match(result.reason, /offer_escalation_to_support/);
    assert.match(result.reason, new RegExp(rejectedCase));
    assert.equal(await disputeRuns("order_3401"), before, "no second dispute case");
    const approved: any = await escalateForDeliveryDispute.execute!({ orderId: "order_1181", problemSummary: "didn't get it" } as any, toolContext());
    assert.equal(approved.status, "error", "an approved dispute is not opened again either");
  });

  test("the way forward works: the customer can be offered escalation to support for the decided dispute", async () => {
    const offer: any = await offerEscalationToSupport.execute!({ orderId: "order_3401", message: "I can escalate this to our support team, if you'd like." }, toolContext());
    assert.equal(offer.caseId, rejectedCase);
  });

  test("control: an order with no dispute is unaffected, and a first dispute still opens", async () => {
    const order: any = await commerceGetOrder.execute!({ orderId: "order_2001" }, toolContext());
    assert.equal(order.existingDispute, undefined);
    const status: any = await checkEscalationStatus.execute!({ orderId: "order_2001", caseType: "delivery_dispute" }, toolContext());
    assert.equal(status.found, false);
    await openDispute("order_2001");
  });
});
