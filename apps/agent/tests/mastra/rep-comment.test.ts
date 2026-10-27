// A rep's "Message to the customer" on an approve / modify must reach the customer — in the live chat push AND the
// email. It used to be accepted by the Desk form and the workflow and then read by nothing (found 2026-10-08, from a
// MODIFIED refund that showed the customer a smaller number with no explanation).
//
// Drives the real /escalations/:runId/resume route against a throwaway database and the shipped demo policy.
// Run with: npx tsx --test --test-force-exit src/mastra/rep-comment.test.ts

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "wismo-repcomment-"));
process.env.AGENT_DB_URL = `file:${join(dir, "test.db")}`;

const { mastra } = await import("../../src/mastra/index");
const { app } = await import("../../src/server");
const { caseEvents } = await import("../../src/mastra/case-events");
const { REP_COMMENT_MAX, repComment } = await import("../../src/mastra/workflows/policy-review-workflow");

const SESSION = "rep-comment-test-session";

async function openCase(runId: string, orderId: string, amount: number) {
  const run = await mastra.getWorkflow("policyReviewWorkflow")!.createRun({ runId });
  const started: any = await run.start({
    inputData: { orderId, refundAmount: amount, caseType: "delivery_dispute", problemSummary: "test", threadId: `t_${runId}`, sessionId: SESSION, createdAt: new Date().toISOString(), transcript: [], relatedOpenCaseRefundAmount: 0 } as any,
  });
  assert.equal(started.status, "suspended");
}

// Resume through the real HTTP route, capturing the live-push event and the email the server logged.
async function decide(runId: string, decision: object) {
  const events: any[] = [];
  const listener = (event: any) => { if (event.runId === runId) events.push(event); };
  caseEvents.on("resolved", listener);
  const emails: string[] = [];
  const realLog = console.log;
  console.log = (...args: unknown[]) => { const line = args.join(" "); if (line.includes("[notify]") && line.includes("body:")) emails.push(line); realLog(...args); };
  try {
    const response = await app.request(`/escalations/${runId}/resume`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(decision) });
    assert.equal(response.status, 200, await response.clone().text());
  } finally {
    console.log = realLog;
    caseEvents.off("resolved", listener);
  }
  assert.equal(events.length, 1, "exactly one resolved push");
  return { event: events[0], email: emails.join("\n") };
}

describe("a rep's message to the customer", () => {
  after(() => rmSync(dir, { recursive: true, force: true }));

  test("a MODIFIED refund carries the rep's message to the chat push and the email", async () => {
    await openCase("MODCMT", "order_2001", 19.99);
    const { event, email } = await decide("MODCMT", { decision: "modify", modifiedAmount: 10, comment: "  We approved part of this: the zipper was fine, the strap was not.  " });
    assert.equal(event.refundAmount, 10);
    assert.equal(event.comment, "We approved part of this: the zipper was fine, the strap was not.", "trimmed");
    assert.match(email, /\$10\.00 refund has been approved/);
    assert.match(email, /The specialist added: “We approved part of this: the zipper was fine, the strap was not\.”/);
  });

  test("it is part of the resolved case record — on the case itself and in History", async () => {
    // MODCMT was resolved by the first test, with a message.
    const one: any = await (await app.request("/escalations/MODCMT")).json();
    assert.equal(one.repComment, "We approved part of this: the zipper was fine, the strap was not.");
    const history: any = await (await app.request("/escalations/history")).json();
    const entry = history.runs.find((r: any) => r.runId === "MODCMT");
    assert.equal(entry?.repComment, one.repComment);
  });

  test("an APPROVE carries it too", async () => {
    await openCase("APPCMT", "order_3401", 70);
    const { event, email } = await decide("APPCMT", { decision: "approve", comment: "Sorry for the trouble." });
    assert.equal(event.comment, "Sorry for the trouble.");
    assert.match(email, /The specialist added: “Sorry for the trouble\.”/);
  });

  test("with no message — or a blank one — nothing is invented", async () => {
    await openCase("NOCMT1", "order_1181", 165);
    const none = await decide("NOCMT1", { decision: "approve" });
    assert.equal(none.event.comment, undefined);
    assert.doesNotMatch(none.email, /specialist added/);

    await openCase("NOCMT2", "order_4472", 85);
    const blank = await decide("NOCMT2", { decision: "modify", modifiedAmount: 50, comment: "   \n  " });
    assert.equal(blank.event.comment, undefined);
    assert.doesNotMatch(blank.email, /specialist added/);
  });

  test("a very long message is capped", async () => {
    await openCase("LONGCM", "order_5561", 245);
    const { event } = await decide("LONGCM", { decision: "approve", comment: "x".repeat(5000) });
    assert.equal(event.comment.length, REP_COMMENT_MAX);
  });

  test("repComment trims, caps and treats blank as absent", () => {
    assert.equal(repComment(undefined), undefined);
    assert.equal(repComment("   "), undefined);
    assert.equal(repComment("  hi  "), "hi");
    assert.equal(repComment("y".repeat(REP_COMMENT_MAX + 50))?.length, REP_COMMENT_MAX);
  });
});
