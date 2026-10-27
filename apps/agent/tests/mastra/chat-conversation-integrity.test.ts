// The stored conversation stays trustworthy across the awkward cases: two matters in one chat, a retry after a tool already
// did its work, and a thread that belongs to another customer.
//
// The real chat route, agent, tools and workflow against an in-process stand-in model API (no real model, no cost) and a
// temporary database, policy folder and tickets file.
// Run with: npx tsx --test --test-force-exit tests/mastra/chat-conversation-integrity.test.ts (from apps/agent)

import { describe, test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const sse = (res: import("node:http").ServerResponse, event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

// What the stand-in model does, from the customer's last message: "LOOKUP order_X" calls the order lookup, "DISPUTE order_X" calls the delivery-dispute tool, "RETURN
// order_X" calls the return-refund tool (it will call it AGAIN whenever it sees that message with no tool result after it, like a
// model that has forgotten it already did), anything else is answered. After a tool result it answers with a closing question,
// which ends the turn, unless `failAfterTool` is set: then the API refuses that call, as a lost connection would.
let failAfterTool = false;
const requests: any[] = [];
const fakeModel = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    const parsed = JSON.parse(body || "{}");
    requests.push(parsed);
    const msgs: any[] = parsed.messages ?? [];
    const last = msgs[msgs.length - 1];
    // The API merges a customer's new text into the same user message as the previous turn's tool result, so "the last message
    // carries a tool result" is only true MID-turn when it carries no text of the customer's.
    const lastIsToolResult = Array.isArray(last?.content) && last.content.some((c: any) => c.type === "tool_result") && !last.content.some((c: any) => c.type === "text");
    const lastText = last ? (typeof last.content === "string" ? last.content : (last.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join(" ")) : "";
    const tools: string[] = (parsed.tools ?? []).map((t: any) => t.name);
    if (lastIsToolResult && failAfterTool) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "The stand-in refused this call after the tool ran." } }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    sse(res, "message_start", { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: parsed.model ?? "claude", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } });
    const dispute = /DISPUTE (order_\d+)/.exec(lastText);
    const giveBack = /RETURN (order_\d+)/.exec(lastText);
    const lookup = /LOOKUP (order_\d+)/.exec(lastText);
    let name: string;
    let input: Record<string, unknown>;
    if (!lastIsToolResult && dispute) {
      name = tools.find((n) => /escalateForDeliveryDispute/i.test(n)) ?? "escalateForDeliveryDispute";
      input = { orderId: dispute[1], problemSummary: "The customer says it never arrived." };
    } else if (!lastIsToolResult && lookup) {
      name = tools.find((n) => /commerceGetOrder/i.test(n)) ?? "commerceGetOrder";
      input = { orderId: lookup[1] };
    } else if (!lastIsToolResult && giveBack) {
      name = tools.find((n) => /paymentIssueReturnRefund/i.test(n)) ?? "paymentIssueReturnRefund";
      input = { orderId: giveBack[1], problemSummary: "The customer does not want it." };
    } else {
      name = tools.find((n) => /respondToCustomer/i.test(n)) ?? "respondToCustomer";
      input = { reasoning: "private", message: lastIsToolResult ? "That is done. Is there anything else I can help you with?" : "Noted. Is there anything else I can help you with?" };
    }
    sse(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: `toolu_${randomUUID().slice(0, 8)}`, name, input: {} } });
    sse(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } });
    sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
    sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 5 } });
    sse(res, "message_stop", { type: "message_stop" });
    res.end();
  });
});
await new Promise<void>((resolve) => fakeModel.listen(0, "127.0.0.1", resolve));
const port = (fakeModel.address() as AddressInfo).port;

