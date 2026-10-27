// A real chat route and agent with a stand-in model API served from this process: no real model, no cost. Each test file that
// uses it runs in its own process, so the environment it sets (temporary database, policy folder, tickets file) belongs to that
// file alone. Import anything from `src/` AFTER calling createChatHarness (use `await import(...)`): the server and the Mastra
// instance read their environment when they load.
//
// The stand-in obeys the customer, which is the point: whatever a hostile customer talks a real model into, the code around it
// has to hold. A customer message may carry directives:
//   @@CALL <toolName> <json>   the model calls that tool with exactly that input (a name that is not a tool is called anyway)
//   @@SAY <text>               the model's reply is exactly that text (it repeats it if a guard sends it back)
//   @@SAYX <letters>           the same, hidden (see `hide`) so it is NOT among the customer's own words: the reply guards accept
//                              what the customer said themselves, numbers included, so an invented amount must not be typed by them
//   @@LEADIN <text>           with @@CALL: the first step ALSO sends <text> as a reply, beside the call (the "Let me check on that" line)
//   @@REPEAT <n>               after a tool result the model calls the same tool again, up to n times (a model that will not give up)
// Without a directive it answers "Noted. Is there anything else I can help you with?", a closing question, which ends the turn.
// Behaviour switches, changeable between requests: `mode.failAfterTool` (the API refuses the call that follows a tool result),
// `mode.delayMs` (every call waits first), `mode.errorMidStream` (the reply starts, then the API sends an error event),
// `mode.quietWhenFree` (after a tool result, a model that is allowed to answer with nothing does: it stops. A turn that FORCES a
// tool call still gets its reply). The stand-in always obeys a tool choice the agent forces.

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const DEFAULT_REPLY = "Noted. Is there anything else I can help you with?";

interface HarnessMode {
  failAfterTool: boolean;
  delayMs: number;
  errorMidStream: boolean;
  quietWhenFree: boolean;
}

interface Ids {
  sessionId: string;
  conversationId: string;
}

// Each byte as two letters a-p (its two nibbles). Letters only, on purpose: any digit in the customer's message would count as a
// number the customer "said", and make an invented "3 days" look grounded.
export const hide = (text: string): string => Array.from(Buffer.from(text, "utf8")).map((b) => String.fromCharCode(97 + (b >> 4), 97 + (b & 15))).join("");
const unhide = (letters: string): string => Buffer.from(letters.match(/../g)!.map((pair) => ((pair.charCodeAt(0) - 97) << 4) | (pair.charCodeAt(1) - 97))).toString("utf8");

