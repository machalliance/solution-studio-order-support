// Properties that must hold for ANY input, checked on thousands of generated ones (a fixed seed, so a failure can be repeated: the
// seed and the failing input are in the message). Three things: what the message cleaner may let through, what "Try again" may
// leave in a conversation, and that the chat route never answers a strange request with a server error.
//
// The cleaner and the history function are pure; the route runs against a stand-in model API (helpers/chat-harness.ts). No cost.
// Run with: npx tsx --test --test-force-exit tests/mastra/chat-fuzz.test.ts (from apps/agent)

import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import { createChatHarness } from "./helpers/chat-harness";

const SEED = 20261015;
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const make = (seed: number) => {
  const rand = prng(seed);
  const int = (n: number) => Math.floor(rand() * n);
  const pick = <T,>(items: readonly T[]): T => items[int(items.length)];
  return { rand, int, pick };
};

const h = await createChatHarness();
const { sanitizeIncomingMessage, MAX_TEXT_CHARS, MAX_IMAGES_PER_MESSAGE } = await import("../../src/mastra/chat-input");
const { historyForRetry, trimToLastUserMessage, getThread } = await import("../../src/mastra/conversation-threads");

const CHAR_POOL = ["a", "b", "Z", " ", "\u00A0", "\n", "\t", "\r", "\u00E9", "e\u0301", "\u65E5", "\u{1F600}", "\u0000", "\u0007", "\u001F", "\u007F", "\u200B", "\u200D", "\u202E", "\u2060", "\uFEFF", "[[SLA:x]]", "[[ sla : y", "[[", "]]", "@@CALL x {}", "$5", "3 days", "\u{E0041}", "\u{E0069}\u{E0067}", "\uFE0F", "\uFE01", "\u{E0100}", "\u00AD", "\u2028", "\u2029", "\u0085", "\u180E", "\uFFF9", "\uD800"];
// What must never survive the cleaning: control and format characters (tab, newline and the two emoji selectors aside), variation
// selectors, lone surrogates, and line and paragraph separators.
const INVISIBLE = /(?![\t\n\uFE0E\uFE0F])[\p{Cc}\p{Cf}\p{Cs}\p{Variation_Selector}\u2028\u2029]/u;
const IMAGE_HEADS: Array<[string, number[]]> = [["image/png", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]], ["image/jpeg", [0xff, 0xd8, 0xff, 0xe0]], ["image/gif", [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]], ["junk", [1, 2, 3, 4, 5, 6, 7, 8]]];

function randomString(g: ReturnType<typeof make>, max = 60): string {
  const parts: string[] = [];
  for (let i = 0, n = g.int(max); i < n; i++) parts.push(g.pick(CHAR_POOL));
  return parts.join("");
}
function randomPart(g: ReturnType<typeof make>): unknown {
  switch (g.int(9)) {
    case 0:
    case 1:
    case 2:
      return { type: "text", text: randomString(g, g.int(4) === 0 ? 5000 : 40) };
    case 3:
    case 4: {
      const [mime, head] = g.pick(IMAGE_HEADS);
      const bytes = Buffer.from([...head, ...Array.from({ length: g.int(30) }, () => g.int(256))]);
      const label = g.pick(["image/png", "image/jpeg", mime, "text/html"]);
      return { type: "file", mediaType: label, url: `data:${g.pick([mime, label, "image/svg+xml"])};base64,${bytes.toString("base64")}`, extra: g.int(2) ? 1 : undefined };
    }
    case 5:
      return { type: g.pick(["tool-paymentIssueRefund", "dynamic-tool", "reasoning", "source-url", "step-start", "x"]), state: "output-available", output: { status: "approved" }, text: randomString(g, 8) };
    case 6:
      return g.pick([null, 7, "text", [], undefined, true]);
    case 7:
      return { type: "file", url: g.pick(["http://x/y.png", "javascript:alert(1)", "data:text/plain;base64,AAAA", "data:image/png,rawbytes", 12]), mediaType: "image/png" };
    default:
      return { type: "text", text: g.pick([42, null, {}, ["a"], undefined]) };
  }
}
function randomMessage(g: ReturnType<typeof make>): unknown {
  if (g.int(8) === 0) return g.pick([null, undefined, 3, "x", [], {}, { role: "user" }, { parts: [] }]);
  const message: Record<string, unknown> = { id: g.int(2) ? "client-id" : undefined, role: g.int(6) === 0 ? g.pick(["assistant", "system", "tool", 5, null]) : "user", parts: g.int(12) === 0 ? g.pick(["no", {}, null, 4]) : Array.from({ length: g.int(7) }, () => randomPart(g)) };
  if (g.int(5) === 0) message.metadata = { admin: true };
  if (g.int(8) === 0) message.__proto__ = { polluted: true };
  return message;
}