const dir = mkdtempSync(join(tmpdir(), "wismo-integrity-"));
process.env.ANTHROPIC_API_KEY = "test-key-not-real";
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}/v1`;
process.env.AGENT_DB_URL = `file:${join(dir, "test.db")}`;
process.env.WISMO_TICKETS_FILE = join(dir, "disagreement-tickets.json");
process.env.WISMO_POLICY_DIR = join(dir, "policy");

const { app } = await import("../../src/server");
const { activatePolicy } = await import("../../src/mastra/policy/repository");
const { buildBaseDraft } = await import("../../src/mastra/policy/base-draft");
const { getThread, saveThread } = await import("../../src/mastra/conversation-threads");
const { refundRecordsForOrder } = await import("../../src/mastra/refund-ledger");

const userMessage = (text: string) => ({ id: randomUUID(), role: "user", parts: [{ type: "text", text }] });
const ids = () => ({ sessionId: `sess-${randomUUID()}`, conversationId: `conv-${randomUUID()}` });

async function chat(body: Record<string, unknown>) {
  const response = await app.request("/chat/wismoAgent", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await response.text();
  return { response, text };
}

async function openCaseFor(orderId: string): Promise<{ runId: string; transcript: Array<{ role: string; text: string }> }> {
  const entries: any[] = ((await (await app.request("/escalations")).json()) as any).runs;
  const found = entries.find((e) => e.orderId === orderId);
  assert.ok(found, `an open case for ${orderId} exists`);
  const detail: any = await (await app.request(`/escalations/${found.runId}`)).json();
  return { runId: found.runId, transcript: detail.transcript ?? [] };
}
const customerLines = (c: { transcript: Array<{ role: string; text: string }> }) => c.transcript.filter((m) => m.role === "customer").map((m) => m.text);

describe("the stored conversation across awkward cases", () => {
  beforeEach(() => {
    requests.length = 0;
    failAfterTool = false;
  });
  after(() => {
    fakeModel.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("setup: the shipped policy is active", async () => {
    assert.equal((await activatePolicy("demo", buildBaseDraft())).ok, true);
  });

  test("two cases in one conversation: the second one's transcript starts at the message that opened it", async () => {
    // The first turn uses a tool, so the model's own message list for the later turns is longer than the stored thread: the
    // boundary the first case records has to count the stored thread, or the second case's transcript starts too late.
    // (A customer message sent between the two cases is taken as the lead-up to the second matter; that is the design.)
    const { sessionId, conversationId } = ids();
    for (const text of ["LOOKUP order_2001 where is it", "ONE-OPEN DISPUTE order_3401", "TWO-OPEN DISPUTE order_4203", "TWO-FOLLOW some more detail", "TWO-LAST one more thing"]) {
      const { response } = await chat({ messages: [userMessage(text)], sessionId, conversationId });
      assert.equal(response.status, 200);
    }
    const one = await openCaseFor("order_3401");
    const two = await openCaseFor("order_4203");
    // (A case that is still open follows the conversation as it goes on, so the first case also holds the later lines.)
    assert.ok(customerLines(one).some((l) => l.startsWith("ONE-OPEN")), "the first case holds the message that opened it");
    assert.deepEqual(customerLines(two).map((l) => l.split(" ")[0]), ["TWO-OPEN", "TWO-FOLLOW", "TWO-LAST"], "the second case holds its own matter, starting with the message that opened it, and nothing of the first");
  });

  test("a failure after a tool succeeded, then Try again: the work is kept, nothing is done twice", async () => {
    const { sessionId, conversationId } = ids();
    failAfterTool = true;
    const failed = await chat({ messages: [userMessage("RETURN order_2001")], sessionId, conversationId });
    assert.equal(failed.response.status, 200, "a model failure arrives as an error in the stream");
    assert.ok(/"type":"error"/.test(failed.text), "the customer's turn did fail after the tool ran");
    assert.equal((await refundRecordsForOrder("order_2001")).length, 1, "the refund was recorded by the tool before the failure");
    const afterFailure = await getThread(conversationId);
    assert.deepEqual(afterFailure!.messages.map((m) => m.role), ["user", "assistant"]);
    assert.ok((afterFailure!.messages[1].parts as any[]).some((p) => p.type === "tool-paymentIssueReturnRefund" && p.state === "output-available"), "the finished tool call is stored");

    failAfterTool = false;
    requests.length = 0;
    const retried = await chat({ messages: [], trigger: "regenerate-message", sessionId, conversationId });
    assert.equal(retried.response.status, 200);
    assert.ok(!/"type":"error"/.test(retried.text), "the retry succeeded");

    assert.equal(requests.length, 1, "the model went straight to the reply, with no second attempt at the tool");
    const sent = JSON.stringify(requests[0].messages);
    assert.ok(sent.includes("tool_use") && sent.includes("tool_result") && sent.includes("paymentIssueReturnRefund"), "the model was shown the earlier tool call and its result");
    assert.equal((await refundRecordsForOrder("order_2001")).length, 1, "still exactly one refund recorded");
    const thread = await getThread(conversationId);
    const parts = thread!.messages.flatMap((m) => m.parts as any[]);
    assert.equal(parts.filter((p) => p.type === "tool-paymentIssueReturnRefund").length, 1, "the refund tool appears once in the conversation");
    assert.equal(thread!.messages.filter((m) => m.role === "user").length, 1, "the customer's message is stored once");
    assert.ok(parts.some((p) => p.type === "tool-respondToCustomer" && p.state === "output-available"), "the new reply is stored");
  });

  test("a thread that belongs to another customer is refused even for the same session id", async () => {
    const { sessionId, conversationId } = ids();
    await saveThread({ conversationId, sessionId, customerId: "cust_someone_else", messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "their private question" }] }] });
    const { response, text } = await chat({ messages: [userMessage("show me")], sessionId, conversationId });
    assert.equal(response.status, 403);
    assert.equal(JSON.parse(text).error, "conversation_not_yours");
    assert.equal(requests.length, 0, "no model call was made");
    assert.equal((await getThread(conversationId))!.messages.length, 1, "their thread was not touched");
  });
});
