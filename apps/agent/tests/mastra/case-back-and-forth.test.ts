// A rep's question and the customer's reply must not take the case out of the Escalation Desk's "Side by side" box.
// That box shows the case summary ("Customer Info", problemSummary) beside the case's own policy or carrier finding
// ("System Info", explanation). Two faults emptied it once a message had gone back and forth:
//   1. When the customer replied, the end-of-turn sync replaced the explanation with a generic note about the reply, so the
//      finding the rep is deciding against was gone (and stayed gone: the next question carried the note forward).
//   2. A second question was appended to the ORIGINAL summary, because the workflow rebuilds the case from its frozen input,
//      so the first question dropped out and the summary held only the last one.
// Real workflow runs and the real resume route against a throwaway database; no model is called.
// Run with: npx tsx --test --test-force-exit tests/mastra/case-back-and-forth.test.ts (from apps/agent)

import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "wismo-back-and-forth-"));
process.env.AGENT_DB_URL = `file:${join(dir, "test.db")}`;
process.env.WISMO_TICKETS_FILE = join(dir, "tickets.json");
process.env.WISMO_DEMO_CUSTOMER_NAME = "Test Customer";
process.env.WISMO_DEMO_CUSTOMER_EMAIL = "test.customer@example.com";
process.env.WISMO_REP_NAME = "Test Rep";

const { mastra } = await import("../../src/mastra/index");
const { app } = await import("../../src/server");
const { syncCaseTranscriptForOrder } = await import("../../src/mastra/tools/case-sync");
const { markSessionConnected, markSessionDisconnected } = await import("../../src/mastra/active-sessions");
const { caseEvents } = await import("../../src/mastra/case-events");
const { caseResolvedMessage } = await import("../../../../shared/case-notices");

const SESSION = "back-and-forth-session";
const ORDER = "order_3401";
const RUN = "BCKFRT";
const SUMMARY = "Customer says they never received order #3401 (Camp Slip-On Shoe). Carrier record shows it delivered and signed for in the customer's own name.";
const FIRST_QUESTION = "Could anyone else at the address have signed for it?";
const SECOND_QUESTION = "Is there a side gate or a neighbour who takes parcels?";

const caseJson = async (): Promise<any> => (await app.request(`/escalations/${RUN}`)).json();
const ask = (question: string) =>
  app.request(`/escalations/${RUN}/resume`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision: "request_more_info", question }) });
const say = (role: "user" | "assistant", text: string, i: number) => ({ id: `m${i}`, role, parts: [{ type: "text", text }] });
const sync = async (conversation: object[]) => (await syncCaseTranscriptForOrder(mastra, "cust_demo_01", ORDER, conversation as any, SESSION)).status;

