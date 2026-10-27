// The stored conversation under load and failure: long chats, many chats at once, a race for one conversation id, the size cap, a
// demo reset in the middle of a turn, repeated failed retries, a reply that breaks off halfway, a browser that disappears at
// different moments, a burst of notices, and a database that is closed and reopened.
//
// Real chat route and agent against a stand-in model API (helpers/chat-harness.ts); temporary database and policy. No cost.
// Run with: npx tsx --test --test-force-exit tests/mastra/chat-conversation-state.test.ts (from apps/agent)

import { describe, test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createChatHarness } from "./helpers/chat-harness";

const h = await createChatHarness({ policy: true });
const { getThread, saveThread, clearAllThreads, MAX_THREAD_MESSAGES } = await import("../../src/mastra/conversation-threads");
const { caseEvents } = await import("../../src/mastra/case-events");
const { refundRecordsForOrder } = await import("../../src/mastra/refund-ledger");

const roles = (messages: Array<{ role: string }>) => messages.map((m) => m.role).join(",");
async function waitFor<T>(read: () => Promise<T | undefined | false>, what: string, ms = 8000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() - start > ms) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
const notice = (sessionId: string, n: number) => caseEvents.emit("more-info-requested", { runId: "ABC123", orderId: "order_2001", customerId: "cust_demo_01", sessionId, question: `Question number ${n}?` });
// A message after a browser walked away: the turn lock may take a moment to clear.
async function turnWhenFree(ids: ReturnType<typeof h.newIds>, text: string) {
  let result = await h.turn(ids, text);
  for (let i = 0; i < 100 && result.status === 429; i++) {
    await new Promise((r) => setTimeout(r, 50));
    result = await h.turn(ids, text);
  }
  return result;
}

