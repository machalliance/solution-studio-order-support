import { test } from "node:test";
import assert from "node:assert/strict";
import { createKeyedLock } from "../../src/mastra/keyed-lock";
import { newReviewDeadline, reviewDeadline } from "../../src/mastra/case-state";

test("snapshot edits wait for resolution and recheck terminal state", async () => {
  const lock = createKeyedLock();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let status = "suspended";
  let staleWrite = false;
  const resolution = lock.withLock("case", async () => { await gate; status = "resolved"; });
  const edit = lock.withLock("case", async () => { if (status === "suspended") staleWrite = true; });
  release();
  await Promise.all([resolution, edit]);
  assert.equal(staleWrite, false);
});
test("a rejected operation does not strand its case lock", async () => {
  const lock = createKeyedLock();
  await assert.rejects(lock.withLock("case", async () => { throw new Error("failed"); }));
  assert.equal(await lock.withLock("case", async () => "next"), "next");
});
test("existing deadlines are stable; legacy deadlines use creation time", () => {
  const createdAt = "2026-01-01T00:00:00.000Z";
  const reviewDeadlineIso = "2026-01-01T00:05:00.000Z";
  assert.equal(reviewDeadline({ createdAt, reviewDeadlineIso }), reviewDeadlineIso);
  assert.equal(reviewDeadline({ createdAt }), newReviewDeadline(Date.parse(createdAt)));
});
