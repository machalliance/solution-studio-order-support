import { test } from "node:test";
import assert from "node:assert/strict";
import { createEventHistory } from "../../src/mastra/event-history";

test("replay only missed events for the correct customer and session", () => {
  const history = createEventHistory();
  const first = history.record("started", { customerId: "c", sessionId: "s" }, 1);
  history.record("other-tab", { customerId: "c", sessionId: "other" }, 2);
  history.record("other-customer", { customerId: "other", sessionId: "s" }, 3);
  const missed = history.record("resolved", { customerId: "c", sessionId: "s" }, 4);
  assert.deepEqual(history.since("c", "s", first.id, 5), [missed]);
  assert.deepEqual(history.since("c", "s", missed.id, 5), []);
  assert.deepEqual(history.since("c", "s", undefined, 5), [first, missed]);
});
test("history is bounded and expired events are not replayed", () => {
  const history = createEventHistory(2, 10);
  history.record("one", { customerId: "c", sessionId: "s" }, 0);
  history.record("two", { customerId: "c", sessionId: "s" }, 1);
  history.record("three", { customerId: "c", sessionId: "s" }, 2);
  assert.equal(history.since("c", "s", undefined, 3).length, 2);
  assert.equal(history.since("c", "s", undefined, 12).length, 0);
});
