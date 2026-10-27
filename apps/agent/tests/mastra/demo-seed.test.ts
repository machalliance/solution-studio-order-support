// Every flow that starts a case must supply the open-case amount the policy REQUIRES (a missing figure is
// "unavailable", so the case escalates with a generic policy-evaluation-error instead of its real reason). The
// demo seed was the one flow that didn't — found 2026-10-08, after a demo reset showed the seeded cases with no
// real reason. Runs the real seed against a throwaway database.
//
// resetDemoData also clears the disagreement-tickets file, so this test points WISMO_TICKETS_FILE at a temp file
// and never touches the real data/disagreement-tickets.json.
//
// Run with: npx tsx --test --test-force-exit src/mastra/demo-seed.test.ts

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "wismo-seed-"));
process.env.AGENT_DB_URL = `file:${join(dir, "test.db")}`;

process.env.WISMO_TICKETS_FILE = join(dir, "disagreement-tickets.json");

const { mastra } = await import("../../src/mastra/index");
const { resetDemoData } = await import("../../src/mastra/demo-seed");
const { getThread, saveThread } = await import("../../src/mastra/conversation-threads");
const { POLICY_REVIEW_STEP_ID } = await import("../../src/mastra/workflows/policy-review-workflow");

describe("the demo seed", () => {
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  let seeded: Array<{ runId: string; orderId: string; reasonCode?: string; policyNumber?: string }> = [];

  before(async () => {
    // A chat conversation stored before the reset, to see that the reset clears it with everything else.
    await saveThread({ conversationId: "conv-before-reset", sessionId: "sess-before-reset", customerId: "cust_demo_01", messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "hello" }] }] });
    const summary = await resetDemoData(mastra as any);
    assert.ok(summary.createdCases >= 5, `expected the seeded scenarios to suspend, got ${summary.createdCases}`);
    const { runs } = await mastra.getWorkflow("policyReviewWorkflow")!.listWorkflowRuns({});
    seeded = (runs as any[]).map((run) => {
      const snapshot = typeof run.snapshot === "string" ? JSON.parse(run.snapshot) : run.snapshot;
      const step = snapshot?.context?.[POLICY_REVIEW_STEP_ID];
      const payload = step?.suspendPayload?.[POLICY_REVIEW_STEP_ID] ?? step?.suspendPayload ?? {};
      return { runId: run.runId, orderId: step?.payload?.orderId, reasonCode: payload.reasonCode, policyNumber: payload.policy?.number };
    });
  });

  test("clears the stored chat conversations", async () => {
    assert.equal(await getThread("conv-before-reset"), undefined);
  });

  test("seeds cases", () => {
    assert.ok(seeded.length >= 5);
  });

  test("no seeded case escalated because of a policy evaluation error", () => {
    const failed = seeded.filter((c) => c.reasonCode === "policy-evaluation-error");
    assert.deepEqual(failed, [], "these cases escalated with policy-evaluation-error — a flow is starting cases without a figure the policy requires");
  });

  test("every seeded case carries the rule that sent it to a person", () => {
    for (const c of seeded) assert.ok(c.reasonCode && c.policyNumber, `case ${c.runId} (${c.orderId}) has reason ${c.reasonCode} / policy ${c.policyNumber}`);
  });
});
