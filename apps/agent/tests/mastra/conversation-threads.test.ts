// The server's own record of each conversation. Real LibSQL file, in a temp folder.
// Run with: npx tsx --test --test-force-exit tests/mastra/conversation-threads.test.ts (from apps/agent)

import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "wismo-threads-"));
process.env.AGENT_DB_URL = `file:${join(dir, "threads.db")}`;

const { appendNoticeToSession, appendToThread, clearAllThreads, getThread, lastUserText, saveThread, trimToLastUserMessage, historyForRetry, withThreadLock } = await import("../../src/mastra/conversation-threads");

const userMsg = (id: string, text: string) => ({ id, role: "user" as const, parts: [{ type: "text", text }] });
const botMsg = (id: string, text: string) => ({ id, role: "assistant" as const, parts: [{ type: "text", text }] });

describe("the thread store", () => {
  after(() => rmSync(dir, { recursive: true, force: true }));

  test("a saved thread reads back exactly, with its session and customer", async () => {
    const messages = [userMsg("u1", "hi"), { id: "a1", role: "assistant" as const, parts: [{ type: "step-start" }, { type: "tool-commerceGetOrder", toolCallId: "t1", state: "output-available", input: { orderId: "order_2001" }, output: { status: "delivered" } }, { type: "text", text: "Delivered." }] }];
    await saveThread({ conversationId: "c-roundtrip", sessionId: "s1", customerId: "cust_demo_01", messages });
    const thread = await getThread("c-roundtrip");
    assert.deepEqual(thread, { conversationId: "c-roundtrip", sessionId: "s1", customerId: "cust_demo_01", messages });
  });

  test("an unknown conversation is undefined", async () => {
    assert.equal(await getThread("nope"), undefined);
  });

  test("saving again replaces the messages but never changes who owns the thread", async () => {
    await saveThread({ conversationId: "c-owner", sessionId: "s-first", customerId: "cust_demo_01", messages: [userMsg("u1", "one")] });
    await saveThread({ conversationId: "c-owner", sessionId: "s-someone-else", customerId: "cust_other", messages: [userMsg("u1", "one"), userMsg("u2", "two")] });
    const thread = await getThread("c-owner");
    assert.equal(thread?.sessionId, "s-first", "the first session keeps the thread");
    assert.equal(thread?.customerId, "cust_demo_01");
    assert.equal(thread?.messages.length, 2);
  });

  test("append adds to the end, and does nothing for a thread that does not exist", async () => {
    await saveThread({ conversationId: "c-append", sessionId: "s2", customerId: "cust_demo_01", messages: [userMsg("u1", "hi")] });
    await appendToThread("c-append", botMsg("a1", "hello"));
    assert.deepEqual((await getThread("c-append"))?.messages.map((m) => m.id), ["u1", "a1"]);
    await appendToThread("c-never-existed", botMsg("a2", "lost"));
    assert.equal(await getThread("c-never-existed"), undefined);
  });

  test("concurrent appends under the lock all land, none overwrite another", async () => {
    await saveThread({ conversationId: "c-race", sessionId: "s3", customerId: "cust_demo_01", messages: [userMsg("u1", "hi")] });
    await Promise.all(Array.from({ length: 12 }, (_, i) => appendToThread("c-race", botMsg(`a${i}`, `reply ${i}`))));
    const ids = (await getThread("c-race"))!.messages.map((m) => m.id);
    assert.equal(ids.length, 13);
    assert.equal(new Set(ids).size, 13);
  });

  test("withThreadLock runs one job per conversation at a time, in order", async () => {
    const order: string[] = [];
    const slow = withThreadLock("c-lock", async () => {
      order.push("slow start");
      await new Promise((r) => setTimeout(r, 40));
      order.push("slow end");
    });
    const fast = withThreadLock("c-lock", async () => {
      order.push("fast");
    });
    await Promise.all([slow, fast]);
    assert.deepEqual(order, ["slow start", "slow end", "fast"]);
  });

  test("a notice for a session lands in that session's most recently used thread, and no other session's", async () => {
    await saveThread({ conversationId: "c-old", sessionId: "s-notice", customerId: "cust_demo_01", messages: [userMsg("u1", "first chat")] });
    await new Promise((r) => setTimeout(r, 15));
    await saveThread({ conversationId: "c-new", sessionId: "s-notice", customerId: "cust_demo_01", messages: [userMsg("u1", "second chat")] });
    await saveThread({ conversationId: "c-bystander", sessionId: "s-other", customerId: "cust_demo_01", messages: [userMsg("u1", "unrelated")] });

    await appendNoticeToSession("s-notice", "Update on order #2001: a rep reviewed your case.");

    const added = (await getThread("c-new"))!.messages;
    assert.equal(added.length, 2);
    assert.deepEqual(added[1].role, "assistant");
    assert.deepEqual(added[1].parts, [{ type: "text", text: "Update on order #2001: a rep reviewed your case." }]);
    assert.equal((await getThread("c-old"))!.messages.length, 1);
    assert.equal((await getThread("c-bystander"))!.messages.length, 1);
  });

  test("a notice for a session with no thread (a seeded case, a tab that never wrote) is a quiet no-op", async () => {
    await appendNoticeToSession("seed", "Update on order #1: …");
    await appendNoticeToSession("s-never-chatted", "Update on order #1: …");
  });

  test("clearAllThreads empties the table (a demo reset)", async () => {
    await saveThread({ conversationId: "c-clear", sessionId: "s4", customerId: "cust_demo_01", messages: [userMsg("u1", "hi")] });
    await clearAllThreads();
    assert.equal(await getThread("c-clear"), undefined);
    assert.equal(await getThread("c-roundtrip"), undefined);
  });
});