describe("a case keeps its summary and its own finding through questions and replies", () => {
  after(() => rmSync(dir, { recursive: true, force: true }));

  test("the finding survives a question and the customer's reply, and the status still changes", async () => {
    markSessionConnected(SESSION); // a rep's question only re-suspends the case when the customer's chat tab is there to receive it
    const run = await mastra.getWorkflow("policyReviewWorkflow")!.createRun({ runId: RUN });
    const started: any = await run.start({
      inputData: {
        orderId: ORDER, refundAmount: 70, caseType: "delivery_dispute", problemSummary: SUMMARY, threadId: "t_back_and_forth", sessionId: SESSION,
        createdAt: new Date().toISOString(), transcript: [{ role: "customer", text: "I never got my order 3401", timestamp: new Date().toISOString() }],
        relatedOpenCaseRefundAmount: 0,
      } as any,
    });
    assert.equal(started.status, "suspended");
    const opened = await caseJson();
    assert.ok(opened.explanation.length > 20, "the case opens with a real policy or carrier finding");
    assert.equal(opened.problemSummary, SUMMARY);

    assert.equal((await ask(FIRST_QUESTION)).status, 200);
    const asked = await caseJson();
    assert.equal(asked.reasonCode, "awaiting-customer-response");
    assert.equal(asked.explanation, opened.explanation, "the question does not replace the finding");
    assert.equal(asked.problemSummary, `${SUMMARY} — rep asked: "${FIRST_QUESTION}"`);

    const firstReply = [say("user", "I never got my order 3401", 1), say("assistant", "A specialist asked: could anyone else have signed?", 2), say("user", "No, I live alone and nobody was home.", 3), say("assistant", "Thanks, I have passed that on.", 4)];
    assert.equal(await sync(firstReply), "updated");
    const replied = await caseJson();
    assert.equal(replied.reasonCode, "customer-responded", "the case is marked as answered");
    assert.equal(replied.title, "Customer replied — ready for review");
    assert.equal(replied.explanation, opened.explanation, "the customer's reply does not replace the finding with a note about the reply");
    assert.equal(replied.problemSummary, asked.problemSummary, "…and the summary is unchanged");
  });

  test("every question stays in the summary, in order, and the finding is still there after the second round", async () => {
    const before = await caseJson();
    assert.equal(before.reasonCode, "customer-responded", "this continues the case from the previous test");

    assert.equal((await ask(SECOND_QUESTION)).status, 200);
    const secondAsk = await caseJson();
    assert.equal(secondAsk.explanation, before.explanation, "the finding is still the case's own after a second question");
    assert.ok(secondAsk.problemSummary.startsWith(SUMMARY), "the original summary is still first");
    const firstAt = secondAsk.problemSummary.indexOf(FIRST_QUESTION);
    const secondAt = secondAsk.problemSummary.indexOf(SECOND_QUESTION);
    assert.ok(firstAt > 0 && secondAt > firstAt, `both questions are in the summary, in the order they were asked: ${secondAsk.problemSummary}`);
    assert.equal(secondAsk.problemSummary.split("rep asked:").length - 1, 2, "…each exactly once");

    const secondReply = [
      say("user", "I never got my order 3401", 1), say("assistant", "A specialist asked: could anyone else have signed?", 2), say("user", "No, I live alone and nobody was home.", 3), say("assistant", "Thanks, I have passed that on.", 4),
      say("assistant", "A specialist asked: is there a side gate or a neighbour?", 5), say("user", "No gate, and I don't know my neighbours.", 6), say("assistant", "Thanks.", 7),
    ];
    assert.equal(await sync(secondReply), "updated");
    const after = await caseJson();
    assert.equal(after.reasonCode, "customer-responded");
    assert.equal(after.explanation, before.explanation, "the finding survives the second reply too");
    assert.equal(after.problemSummary, secondAsk.problemSummary);
  });
});

