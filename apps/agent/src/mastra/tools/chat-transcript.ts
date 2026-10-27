// Shared by every escalation path that needs to freeze a case's transcript at the
// moment it's created: refund-policy-gate.ts (refund + plain_return) and
// delivery-dispute.ts.

import { timestampFor } from "../message-timestamps";

interface RawMessagePart {
  type?: string;
  text?: string;
  // An AI SDK v5+ "file" part — what a customer's attached photo (ChatWidget.tsx's
  // SimpleImageAttachmentAdapter, via @assistant-ui/ai-sdk's toCreateMessage) actually
  // arrives as: not a distinct "image" part type, just a "file" part whose mediaType
  // happens to start with "image/". url is a data: URL, same shape demo-seed.ts's
  // synthesized damage photos already use for imageDataUrl below.
  url?: string;
  // The MODEL-facing form of the same photo (what refund-policy-gate.ts reads when it builds a new case's first
  // transcript from context.messages): {type:"file", mediaType, data} where data is a data: URL string — checked
  // against a real hook's context.messages — or, to be safe, a bare base64 string or raw bytes. No `url` there.
  data?: unknown;
  mediaType?: string;
  // Present on a "dynamic-tool" part (see toolNameOf below) — a respond_to_customer
  // tool call's own result, once resolved.
  toolName?: string;
  output?: unknown;
  // The MODEL-facing shape (see replyTextOf below): a {type:"tool-call", toolCallId,
  // toolName, input} part on an assistant message, answered by a {type:"tool-result",
  // toolCallId, output} part on a separate role:"tool" message.
  toolCallId?: string;
  input?: { message?: unknown };
}
interface RawMessage {
  id?: string;
  role?: string;
  content?: unknown;
  parts?: RawMessagePart[];
}

function messageParts(msg: RawMessage): RawMessagePart[] {
  return Array.isArray(msg.parts) ? msg.parts : Array.isArray(msg.content) ? (msg.content as RawMessagePart[]) : [];
}

// A tool-call part's name is the tool's JS registration key (camelCase) — either
// `{type: "tool-<name>", ...}` or `{type: "dynamic-tool", toolName, ...}` — same shape
// touched-orders-from-history.ts already verified against a real captured event.
function toolNameOf(part: RawMessagePart): string | undefined {
  if (part.type === "dynamic-tool") return part.toolName;
  if (typeof part.type === "string" && part.type.startsWith("tool-")) return part.type.slice("tool-".length);
  return undefined;
}

// Every customer-facing utterance is now a respond_to_customer tool call, not a text
// part (see wismo-agent.ts's ground rules) — a code-review finding caught that this
// function, unlike server.ts's own extractCustomerText, was never updated for that, so
// EVERY past agent turn silently vanished from a case's rebuilt transcript (case-
// sync.ts rebuilds from scratch on every sync) the moment this feature shipped, leaving
// only whatever server.ts's onFinish had separately, synthetically patched in for the
// CURRENT turn alone. Reads `.output.message` (what was actually said, post-leak-guard
// interception if any fired) rather than `.input.message` (what the model originally
// intended) — the transcript should reflect the real, possibly-substituted reply, same
// as what the customer actually saw.
function toolResponseText(part: RawMessagePart, resultsByCallId?: Map<string, string>): string | undefined {
  // The MODEL-facing shape: what a tool's execute()/a beforeToolCall hook sees as
  // context.messages (refund-policy-gate.ts builds a new case's first transcript from it).
  // There a reply is NOT a "tool-respondToCustomer" part — it's a {type:"tool-call"} part
  // on the assistant message, its result on a LATER role:"tool" message — so without this
  // branch every agent reply came out empty and was dropped: a case created and resolved in
  // one turn (an autonomous return) had a transcript of only the customer's own lines.
  // Prefers the recorded result (what was actually said, post-leak-guard) and falls back
  // to what the model asked to say if the result isn't in this slice of history.
  if (part.type === "tool-call") {
    if (part.toolName !== "respondToCustomer") return undefined;
    const settled = part.toolCallId ? resultsByCallId?.get(part.toolCallId) : undefined;
    return settled ?? (typeof part.input?.message === "string" ? part.input.message : undefined);
  }
  // The web-client shape (and what case-sync.ts's rebuild reads): a "tool-respondToCustomer"
  // part carrying its own result.
  if (toolNameOf(part) !== "respondToCustomer") return undefined;
  return replyTextOf(part.output);
}

// The words of a respond_to_customer RESULT, in either shape it arrives in: the plain
// {message} the browser resends, or an AI SDK model message's {type:"json", value:{message}}.
// A failed call (input validation) doesn't throw — @mastra/core hands back {error:true,
// message:"Tool input validation failed…"} as the "result" — which must never be
// recorded as something the agent said to the customer.
function replyTextOf(output: unknown): string | undefined {
  const body = (output as { value?: unknown } | null | undefined)?.value ?? output;
  const { message, error } = (body ?? {}) as { message?: unknown; error?: unknown };
  return error !== true && typeof message === "string" ? message : undefined;
}

// Every settled respond_to_customer result in a model-message history, by tool-call id —
// they live on separate role:"tool" messages after the assistant message that made the call.
function respondToCustomerResults(messages: RawMessage[]): Map<string, string> {
  const results = new Map<string, string>();
  for (const msg of messages) {
    if (msg?.role !== "tool") continue;
    for (const part of messageParts(msg)) {
      if (part?.type !== "tool-result" || part.toolName !== "respondToCustomer" || !part.toolCallId) continue;
      const text = replyTextOf(part.output);
      if (text !== undefined) results.set(part.toolCallId, text);
    }
  }
  return results;
}