describe("thread helpers", () => {
  test("lastUserText is the newest customer message's text, or empty", () => {
    assert.equal(lastUserText([userMsg("u1", "first"), botMsg("a1", "reply"), userMsg("u2", "I disagree"), botMsg("a2", "ok")]), "I disagree");
    assert.equal(lastUserText([botMsg("a1", "hello")]), "");
    assert.equal(lastUserText([]), "");
    assert.equal(lastUserText([{ id: "u1", role: "user", parts: [{ type: "file", mediaType: "image/png", url: "data:image/png;base64,AAAA" }] }]), "", "a photo-only message has no text");
  });

  test("trimToLastUserMessage drops everything after the newest customer message", () => {
    const thread = [userMsg("u1", "a"), botMsg("a1", "b"), userMsg("u2", "c"), botMsg("a2", "d"), botMsg("a3", "e")];
    assert.deepEqual(trimToLastUserMessage(thread)?.map((m) => m.id), ["u1", "a1", "u2"]);
    assert.deepEqual(trimToLastUserMessage([userMsg("u1", "a")])?.map((m) => m.id), ["u1"]);
    assert.equal(trimToLastUserMessage([botMsg("a1", "b")]), undefined);
    assert.equal(trimToLastUserMessage([]), undefined);
  });
});

describe("history for Try again", () => {
  const isReply = (name: string) => name === "respondToCustomer" || name === "offerNewChat";
  const done = (name: string, output: unknown = { ok: true }) => ({ type: `tool-${name}`, toolCallId: `call-${name}`, state: "output-available", input: {}, output });
  const customer = userMsg("u1", "return my socks");
  const assistant = (id: string, ...parts: unknown[]) => ({ id, role: "assistant" as const, parts });

  test("what the failed turn already did stays; the reply goes", () => {
    const failed = assistant("a1", { type: "step-start" }, done("commerceGetOrder"), { type: "step-start" }, done("paymentIssueReturnRefund", { status: "approved" }), { type: "step-start" }, done("respondToCustomer", { message: "Done." }), { type: "text", text: "stray text" });
    const result = historyForRetry([userMsg("u0", "earlier"), botMsg("a0", "ok"), customer, failed], isReply)!;
    assert.deepEqual(result.map((m) => m.id), ["u0", "a0", "u1", "a1"]);
    const kept = result[3].parts as any[];
    assert.deepEqual(kept.map((p) => p.type), ["step-start", "tool-commerceGetOrder", "step-start", "tool-paymentIssueReturnRefund"], "completed action tools stay, with their step markers; the reply tool, the text and the trailing marker go");
    assert.deepEqual(kept[3].output, { status: "approved" }, "the result itself is intact");
  });

  test("a tool that did not finish, or errored, is not kept", () => {
    const failed = assistant("a1", { type: "step-start" }, { type: "tool-paymentIssueReturnRefund", toolCallId: "x", state: "input-available", input: {} }, { type: "step-start" }, { type: "tool-commerceGetOrder", toolCallId: "y", state: "output-error", errorText: "boom" });
    assert.deepEqual(historyForRetry([customer, failed], isReply)!.map((m) => m.id), ["u1"], "nothing completed, so the history ends at the customer's message");
  });

  test("nothing kept when the failed turn only replied, and the card tools count as replies", () => {
    assert.deepEqual(historyForRetry([customer, assistant("a1", { type: "step-start" }, done("respondToCustomer"))], isReply)!.map((m) => m.id), ["u1"]);
    assert.deepEqual(historyForRetry([customer, assistant("a1", { type: "step-start" }, done("offerNewChat"))], isReply)!.map((m) => m.id), ["u1"]);
  });

  test("a notice that arrived after the failed message is dropped, and kept parts from several messages are one message", () => {
    const result = historyForRetry([customer, assistant("a1", { type: "step-start" }, done("paymentIssueReturnRefund")), botMsg("notice", "Update on order #2001: …")], isReply)!;
    assert.deepEqual(result.map((m) => m.id), ["u1", "a1"], "the notice would leave the history ending on an assistant message");
    const two = historyForRetry([customer, assistant("a1", { type: "step-start" }, done("commerceGetOrder")), assistant("a2", { type: "step-start" }, done("paymentIssueReturnRefund"))], isReply)!;
    assert.deepEqual(two.map((m) => m.id), ["u1", "a1"]);
    assert.deepEqual((two[1].parts as any[]).filter((p) => p.type !== "step-start").map((p) => p.type), ["tool-commerceGetOrder", "tool-paymentIssueReturnRefund"]);
  });

  test("the customer's own message is untouched, and with no customer message there is nothing to retry", () => {
    assert.deepEqual(historyForRetry([customer], isReply)!, [customer]);
    assert.equal(historyForRetry([botMsg("a1", "hello")], isReply), undefined);
    assert.equal(historyForRetry([], isReply), undefined);
  });
});
