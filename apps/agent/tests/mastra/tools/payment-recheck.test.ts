// The money step's policy re-check must read the OTHER open cases on the order itself, at the moment it
// authorizes — not take that figure from its caller (the amount the workflow was started with, which a case
// opened in between makes stale). Found 2026-10-08.
//
// Runs against a throwaway database (a real Mastra workflow, a real suspended case) and the SHIPPED demo
// policy (data/policy/demo) — so it asserts that policy still has the two rules it relies on, and says so
// plainly if an operator has edited them away, instead of failing mysteriously.

import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "wismo-recheck-"));
process.env.AGENT_DB_URL = `file:${join(dir, "test.db")}`;

const { mastra } = await import("../../../src/mastra/index");
const { issueRefund } = await import("../../../src/mastra/tools/payment");
const { extractOpenCaseAmountForOrder, pendingAmountFromOtherOpenCases } = await import("../../../src/mastra/refund-ledger");
const { findOpenCasesForOrder, refundAmountOf } = await import("../../../src/mastra/tools/case-lookup");
const { getActiveVersion } = await import("../../../src/mastra/policy/repository");

const ORDER = "order_2001"; // single item, $19.99, delivered 3 days ago — an ordinary, in-window return
const OPEN_CASE = "OPENA1";

async function openACaseOnTheOrder(runId: string, refundAmount: number) {
  const workflow = mastra.getWorkflow("policyReviewWorkflow")!;
  const run = await workflow.createRun({ runId });
  const started: any = await run.start({
    inputData: { orderId: ORDER, refundAmount, caseType: "delivery_dispute", problemSummary: "test", threadId: "t", sessionId: "s", createdAt: new Date().toISOString(), transcript: [], relatedOpenCaseRefundAmount: 0 } as any,
  });
  assert.equal(started.status, "suspended", "a delivery dispute should be waiting on a person");
}

// Run with: npx tsx --test --test-force-exit src/mastra/tools/payment-recheck.test.ts
// (--test-force-exit because the LibSQL client keeps the process alive after the tests finish.)
describe("issueRefund's policy re-check reads the open cases live", () => {
  after(() => rmSync(dir, { recursive: true, force: true }));

  test("precondition: the shipped demo policy still has the rules this test relies on", async () => {
    const policy = (await getActiveVersion("demo"))!;
    const ids = policy.rules.map((r) => r.id);
    for (const id of ["one-return-per-order", "delivery-dispute-requires-investigation", "within-return-refund-ceiling"]) {
      assert.ok(ids.includes(id), `data/policy/demo no longer has the "${id}" rule — this test is written against the shipped policy`);
    }
  });

  test("with no other case open, an in-window return is approved", async () => {
    const result = await issueRefund({ orderId: ORDER, amount: 19.99, authorizedBy: "return-autonomous", runId: "THISRUN" });
    assert.equal(result.status, "approved");
  });

  test("a case that opens AFTER the caller worked out its figure still stops the automatic approval", async () => {
    await openACaseOnTheOrder(OPEN_CASE, 19.99);
    // The caller has no say in the open-case amount any more: there is no input to pass it through.
    const result = await issueRefund({ orderId: ORDER, amount: 19.99, authorizedBy: "return-autonomous", runId: "THISRUN" });
    assert.equal(result.status, "rejected");
    assert.equal(result.recheck?.reasonCode, "one-return-per-order");
    assert.ok(result.recheck?.customerReason, "the refusal carries a customer-safe reason");
    assert.ok(result.recheck?.policy?.number, "…and the rule that decided");
  });

  // The demo policy never approves a damage claim or a dispute automatically, so this does NOT prove those two
  // branches read the open cases live (only the plain-return test above can) — it proves they go through the same
  // re-check and come back as a refusal the workflow can escalate.
  test("the damage-claim and dispute authorizations are refused by the same re-check, with the policy's answer attached", async () => {
    for (const authorizedBy of ["autonomous", "dispute-autonomous"] as const) {
      const result = await issueRefund({ orderId: ORDER, amount: 19.99, authorizedBy, notCustomerFault: true, runId: "THISRUN" });
      assert.equal(result.status, "rejected", authorizedBy);
      assert.ok(result.recheck, authorizedBy);
    }
  });

  test("a case's own ask is not 'another case' — the run being authorized is left out", async () => {
    const result = await issueRefund({ orderId: ORDER, amount: 19.99, authorizedBy: "return-autonomous", runId: OPEN_CASE });
    assert.equal(result.status, "approved");
  });

  test("a rep's approval is a human decision — it is not re-checked against policy, open cases or not", async () => {
    const result = await issueRefund({ orderId: ORDER, amount: 19.99, authorizedBy: "escalation-approval", runId: "THISRUN" });
    assert.equal(result.status, "approved");
  });

  test("the workflow sends a refused automatic return to a person instead of ending the case as an error", async () => {
    // The workflow is started with the figure the gate worked out BEFORE the case above opened: 0.
    const workflow = mastra.getWorkflow("policyReviewWorkflow")!;
    const run = await workflow.createRun({ runId: "STALE1" });
    const result: any = await run.start({
      inputData: { orderId: ORDER, refundAmount: 19.99, caseType: "plain_return", problemSummary: "test", threadId: "t2", sessionId: "s2", createdAt: new Date().toISOString(), transcript: [], relatedOpenCaseRefundAmount: 0 } as any,
    });
    assert.equal(result.status, "suspended", "a person must decide — not a closed case the customer is told is an error");
    const payload = result.suspendPayload?.["human-policy-review"];
    assert.equal(payload?.reasonCode, "one-return-per-order");
    assert.ok(payload?.customerReason);
    assert.ok(payload?.policy?.number);
  });

  test("the live amount matches the gate's own definition of 'other open cases' (case-lookup.ts)", async () => {
    const workflow = mastra.getWorkflow("policyReviewWorkflow")!;
    const { runs } = await workflow.listWorkflowRuns({});
    const viaGate = (await findOpenCasesForOrder(workflow as any, ORDER)).reduce((sum, match) => sum + refundAmountOf(match), 0);
    assert.equal(extractOpenCaseAmountForOrder(ORDER, runs as any[]), viaGate);
    assert.equal(viaGate, 39.98, "two $19.99 cases are open on the order by now (OPENA1 and STALE1)");
    assert.equal(await pendingAmountFromOtherOpenCases(ORDER), viaGate);
    assert.equal(await pendingAmountFromOtherOpenCases(ORDER, OPEN_CASE), 19.99, "leaving one case out leaves the other");
    assert.equal(await pendingAmountFromOtherOpenCases("order_1181"), 0, "another order's cases never count");
  });
});