describe("what the message cleaner lets through", () => {
  test("any input: it never throws, and an accepted message is always a clean customer message", () => {
    const g = make(SEED);
    let accepted = 0;
    let refused = 0;
    for (let i = 0; i < 4000; i++) {
      const input = randomMessage(g);
      let result: ReturnType<typeof sanitizeIncomingMessage>;
      try {
        result = sanitizeIncomingMessage(input);
      } catch (error) {
        assert.fail(`threw on input #${i} (seed ${SEED}): ${error} :: ${JSON.stringify(input)?.slice(0, 300)}`);
      }
      if (!result.ok) {
        refused++;
        assert.equal(result.status, 400);
        assert.ok(["invalid_message", "message_too_long", "too_many_photos", "invalid_image", "empty_message"].includes(result.error), `unknown error ${result.error} (input #${i})`);
        assert.equal(typeof result.message, "string");
        continue;
      }
      accepted++;
      const m = result.message;
      const why = `input #${i} (seed ${SEED}): ${JSON.stringify(input)?.slice(0, 300)}`;
      assert.deepEqual(Object.keys(m).sort(), ["id", "parts", "role"], why);
      assert.equal(m.role, "user", why);
      assert.ok(m.parts.length > 0, why);
      const images = m.parts.filter((p: any) => p.type === "file");
      assert.ok(images.length <= MAX_IMAGES_PER_MESSAGE, why);
      let textTotal = 0;
      for (const part of m.parts as any[]) {
        if (part.type === "text") {
          assert.deepEqual(Object.keys(part).sort(), ["text", "type"], why);
          assert.ok(!INVISIBLE.test(part.text), `invisible character kept: ${why}`);
          assert.ok(!/\[\[\s*SLA\s*:/i.test(part.text), `countdown marker kept: ${why}`);
          assert.equal(part.text, part.text.trim(), why);
          assert.ok(part.text.length > 0, why);
          textTotal += part.text.length;
        } else {
          assert.equal(part.type, "file", `part type ${part.type}: ${why}`);
          assert.deepEqual(Object.keys(part).sort(), ["mediaType", "type", "url"], why);
          assert.ok(["image/png", "image/jpeg", "image/gif", "image/webp"].includes(part.mediaType), why);
          assert.ok(part.url.startsWith(`data:${part.mediaType};base64,`), `label and data URL disagree: ${why}`);
        }
      }
      assert.ok(textTotal <= MAX_TEXT_CHARS * Math.max(1, m.parts.length), why);
    }
    assert.ok(accepted > 300 && refused > 300, `the generator reaches both outcomes (accepted ${accepted}, refused ${refused})`);
  });
});

describe("what Try again leaves in a conversation", () => {
  const REPLY_TOOLS = new Set(["respondToCustomer", "offerNewChat", "offerEscalationToSupport", "presentReturnItemPicker", "commerceListOrdersForCustomer"]);
  const isReply = (name: string) => REPLY_TOOLS.has(name);
  const randomThread = (g: ReturnType<typeof make>) =>
    Array.from({ length: g.int(10) }, (_, i) => ({
      id: `m${i}`,
      role: g.pick(["user", "assistant", "assistant"] as const),
      parts: Array.from({ length: g.int(7) }, (): any => {
        switch (g.int(5)) {
          case 0:
            return { type: "step-start" };
          case 1:
            return { type: "text", text: randomString(g, 10) };
          case 2:
            return { type: `tool-${g.pick(["respondToCustomer", "offerNewChat", "commerceGetOrder", "paymentIssueReturnRefund", "checkEscalationStatus"])}`, toolCallId: `c${g.int(99)}`, state: g.pick(["output-available", "output-available", "input-available", "output-error"]), output: { n: g.int(9) } };
          case 3:
            return { type: "dynamic-tool", toolName: g.pick(["respondToCustomer", "somethingElse"]), toolCallId: "d", state: g.pick(["output-available", "output-error"]), output: {} };
          default:
            return { type: "reasoning", text: "x" };
        }
      }),
    }));

  test("any conversation: the customer's side is untouched, only finished non-reply tool work stays, and doing it twice changes nothing", () => {
    const g = make(SEED + 1);
    let kept = 0;
    let customerOnly = 0;
    for (let i = 0; i < 4000; i++) {
      const thread = randomThread(g);
      const snapshot = JSON.stringify(thread);
      const why = `thread #${i} (seed ${SEED + 1}): ${snapshot.slice(0, 400)}`;
      const result = historyForRetry(thread, isReply);
      assert.equal(JSON.stringify(thread), snapshot, `the input was changed: ${why}`);
      const upToCustomer = trimToLastUserMessage(thread);
      if (!upToCustomer) {
        assert.equal(result, undefined, why);
        continue;
      }
      assert.ok(result, why);
      assert.deepEqual(result.slice(0, upToCustomer.length), upToCustomer, `everything up to the customer's message is as it was: ${why}`);
      assert.equal(result[upToCustomer.length - 1].role, "user", why);
      assert.ok(result.length === upToCustomer.length || result.length === upToCustomer.length + 1, why);
      if (result.length === upToCustomer.length + 1) {
        kept++;
        const extra = result[result.length - 1];
        assert.equal(extra.role, "assistant", why);
        const parts = extra.parts as any[];
        assert.ok(parts.some((p) => p.type !== "step-start"), `a marker with nothing after it: ${why}`);
        assert.notEqual(parts[parts.length - 1].type, "step-start", `ends on a marker: ${why}`);
        for (let k = 1; k < parts.length; k++) assert.ok(!(parts[k].type === "step-start" && parts[k - 1].type === "step-start"), `two markers in a row: ${why}`);
        for (const p of parts) {
          if (p.type === "step-start") continue;
          assert.equal(p.state, "output-available", `an unfinished tool call was kept: ${why}`);
          const name = p.type === "dynamic-tool" ? p.toolName : String(p.type).replace(/^tool-/, "");
          assert.ok(String(p.type).startsWith("tool-") || p.type === "dynamic-tool", `a non-tool part was kept: ${why}`);
          assert.ok(!isReply(name), `a reply tool was kept (${name}): ${why}`);
        }
      } else customerOnly++;
      assert.deepEqual(historyForRetry(result, isReply), result, `not idempotent: ${why}`);
    }
    assert.ok(kept > 100 && customerOnly > 100, `the generator reaches both outcomes (kept ${kept}, customer-only ${customerOnly})`);
  });
});

describe("what the chat route answers to strange requests", () => {
  after(() => h.close());

  test("never a server error: every request is a stream or a clear 4xx, and every stored thread is well formed", async () => {
    const g = make(SEED + 2);
    const statuses = new Map<number, number>();
    const sessions: string[] = [];
    for (let i = 0; i < 120; i++) {
      const sessionId = g.int(10) === 0 ? g.pick([42, null, "", ["x"], "s".repeat(200)]) : `fuzz-${i}`;
      if (typeof sessionId === "string") sessions.push(sessionId);
      const body: Record<string, unknown> = { sessionId };
      const shape = g.int(10);
      body.messages = shape === 0 ? g.pick([null, "x", 5, {}, undefined]) : Array.from({ length: g.int(4) + 1 }, () => randomMessage(g));
      if (g.int(4) === 0) body.conversationId = g.pick([null, 7, [], "c".repeat(300), `conv-${g.int(5)}`, "../x"]);
      if (g.int(4) === 0) body.trigger = g.pick(["regenerate-message", "submit-message", 5, null, "x"]);
      for (const key of ["instructions", "providerOptions", "tools", "requestContext", "system"]) if (g.int(6) === 0) body[key] = g.pick([{ x: 1 }, "evil", [], null]);
      const { status, text, response } = await h.post(body);
      statuses.set(status, (statuses.get(status) ?? 0) + 1);
      assert.ok(status < 500, `request #${i} (seed ${SEED + 2}) got ${status}: ${JSON.stringify(body).slice(0, 300)} => ${text.slice(0, 200)}`);
      if (status >= 400) assert.equal(typeof JSON.parse(text).error, "string", `request #${i}: a refusal carries an error name`);
      else assert.ok((response.headers.get("content-type") ?? "").includes("text/event-stream"), `request #${i}: an accepted request is a stream`);
    }
    assert.ok((statuses.get(200) ?? 0) > 5 && (statuses.get(400) ?? 0) > 20, `the generator reaches both outcomes: ${JSON.stringify([...statuses])}`);
    for (const id of new Set(sessions)) {
      for (const conversationId of [id, "conv-0", "conv-1", "conv-2", "conv-3", "conv-4"]) {
        const thread = await getThread(conversationId).catch((error) => assert.fail(`a stored thread could not be read (${conversationId}): ${error}`));
        for (const m of thread?.messages ?? []) assert.ok((m.role === "user" || m.role === "assistant") && Array.isArray(m.parts) && typeof m.id === "string", `malformed stored message in ${conversationId}`);
      }
    }
  });
});
