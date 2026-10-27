// A turn that ends in a card (the order list, the item picker, the two offer cards) must end THERE. It used to give the
// model one more full step after the card (a ~9s model call), and the whole time the stream stayed open the customer's chat
// was locked, with no typing dots (the card is already showing) and nothing to say it was still busy: "I clicked where is
// my order, the list shows, then I'm stuck".
//
// The real chat route, the real agent and tools, against a fake model API served from this process: no real model, no cost.
// Run with: npx tsx --test --test-force-exit tests/mastra/chat-turn-ends-after-card.test.ts (from apps/agent)

import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let trailingStepMs = 4000; // how long the fake model takes for any call after the first, like a real model call
let alsoLookUpOrder = false; // the first step calls the lookup tool as well as the order list, in parallel

let modelCalls = 0;
const sse = (res: import("node:http").ServerResponse, event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

const fakeModel = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    const parsed = JSON.parse(body || "{}");
    const afterToolResult = (parsed.messages ?? []).some((m: any) => Array.isArray(m.content) && m.content.some((c: any) => c.type === "tool_result"));
    modelCalls++;
    res.writeHead(200, { "content-type": "text/event-stream" });
    sse(res, "message_start", { type: "message_start", message: { id: `msg_${modelCalls}`, type: "message", role: "assistant", model: parsed.model ?? "claude", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } });
    if (!afterToolResult) {
      const tool = (parsed.tools ?? []).map((t: any) => t.name as string).find((name: string) => /listOrders/i.test(name)) ?? "commerceListOrdersForCustomer";
      sse(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: tool, input: {} } });
      sse(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } });
      sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
      if (alsoLookUpOrder) {
        const lookup = (parsed.tools ?? []).map((t: any) => t.name as string).find((name: string) => /getOrder/i.test(name)) ?? "commerceGetOrder";
        sse(res, "content_block_start", { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_2", name: lookup, input: {} } });
        sse(res, "content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: JSON.stringify({ orderId: "order_2001" }) } });
        sse(res, "content_block_stop", { type: "content_block_stop", index: 1 });
      }
      sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 5 } });
      sse(res, "message_stop", { type: "message_stop" });
      res.end();
    } else {
      setTimeout(() => {
        sse(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
        sse(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Here are your orders." } });
        sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
        sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 6 } });
        sse(res, "message_stop", { type: "message_stop" });
        res.end();
      }, trailingStepMs);
    }
  });
});
await new Promise<void>((resolve) => fakeModel.listen(0, "127.0.0.1", resolve));
const port = (fakeModel.address() as AddressInfo).port;

const dir = mkdtempSync(join(tmpdir(), "wismo-cardturn-"));
process.env.ANTHROPIC_API_KEY = "test-key-not-real";
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}/v1`;
process.env.AGENT_DB_URL = `file:${join(dir, "test.db")}`;
process.env.WISMO_TICKETS_FILE = join(dir, "disagreement-tickets.json");

const { app } = await import("../../src/server");

describe("a turn that shows a card ends with the card", () => {
  after(() => {
    fakeModel.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function askForOrders() {
    modelCalls = 0;
    const sessionId = `card-turn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const started = Date.now();
    const response = await app.request("/chat/wismoAgent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "Where is my order?" }] }], sessionId, conversationId: sessionId }),
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    return { text, elapsed: Date.now() - started };
  }

  test("asking for the order list: the list arrives, the stream closes at once, and the model is called once", async () => {
    trailingStepMs = 4000;
    alsoLookUpOrder = false;
    const { text, elapsed } = await askForOrders();
    assert.ok(text.includes("tool-output-available"), "the order list result should be in the stream");
    assert.equal(modelCalls, 1, "no second model call after the card");
    assert.ok(elapsed < trailingStepMs - 1000, `the stream should close right after the card, not after another model call (took ${elapsed}ms)`);
  });

  test("control: when the same step ALSO looked something up, the model still gets its next step to read the result", async () => {
    trailingStepMs = 200;
    alsoLookUpOrder = true;
    const { text } = await askForOrders();
    assert.ok(text.includes("tool-output-available"), "the order list result should be in the stream");
    assert.equal(modelCalls, 2, "the lookup's result has to be read, so the turn must not end at the card");
  });
});
