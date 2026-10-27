// Three gaps found in an outside review (2026-10-09), each reproduced here before it was fixed:
//   1. shipping_generate_return_label made a label for EVERY selected item as soon as ONE of them had an approved
//      refund (`some`, not `every`) — and, with no itemIds, for the whole order.
//   2. lookup_case_by_id lost the support ticket of a case that ended as "escalated to support" (a timeout or a
//      rep's own escalation): it answered "unclear" with no ticket id and no contact window.
//   3. offer_escalation_to_support treated item references that matched NOTHING as "no item given" and searched the
//      whole order, so a made-up item could surface another item's decided case.
//
// Real workflow runs against a throwaway database and a starting-policy copy in its own temp folder; no model is called.
// Run with: npx tsx --test --test-force-exit tests/mastra/tools/case-tools.test.ts (from apps/agent)

import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RequestContext } from "@mastra/core/request-context";

const dir = mkdtempSync(join(tmpdir(), "wismo-casetools-"));
process.env.AGENT_DB_URL = `file:${join(dir, "test.db")}`;
process.env.WISMO_POLICY_DIR = join(dir, "policy"); // its own policy folder: the tests must not depend on the live one an operator can edit

const { mastra } = await import("../../../src/mastra/index");
const { ensureSeeded } = await import("../../../src/mastra/policy/repository");
const { buildBaseDraft } = await import("../../../src/mastra/policy/base-draft");
await ensureSeeded("demo", buildBaseDraft());
const { app } = await import("../../../src/server");
const { SESSION_CUSTOMER_ID_KEY } = await import("../../../src/mastra/request-context");
const { shippingGenerateReturnLabel } = await import("../../../src/mastra/tools/shipping");
const { lookupCaseById } = await import("../../../src/mastra/tools/case-lookup-tool");
const { offerEscalationToSupport } = await import("../../../src/mastra/tools/offer-escalation");
const { getSupportTicketContactHours } = await import("../../../src/mastra/runtime-settings");

// order_4203 (cust_demo_01): pants-002, socks-004 ($19.99), belt-001 — delivered 8 days ago.
const ORDER = "order_4203";
const SOCKS = "socks-004";
const BELT = "belt-001";

function toolContext() {
  const requestContext = new RequestContext();
  requestContext.setRaw(SESSION_CUSTOMER_ID_KEY, "cust_demo_01");
  return { requestContext, mastra } as any;
}

function runInput(overrides: Record<string, unknown>) {
  return {
    orderId: ORDER,
    refundAmount: 19.99,
    problemSummary: "test",
    threadId: "t",
    sessionId: "case-tools-test-session",
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

describe("the return-label, case-lookup and escalation-offer tools", () => {
  after(() => rmSync(dir, { recursive: true, force: true }));

  const SOCKS_CASE = "SOCKS1";
  const SUPPORT_CASE = "SUPPRT";

  test("setup: an in-policy return of the socks is approved on the spot (the shipped policy decides)", async () => {
    const started = await startCase(SOCKS_CASE, { caseType: "plain_return", itemIds: [SOCKS] });
    assert.equal(started.status, "success", "the shipped demo policy should approve this return itself — has it been edited?");
    assert.equal(started.steps["human-policy-review"].output.action, "executed");
  });

  describe("shipping_generate_return_label", () => {
    test("a label for the item that has an approved refund is made", async () => {
      const label: any = await shippingGenerateReturnLabel.execute!({ orderId: ORDER, itemIds: [SOCKS] }, toolContext());
      assert.equal(label.returnTrackingNumber, "RTN-004203_socks-004");
    });

    test("a selection with one approved item and one that was never approved is refused — not silently widened", async () => {
      await assert.rejects(() => shippingGenerateReturnLabel.execute!({ orderId: ORDER, itemIds: [SOCKS, BELT] }, toolContext()), /belt|No refund on record/i);
    });

    test("no itemIds means the WHOLE order, so it is refused while only one item has an approved refund", async () => {
      await assert.rejects(() => shippingGenerateReturnLabel.execute!({ orderId: ORDER }, toolContext()), /No refund on record/i);
    });

    test("the refusal names the item that is missing, so the model can correct itself", async () => {
      await assert.rejects(() => shippingGenerateReturnLabel.execute!({ orderId: ORDER, itemIds: [SOCKS, BELT] }, toolContext()), (error: Error) => {
        assert.match(error.message, /belt/i);
        return true;
      });
    });
  });

  describe("offer_escalation_to_support", () => {
    const message = "I can escalate this to our support team, if you'd like.";

    test("control: an item that has a decided case is offered, and the card carries that case", async () => {
      const offer: any = await offerEscalationToSupport.execute!({ orderId: ORDER, itemIds: [SOCKS], message }, toolContext());
      assert.equal(offer.caseId, SOCKS_CASE);
    });

    test("control: an item with no decided case of its own is not offered someone else's", async () => {
      await assert.rejects(() => offerEscalationToSupport.execute!({ orderId: ORDER, itemIds: [BELT], message }, toolContext()), /no decided case/i);
    });

    test("item references that match NOTHING on the order are refused — never treated as 'the whole order'", async () => {
      await assert.rejects(() => offerEscalationToSupport.execute!({ orderId: ORDER, itemIds: ["no-such-item"], message }, toolContext()), /no such item|none of those|which item/i);
    });

    test("no itemIds at all still means the whole order (unchanged)", async () => {
      const offer: any = await offerEscalationToSupport.execute!({ orderId: ORDER, message }, toolContext());
      assert.equal(offer.caseId, SOCKS_CASE);
    });
  });

  describe("lookup_case_by_id", () => {
    test("setup: a case that a rep escalated to support ends with a ticket", async () => {
      const started = await startCase(SUPPORT_CASE, { orderId: "order_3401", refundAmount: 70, caseType: "delivery_dispute" });
      assert.equal(started.status, "suspended");
      const response = await app.request(`/escalations/${SUPPORT_CASE}/resume`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "escalate_to_support" }),
      });
      assert.equal(response.status, 200, await response.clone().text());
    });

    test("the ticket and its contact window come back with the case — not a bare 'unclear'", async () => {
      const result: any = await lookupCaseById.execute!({ caseId: SUPPORT_CASE }, toolContext());
      assert.equal(result.found, true);
      assert.equal(result.status, "unclear");
      assert.match(result.ticketId ?? "", /^TKT-/);
      assert.equal(result.contactWindowHours, getSupportTicketContactHours());
    });

    test("control: a case that is still with a specialist is 'pending'", async () => {
      const started = await startCase("OPENCS", { orderId: "order_1181", refundAmount: 165, caseType: "delivery_dispute" });
      assert.equal(started.status, "suspended");
      const result: any = await lookupCaseById.execute!({ caseId: "OPENCS" }, toolContext());
      assert.equal(result.status, "pending");
      assert.equal(result.awaitingCustomerReply, false);
    });
  });
});
