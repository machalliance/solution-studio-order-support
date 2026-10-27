// A customer who gets "Let me check on that for you" must then get an ANSWER, even when the lookup behind it fails (a mistyped order
// number, an order that is not theirs) or when the model, left free to, would say nothing more. The agent often sends that opening
// line and the lookup in the same step; its result is still to be told. A turn ends early only for a failure that cannot be
// recovered from in this turn: a tool that does not exist, or the model service failing.
//
// The real chat route, agent, tools and turn-ending rules against a stand-in model API (helpers/chat-harness.ts). No cost.
// Run with: npx tsx --test --test-force-exit tests/mastra/chat-failed-lookup.test.ts (from apps/agent)

import { describe, test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createChatHarness } from "./helpers/chat-harness";

const h = await createChatHarness({ policy: true });
const LEAD_IN = "Let me check on that for you.";
const withLeadIn = (tool: string, input: unknown) => `@@LEADIN ${LEAD_IN} @@CALL ${tool} ${JSON.stringify(input)}`;

describe("an answer after the opening line", () => {
  beforeEach(() => {
    h.requests.length = 0;
    h.mode.quietWhenFree = false;
    h.mode.failAfterTool = false;
  });
  after(() => h.close());

  for (const [what, orderId] of [["an order that does not exist", "order_99999"], ["an order that is not this customer's", "order_7731"]] as const) {
    test(`a lookup that fails (${what}) is answered, not left at the opening line`, async () => {
      h.mode.quietWhenFree = true; // a model allowed to stop would stop: the turn must not allow it
      const ids = h.newIds();
      assert.equal((await h.turn(ids, withLeadIn("commerceGetOrder", { orderId }))).status, 200);
      const replies = await h.shownReplies(ids.conversationId);
      assert.equal(replies[0], LEAD_IN);
      assert.ok(replies.length >= 2, `the customer got only: ${JSON.stringify(replies)}`);
      assert.notEqual(replies[replies.length - 1], LEAD_IN, "the last thing the customer was shown is not the opening line");
      const [lookup] = await h.toolParts(ids.conversationId, "commerceGetOrder");
      assert.equal(lookup.state, "output-error", "the lookup really did fail");
    });
  }

  test("a lookup that works is answered even when a free step would stay silent", async () => {
    h.mode.quietWhenFree = true;
    const ids = h.newIds();
    await h.turn(ids, withLeadIn("commerceGetOrder", { orderId: "order_2001" }));
    const replies = await h.shownReplies(ids.conversationId);
    assert.equal(replies[0], LEAD_IN);
    assert.ok(replies.length >= 2, `the customer got only: ${JSON.stringify(replies)}`);
  });

  test("a model that answers on its own is not made to say it twice: two replies, two model calls", async () => {
    const ids = h.newIds();
    await h.turn(ids, `${withLeadIn("commerceGetOrder", { orderId: "order_2001" })} @@SAY Your order is on its way. Is there anything else I can help you with?`);
    assert.deepEqual(await h.shownReplies(ids.conversationId), [LEAD_IN, "Your order is on its way. Is there anything else I can help you with?"]);
    assert.equal(h.requests.length, 2);
  });

  test("a lookup that keeps failing is not retried without end, and the customer still gets a final reply", async () => {
    const ids = h.newIds();
    await h.turn(ids, `${withLeadIn("commerceGetOrder", { orderId: "order_99999" })} @@REPEAT 12`);
    assert.ok(h.requests.length <= 8, `the turn used ${h.requests.length} model calls`);
    const replies = await h.shownReplies(ids.conversationId);
    assert.ok(replies.length >= 2 && replies[replies.length - 1] !== LEAD_IN, `the customer got: ${JSON.stringify(replies)}`);
  });

  test("a tool that does not exist still ends the turn at once (an unrecoverable failure)", async () => {
    const ids = h.newIds();
    await h.turn(ids, withLeadIn("adminRefundEverything", { orderId: "order_2001" }));
    assert.deepEqual(await h.shownReplies(ids.conversationId), [LEAD_IN]);
    assert.equal(h.requests.length, 1, "no further model call was spent on it");
  });

  test("the model service failing after the opening line still ends the turn, and the browser is told", async () => {
    h.mode.failAfterTool = true;
    const ids = h.newIds();
    const { text } = await h.turn(ids, withLeadIn("commerceGetOrder", { orderId: "order_2001" }));
    assert.ok(/"type":"error"/.test(text), "the stream carries the error");
    assert.deepEqual(await h.shownReplies(ids.conversationId), [LEAD_IN]);
  });
});
