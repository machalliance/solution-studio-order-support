// A customer who disagrees with a decision the agent made ON ITS OWN must always be able to reach a person, whatever the
// policy says. The route there (offer_escalation_to_support -> POST /chat/:agentId/escalate-disagreement) never reads
// policy.json: it only needs a decided case. This runs it after each kind of automatic outcome, including a policy with
// every automatic decision switched off.
//
// Real tools, gate, workflow and route against a throwaway database, policy folder and tickets file; no model is called.
// Run with: npx tsx --test --test-force-exit tests/mastra/disagreement-after-automatic-decision.test.ts (from apps/agent)

import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RequestContext } from "@mastra/core/request-context";
import { editedPolicy } from "./helpers/edited-policy";

const dir = mkdtempSync(join(tmpdir(), "wismo-disagree-"));
process.env.AGENT_DB_URL = `file:${join(dir, "test.db")}`;
process.env.WISMO_POLICY_DIR = join(dir, "policy");
process.env.WISMO_TICKETS_FILE = join(dir, "disagreement-tickets.json");

const { mastra } = await import("../../src/mastra/index");
const { app } = await import("../../src/server");
const { SESSION_CUSTOMER_ID_KEY, SESSION_ID_KEY } = await import("../../src/mastra/request-context");
const { activatePolicy } = await import("../../src/mastra/policy/repository");
const { escalateForDeliveryDispute } = await import("../../src/mastra/tools/delivery-dispute");
const { refundPolicyGate } = await import("../../src/mastra/refund-policy-gate");
const { offerEscalationToSupport } = await import("../../src/mastra/tools/offer-escalation");
const { getDisagreementTicket } = await import("../../src/mastra/disagreement-tickets");

function toolContext() {
  const requestContext = new RequestContext();
  requestContext.setRaw(SESSION_CUSTOMER_ID_KEY, "cust_demo_01");
  requestContext.setRaw(SESSION_ID_KEY, "disagree-test-session");
  return { requestContext, mastra } as any;
}

// What the card does when the customer clicks "Escalate to support".
async function clickEscalate(caseId: string, message: string) {
  const response = await app.request("/chat/wismoAgent/escalate-disagreement", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ conversationId: "some-other-conversation", caseId, message }),
  });
  return { status: response.status, body: (await response.json()) as any };
}

// The agent offers the card for a decided matter, then the customer confirms it. Returns the decided case's ID.
async function disagreeAbout(orderId: string, message: string) {
  const offer: any = await offerEscalationToSupport.execute!({ orderId, message: "I understand — I can escalate this to our support team." } as any, toolContext());
  assert.ok(offer.caseId, `the card could not be offered for ${orderId}: ${JSON.stringify(offer)}`);
  const first = await clickEscalate(offer.caseId, message);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.match(first.body.ticketId, /^TKT-/);
  assert.equal((await getDisagreementTicket(offer.caseId))?.ticketId, first.body.ticketId, "the ticket is recorded against the original case");
  const again = await clickEscalate(offer.caseId, message);
  assert.equal(again.body.ticketId, first.body.ticketId, "clicking twice never opens a second ticket");
  return offer.caseId as string;
}

describe("disagreeing with something the agent decided by itself always reaches a person", () => {
  after(() => rmSync(dir, { recursive: true, force: true }));

  test("setup: a policy that decides disputes and damage claims automatically", async () => {
    assert.equal((await activatePolicy("demo", editedPolicy())).ok, true);
  });

  test("an automatic DECLINE of a delivery dispute", async () => {
    const result: any = await escalateForDeliveryDispute.execute!({ orderId: "order_4203", problemSummary: "never arrived" } as any, toolContext());
    assert.equal(result.status, "denied", JSON.stringify(result));
    await disagreeAbout("order_4203", "I really did not get it and I want a person to look.");
    await assert.rejects(
      offerEscalationToSupport.execute!({ orderId: "order_4203", message: "x" } as any, toolContext()),
      /already open/i,
      "once a ticket exists the customer is told so instead of being offered a second one"
    );
  });

  test("an automatic DENIAL of a damage claim (the shipped rule for a customer's own fault)", async () => {
    const out: any = await refundPolicyGate({
      toolName: "paymentIssueRefund",
      input: { orderId: "order_1181", problemSummary: "I dropped it", notCustomerFault: false },
      context: { ...toolContext(), messages: [] },
    } as any);
    assert.equal(out.output.status, "denied", JSON.stringify(out));
    await disagreeAbout("order_1181", "It was already faulty before I dropped it.");
  });

  test("an automatic APPROVAL the customer is unhappy with, even after the operator switches every automatic decision off", async () => {
    const result: any = await escalateForDeliveryDispute.execute!({ orderId: "order_2001", problemSummary: "never arrived" } as any, toolContext());
    assert.equal(result.status, "approved", JSON.stringify(result));
    const off = editedPolicy();
    off.settings.autonomousRefundsEnabled.value = false;
    off.settings.autonomousPlainReturnsEnabled.value = false;
    assert.equal((await activatePolicy("demo", off)).ok, true);
    await disagreeAbout("order_2001", "I wanted the item re-sent, not a refund.");
  });

  test("a dispute a REP decided (not only an automatic one) can be disagreed with from a later conversation", async () => {
    const opened: any = await escalateForDeliveryDispute.execute!({ orderId: "order_3401", problemSummary: "never arrived" } as any, toolContext());
    assert.equal(opened.status, "escalated", "no rule decides a $70 dispute, so it goes to a person");
    const rejected = await app.request(`/escalations/${opened.runId}/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "reject", reason: "The carrier shows it delivered and signed for." }),
    });
    assert.equal(rejected.status, 200, await rejected.clone().text());
    assert.equal(await disagreeAbout("order_3401", "That is not right."), opened.runId);
  });

  test("a customer asking about ONE ITEM is not handed the order's dispute, but a whole-order matter is", async () => {
    assert.equal((await activatePolicy("demo", editedPolicy())).ok, true, "back to the policy that decides disputes automatically");
    const result: any = await escalateForDeliveryDispute.execute!({ orderId: "order_4472", problemSummary: "never arrived" } as any, toolContext());
    assert.equal(result.status, "denied", "$230 is over the automatic-decline line");
    await assert.rejects(
      offerEscalationToSupport.execute!({ orderId: "order_4472", itemIds: ["top-001"], message: "x" } as any, toolContext()),
      /no decided case/i,
      "an item-level question never surfaces a whole-order dispute"
    );
    await disagreeAbout("order_4472", "I did not receive anything.");
  });
});
