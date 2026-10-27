import { createTool } from "@mastra/core/tools";
import { z } from "zod";

// The ONLY way wismoAgent may say anything to the customer (see wismo-agent.ts's ground rules),
// replacing free assistant text. Splitting `reasoning` from `message` doesn't GUARANTEE reasoning never
// lands in `message` (same model, same generation; it is still instruction-following). What it buys,
// structurally:
//   1. reasoning is captured as this tool call's INPUT, which Mastra's observability already traces, so
//      it appears in the Escalation Desk's Activity trail and a rep can see WHY the agent did something.
//   2. ChatWidget.tsx's renderer reads ONLY `.message` off the tool's RESULT, so `.reasoning` never
//      reaches the component that renders the bubble. That alone is a rendering-layer guarantee, not a
//      transport one: the AI SDK's UIMessage stream also echoes the tool's full INPUT to the client as
//      it streams. server.ts's redactReasoningFromClientStream strips `reasoning` from the outgoing
//      stream (server-side tracing is untouched), so it never reaches the browser's network layer.
//   3. response-leak-guard.ts's beforeToolCall hook gets a clean interception point (this exact call)
//      to scan `message` for leak signals and swap in a safe fallback BEFORE it reaches the customer,
//      which isn't possible for freeform streamed text without buffering the whole stream.
export const respondToCustomer = createTool({
  id: "respond_to_customer",
  description:
    "The only way to say anything to the customer — a narration before a tool call, a reaction to a result, an answer, a clarifying question, anything. Never produce plain text directly; always call this instead. `reasoning` is for you only (never rendered in the chat, but traced for governance) — put your own analysis, which tool you're about to call and why, policy evaluation, or anything about internal state there, staying factual rather than including anything you wouldn't want read back verbatim. `message` is exactly what the customer sees — plain, natural customer-service language only. No analysis, no deliberation, no mention of tools, functions, internal identifiers, reason codes, or policy mechanics.",
  inputSchema: z.object({
    reasoning: z
      .string()
      .describe("Private. Your own reasoning, tool-selection rationale, or policy evaluation — never rendered in the chat, but keep it factual rather than including anything you wouldn't want read back verbatim."),
    message: z
      .string()
      .describe(
        "Exactly what the customer sees, verbatim. Plain customer-service language only — never reference tools, functions, internal identifiers, reason codes, or why you're doing something; just say the thing itself."
      ),
  }),
  // `error` is optional and ABSENT on a genuine reply. claim-grounding-guard.ts returns {error: true, message}
  // (message = a correction for the model, never shown) when a reply states a specific that isn't in the
  // facts; Mastra drops fields a schema doesn't declare, so without this the flag could vanish and the
  // correction would be rendered to the customer as if it were the reply.
  outputSchema: z.object({ message: z.string(), error: z.boolean().optional() }),
  // Not gated like paymentIssueRefund/paymentIssueReturnRefund's own stubs — this one
  // genuinely runs. response-leak-guard.ts's hook only intercepts (replacing the
  // output) when it actually finds a leak signal; otherwise this executes normally.
  execute: async ({ message }) => ({ message }),
});