// The customer's chat tab is NOT connected (every seeded case, or a customer who closed the tab), so a rep's question has nobody to
// reach. By design the case then ends in a support ticket instead of waiting for nobody. It used to be recorded exactly like an
// SLA timeout: "No rep responded in time", labelled as the system's doing, with no trace that the rep asked anything.
describe("a question the customer cannot be asked is still on the record", () => {
  const UNREACHABLE_RUN = "UNRCHD";
  const QUESTION = "Could you send a photo of the zipper?";

  test("the case, History, the saved conversation and the customer's notice all say a rep asked", async () => {
    const events: any[] = [];
    const onResolved = (event: any) => events.push(event);
    caseEvents.on("resolved", onResolved);
    try {
      // No markSessionConnected for this session: nobody is listening.
      const run = await mastra.getWorkflow("policyReviewWorkflow")!.createRun({ runId: UNREACHABLE_RUN });
      const started: any = await run.start({
        inputData: {
          orderId: "order_2001", refundAmount: 20, caseType: "delivery_dispute", problemSummary: "Zipper pull broke.", threadId: "t_unreachable", sessionId: "nobody-is-listening",
          createdAt: new Date().toISOString(), transcript: [{ role: "customer", text: "The zipper pull broke.", timestamp: new Date().toISOString() }], relatedOpenCaseRefundAmount: 0,
        } as any,
      });
      assert.equal(started.status, "suspended");

      const response = await app.request(`/escalations/${UNREACHABLE_RUN}/resume`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision: "request_more_info", question: QUESTION }) });
      assert.equal(response.status, 200);

      const record: any = await (await app.request(`/escalations/${UNREACHABLE_RUN}`)).json();
      assert.equal(record.outcome, "escalated_to_support", "the case still ends in a support ticket (nobody was there to answer)");
      assert.ok(record.ticketId, "…with a ticket");
      assert.equal(record.resolvedBy, "rep", "a rep acted, so it is not recorded as the system's timeout");
      assert.equal(record.repQuestion, QUESTION, "the rep's question is on the record");
      const last = record.transcript[record.transcript.length - 1];
      assert.equal(last.role, "agent");
      assert.ok(last.text.includes(QUESTION), "the question is in the saved conversation, after the customer's message");
      assert.equal(record.transcript[0].text, "The zipper pull broke.", "…and nothing said earlier was lost");

      const history: any = await (await app.request("/escalations/history")).json();
      const entry = (Array.isArray(history) ? history : history.runs ?? history.history ?? []).find((e: any) => e.runId === UNREACHABLE_RUN);
      assert.equal(entry?.resolvedBy, "rep", "History agrees");
      assert.equal(entry?.repQuestion, QUESTION);

      const event = events.find((e) => e.runId === UNREACHABLE_RUN);
      assert.ok(event, "the customer is told");
      assert.equal(event.question, QUESTION);
      assert.equal(event.resolvedBy, "rep");
      const notice = caseResolvedMessage(event, (amount: number, currency: string) => `${currency} ${amount}`);
      assert.ok(notice.includes(QUESTION), "the notice quotes the question");
      assert.ok(!/longer than usual/.test(notice), "…and is not the timeout apology");
    } finally {
      caseEvents.off("resolved", onResolved);
    }
  });
});

// The Desk warns a rep BEFORE they send a question nobody can receive, so it needs to know whether the customer's chat tab is there.
describe("an open case says whether the customer is connected right now", () => {
  test("false with no chat tab, true while one is connected, false again once it leaves", async () => {
    const SESSION_ID = "connection-flag-session";
    const run = await mastra.getWorkflow("policyReviewWorkflow")!.createRun({ runId: "CONFLG" });
    const started: any = await run.start({
      inputData: {
        orderId: "order_4203", refundAmount: 20, caseType: "delivery_dispute", problemSummary: "Test.", threadId: "t_flag", sessionId: SESSION_ID,
        createdAt: new Date().toISOString(), transcript: [{ role: "customer", text: "Test.", timestamp: new Date().toISOString() }], relatedOpenCaseRefundAmount: 0,
      } as any,
    });
    assert.equal(started.status, "suspended");
    const connected = async () => ((await (await app.request("/escalations/CONFLG")).json()) as any).customerConnected;
    assert.equal(await connected(), false, "nobody has connected yet");
    markSessionConnected(SESSION_ID);
    assert.equal(await connected(), true, "the chat tab is connected");
    markSessionDisconnected(SESSION_ID);
    assert.equal(await connected(), false, "…and not any more once it leaves");
  });
});

