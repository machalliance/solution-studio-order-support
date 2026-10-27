// A customer who opens the chat with "help with an issue for an order" gets the order list first, then types their
// problem — and the model answers from what it has already seen. The list used to carry only order ids and item names,
// so an item that already had an open case or a support ticket looked fresh: the agent asked how it happened and for a
// photo before anything caught it. The list now carries the same case facts commerce_get_order does.
//
// Real workflow runs against a throwaway database and tickets file, and a starting-policy copy in its own temp folder; no model is called.
// Run with: npx tsx --test --test-force-exit tests/mastra/tools/order-list-coverage.test.ts (from apps/agent)

import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RequestContext } from "@mastra/core/request-context";

const dir = mkdtempSync(join(tmpdir(), "wismo-orderlist-"));
process.env.AGENT_DB_URL = `file:${join(dir, "test.db")}`;
process.env.WISMO_POLICY_DIR = join(dir, "policy"); // its own policy folder: the tests must not depend on the live one an operator can edit
process.env.WISMO_TICKETS_FILE = join(dir, "disagreement-tickets.json");

const { mastra } = await import("../../../src/mastra/index");
const { ensureSeeded } = await import("../../../src/mastra/policy/repository");
const { buildBaseDraft } = await import("../../../src/mastra/policy/base-draft");
await ensureSeeded("demo", buildBaseDraft());
const { app } = await import("../../../src/server");
const { SESSION_CUSTOMER_ID_KEY } = await import("../../../src/mastra/request-context");
const { commerceGetOrder, commerceListOrdersForCustomer } = await import("../../../src/mastra/tools/commerce");

function toolContext() {
  const requestContext = new RequestContext();
  requestContext.setRaw(SESSION_CUSTOMER_ID_KEY, "cust_demo_01");
  return { requestContext, mastra } as any;
}

function runInput(overrides: Record<string, unknown>) {
  return {
    orderId: "order_4203",
    refundAmount: 19.99,
    problemSummary: "test",
    threadId: "t",
    sessionId: "order-list-test-session",
    createdAt: new Date().toISOString(),
    transcript: [],
    relatedOpenCaseRefundAmount: 0,
    ...overrides,
  } as any;
}

async function startCase(runId: string, overrides: Record<string, unknown>) {
  const run = await mastra.getWorkflow("policyReviewWorkflow")!.createRun({ runId });
  return (await run.start({ inputData: runInput(overrides) })) as any;
}

async function listedOrder(orderId: string): Promise<any> {
  const raw = await commerceListOrdersForCustomer.execute!({}, toolContext());
  // Mastra drops any field the output schema doesn't declare, so check what survives the schema, not just what execute returns.
  const checked: any = await commerceListOrdersForCustomer.outputSchema!["~standard"].validate(raw);
  assert.equal(checked.issues, undefined, JSON.stringify(checked.issues));
  const order = checked.value.orders.find((o: any) => o.id === orderId);
  assert.ok(order, `${orderId} should be in the list`);
  return order;
}

describe("the order list carries the case facts for each order", () => {
  after(() => rmSync(dir, { recursive: true, force: true }));

  test("setup: an approved return, a case that became a support ticket, an open case, and an open dispute", async () => {
    // order_4203: the socks return is approved on the spot by the shipped policy.
    assert.equal((await startCase("LSTRET", { orderId: "order_4203", caseType: "plain_return", itemIds: ["socks-004"] })).status, "success");
    // order_4472: the jacket's claim goes to a specialist, who sends it on to support (a ticket); the top's claim stays open.
    const jacket = await startCase("LSTJKT", { orderId: "order_4472", refundAmount: 145, caseType: "refund", itemIds: ["jacket-001"] });
    assert.equal(jacket.status, "suspended");
    const escalate = await app.request("/escalations/LSTJKT/resume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision: "escalate_to_support" }) });
    assert.equal(escalate.status, 200, await escalate.clone().text());
    assert.equal((await startCase("LSTTOP", { orderId: "order_4472", refundAmount: 85, caseType: "refund", itemIds: ["top-001"] })).status, "suspended");
    // order_3401: a delivery dispute with a specialist.
    assert.equal((await startCase("LSTDSP", { orderId: "order_3401", refundAmount: 70, caseType: "delivery_dispute" })).status, "suspended");
  });

  test("an item whose refund was approved is listed as such, and the order's other items are not", async () => {
    const order = await listedOrder("order_4203");
    assert.equal(order.existingCases.length, 1, JSON.stringify(order.existingCases));
    assert.equal(order.existingCases[0].objectID, "socks-004");
    assert.equal(order.existingCases[0].state, "refund_approved");
    assert.equal(order.existingCases[0].caseId, "LSTRET");
    assert.ok(order.existingCases[0].statement.length > 0);
    assert.equal(order.existingDispute, undefined);
  });

  test("a case that became a support ticket is listed with its ticket, next to an item whose case is still open", async () => {
    const order = await listedOrder("order_4472");
    const byItem = Object.fromEntries(order.existingCases.map((c: any) => [c.objectID, c]));
    assert.equal(byItem["jacket-001"].state, "with_support");
    assert.match(byItem["jacket-001"].ticketId, /^TKT-/);
    assert.ok(byItem["jacket-001"].statement.includes(byItem["jacket-001"].ticketId), "the sentence to relay names the real ticket");
    assert.equal(byItem["top-001"].state, "under_review");
    assert.equal(byItem["top-001"].caseId, "LSTTOP");
  });

  test("an open delivery dispute is listed on its order", async () => {
    const order = await listedOrder("order_3401");
    assert.equal(order.existingDispute.state, "under_review");
    assert.equal(order.existingDispute.caseId, "LSTDSP");
  });

  test("control: an order with nothing on it carries no case facts at all", async () => {
    const order = await listedOrder("order_2001");
    assert.equal(order.existingCases, undefined);
    assert.equal(order.existingDispute, undefined);
  });

  test("the list says the same thing commerce_get_order does about each item", async () => {
    for (const orderId of ["order_4203", "order_4472", "order_3401", "order_2001"]) {
      const detail: any = await commerceGetOrder.execute!({ orderId }, toolContext());
      const fromDetail = detail.items.filter((i: any) => i.existingCase).map((i: any) => ({ objectID: i.objectID, ...i.existingCase }));
      const listed = await listedOrder(orderId);
      const fromList = (listed.existingCases ?? []).map(({ name: _name, ...rest }: any) => rest);
      assert.deepEqual(fromList, fromDetail, orderId);
      assert.deepEqual(listed.existingDispute, detail.existingDispute, orderId);
    }
  });
});
