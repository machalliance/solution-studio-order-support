// The reply guard must keep internal reason codes out of customer messages, including the code of a rule
// added to policy.json AFTER this code was written (on the Policies page, or accepted from the Policy
// Helper). It used to check only a hand-typed list, so a new rule's code was invisible to it until someone
// remembered to copy it over.

import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// A throwaway policy folder, so the activation test below never writes into the real data/policy.
const dir = mkdtempSync(join(tmpdir(), "wismo-leakguard-"));
process.env.WISMO_POLICY_DIR = join(dir, "policy");

const { createResponseLeakGuard, detectIdentifierLeak, REASON_CODES, SAFE_FALLBACK_MESSAGE } = await import("../../src/mastra/response-leak-guard");
const { activatePolicy, liveReasonCodes, reasonCodesOf } = await import("../../src/mastra/policy/repository");
const { buildBaseDraft } = await import("../../src/mastra/policy/base-draft");

const here = dirname(fileURLToPath(import.meta.url));
const AGENT_ROOT = join(here, "../..");
const SCRATCH = `test-leak-guard-${process.pid}-${Date.now()}`;
const NEW_CODE = "brand-new-reason-code";

describe("detectIdentifierLeak", () => {
  test("blocks a code from the fixed list, and leaves ordinary prose, links and case IDs alone", () => {
    assert.ok(detectIdentifierLeak("This was escalated because of return-outside-window."));
    assert.equal(detectIdentifierLeak("A specialist will take a look and follow up with you."), null);
    assert.equal(detectIdentifierLeak("Here is your label: https://returns.waybound.com/RTN-002001 (case 7K3PQR)."), null);
  });

  test("a code that exists nowhere is not blocked, until it is passed in as a live-policy code", () => {
    const message = `Sorry, ${NEW_CODE} applies to this request.`;
    assert.equal(detectIdentifierLeak(message), null);
    assert.ok(detectIdentifierLeak(message, [NEW_CODE]));
  });

  test("a plain one-word code, or one with a space or odd characters, is ignored", () => {
    assert.equal(detectIdentifierLeak("Please review this and reply.", ["review"]), null);
    assert.equal(detectIdentifierLeak("VIP members get priority.", ["VIP"]), null, "an all-caps single word reads as prose");
    assert.equal(detectIdentifierLeak("anything", ["x y-z", "(a|b)-c", ""]), null);
  });

  test("a code is blocked whatever its style: camelCase, PascalCase, any case of kebab, dotted, namespaced", () => {
    for (const code of ["brandNewReasonCode", "NeedsReview", "EXCEEDS-LIMIT", "Exceeds-Limit", "policy.fault.unknown", "policy:fault", "exceeds_limit"]) {
      assert.ok(detectIdentifierLeak(`Sorry, this was held because of ${code}.`, [code]), `${code} should be caught`);
    }
  });

  test("a code is matched whatever the case of the reply, and a dot in a code is a dot, not a wildcard", () => {
    assert.ok(detectIdentifierLeak("because of BRANDNEWREASON-CODE", ["brandnewreason-code"]));
    assert.ok(detectIdentifierLeak("because of exceeds-limit", ["EXCEEDS-LIMIT"]));
    assert.equal(detectIdentifierLeak("axb-c is fine", ["a.b-c"]), null);
    assert.ok(detectIdentifierLeak("a.b-c is held", ["a.b-c"]));
  });
});