// The response window also applies while a case waits on the customer's answer, even when the customer is connected. It starts when the
// rep's question is SENT: the re-suspended case used to carry no deadline of its own, so the sweep fell back to the case's creation time.
describe("a case waiting on the customer times out on the same window", () => {
  const WAIT_SESSION = "waiting-session";
  const WAIT_QUESTION = "Could you send a photo of the damage?";

  async function openOldCaseAndAsk(runId: string, orderId: string) {
    markSessionConnected(WAIT_SESSION); // the customer IS connected: the question is delivered and the case waits for the answer
    const longAgo = new Date(Date.now() - 60 * 60_000).toISOString(); // far older than any response window
    const run = await mastra.getWorkflow("policyReviewWorkflow")!.createRun({ runId });
    const started: any = await run.start({
      inputData: {
        orderId, refundAmount: 20, caseType: "delivery_dispute", problemSummary: "Test.", threadId: `t_${runId}`, sessionId: WAIT_SESSION,
        createdAt: longAgo, transcript: [{ role: "customer", text: "Test.", timestamp: longAgo }], relatedOpenCaseRefundAmount: 0,
      } as any,
    });
    assert.equal(started.status, "suspended");
    const response = await app.request(`/escalations/${runId}/resume`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision: "request_more_info", question: WAIT_QUESTION }) });
    assert.equal(response.status, 200);
    const waiting: any = await (await app.request(`/escalations/${runId}`)).json();
    assert.equal(waiting.reasonCode, "awaiting-customer-response", "the connected customer was asked and the case waits for them");
    return waiting;
  }
  const sweep = async (): Promise<any> => (await app.request("/escalations/check-timeouts", { method: "POST" })).json();
  const setLiveDeadline = async (runId: string, iso: string) => {
    const store: any = await mastra.getStorage()!.getStore("workflows");
    const snapshot: any = await store.loadWorkflowSnapshot({ workflowName: "policy-review-workflow", runId });
    snapshot.context["human-policy-review"].suspendPayload.reviewDeadlineIso = iso;
    await store.persistWorkflowSnapshot({ workflowName: "policy-review-workflow", runId, snapshot });
  };

  test("the window starts when the question is sent: an old case is not ticketed the moment it is asked", async () => {
    const waiting = await openOldCaseAndAsk("WAITNW", "order_1181");
    assert.ok(new Date(waiting.reviewDeadlineIso).getTime() > Date.now(), "the waiting case has its own deadline, in the future");
    const swept = await sweep();
    assert.ok(!swept.runs.some((r: any) => r.runId === "WAITNW"), "…so the sweep leaves it open");
    assert.equal(((await (await app.request("/escalations/WAITNW")).json()) as any).reasonCode, "awaiting-customer-response");
  });

  test("when the customer does not answer within the window, a support ticket opens and they are told why", async () => {
    await openOldCaseAndAsk("WAITTO", "order_4472");
    await setLiveDeadline("WAITTO", new Date(Date.now() - 60_000).toISOString());
    const events: any[] = [];
    const onResolved = (event: any) => events.push(event);
    caseEvents.on("resolved", onResolved);
    try {
      const swept = await sweep();
      assert.ok(swept.runs.some((r: any) => r.runId === "WAITTO"), "the sweep tickets it although the customer is connected");
    } finally {
      caseEvents.off("resolved", onResolved);
    }
    const record: any = await (await app.request("/escalations/WAITTO")).json();
    assert.equal(record.outcome, "escalated_to_support");
    assert.ok(record.ticketId);
    assert.equal(record.resolvedBy, "system");
    assert.equal(record.customerDidNotReply, true, "the record says it was the customer's answer that did not come");
    const event = events.find((e) => e.runId === "WAITTO");
    assert.equal(event?.customerDidNotReply, true);
    const notice = caseResolvedMessage(event, (amount: number, currency: string) => `${currency} ${amount}`);
    assert.match(notice, /we haven't heard back/);
    assert.ok(!/longer than usual/.test(notice));
  });

  test("a case no customer was ever asked about still times out as before, without that flag", async () => {
    const run = await mastra.getWorkflow("policyReviewWorkflow")!.createRun({ runId: "PLAINTO" });
    await run.start({
      inputData: {
        orderId: "order_5561", refundAmount: 20, caseType: "delivery_dispute", problemSummary: "Test.", threadId: "t_plainto", sessionId: "plain-session",
        createdAt: new Date().toISOString(), transcript: [{ role: "customer", text: "Test.", timestamp: new Date().toISOString() }], relatedOpenCaseRefundAmount: 0,
      } as any,
    });
    await setLiveDeadline("PLAINTO", new Date(Date.now() - 60_000).toISOString());
    assert.ok((await sweep()).runs.some((r: any) => r.runId === "PLAINTO"));
    const record: any = await (await app.request("/escalations/PLAINTO")).json();
    assert.equal(record.resolvedBy, "system");
    assert.equal(record.customerDidNotReply, undefined, "an ordinary timeout is not described as the customer's silence");
  });
});
