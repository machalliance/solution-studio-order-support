// The agent's prompt and tools (~14.5k tokens) are the same on every model step of every turn, so the prompt carries a cache
// marker and the provider bills the repeats at a fraction of the normal input price. This checks what actually leaves the
// agent: on EVERY model call of a turn, including the later steps, the instructions block carries the marker, its text is the
// agent's own instructions untouched, and the tools are still all there.
//
// The real chat route and agent against a fake model API served from this process: no real model, no cost.
// Run with: npx tsx --test --test-force-exit tests/mastra/prompt-caching.test.ts (from apps/agent)

import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const requests: any[] = [];
const sse = (res: import("node:http").ServerResponse, event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

// First call: the order-list tool AND the order lookup together, so the turn needs a second model call to read the lookup.
const fakeModel = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    const parsed = JSON.parse(body || "{}");
    requests.push(parsed);
    const afterToolResult = (parsed.messages ?? []).some((m: any) => Array.isArray(m.content) && m.content.some((c: any) => c.type === "tool_result"));
    res.writeHead(200, { "content-type": "text/event-stream" });
    sse(res, "message_start", { type: "message_start", message: { id: `msg_${requests.length}`, type: "message", role: "assistant", model: parsed.model ?? "claude", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } });
    if (!afterToolResult) {
      const names: string[] = (parsed.tools ?? []).map((t: any) => t.name);
      const list = names.find((n) => /listOrders/i.test(n)) ?? "commerceListOrdersForCustomer";
      const lookup = names.find((n) => /getOrder/i.test(n)) ?? "commerceGetOrder";
      sse(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: list, input: {} } });
      sse(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } });
      sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
      sse(res, "content_block_start", { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_2", name: lookup, input: {} } });
      sse(res, "content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: JSON.stringify({ orderId: "order_2001" }) } });
      sse(res, "content_block_stop", { type: "content_block_stop", index: 1 });
      sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 5 } });
    } else {
      sse(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
      sse(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } });
      sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
      sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } });
    }
    sse(res, "message_stop", { type: "message_stop" });
    res.end();
  });
});
await new Promise<void>((resolve) => fakeModel.listen(0, "127.0.0.1", resolve));
const port = (fakeModel.address() as AddressInfo).port;

const dir = mkdtempSync(join(tmpdir(), "wismo-caching-"));
process.env.ANTHROPIC_API_KEY = "test-key-not-real";
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}/v1`;
process.env.AGENT_DB_URL = `file:${join(dir, "test.db")}`;
process.env.WISMO_TICKETS_FILE = join(dir, "disagreement-tickets.json");

const { mastra } = await import("../../src/mastra/index");
const { app } = await import("../../src/server");

describe("the prompt cache marker", () => {
  after(() => {
    fakeModel.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("every model call of a multi-step turn carries it on the instructions block, with the prompt text and tools unchanged", async () => {
    const sessionId = `caching-${Date.now()}`;
    const response = await app.request("/chat/wismoAgent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "Where is my order?" }] }], sessionId, conversationId: sessionId }),
    });
    assert.equal(response.status, 200);
    await response.text();
    assert.ok(requests.length >= 2, `the turn should take at least two model calls to be a meaningful check (took ${requests.length})`);

    const instructions: any = await (mastra.getAgent("wismoAgent") as any).getInstructions();
    const promptText: string = typeof instructions === "string" ? instructions : instructions.content;
    assert.ok(promptText.startsWith("You are Wismo"), "the agent's instructions are the Wismo prompt");

    for (const [i, request] of requests.entries()) {
      const blocks: any[] = Array.isArray(request.system) ? request.system : [{ type: "text", text: String(request.system) }];
      const main = blocks.find((b) => b.text === promptText);
      assert.ok(main, `call ${i + 1}: the system prompt is the agent's own text, character for character`);
      assert.deepEqual(main.cache_control, { type: "ephemeral" }, `call ${i + 1}: the instructions block carries the cache marker`);
      assert.ok(blocks.filter((b) => b.cache_control).length <= 4, "the provider allows at most four cache markers");
      assert.equal((request.tools ?? []).length, 15, `call ${i + 1}: all tools are still sent`);
    }
  });
});