describe("reasonCodesOf / liveReasonCodes", () => {
  test("a document's codes are its rules' and its fallback's", () => {
    const codes = reasonCodesOf(buildBaseDraft());
    assert.ok(codes.includes("one-return-per-order"));
    assert.ok(codes.includes("needs-a-person"), "the fallback's code is included");
    assert.equal(new Set(codes).size, codes.length, "no duplicates");
  });

  test("an unreadable or missing namespace gives no extra codes instead of throwing", async () => {
    assert.deepEqual(await liveReasonCodes("no-such-namespace-for-this-test"), []);
  });

  test("the codes are cached per policy file, yet a newly saved policy is seen at once (no stale codes)", async () => {
    const namespace = `${SCRATCH}-cache`;
    const draft = buildBaseDraft();
    assert.equal((await activatePolicy(namespace, draft)).ok, true);
    const before = await liveReasonCodes(namespace);
    assert.deepEqual(await liveReasonCodes(namespace), before, "a second read gives the same codes");
    const template = draft.rules.find((rule) => rule.kind === "restriction")!;
    const added = { ...template, id: "cache-test-rule", outcome: { ...template.outcome, reasonCode: "cache-test-code" } } as typeof template;
    delete (added as { number?: string }).number;
    assert.equal((await activatePolicy(namespace, { ...draft, rules: [...draft.rules, added] })).ok, true);
    assert.ok((await liveReasonCodes(namespace)).includes("cache-test-code"), "the code from the newly saved version is returned, not the cached one");
  });

  test("a rule added to the live policy is picked up with no change to the code", async () => {
    const draft = buildBaseDraft();
    const template = draft.rules.find((rule) => rule.kind === "restriction")!;
    const added = { ...template, id: "brand-new-rule", outcome: { ...template.outcome, reasonCode: NEW_CODE } } as typeof template;
    delete (added as { number?: string }).number;
    const activated = await activatePolicy(SCRATCH, { ...draft, rules: [...draft.rules, added] });
    assert.equal(activated.ok, true, JSON.stringify(activated));

    const codes = await liveReasonCodes(SCRATCH);
    assert.ok(codes.includes(NEW_CODE), "the new rule's code is read from the saved policy");
    assert.ok(codes.includes("one-return-per-order"), "the existing codes are still there");
    assert.ok(detectIdentifierLeak(`Because of ${NEW_CODE}.`, codes));
  });
});

describe("the guard hook", () => {
  const hook = createResponseLeakGuard(async () => [NEW_CODE]);
  const call = (message: unknown) => hook({ toolName: "respondToCustomer", input: { message } } as any);

  test("swaps a reply containing a live-policy code for the safe fallback", async () => {
    const result: any = await call(`That is because of ${NEW_CODE}.`);
    assert.equal(result.proceed, false);
    assert.equal(result.output.message, SAFE_FALLBACK_MESSAGE);
  });

  test("lets a clean reply through, and ignores other tools and a missing message", async () => {
    assert.equal(await call("Your return is approved."), undefined);
    assert.equal(await call(undefined), undefined);
    assert.equal(await hook({ toolName: "commerceGetOrder", input: { message: NEW_CODE } } as any), undefined);
  });
});

// The fixed list still has to hold every code that CODE produces (the ones no policy edit can add). Found by
// reading the source, so a new `reasonCode: "..."` somewhere in the agent that nobody added to the list
// fails here instead of reaching a customer.
describe("the fixed list covers every reason code the code itself produces", () => {
  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return sourceFiles(path);
      return path.endsWith(".ts") && !path.endsWith("response-leak-guard.ts") ? [path] : [];
    });
  }

  test("every multi-word reasonCode literal in src/ is in REASON_CODES", () => {
    const pattern = /reasonCode\s*[:=]\s*"([a-z0-9]+(?:-[a-z0-9]+)+)"/g;
    const missing: string[] = [];
    let found = 0;
    for (const file of sourceFiles(join(AGENT_ROOT, "src"))) {
      for (const match of readFileSync(file, "utf-8").matchAll(pattern)) {
        found++;
        if (!REASON_CODES.includes(match[1])) missing.push(`${match[1]} (${file.slice(AGENT_ROOT.length + 1)})`);
      }
    }
    assert.ok(found >= 6, `expected to find the reason codes the code produces, found ${found}`);
    assert.deepEqual(missing, [], `add these to REASON_CODES in response-leak-guard.ts`);
  });
});

after(() => rmSync(dir, { recursive: true, force: true }));