const sse = (res: import("node:http").ServerResponse, event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

export async function createChatHarness(options: { policy?: boolean } = {}) {
  const requests: any[] = [];
  const mode: HarnessMode = { failAfterTool: false, delayMs: 0, errorMidStream: false, quietWhenFree: false };

  const fakeModel = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      const parsed = JSON.parse(body || "{}");
      requests.push(parsed);
      if (mode.delayMs > 0) await new Promise((r) => setTimeout(r, mode.delayMs));
      const msgs: any[] = parsed.messages ?? [];
      const last = msgs[msgs.length - 1];
      // The API merges a customer's new text into the same user message as the previous turn's tool result, so a message that
      // carries a tool result is a MID-turn continuation only when it carries none of the customer's text.
      const lastIsToolResult = Array.isArray(last?.content) && last.content.some((c: any) => c.type === "tool_result") && !last.content.some((c: any) => c.type === "text");
      const textOf = (m: any): string => (m ? (typeof m.content === "string" ? m.content : (m.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join(" ")) : "");
      // The customer text this turn is answering: the newest message that carries any text.
      const customerText = [...msgs].reverse().map(textOf).find((t) => t.length > 0) ?? "";
      const tools: string[] = (parsed.tools ?? []).map((t: any) => t.name);

      if (lastIsToolResult && mode.failAfterTool) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "The stand-in refused this call after the tool ran." } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      sse(res, "message_start", { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: parsed.model ?? "claude", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } });

      if (mode.errorMidStream) {
        sse(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
        sse(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Partial reply" } });
        sse(res, "error", { type: "error", error: { type: "overloaded_error", message: "Overloaded" } });
        res.end();
        return;
      }

      const choice = parsed.tool_choice as { type?: string; name?: string } | undefined;
      const forcedName = choice?.type === "tool" ? choice.name : undefined;
      const mustCallATool = choice?.type === "any" || choice?.type === "tool";
      if (lastIsToolResult && mode.quietWhenFree && !mustCallATool) {
        // Allowed to answer with nothing, and does.
        sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } });
        sse(res, "message_stop", { type: "message_stop" });
        res.end();
        return;
      }
      const repeatMatch = /@@REPEAT (\d+)/.exec(customerText);
      const toolResultsThisTurn = msgs.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((c: any) => c.type === "tool_result").length;
      const repeating = lastIsToolResult && repeatMatch && !forcedName && toolResultsThisTurn < Number(repeatMatch[1]) + 1;
      const call = !lastIsToolResult || repeating ? /@@CALL (\S+) (\{.*\})/.exec(customerText) : null;
      const leadIn = !lastIsToolResult ? /@@LEADIN ([^@]+)/.exec(customerText) : null;
      const sayHidden = /@@SAYX ([a-p]+)/.exec(customerText);
      const say = sayHidden ? ([null, unhide(sayHidden[1])] as const) : /@@SAY (.+)/.exec(customerText);
      let name: string;
      let input: Record<string, unknown>;
      let callInput: Record<string, unknown> | undefined;
      try {
        callInput = call ? JSON.parse(call[2]) : undefined;
      } catch {
        // A directive that is not valid JSON is just text, as far as the stand-in is concerned.
      }
      if (call && callInput && !forcedName) {
        name = tools.find((n) => n === call[1]) ?? call[1];
        input = callInput;
      } else {
        name = forcedName ?? tools.find((n) => n === "respondToCustomer") ?? "respondToCustomer";
        input = { reasoning: "private", message: say ? say[1].trim() : DEFAULT_REPLY };
      }
      let blockIndex = 0;
      const sendToolUse = (toolName: string, toolInput: Record<string, unknown>) => {
        sse(res, "content_block_start", { type: "content_block_start", index: blockIndex, content_block: { type: "tool_use", id: `toolu_${randomUUID().slice(0, 8)}`, name: toolName, input: {} } });
        sse(res, "content_block_delta", { type: "content_block_delta", index: blockIndex, delta: { type: "input_json_delta", partial_json: JSON.stringify(toolInput) } });
        sse(res, "content_block_stop", { type: "content_block_stop", index: blockIndex });
        blockIndex++;
      };
      // "Let me check on that" beside the lookup, in one step, as the real model often does.
      if (leadIn && call && callInput && !forcedName) sendToolUse("respondToCustomer", { reasoning: "private", message: leadIn[1].trim() });
      sendToolUse(name, input);
      sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 5 } });
      sse(res, "message_stop", { type: "message_stop" });
      res.end();
    });
  });
  await new Promise<void>((resolve) => fakeModel.listen(0, "127.0.0.1", resolve));
  const port = (fakeModel.address() as AddressInfo).port;

  const dir = mkdtempSync(join(tmpdir(), "wismo-harness-"));
  process.env.ANTHROPIC_API_KEY = "test-key-not-real";
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}/v1`;
  process.env.AGENT_DB_URL = `file:${join(dir, "test.db")}`;
  process.env.WISMO_TICKETS_FILE = join(dir, "disagreement-tickets.json");
  process.env.WISMO_POLICY_DIR = join(dir, "policy");

  const { app } = await import("../../../src/server");
  if (options.policy) {
    const { activatePolicy } = await import("../../../src/mastra/policy/repository");
    const { buildBaseDraft } = await import("../../../src/mastra/policy/base-draft");
    const result = await activatePolicy("demo", buildBaseDraft());
    if (!result.ok) throw new Error("the shipped policy did not activate");
  }

  const newIds = (): Ids => ({ sessionId: `sess-${randomUUID()}`, conversationId: `conv-${randomUUID()}` });
  const userMessage = (text: string) => ({ id: randomUUID(), role: "user", parts: [{ type: "text", text }] });

  async function post(body: unknown, rawBody?: string) {
    const response = await app.request("/chat/wismoAgent", { method: "POST", headers: { "content-type": "application/json" }, body: rawBody ?? JSON.stringify(body) });
    const text = await response.text();
    return { status: response.status, text, response };
  }

  // One customer message in a conversation.
  const turn = (ids: Ids, text: string) => post({ messages: [userMessage(text)], ...ids });

  return {
    app,
    requests,
    mode,
    dir,
    newIds,
    userMessage,
    post,
    turn,
    /** Every reply the customer was actually shown in a stored thread: respond_to_customer results that are not errors. */
    async shownReplies(conversationId: string): Promise<string[]> {
      const { getThread } = await import("../../../src/mastra/conversation-threads");
      const thread = await getThread(conversationId);
      return (thread?.messages ?? [])
        .filter((m) => m.role === "assistant")
        .flatMap((m) => m.parts as any[])
        .filter((p) => p.type === "tool-respondToCustomer" && p.state === "output-available" && p.output?.error !== true)
        .map((p) => String(p.output?.message ?? ""));
    },
    /** The stored tool parts of one tool across a thread. */
    async toolParts(conversationId: string, toolName: string): Promise<any[]> {
      const { getThread } = await import("../../../src/mastra/conversation-threads");
      const thread = await getThread(conversationId);
      return (thread?.messages ?? []).flatMap((m) => m.parts as any[]).filter((p) => p.type === `tool-${toolName}`);
    },
    close() {
      fakeModel.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