// ChatWidget.tsx's slaCountdownMarker() pushes "[[SLA:runId:orderId:deadlineIso]]" into
// the customer's own thread as a real assistant-role message (runtime.thread.append), so
// the storefront's own RichText can render it as a live countdown — client-UI-only by
// design, never meant to be read as text. But the AI SDK client resends full history on
// every turn, so this literal marker string comes right back as part of
// context.agent.messages on the customer's NEXT message, and without this strip,
// messageText/buildTranscript below would capture it verbatim into the case transcript —
// confirmed live: it showed up as raw "[[SLA:MSP5M9:order_4472:2026-...Z]]" text
// attributed to the agent in the Escalation Desk, which has no RichText parser of its own
// to turn it into anything meaningful. Same regex shape as ChatWidget.tsx's own
// TOKEN_PATTERN (kept independent rather than shared — different workspace, and this
// side only ever needs to strip the marker, never render it).
const SLA_MARKER_PATTERN = /\[\[SLA:[^:]+:[^:]+:[^\]]+\]\]/g;

export function messageText(msg: RawMessage, resultsByCallId?: Map<string, string>): string {
  if (typeof msg.content === "string") return msg.content.replace(SLA_MARKER_PATTERN, "").trim();
  return messageParts(msg)
    .map((p) => (p && (p.type === "text" || typeof p.text === "string") ? (p.text ?? "") : toolResponseText(p, resultsByCallId)))
    .filter((t): t is string => t !== undefined)
    .join("\n\n")
    .replace(SLA_MARKER_PATTERN, "")
    .trim();
}

// First image attachment on the message, if any — see RawMessagePart's own comment on
// why a "file" part with an image mediaType, not a dedicated "image" type. Only the
// first: this app's transcriptMessageSchema has room for one photo per message, matching
// what a customer actually does in practice (one photo per damage report), and the
// Escalation Desk's lightbox already only ever shows one per message.
//
// A photo reaches here in two shapes, and BOTH must be read: the browser's UIMessage part
// ({url}) and the model-side message ({data}). Reading only the first silently dropped the
// photo from every case's creation-time transcript — and, being a photo
// with no caption, the whole message with it.
function imageDataUrlOf(part: RawMessagePart): string | undefined {
  if (!part || part.type !== "file" || !part.mediaType?.startsWith("image/")) return undefined;
  if (typeof part.url === "string") return part.url;
  const { data } = part;
  if (typeof data === "string") return /^(data|https?):/i.test(data) ? data : `data:${part.mediaType};base64,${data}`;
  if (data instanceof Uint8Array) return `data:${part.mediaType};base64,${Buffer.from(data).toString("base64")}`;
  return undefined;
}

function messageImageDataUrl(msg: RawMessage): string | undefined {
  for (const part of messageParts(msg)) {
    const url = imageDataUrlOf(part);
    if (url) return url;
  }
  return undefined;
}

// excludeFirstN (session-case-boundary.ts): how many leading messages belonged to the
// LAST case already created in this same session, if any — everything before that
// index is old, already-handled business, not part of whatever's being escalated now.
// A message-id-based version of this was tried first and abandoned: a beforeToolCall
// hook's own `context.messages` carries no `.id` field at all (confirmed live), so a
// count is what session-case-boundary.ts actually tracks — see its own comment for why
// that's a reliable enough proxy despite not being id-precise.
//
// The count alone drifts whenever an assistant-role message was appended OUTSIDE a normal
// turn — a rep's "case resolved" push, a "specialist has a question" push, an SLA
// countdown marker (all pushed over SSE straight into the client's thread) — since each
// one shifts every later index by one. Live-reproduced: resolving one case from the Desk
// and then raising a new topic in the same chat left that case's resolution push as the
// FIRST line of the new case's transcript. So after cutting at the count, also skip
// forward to the first customer message: an assistant message can't open a conversation,
// so anything sitting before the next customer message is leftover from the old matter.
function scopeSinceLastCase(messages: unknown[], excludeFirstN: number | undefined): unknown[] {
  const raw = messages as RawMessage[];
  if (!excludeFirstN) return raw;
  let start = Math.min(excludeFirstN, raw.length);
  while (start < raw.length && raw[start]?.role !== "user") start++;
  // Every case-creating tool call is triggered by a customer message, so there is always
  // at least one — but if the count somehow overshot it (a shorter resent history than
  // when it was recorded), fall back to the last customer message rather than an empty
  // transcript.
  if (start >= raw.length) start = Math.max(0, raw.map((m) => m?.role).lastIndexOf("user"));
  return raw.slice(start);
}

// The real conversation, not a paraphrase — the anti-coercion doc's worked example
// explicitly endorses passing the customer's own words through as context for the human
// reviewer, as long as nothing downstream treats it as verified fact. It doesn't:
// decideRefund never reads the transcript, only the tool-fetched order/customer.
export function buildTranscript(messages: unknown[], excludeFirstN?: number): { role: "customer" | "agent"; text: string; timestamp: string; imageDataUrl?: string }[] {
  // From the WHOLE history, not the scoped slice: a result sits after its call, but nothing
  // here should depend on where scopeSinceLastCase happens to cut.
  const resultsByCallId = respondToCustomerResults(messages as RawMessage[]);
  return (scopeSinceLastCase(messages, excludeFirstN) as RawMessage[])
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({
      role: (m.role === "user" ? "customer" : "agent") as "customer" | "agent",
      text: messageText(m, resultsByCallId),
      timestamp: timestampFor(m.id),
      imageDataUrl: messageImageDataUrl(m),
    }))
    // A message can be a photo with no caption at all — keep it once it has either real
    // text or an attached image, not just when text alone is non-empty (the original
    // check, from before a message could ever carry a photo with nothing else).
    .filter((m) => m.text.trim().length > 0 || m.imageDataUrl !== undefined);
}
