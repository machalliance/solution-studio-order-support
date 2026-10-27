// The live-update stream (GET /chat/:agentId/events) must send its first bytes at once. The response headers leave the server with
// the first byte, so a stream with nothing to replay used to stay silent until its first keep-alive, 25 seconds later: the browser
// held a request with no response, and a page refresh in that window cancelled it (Firefox logs that as a CORS failure with no
// status). The first thing the stream sends is now a ping, ahead of any replay.
//
// Run with: npx tsx --test --test-force-exit tests/mastra/chat-events-stream.test.ts (from apps/agent)

import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import { createChatHarness } from "./helpers/chat-harness";

const h = await createChatHarness();
const { app } = await import("../../src/server");
const { caseEvents } = await import("../../src/mastra/case-events");

// Reads from the stream until `want` text has arrived or `ms` has passed; returns what arrived. Cancels the stream afterwards, the
// way a browser leaving the page does.
async function read(path: string, want: string, ms: number, headers: Record<string, string> = {}): Promise<{ text: string; ms: number; status: number }> {
  const started = Date.now();
  const response = await app.request(path, { headers });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const deadline = new Promise<"late">((resolve) => setTimeout(() => resolve("late"), ms));
  while (!text.includes(want)) {
    const next = await Promise.race([reader.read(), deadline]);
    if (next === "late" || next.done) break;
    text += decoder.decode(next.value);
  }
  await reader.cancel();
  return { text, ms: Date.now() - started, status: response.status };
}

describe("the live-update stream", () => {
  after(() => h.close());

  test("sends a first event at once, without waiting for the keep-alive", async () => {
    const result = await read(`/chat/wismoAgent/events?sessionId=sess-first-bytes-${Date.now()}&cursor=`, "event: ping", 2000);
    assert.equal(result.status, 200);
    assert.ok(result.text.includes("event: ping"), `nothing arrived in 2 s; got: ${JSON.stringify(result.text)}`);
    assert.ok(result.ms < 2000, `the first bytes took ${result.ms} ms`);
  });

  test("the first event is only a ping: a quiet stream sends no case event", async () => {
    const result = await read(`/chat/wismoAgent/events?sessionId=sess-quiet-${Date.now()}`, "event: ping", 2000);
    assert.equal(result.text, "event: ping\ndata: \n\n");
  });

  test("a case event that is waiting to be replayed still arrives, after the ping, with its id", async () => {
    const sessionId = `sess-replay-${Date.now()}`;
    const { customers } = await import("../../src/fixtures/demo-data");
    caseEvents.emit("resolved", { customerId: customers.cust_demo_01.id, sessionId, runId: "TESTRUN", orderId: "order_2001", action: "denied" });
    const result = await read(`/chat/wismoAgent/events?sessionId=${sessionId}&cursor=`, "event: case-resolved", 2000);
    const ping = result.text.indexOf("event: ping");
    const resolved = result.text.indexOf("event: case-resolved");
    assert.ok(ping >= 0 && resolved > ping, `got: ${JSON.stringify(result.text)}`);
    assert.match(result.text, /event: case-resolved\ndata: .*\nid: \S+\n\n/, "the replayed event keeps its id, so a reconnecting browser can resume from it");
  });

  test("a case event that happens while the stream is open arrives too", async () => {
    const sessionId = `sess-live-${Date.now()}`;
    const { customers } = await import("../../src/fixtures/demo-data");
    const response = await app.request(`/chat/wismoAgent/events?sessionId=${sessionId}`);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const first = await reader.read();
    assert.ok(decoder.decode(first.value).includes("event: ping"));
    caseEvents.emit("resolved", { customerId: customers.cust_demo_01.id, sessionId, runId: "LIVERUN", orderId: "order_2001", action: "denied" });
    const second = await Promise.race([reader.read(), new Promise<"late">((resolve) => setTimeout(() => resolve("late"), 2000))]);
    await reader.cancel();
    assert.notEqual(second, "late", "the live event did not arrive");
    assert.ok(decoder.decode((second as { value: Uint8Array }).value).includes("event: case-resolved"));
  });
});
