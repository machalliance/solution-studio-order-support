// A case's history is a RECORD: whatever the rep saw when they decided is what History must show afterwards.
// Two faults let a live chat case lose its customer photo (found 2026-10-09, case "hole in the rain jacket"; a SEEDED case
// kept hers because a seeded photo is part of the data the case is created with):
//   1. A new case's first transcript is built from the model-side message history, where a photo is
//      {type:"file", mediaType, data:"data:image/…"} — buildTranscript only knew the browser's {url} shape, so a photo
//      message (no text) was dropped.
//   2. While a case is open the end-of-turn sync keeps its LIVE transcript current (photo, replies, the agent's last
//      message) — but a resolved case reads the transcript frozen at CREATION, and the live one was discarded the moment a
//      rep decided. Every way a case ends (approve, reject, escalate to support, a timeout) lost everything said since.
// Real workflow runs against a throwaway database; no model is called.
// Run with: npx tsx --test --test-force-exit tests/mastra/transcript-history.test.ts (from apps/agent)

import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "wismo-history-"));
process.env.AGENT_DB_URL = `file:${join(dir, "test.db")}`;
process.env.WISMO_DEMO_CUSTOMER_NAME = "Test Customer";
process.env.WISMO_DEMO_CUSTOMER_EMAIL = "test.customer@example.com";
process.env.WISMO_REP_NAME = "Test Rep";

const { buildTranscript } = await import("../../src/mastra/tools/chat-transcript");
const { mastra } = await import("../../src/mastra/index");
const { app } = await import("../../src/server");
const { syncCaseTranscriptForOrder } = await import("../../src/mastra/tools/case-sync");

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";
const RAW_BASE64 = PNG.split(",")[1];

describe("buildTranscript keeps a customer's photo from either message shape", () => {
  const withPhoto = (photoPart: object) => [
    { role: "user", content: [{ type: "text", text: "my jacket has a hole" }] },
    { role: "assistant", content: [{ type: "text", text: "could you send a photo?" }] },
    { role: "user", content: [photoPart] },
  ];

  test("the model-side shape: {type:'file', mediaType, data:'data:image/…'} — a photo with no caption is kept, not dropped", () => {
    const transcript = buildTranscript(withPhoto({ type: "file", mediaType: "image/png", data: PNG }));
    assert.equal(transcript.length, 3);
    assert.equal(transcript[2].role, "customer");
    assert.equal(transcript[2].imageDataUrl, PNG);
  });

  test("the same, when the data is a bare base64 string or raw bytes", () => {
    assert.equal(buildTranscript(withPhoto({ type: "file", mediaType: "image/png", data: RAW_BASE64 }))[2].imageDataUrl, PNG);
    assert.equal(buildTranscript(withPhoto({ type: "file", mediaType: "image/png", data: Buffer.from(RAW_BASE64, "base64") }))[2].imageDataUrl, PNG);
  });

  test("the browser's shape {type:'file', url} still works", () => {
    assert.equal(buildTranscript(withPhoto({ type: "file", mediaType: "image/png", url: PNG }))[2].imageDataUrl, PNG);
  });

  test("a file that is not an image is not shown as one", () => {
    const transcript = buildTranscript(withPhoto({ type: "file", mediaType: "application/pdf", data: "data:application/pdf;base64,AAAA" }));
    assert.equal(transcript.length, 2, "…and a message with nothing to show is still dropped");
  });
});

const SESSION = "history-test-session";

async function openCase(runId: string, orderId: string) {
  const run = await mastra.getWorkflow("policyReviewWorkflow")!.createRun({ runId });
  const started: any = await run.start({
    inputData: {
      orderId, refundAmount: 20, caseType: "delivery_dispute", problemSummary: "test", threadId: `t_${runId}`, sessionId: SESSION,
      createdAt: new Date().toISOString(), transcript: [{ role: "customer", text: "My jacket has a hole in it.", timestamp: new Date().toISOString() }],
      relatedOpenCaseRefundAmount: 0,
    } as any,
  });
  assert.equal(started.status, "suspended");
}

// What the end-of-turn sync is handed after the customer has sent a photo and the agent has replied (browser shape).
const CONVERSATION_AFTER_OPENING = [
  { id: "u1", role: "user", parts: [{ type: "text", text: "My jacket has a hole in it." }] },
  { id: "a1", role: "assistant", parts: [{ type: "tool-respondToCustomer", output: { message: "Could you send a photo of the hole?" } }] },
  { id: "u2", role: "user", parts: [{ type: "file", mediaType: "image/png", url: PNG }] },
  { id: "a2", role: "assistant", parts: [{ type: "text", text: "Thank you — a specialist will review the photo." }] },
];

