// The review workflow's AUTOMATIC branches that the shipped demo policy never takes, run end to end: an operator (or
// the Policy Helper) makes a plain edit to policy.json and cases start resolving themselves in ways that had only
// ever been typechecked. Three edits, each through the real validator and then the real tools, gate and workflow:
//   - disputes are no longer always sent to a rep: small ones are refunded, large ones declined, the rest go to a person;
//   - a damage claim that is not the customer's fault is approved automatically when it is small enough;
//   - the spending ceiling (System Authority) still clamps an automatic approval that a policy allows.
//
// Runs against a throwaway database AND a throwaway policy folder (WISMO_POLICY_DIR), so the real "demo" policy and its
// version history are never touched. No model is called.
// Run with: npx tsx --test --test-force-exit tests/mastra/automatic-decision-paths.test.ts (from apps/agent)

import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RequestContext } from "@mastra/core/request-context";
import { editedPolicy } from "./helpers/edited-policy";

const dir = mkdtempSync(join(tmpdir(), "wismo-autopaths-"));
process.env.AGENT_DB_URL = `file:${join(dir, "test.db")}`;
process.env.WISMO_POLICY_DIR = join(dir, "policy");

const { mastra } = await import("../../src/mastra/index");
const { app } = await import("../../src/server");
const { SESSION_CUSTOMER_ID_KEY, SESSION_ID_KEY } = await import("../../src/mastra/request-context");
const { activatePolicy } = await import("../../src/mastra/policy/repository");
const { escalateForDeliveryDispute } = await import("../../src/mastra/tools/delivery-dispute");
const { refundPolicyGate } = await import("../../src/mastra/refund-policy-gate");
const { alreadyRefundedItemIds, totalRefundedForOrder } = await import("../../src/mastra/refund-ledger");
const { getMaxAutonomousAmount, setMaxAutonomousAmount } = await import("../../src/mastra/runtime-settings");

// cust_demo_01's orders: order_2001 $19.99 · order_3401 $70 · order_1181 $165 · order_4203 $189.99 · order_4472 $230
function toolContext() {
  const requestContext = new RequestContext();
  requestContext.setRaw(SESSION_CUSTOMER_ID_KEY, "cust_demo_01");
  requestContext.setRaw(SESSION_ID_KEY, "auto-paths-test-session");
  return { requestContext, mastra } as any;
}

async function caseDetail(runId: string) {
  const response = await app.request(`/escalations/${runId}`);
  return { status: response.status, body: (await response.json()) as any };
}

async function historyEntry(runId: string) {
  const body: any = await (await app.request("/escalations/history")).json();
  return (body.runs as any[]).find((run) => run.runId === runId);
}

describe("an edited policy takes the automatic branches that had never run", () => {
  after(() => rmSync(dir, { recursive: true, force: true }));

  test("the edits pass the real validator and are activated", async () => {
    const result = await activatePolicy("demo", editedPolicy());
    assert.equal(result.ok, true, JSON.stringify(result));
  });

  test("a small disputed order is refunded automatically, with the refund recorded and the case resolved", async () => {
    const result: any = await escalateForDeliveryDispute.execute!({ orderId: "order_2001", problemSummary: "never arrived" } as any, toolContext());
    assert.equal(result.status, "approved", JSON.stringify(result));
    assert.ok(result.refundId, "a refund id comes back");
    assert.equal(result.amount, 19.99);
    assert.deepEqual([...(await alreadyRefundedItemIds("order_2001"))], ["socks-004"], "the refund is recorded against the real item");
    assert.equal(await totalRefundedForOrder("order_2001"), 19.99);
  });

  test("…and the resolved case reads back correctly in History and on its detail page", async () => {
    const history: any = await (await app.request("/escalations/history")).json();
    const entry = (history.runs as any[]).find((run) => run.orderId === "order_2001");
    assert.ok(entry, "the automatically resolved dispute is in History");
    assert.equal(entry.outcome, "approved");
    assert.equal(entry.resolvedBy, "agent");
    assert.equal(entry.caseType, "delivery_dispute");
    const detail = await caseDetail(entry.runId);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.outcome, "approved");
    assert.equal(detail.body.policy?.number != null || detail.body.policy?.text != null, true, "the rule that decided it is on the record");
  });

  test("a second dispute on the same order cannot be refunded again", async () => {
    const before = await totalRefundedForOrder("order_2001");
    const result: any = await escalateForDeliveryDispute.execute!({ orderId: "order_2001", problemSummary: "still not here" } as any, toolContext());
    assert.notEqual(result.status, "approved", `a second automatic refund was approved: ${JSON.stringify(result)}`);
    assert.equal(await totalRefundedForOrder("order_2001"), before, "no more money was recorded");
  });

  test("a large disputed order is declined automatically, and no money moves", async () => {
    const result: any = await escalateForDeliveryDispute.execute!({ orderId: "order_4203", problemSummary: "never arrived" } as any, toolContext());
    assert.equal(result.status, "denied", JSON.stringify(result));
    assert.equal(result.reason, "We're not able to refund this one automatically.", "the customer gets the rule's own wording");
    assert.equal(await totalRefundedForOrder("order_4203"), 0);
    const history = await historyEntry((await (await app.request("/escalations/history")).json() as any).runs.find((r: any) => r.orderId === "order_4203")?.runId);
    assert.equal(history?.outcome, "denied");
    assert.equal(history?.resolvedBy, "agent");
  });

  test("a disputed order no rule decides goes to a person, by the fallback", async () => {
    const result: any = await escalateForDeliveryDispute.execute!({ orderId: "order_3401", problemSummary: "never arrived" } as any, toolContext());
    assert.equal(result.status, "escalated", JSON.stringify(result));
    const detail = await caseDetail(result.runId);
    assert.equal(detail.body.reasonCode, "needs-a-person");
    assert.equal(await totalRefundedForOrder("order_3401"), 0);
  });

  test("a small damage claim that is not the customer's fault is approved automatically", async () => {
    const output: any = await refundPolicyGate({
      toolName: "paymentIssueRefund",
      input: { orderId: "order_1181", problemSummary: "zipper failed on first wear", notCustomerFault: true },
      context: { ...toolContext(), messages: [] },
    } as any);
    assert.equal(output.proceed, false);
    assert.equal(output.output.status, "approved", JSON.stringify(output));
    assert.equal(output.output.amount, 165);
    assert.deepEqual([...(await alreadyRefundedItemIds("order_1181"))], ["jacket-002"]);
  });

  test("the spending ceiling still clamps an automatic approval the policy allows", async () => {
    const original = getMaxAutonomousAmount();
    setMaxAutonomousAmount(200);
    try {
      const output: any = await refundPolicyGate({
        toolName: "paymentIssueRefund",
        input: { orderId: "order_4472", problemSummary: "tore on first wear", notCustomerFault: true },
        context: { ...toolContext(), messages: [] },
      } as any);
      assert.equal(output.output.status, "escalated", JSON.stringify(output));
      const detail = await caseDetail(output.output.runId);
      assert.equal(detail.body.reasonCode, "exceeds-max-autonomous-amount");
      assert.equal(await totalRefundedForOrder("order_4472"), 0, "nothing was paid");
    } finally {
      setMaxAutonomousAmount(original);
    }
  });
});