describe("the stored conversation under load and failure", () => {
  beforeEach(() => {
    h.requests.length = 0;
    h.mode.failAfterTool = false;
    h.mode.errorMidStream = false;
    h.mode.delayMs = 0;
  });
  after(() => h.close());

  test("a twenty-turn chat is stored in order, and the model is shown all of it", async () => {
    const ids = h.newIds();
    for (let i = 1; i <= 20; i++) assert.equal((await h.turn(ids, `message number ${i} of the chat`)).status, 200);
    const thread = (await getThread(ids.conversationId))!;
    assert.equal(thread.messages.length, 40);
    assert.equal(new Set(thread.messages.map((m) => m.id)).size, 40, "every message has its own id");
    assert.equal(roles(thread.messages), Array.from({ length: 20 }, () => "user,assistant").join(","), "they alternate");
    const lastRequest = JSON.stringify(h.requests[h.requests.length - 1].messages);
    let at = -1;
    for (let i = 1; i <= 20; i++) {
      const next = lastRequest.indexOf(`message number ${i} of the chat`);
      assert.ok(next > at, `message ${i} is in the model's history, after the one before it`);
      at = next;
    }
  });

  test("twenty chats at the same moment each keep to themselves", async () => {
    const chats = Array.from({ length: 20 }, (_, i) => ({ ids: h.newIds(), text: `PRIVATE-${i}-${randomUUID().slice(0, 6)}` }));
    const results = await Promise.all(chats.map((c) => h.turn(c.ids, c.text)));
    assert.deepEqual(results.map((r) => r.status), Array(20).fill(200));
    for (const [i, c] of chats.entries()) {
      const stored = JSON.stringify((await getThread(c.ids.conversationId))!.messages);
      assert.ok(stored.includes(c.text), `chat ${i} holds its own message`);
      for (const other of chats) if (other !== c) assert.ok(!stored.includes(other.text), `chat ${i} holds no one else's message`);
    }
  });

  test("two sessions racing for one conversation id: one gets it, the other is refused", async () => {
    const conversationId = `conv-${randomUUID()}`;
    const a = { sessionId: `sess-a-${randomUUID()}`, conversationId };
    const b = { sessionId: `sess-b-${randomUUID()}`, conversationId };
    const results = await Promise.all([h.turn(a, "from A"), h.turn(b, "from B")]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 403]);
    const winner = results[0].status === 200 ? a : b;
    const thread = (await getThread(conversationId))!;
    assert.equal(thread.sessionId, winner.sessionId, "the thread belongs to the one that got in first");
    assert.ok(!JSON.stringify(thread.messages).includes(results[0].status === 200 ? "from B" : "from A"), "and holds nothing of the other");
  });

  test("the size cap: a chat at 199 messages takes one more turn, then is asked to start a new chat; Try again still works", async () => {
    const ids = h.newIds();
    const seeded = Array.from({ length: MAX_THREAD_MESSAGES - 1 }, (_, i) => ({ id: `s${i}`, role: i % 2 === 0 ? ("user" as const) : ("assistant" as const), parts: [{ type: "text", text: `seeded ${i}` }] }));
    await saveThread({ ...ids, customerId: "cust_demo_01", messages: seeded });
    assert.equal((await h.turn(ids, "the last one that fits")).status, 200);
    assert.equal((await getThread(ids.conversationId))!.messages.length, MAX_THREAD_MESSAGES + 1);
    const refused = await h.turn(ids, "one too many");
    assert.equal(refused.status, 409);
    assert.equal(JSON.parse(refused.text).error, "conversation_too_long");
    assert.equal((await h.post({ messages: [], trigger: "regenerate-message", ...ids })).status, 200, "a retry of the last message is still allowed");
  });

  test("a demo reset in the middle of a turn: the turn completes, nothing crashes, and the chat starts again from the new message", async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", listener);
    try {
      const ids = h.newIds();
      h.mode.delayMs = 400;
      const running = h.turn(ids, "before the reset");
      await waitFor(() => getThread(ids.conversationId), "the customer's message to be stored");
      await clearAllThreads();
      assert.equal((await running).status, 200);
      h.mode.delayMs = 0;
      assert.equal(await getThread(ids.conversationId), undefined, "the reply of the interrupted turn is not written into a thread that was cleared");
      assert.equal((await h.turn(ids, "after the reset")).status, 200);
      const thread = (await getThread(ids.conversationId))!;
      assert.equal(roles(thread.messages), "user,assistant");
      assert.ok(!JSON.stringify(thread.messages).includes("before the reset"));
      await new Promise((r) => setTimeout(r, 100));
      assert.deepEqual(unhandled, [], "no unhandled rejection");
    } finally {
      process.off("unhandledRejection", listener);
    }
  });

  test("failing the same retry again and again keeps the finished work once, and a retry that works finishes the job", async () => {
    const ids = h.newIds();
    const returnIt = `@@CALL paymentIssueReturnRefund ${JSON.stringify({ orderId: "order_2001", problemSummary: "return it" })}`;
    h.mode.failAfterTool = true;
    await h.turn(ids, returnIt);
    for (let i = 0; i < 3; i++) {
      assert.equal((await h.post({ messages: [], trigger: "regenerate-message", ...ids })).status, 200);
      const thread = (await getThread(ids.conversationId))!;
      assert.equal(roles(thread.messages), "user,assistant", `after failed retry ${i + 1}`);
      const parts = await h.toolParts(ids.conversationId, "paymentIssueReturnRefund");
      assert.equal(parts.length, 1, `the refund call is stored once after failed retry ${i + 1}`);
      assert.equal(parts[0].output?.status, "approved", `and it is still the original approval, not a later attempt's refusal (retry ${i + 1})`);
    }
    assert.equal((await refundRecordsForOrder("order_2001")).length, 1);
    h.mode.failAfterTool = false;
    assert.equal((await h.post({ messages: [], trigger: "regenerate-message", ...ids })).status, 200);
    assert.deepEqual((await h.shownReplies(ids.conversationId)).length, 1, "now the reply exists");
    assert.equal((await h.toolParts(ids.conversationId, "paymentIssueReturnRefund")).length, 1);
    assert.equal((await refundRecordsForOrder("order_2001")).length, 1, "and the refund was never repeated");
  });

  test("Try again after a send that never arrived sends THAT message, and does not rerun the one before it", async () => {
    const ids = h.newIds();
    const first = { id: "browser-1", role: "user", parts: [{ type: "text", text: "FIRST question" }] };
    assert.equal((await h.post({ messages: [first], ...ids })).status, 200);
    h.requests.length = 0;
    // The second send was lost on the way (a dropped connection): the server never saw it. The browser's Try again names it.
    const second = { id: "browser-2", role: "user", parts: [{ type: "text", text: "SECOND question" }] };
    const shownBefore = { id: "a1", role: "assistant", parts: [{ type: "text", text: "earlier reply" }] };
    const retried = await h.post({ messages: [first, shownBefore, second], trigger: "regenerate-message", ...ids });
    assert.equal(retried.status, 200);
    assert.equal(h.requests.length, 1, "one model call, for the new message");
    const sent = JSON.stringify(h.requests[0].messages);
    assert.ok(sent.includes("SECOND question"), "the model was given the message that was retried");
    assert.equal(sent.split("FIRST question").length - 1, 1, "the first message is in the history once, not run again");
    const thread = (await getThread(ids.conversationId))!;
    assert.equal(roles(thread.messages), "user,assistant,user,assistant");
    assert.deepEqual(thread.messages.filter((m) => m.role === "user").map((m) => (m.parts as any[])[0].text), ["FIRST question", "SECOND question"]);
  });

  test("Try again on a message the server did store reruns it once, even though the browser names it", async () => {
    const ids = h.newIds();
    const message = { id: "browser-7", role: "user", parts: [{ type: "text", text: "look up order 2001" }] };
    h.mode.failAfterTool = true;
    await h.post({ messages: [{ ...message, parts: [{ type: "text", text: `@@CALL commerceGetOrder {"orderId":"order_2001"}` }] }], ...ids });
    h.mode.failAfterTool = false;
    h.requests.length = 0;
    const retried = await h.post({ messages: [{ ...message, parts: [{ type: "text", text: `@@CALL commerceGetOrder {"orderId":"order_2001"}` }] }], trigger: "regenerate-message", ...ids });
    assert.equal(retried.status, 200);
    const thread = (await getThread(ids.conversationId))!;
    assert.equal(thread.messages.filter((m) => m.role === "user").length, 1, "the customer's message is stored once");
    assert.equal((await h.toolParts(ids.conversationId, "commerceGetOrder")).length, 1, "the finished lookup was not run again");
  });

  test("Try again on the very first message, which never arrived, sends it", async () => {
    const ids = h.newIds();
    const first = { id: "browser-1", role: "user", parts: [{ type: "text", text: "my very first message" }] };
    const retried = await h.post({ messages: [first], trigger: "regenerate-message", ...ids });
    assert.equal(retried.status, 200, retried.text.slice(0, 120));
    assert.ok(JSON.stringify(h.requests[0].messages).includes("my very first message"));
    assert.equal(roles((await getThread(ids.conversationId))!.messages), "user,assistant");
  });

  test("a reply that breaks off halfway is kept as it was shown, and Try again replaces it", async () => {
    const ids = h.newIds();
    h.mode.errorMidStream = true;
    const broken = await h.turn(ids, "tell me something");
    assert.equal(broken.status, 200);
    assert.ok(/"type":"error"/.test(broken.text), "the browser is told the reply failed");
    const afterBreak = (await getThread(ids.conversationId))!;
    const storedText = JSON.stringify(afterBreak.messages);
    console.log(`[observed] after a reply that broke off: ${roles(afterBreak.messages)}; partial text stored: ${storedText.includes("Partial reply")}`);

    h.mode.errorMidStream = false;
    h.requests.length = 0;
    assert.equal((await h.post({ messages: [], trigger: "regenerate-message", ...ids })).status, 200);
    assert.ok(!JSON.stringify(h.requests[0].messages).includes("Partial reply"), "the retry does not show the model the broken-off reply");
    const thread = (await getThread(ids.conversationId))!;
    assert.equal(roles(thread.messages), "user,assistant");
    assert.ok(!JSON.stringify(thread.messages).includes("Partial reply"));
  });

  test("a browser that leaves before, during or after the first bytes: the thread stays sound and the next message works", async () => {
    for (const [what, delayMs, readFirst] of [["before reading anything", 0, false], ["after the first bytes", 0, true], ["while the model is still thinking", 300, false]] as const) {
      const ids = h.newIds();
      h.mode.delayMs = delayMs;
      const response = await h.app.request("/chat/wismoAgent", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: [h.userMessage(`leaving ${what}`)], ...ids }) });
      assert.equal(response.status, 200, what);
      if (readFirst) await response.body!.getReader().read();
      await response.body!.cancel().catch(() => {});
      const settled = await waitFor(async () => {
        const t = await getThread(ids.conversationId);
        return t && t.messages.length === 2 ? t : undefined;
      }, `the reply to be stored after leaving ${what}`);
      assert.equal(roles(settled.messages), "user,assistant", what);
      h.mode.delayMs = 0;
      const next = await turnWhenFree(ids, `back again after leaving ${what}`);
      assert.equal(next.status, 200, what);
      assert.equal(roles((await getThread(ids.conversationId))!.messages), "user,assistant,user,assistant", what);
    }
  });

  test("fifty notices at once, some of them during a running turn, all land and none overwrites another", async () => {
    const ids = h.newIds();
    assert.equal((await h.turn(ids, "start")).status, 200);
    h.mode.delayMs = 300;
    const running = h.turn(ids, "a slow one");
    await waitFor(async () => (await getThread(ids.conversationId))!.messages.length === 3, "the slow turn's message to be stored");
    for (let n = 1; n <= 50; n++) notice(ids.sessionId, n);
    await running;
    h.mode.delayMs = 0;
    const thread = await waitFor(async () => {
      const t = (await getThread(ids.conversationId))!;
      return JSON.stringify(t.messages).split("Question number").length - 1 === 50 ? t : undefined;
    }, "all fifty notices to be stored");
    for (let n = 1; n <= 50; n++) assert.ok(JSON.stringify(thread.messages).includes(`Question number ${n}?`), `notice ${n} is there`);
    assert.ok(JSON.stringify(thread.messages).includes("tool-respondToCustomer"), "and so is the reply of the turn that was running");
    assert.equal(thread.messages.filter((m) => m.role === "user").length, 2, "the customer's own messages are untouched");
  });

  // What each stored message is, in one short string, to compare the order with what the customer sees: their message, the answer,
  // then the notice.
  const outline = (messages: Array<{ role: string; parts: unknown[] }>) =>
    messages.map((m) => {
      const parts = m.parts as any[];
      if (m.role === "user") return `customer: ${parts.find((p) => p.type === "text")?.text}`;
      if (parts.some((p) => p.type === "tool-respondToCustomer")) return "answer";
      const text = parts.find((p) => p.type === "text")?.text ?? "";
      return /Question number (\d+)/.exec(text) ? `notice ${/Question number (\d+)/.exec(text)![1]}` : `other: ${text}`;
    });

  test("a notice that arrives while the agent is answering is stored AFTER the answer, as the customer sees it", async () => {
    const ids = h.newIds();
    h.mode.delayMs = 400;
    const running = h.turn(ids, "any news on my case");
    await waitFor(() => getThread(ids.conversationId), "the customer's message to be stored");
    notice(ids.sessionId, 1);
    await running;
    h.mode.delayMs = 0;
    const thread = await waitFor(async () => {
      const t = (await getThread(ids.conversationId))!;
      return t.messages.length === 3 ? t : undefined;
    }, "the notice to be stored after the answer");
    assert.deepEqual(outline(thread.messages), ["customer: any news on my case", "answer", "notice 1"]);
    // Once the turn is over a notice is stored at once.
    notice(ids.sessionId, 2);
    const later = await waitFor(async () => {
      const t = (await getThread(ids.conversationId))!;
      return t.messages.length === 4 ? t : undefined;
    }, "a notice after the turn to be stored at once");
    assert.deepEqual(outline(later.messages).slice(2), ["notice 1", "notice 2"]);
  });

  test("several notices during one turn are each stored once, in the order they arrived, after the answer", async () => {
    const ids = h.newIds();
    h.mode.delayMs = 500;
    const running = h.turn(ids, "what is happening");
    await waitFor(() => getThread(ids.conversationId), "the customer's message to be stored");
    notice(ids.sessionId, 1);
    await new Promise((r) => setTimeout(r, 40));
    notice(ids.sessionId, 2);
    await new Promise((r) => setTimeout(r, 40));
    notice(ids.sessionId, 3);
    await running;
    h.mode.delayMs = 0;
    const thread = await waitFor(async () => {
      const t = (await getThread(ids.conversationId))!;
      return t.messages.length === 5 ? t : undefined;
    }, "all three notices to be stored");
    assert.deepEqual(outline(thread.messages), ["customer: what is happening", "answer", "notice 1", "notice 2", "notice 3"]);
  });

  test("a customer who answers the rep straight after the turn: the model sees the question before the answer", async () => {
    const ids = h.newIds();
    h.mode.delayMs = 400;
    const running = h.turn(ids, "any news");
    await waitFor(() => getThread(ids.conversationId), "the customer's message to be stored");
    notice(ids.sessionId, 1);
    await running;
    h.mode.delayMs = 0;
    h.requests.length = 0;
    assert.equal((await h.turn(ids, "MY ANSWER to the question")).status, 200, "sent the instant the turn ended");
    const sent = JSON.stringify(h.requests[0].messages);
    assert.ok(sent.indexOf("Question number 1?") >= 0 && sent.indexOf("Question number 1?") < sent.indexOf("MY ANSWER"), "the question comes first");
    assert.equal(sent.split("Question number 1?").length - 1, 1, "and only once");
  });

  test("a customer who leaves while a reply and a notice are both pending: both are stored once, and the next message sees both", async () => {
    const ids = h.newIds();
    h.mode.delayMs = 400;
    const response = await h.app.request("/chat/wismoAgent", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: [h.userMessage("I am about to close the tab")], ...ids }) });
    await response.body!.cancel().catch(() => {});
    await waitFor(() => getThread(ids.conversationId), "the customer's message to be stored");
    notice(ids.sessionId, 1);
    h.mode.delayMs = 0;
    const thread = await waitFor(async () => {
      const t = (await getThread(ids.conversationId))!;
      return t.messages.length === 3 ? t : undefined;
    }, "the reply and the notice to be stored");
    assert.deepEqual(outline(thread.messages), ["customer: I am about to close the tab", "answer", "notice 1"]);
    h.requests.length = 0;
    assert.equal((await turnWhenFree(ids, "back again")).status, 200);
    const sent = JSON.stringify(h.requests[0].messages);
    assert.ok(sent.includes("Question number 1?") && sent.indexOf("Question number 1?") < sent.indexOf("back again"));
  });

  test("a notice goes to the chat the customer used last, and moves with them", async () => {
    const sessionId = `sess-${randomUUID()}`;
    const a = { sessionId, conversationId: `conv-a-${randomUUID()}` };
    const b = { sessionId, conversationId: `conv-b-${randomUUID()}` };
    await h.turn(a, "first chat");
    await new Promise((r) => setTimeout(r, 20));
    await h.turn(b, "second chat");
    notice(sessionId, 1);
    await waitFor(async () => JSON.stringify((await getThread(b.conversationId))!.messages).includes("Question number 1?"), "the notice in the newer chat");
    assert.ok(!JSON.stringify((await getThread(a.conversationId))!.messages).includes("Question number 1?"));
    await new Promise((r) => setTimeout(r, 20));
    await h.turn(a, "back to the first chat");
    notice(sessionId, 2);
    await waitFor(async () => JSON.stringify((await getThread(a.conversationId))!.messages).includes("Question number 2?"), "the notice in the chat used last");
    assert.ok(!JSON.stringify((await getThread(b.conversationId))!.messages).includes("Question number 2?"));
  });

  test("a thread is still there after the database is closed and opened again", async () => {
    const ids = h.newIds();
    await h.turn(ids, "remember me");
    const before = JSON.stringify((await getThread(ids.conversationId))!.messages);
    const original = process.env.AGENT_DB_URL;
    const elsewhere = mkdtempSync(join(tmpdir(), "wismo-reopen-"));
    try {
      process.env.AGENT_DB_URL = `file:${join(elsewhere, "other.db")}`;
      assert.equal(await getThread(ids.conversationId), undefined, "a different database does not have it");
    } finally {
      process.env.AGENT_DB_URL = original;
      rmSync(elsewhere, { recursive: true, force: true });
    }
    assert.equal(JSON.stringify((await getThread(ids.conversationId))!.messages), before, "the original file hands it back unchanged");
  });
});