const caseJson = async (runId: string): Promise<any> => (await app.request(`/escalations/${runId}`)).json();
const decide = (runId: string, decision: object) =>
  app.request(`/escalations/${runId}/resume`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(decision) });

describe("a case's history is what the rep saw when they decided — however it ended", () => {
  after(() => rmSync(dir, { recursive: true, force: true }));

  const endings: Array<[string, string, string, object]> = [
    ["a rep approves it", "HISTAP", "order_3401", { decision: "approve" }],
    ["a rep rejects it", "HISTRJ", "order_1181", { decision: "reject", reason: "Not covered." }],
    ["a rep escalates it to support", "HISTES", "order_2001", { decision: "escalate_to_support" }],
  ];

  for (const [label, runId, orderId, decision] of endings) {
    test(`${label}: the photo and everything said since the case opened are still there`, async () => {
      await openCase(runId, orderId);

      // While the case is open the sync keeps the live transcript current — this half has always worked.
      const synced = await syncCaseTranscriptForOrder(mastra, "cust_demo_01", orderId, CONVERSATION_AFTER_OPENING, SESSION);
      assert.equal(synced.status, "updated");
      const open = await caseJson(runId);
      assert.equal(open.transcript.length, 4, "the open case shows the full live conversation");
      assert.equal(open.transcript.filter((m: any) => m.imageDataUrl).length, 1, "…including the photo");

      assert.equal((await decide(runId, decision)).status, 200);

      const resolved = await caseJson(runId);
      assert.equal(resolved.transcript.length, 4, "History shows the same conversation the rep decided on");
      assert.equal(resolved.transcript[2].imageDataUrl, PNG, "…with the customer's photo");
      assert.match(resolved.transcript[3].text, /specialist will review the photo/, "…and the agent's last message");
    });
  }

  // The ending a customer is most likely to hit ("it went to tech support"): nobody decides, the response window runs out, the sweep opens a ticket.
  test("the response window runs out and the case goes to support: same record", async () => {
    const runId = "HISTTO";
    const run = await mastra.getWorkflow("policyReviewWorkflow")!.createRun({ runId });
    const longAgo = new Date(Date.now() - 60 * 60_000).toISOString(); // well past any response window
    const started: any = await run.start({
      inputData: {
        orderId: "order_4203", refundAmount: 20, caseType: "delivery_dispute", problemSummary: "test", threadId: `t_${runId}`, sessionId: SESSION,
        createdAt: longAgo, transcript: [{ role: "customer", text: "My jacket has a hole in it.", timestamp: longAgo }], relatedOpenCaseRefundAmount: 0,
      } as any,
    });
    assert.equal(started.status, "suspended");
    assert.equal((await syncCaseTranscriptForOrder(mastra, "cust_demo_01", "order_4203", CONVERSATION_AFTER_OPENING, SESSION)).status, "updated");

    // The response deadline is fixed when the case suspends (now + the window), so put it in the past directly.
    const store: any = await mastra.getStorage()!.getStore("workflows");
    const snapshot: any = await store.loadWorkflowSnapshot({ workflowName: "policy-review-workflow", runId });
    snapshot.context["human-policy-review"].suspendPayload.reviewDeadlineIso = new Date(Date.now() - 60_000).toISOString();
    await store.persistWorkflowSnapshot({ workflowName: "policy-review-workflow", runId, snapshot });

    const sweep: any = await (await app.request("/escalations/check-timeouts", { method: "POST" })).json();
    assert.ok(JSON.stringify(sweep).includes(runId), `the sweep should have picked up ${runId}: ${JSON.stringify(sweep).slice(0, 200)}`);

    const resolved = await caseJson(runId);
    assert.equal(resolved.outcome, "escalated_to_support");
    assert.equal(resolved.transcript.length, 4);
    assert.equal(resolved.transcript[2].imageDataUrl, PNG);
  });

  test("History's list view still carries no transcript (a photo is large)", async () => {
    const list: any = await (await app.request("/escalations/history")).json();
    assert.ok(list.runs.length >= 3);
    for (const entry of list.runs) assert.equal(entry.transcript, undefined, `entry ${entry.runId}`);
  });
});
