"use client";

import { useState, useEffect, useContext, useMemo, useRef, createContext, type ReactNode } from "react";
import {
  AssistantRuntimeProvider,
  ThreadPrimitive,
  MessagePrimitive,
  ActionBarPrimitive,
  ComposerPrimitive,
  AttachmentPrimitive,
  useAuiState,
  type TextMessagePartProps,
  type ToolCallMessagePartProps,
  type AssistantRuntime,
} from "@assistant-ui/react";
import { useChatRuntime, AssistantChatTransport } from "@assistant-ui/react-ai-sdk";
import { AGENT_URL } from "@/lib/api";
import { ResizedImageAttachmentAdapter } from "@/lib/image-attachment";
import { parseChatError } from "@/lib/chat-error";
import { formatMoney } from "@/lib/money";
import { caseResolvedMessage as buildCaseResolvedMessage, caseMoreInfoMessage, isCaseNotice } from "../../../../shared/case-notices";

// The launcher/panel pattern here matches Greeter's real widget-trigger + panel
// (host/index.html + src/style.css .g-shell) — pulsing pill, dim+blur backdrop, sliding
// panel. Reimplemented same-document rather than via iframe: Greeter's iframe/postMessage
// split exists to let it embed into an arbitrary THIRD-PARTY retailer site; this app IS
// the retailer site, so there's no cross-origin boundary to bridge in the first place.

// The classic runtime object useChatRuntime() returns — passed down directly via
// context so RichText can call runtime.thread.append(...) on the exact instance
// ChatWidget created. An earlier attempt read this through useAui()'s newer scope-lookup
// API instead; that's built for a different provider setup (AuiProvider/AuiConfig) and
// didn't actually fire here. Calling the method directly on the object we already hold
// removes that uncertainty entirely.
const ChatRuntimeContext = createContext<AssistantRuntime | null>(null);

// Mirrors apps/agent/src/mastra/case-events.ts's CaseResolvedEvent — this app can't
// import that file directly (separate package), so the shape is duplicated here rather
// than reaching across app boundaries for a type.
interface CaseResolvedEvent {
  runId: string;
  orderId: string;
  customerId: string;
  action: "executed" | "denied" | "escalated_to_support";
  refundAmount?: number;
  currency?: string;
  reason?: string;
  ticketId?: string;
  contactWindowHours?: number;
  // Only set when action is "escalated_to_support" — see case-events.ts's own copy of
  // this field. Branches caseResolvedMessage's wording below: "system" (an SLA timeout)
  // reads as an apology for a delay; "rep" (a rep's own proactive escalation, or a question
  // that could not be delivered) reads as a specialist's deliberate decision — using
  // the wrong one would misrepresent what actually happened to the customer.
  resolvedBy?: "system" | "rep";
  // The rep's question when it could not be delivered — see case-events.ts.
  question?: string;
  // The customer did not answer a rep's question within the response window — see case-events.ts.
  customerDidNotReply?: boolean;
  // Set for an approved plain_return, or a damage claim where the rep asked for the item
  // back — see case-events.ts. A rep-approved case (as opposed to the agent's own same-
  // turn autonomous approval, which hands this over itself — see wismo-agent.ts) never
  // had a chance for the customer to ask for it, so this push includes it directly rather
  // than leaving them to ask a follow-up.
  returnLabelUrl?: string;
  returnTrackingNumber?: string;
  // The rep's own message on an approve / modify — see case-events.ts.
  comment?: string;
}

// The wording of both notices lives in shared/case-notices.ts: the agent writes the same words into its stored thread of the
// conversation, so the model has read exactly what the customer read. This binds the widget's own money formatter to the first.
function caseResolvedMessage(event: CaseResolvedEvent): string {
  return buildCaseResolvedMessage(event, formatMoney);
}

interface CaseMoreInfoEvent {
  runId: string;
  orderId: string;
  customerId: string;
  question: string;
}

// Fired once, right when a case is first escalated (refund-policy-gate.ts / delivery-dispute.ts
// in the agent) — puts a live countdown in the chat instead of the model guessing at an
// ETA. The message text pushed for this event is just the [[SLA:...]] marker itself (see
// TOKEN_PATTERN / RichText below) — SlaCountdown supplies all its own copy, so there's no
// surrounding prose to keep in sync with it.
interface CaseEscalationStartedEvent {
  runId: string;
  orderId: string;
  customerId: string;
  deadlineIso: string;
}

function slaCountdownMarker(event: CaseEscalationStartedEvent): string {
  return `[[SLA:${event.runId}:${event.orderId}:${event.deadlineIso}]]`;
}

// Which runs' countdowns are paused, and why:
// - "awaiting-customer": a rep asked a follow-up question, so the clock that was counting
//   down "time for a specialist to respond" no longer means anything (they already
//   responded, with a question) until the customer answers and a fresh one starts
//   (case-sync.ts emits a brand-new case-escalation-started push for that, which mounts
//   its own new SlaCountdown). Still worth showing frozen, not removed — it's the only
//   thing that tells the customer why the clock stopped.
// - "resolved": the case is over (approved/rejected, or already turned into a support
//   ticket) — every one of these outcomes already gets its own pushed message right
//   alongside (caseResolvedMessage — the real approval/denial text, or the real apology +
//   support-ticket number once a timeout genuinely fires server-side), so a resolved
//   widget has nothing left to say that isn't either stale or redundant. Removed, not
//   frozen with placeholder copy.
// Keyed by runId, not orderId, since a countdown for one case shouldn't freeze because the
// customer happens to have a second, unrelated case on the same order.
//
// A "request more info" cycle re-fires case-escalation-started for the SAME runId once
// the customer answers — that's by design (see the architecture doc), but it means TWO
// separate SlaCountdown messages can exist in the thread for one case: the original one
// and the fresh one pushed after the reply. Both read this same runId-keyed state, so an
// earlier version that just cleared the pause entry on a fresh push unpaused BOTH widgets
// at once — the stale original started ticking down from its own long-past deadline
// again ("resumed"), a real bug confirmed live, not just the newest one. latestDeadlineIso
// is how a widget tells whether it's still the live one: only the instance whose OWN
// deadlineIso matches the run's current latest is ever paused/resolved/ticking — every
// older instance for the same runId is removed outright once a newer one exists,
// regardless of what happens to the run afterward (same "nothing left to say" reasoning
// as the resolved case above — the fresh countdown message it was superseded by is
// already sitting right below it).
interface SlaRunState {
  latestDeadlineIso: string;
  pauseReason?: "awaiting-customer" | "resolved";
}
const SlaRunContext = createContext<Map<string, SlaRunState>>(new Map());

function SlaCountdown({ runId, orderId, deadlineIso }: { runId: string; orderId: string; deadlineIso: string }) {
  const runState = useContext(SlaRunContext).get(runId);
  const isLatest = !runState || runState.latestDeadlineIso === deadlineIso;
  const pauseReason = isLatest ? runState?.pauseReason : undefined;
  const deadlineMs = useMemo(() => new Date(deadlineIso).getTime(), [deadlineIso]);
  const [remainingMs, setRemainingMs] = useState(() => deadlineMs - Date.now());

  useEffect(() => {
    if (pauseReason || !isLatest) return;
    const id = setInterval(() => setRemainingMs(deadlineMs - Date.now()), 1000);
    return () => clearInterval(id);
  }, [deadlineMs, pauseReason, isLatest]);

  // Superseded by a fresher countdown, or the case is resolved — nothing left for this
  // widget to say (see the comment above), so it renders nothing at all. globals.css
  // collapses the now-empty message bubble around it too (`.aui-message-assistant:has(>
  // div:empty)`), so no dead, padded shell is left sitting in the transcript either.
  if (!isLatest || pauseReason === "resolved") return null;

  const shortOrderId = orderId.replace(/^order_/, "");

  if (pauseReason === "awaiting-customer") {
    return (
      <div className="sla-countdown" data-past-due="false" data-paused="true">
        <span className="sla-countdown-spinner" aria-hidden="true" />
        <div>
          <div className="sla-countdown-label">Waiting on your reply about order #{shortOrderId}</div>
          <div className="sla-countdown-time">We&rsquo;ll let the specialist know as soon as you respond.</div>
        </div>
      </div>
    );
  }

  const pastDue = remainingMs <= 0;
  const totalSeconds = Math.max(0, Math.round(remainingMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return (
    <div className="sla-countdown" data-past-due={pastDue}>
      <span className="sla-countdown-spinner" aria-hidden="true" />
      <div>
        <div className="sla-countdown-label">
          {pastDue ? "We're sorry — this is taking a little longer than usual" : `Specialist notified about order #${shortOrderId}`}
        </div>
        <div className="sla-countdown-time">
          {pastDue ? `Opening a support ticket for order #${shortOrderId}…` : `${minutes}:${String(seconds).padStart(2, "0")} remaining`}
        </div>
      </div>
    </div>
  );
}

// A push can arrive at any moment, including while the customer's own turn is still
// streaming in — appending immediately in that window landed the pushed text inside the
// same in-progress assistant bubble instead of as its own message (confirmed live: a
// case-resolved push mid-stream visually merged into Wismo's own reply, reading as if
// Wismo itself had said it). isRunning covers exactly that window — "active stream
// connection to the backend" per ThreadState's own doc comment — so waiting for it to
// clear before appending guarantees the push always lands as a clean, separate message.
type PushMessage = Omit<Extract<Parameters<AssistantRuntime["thread"]["append"]>[0], object>, "parentId">;

function appendWhenIdle(runtime: AssistantRuntime, buildMessage: () => PushMessage): () => void {
  // subscribe(callback) may or may not invoke callback synchronously on registration
  // (varies by store implementation) — if it does, referencing a `const unsubscribe`
  // from inside that same synchronous callback throws (temporal dead zone: the
  // assignment hasn't completed yet), silently dropping the append with no visible
  // error. `done` + an always-initialized `unsubscribe` avoids that regardless of
  // whether the first call is synchronous, and guarantees exactly one append either way.
  let done = false;
  let unsubscribe = () => {};
  const tryAppend = () => {
    if (done || runtime.thread.getState().isRunning) return;
    done = true;
    unsubscribe();
    // parentId must exactly match the CURRENT last message's id (read fresh here, not
    // whatever it was when this function was first called) or the runtime treats this as
    // an EDIT of that message instead of a genuine new one — confirmed in the installed
    // @assistant-ui/core source (external-store-thread-runtime-core.js's append():
    // `isEdit = ... rawMessage.parentId !== (this.messages.at(-1)?.id ?? null)`).
    // Omitting parentId (undefined never matches a real id) meant every earlier push was
    // silently treated as an edit — which is exactly why it merged into the model's own
    // reply instead of appearing as its own message, confirmed live via a screenshot.
    const parentId = runtime.thread.getState().messages.at(-1)?.id ?? null;
    runtime.thread.append({ ...buildMessage(), parentId });
  };
  unsubscribe = runtime.thread.subscribe(tryAppend);
  tryAppend();
  return () => {
    done = true;
    unsubscribe();
  };
}

function ChatBubbleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7Z" />
    </svg>
  );
}

function PaperclipIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21.44 11.05 12.25 20.24a5.5 5.5 0 0 1-7.78-7.78l9.19-9.19a3.67 3.67 0 0 1 5.19 5.19l-9.2 9.19a1.83 1.83 0 0 1-2.59-2.59l8.49-8.48" />
    </svg>
  );
}

// This chat UI has no markdown renderer, but the agent sometimes writes markdown-style links
// ([label](url)), which would show as literal brackets. One combined pattern handles that form, a bare
// http(s) URL (tracking links), the customer-facing short order number the agent is told to use
// ("#1188"), the raw internal order ID ("order_1188") as a fallback, and the
// [[SLA:runId:orderId:deadlineIso]] marker a case-escalation-started push is made of (see
// slaCountdownMarker above). Alternatives are checked in that order so a URL inside a markdown link's
// parens is consumed as part of the link, not matched again on its own.
//
// `#(\d+)\b`: the trailing \b is load-bearing. A case ID (case-id.ts: 6 Crockford Base32 chars, digits
// AND letters) can start with digits ("4CWDRB"), and the agent writes one as "case #<caseId>", the same
// "#<token>" shape as a short order number. Without the boundary, `#(\d+)` matched only the leading
// digits ("#4") and rendered a clickable order chip with "CWDRB" dangling after it. \b requires a
// non-word character (or end of string) right after the digits: "#2001" followed by punctuation still
// matches, "#4CWDRB" doesn't (a digit followed by "C"), so a case ID falls through to plain text, which
// is intended (case IDs have no chip of their own).
const TOKEN_PATTERN = new RegExp(
  [
    String.raw`\[\[SLA:([^:]+):([^:]+):([^\]]+)\]\]`, // 1: SLA runId, 2: SLA orderId, 3: SLA deadlineIso
    String.raw`\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)`, // 4: markdown label, 5: markdown url
    String.raw`(https?:\/\/\S+)`, // 6: bare url
    String.raw`#(\d+)\b`, // 7: short order number, digits only — \b excludes a case ID's leading digit run
    String.raw`(\border_\w+)`, // 8: raw order id, sent as-is
  ].join("|"),
  "gi"
);

// shipping_get_tracking_info hands the agent a "nice" branded URL
// (https://track.waybound.com/TRK-...) to quote rather than this dev server's real
// address — reads as a real tracking link either way, but only resolves as one from
// inside the storefront. Rewritten here to the page's own real origin at click time, so
// it actually works on localhost, a LAN IP, or wherever this happens to be running.
const TRACKING_COSMETIC_HOST = "track.waybound.com";
// Same trick, same reason — generateReturnLabel (apps/agent's shipping.ts) hands out
// "https://returns.waybound.com/RTN-..." for a return label; rewritten here to this
// storefront's own real origin's /return-label page at click time.
const RETURN_LABEL_COSMETIC_HOST = "returns.waybound.com";

function resolveHref(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === TRACKING_COSMETIC_HOST && typeof window !== "undefined") {
      return `${window.location.origin}/track${parsed.pathname}`;
    }
    if (parsed.hostname === RETURN_LABEL_COSMETIC_HOST && typeof window !== "undefined") {
      return `${window.location.origin}/return-label${parsed.pathname}`;
    }
  } catch {
    // Not a parseable absolute URL — render it as given.
  }
  return url;
}

// Every button that sends a message by calling runtime.thread.append() directly (an order chip, the
// return-item picker's Submit, an empty-state suggestion) is guarded against firing while the PRIOR turn
// is still streaming. Without it, two quick order-chip clicks started two overlapping /chat/wismoAgent
// requests, and whichever finished first appended first, so replies appeared out of request order. The
// click is silently ignored if a turn is running. It is a plain check inside the handler, not a disabled
// button, so it works from call sites inside and outside a component body (renderRichTextNodes below is a
// plain function and can't call a hook like useAuiState). server.ts's activeChatTurns is the backstop
// this guard alone can't provide.
function appendIfIdle(runtime: AssistantRuntime | null | undefined, message: Parameters<AssistantRuntime["thread"]["append"]>[0]): void {
  if (!runtime || runtime.thread.getState().isRunning) return;
  runtime.thread.append(message);
}

// Renders order numbers as click-to-answer chips — clicking "#1188" sends just "1188"
// into the chat, the same as if the customer had typed it in reply to "which order is
// it?" (demo-data.ts's getOrder() accepts that bare form, "#1188", or the full
// "order_1188" equally) — and tracking links as real anchors that open in a new tab.
// Everything else passes through as plain text. Extracted from RichText below (not just
// used by it) so RespondToCustomer's tool-UI component gets the exact same parsing
// (order chips, links, the SLA countdown token) for its own `message` field, without
// needing a fake TextMessagePartProps object to satisfy RichText's own prop type.
function renderRichTextNodes(text: string, runtime: AssistantRuntime | null | undefined): ReactNode[] {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let key = 0;
  const pattern = new RegExp(TOKEN_PATTERN);
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
    const [, slaRunId, slaOrderId, slaDeadline, mdLabel, mdUrl, bareUrl, shortOrderNumber, orderId] = match;
    if (slaRunId !== undefined && slaOrderId !== undefined && slaDeadline !== undefined) {
      nodes.push(<SlaCountdown key={key++} runId={slaRunId} orderId={slaOrderId} deadlineIso={slaDeadline} />);
    } else if (mdLabel !== undefined && mdUrl !== undefined) {
      nodes.push(
        <a key={key++} href={resolveHref(mdUrl)} target="_blank" rel="noopener noreferrer" className="aui-inline-link">
          {mdLabel}
        </a>
      );
    } else if (bareUrl !== undefined) {
      nodes.push(
        <a key={key++} href={resolveHref(bareUrl)} target="_blank" rel="noopener noreferrer" className="aui-inline-link">
          {bareUrl}
        </a>
      );
    } else if (shortOrderNumber !== undefined) {
      nodes.push(
        <button key={key++} type="button" className="aui-order-chip" onClick={() => appendIfIdle(runtime, shortOrderNumber)}>
          #{shortOrderNumber}
        </button>
      );
    } else if (orderId !== undefined) {
      nodes.push(
        <button key={key++} type="button" className="aui-order-chip" onClick={() => appendIfIdle(runtime, orderId)}>
          {orderId}
        </button>
      );
    }
    lastIndex = pattern.lastIndex;
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

// A message can carry multiple text parts (e.g. text before and after a tool call) —
// each needs its own block so consecutive parts don't visually run together with no
// separator. Matches @assistant-ui/react's own default Text component's whiteSpace:
// pre-line (lost by overriding Text with this component in the first place) — but a
// <div>, not that default's own <p>, since a part can embed SlaCountdown's <div>, and
// a <div> is not valid HTML inside a <p> (React/Next.js reports this as a console
// hydration error, not just a lint nit).
function RichText({ text }: TextMessagePartProps) {
  const runtime = useContext(ChatRuntimeContext);
  return <div style={{ whiteSpace: "pre-line" }}>{renderRichTextNodes(text, runtime)}</div>;
}

// respond_to_customer is the ONLY way wismoAgent says anything to the customer (wismo-agent.ts's ground
// rules). This renders its result exactly like a normal RichText bubble (same order-chip, link and
// SLA-token parsing), so how the agent produces the text is invisible to the customer. It reads ONLY
// `result.message`: `result.reasoning` (the tool's input, traced by Mastra for the Desk's Activity tab)
// is not wired to anything here that could render it. That is a render-layer guarantee only;
// server.ts's redactReasoningFromClientStream is what keeps `reasoning` out of the network stream.
// Keyed by "respondToCustomer", the tool's JS registration key in wismo-agent.ts (camelCase), not its
// snake_case id ("respond_to_customer"): the same gotcha as presentReturnItemPicker (and
// touched-orders-from-history.ts in the agent).
function RespondToCustomer({ result, isError }: ToolCallMessagePartProps<{ reasoning: string; message: string }, { message: string }>) {
  const runtime = useContext(ChatRuntimeContext);
  // When the model calls this tool with invalid input (e.g. omitting `reasoning`), @mastra/core's tool
  // wrapper doesn't throw: it RETURNS the validation-error object as the tool's "successful" result
  // (`{error: true, message: "Tool input validation failed ...", validationErrors: [...]}`), so
  // assistant-ui's `isError` stays false and a bare `result.message` check would render the raw
  // validation text as if it were the customer's reply. `error === true` is the one field that tells them
  // apart: a genuine reply is exactly `{message: string}` (the tool's declared outputSchema) and never
  // carries `error`.
  //
  // `!result.message.trim()`: once server.ts's prepareStep detects a retry loop it locks toolChoice to
  // respond_to_customer for the rest of the turn, and a model with nothing left to say still has to call
  // it on every remaining step, sometimes with an empty `message`. An empty bubble is pointless clutter,
  // so it is skipped, as a null result already is.
  if (!result || isError || (result as { error?: unknown }).error === true || typeof result.message !== "string" || !result.message.trim()) return null;
  return <div style={{ whiteSpace: "pre-line" }}>{renderRichTextNodes(result.message, runtime)}</div>;
}

// The model sometimes says its offer in a normal reply AND through an offer card (offer_new_chat /
// offer_escalation_to_support) with the identical sentence, so the customer reads it twice in one message. A card whose
// sentence is already in a reply of the SAME message shows only its buttons. Strict on purpose: only the same sentence
// (ignoring spacing and capitals) is dropped, so a card that says something different still shows its own text.
function useSentenceAlreadyShown(text: string | undefined): boolean {
  return useAuiState((s) => {
    if (!text) return false;
    const same = (a: string, b: string) => a.replace(/\s+/g, " ").trim().toLowerCase() === b.replace(/\s+/g, " ").trim().toLowerCase();
    return s.message.content.some((part) => {
      if (part.type !== "tool-call" || part.toolName !== "respondToCustomer" || part.isError) return false;
      const reply = (part.result as { message?: unknown } | undefined)?.message;
      return typeof reply === "string" && same(reply, text);
    });
  });
}

// The checkbox return-item picker — a tool-call message part rendered as an interactive
// widget rather than text, same category of special-case as SlaCountdown but registered
// through @assistant-ui's own tool-UI mechanism (components.tools.by_name) instead of a
// RichText token, since this one needs real interactivity (checkboxes + a submit button),
// not just a live-updating display. Keyed by "presentReturnItemPicker" — the tool's JS
// registration key in wismo-agent.ts (camelCase), not its own snake_case id
// ("present_return_item_picker") — touched-orders-from-history.ts hit this same gotcha first.
interface ReturnPickerItem {
  objectID: string;
  name: string;
  price: number;
  currency: string;
  images: string[];
  colourFamily: string;
  colourHex: string;
  // Already covered by an earlier refund (refund-ledger.ts, via present_return_item_
  // picker) — greyed out and unselectable below rather than letting the customer pick
  // it and only finding out it's a no-op once they submit.
  alreadyReturned: boolean;
}
type PickerPurpose = "return" | "damage_claim";
interface ReturnPickerResult {
  orderId: string;
  purpose: PickerPurpose;
  items: ReturnPickerItem[];
}

// purpose only ever changes THIS copy table — every other behavior below (selection,
// disabling an already-covered item, what gets sent server-side) is identical for a
// return and a damage claim. See return-item-picker.ts's own header comment: choosing
// which item(s) stays fully separate from what happens to them afterward.
const PICKER_COPY: Record<PickerPurpose, { heading: (orderId: string) => string; alreadyCoveredTag: string; emptyState: string; submitLabel: string; submittedPrefix: string; appendedMessage: (orderId: string, list: string) => string }> = {
  return: {
    heading: (orderId) => `Which item(s) from order #${orderId} would you like to return?`,
    alreadyCoveredTag: "Already returned",
    emptyState: "Every item on this order has already been returned.",
    submitLabel: "Submit return",
    submittedPrefix: "Selected for return",
    appendedMessage: (orderId, list) => `I'd like to return these item(s) from order #${orderId}: ${list}`,
  },
  damage_claim: {
    heading: (orderId) => `Which item(s) from order #${orderId} are damaged?`,
    alreadyCoveredTag: "Already refunded",
    emptyState: "Every item on this order has already been refunded.",
    submitLabel: "Confirm",
    submittedPrefix: "Reported damaged",
    appendedMessage: (orderId, list) => `The following item(s) from order #${orderId} are damaged: ${list}`,
  },
};

function ReturnItemPicker({ result, isError }: ToolCallMessagePartProps<{ orderId: string }, ReturnPickerResult>) {
  const runtime = useContext(ChatRuntimeContext);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [submittedItems, setSubmittedItems] = useState<ReturnPickerItem[] | null>(null);

  // The tool result streams in as one complete JSON blob (a normal Mastra tool, not a
  // token-by-token stream) — nothing to render until it's actually here. A tool error
  // (e.g. return-item-picker.ts's single-item guard) does NOT leave `result` undefined —
  // it's populated with the error object itself, which has none of ReturnPickerResult's
  // fields — so `isError` needs its own explicit check, not just falsy-`result`. Live-
  // reproduced crash: `result.orderId.replace(...)` below threw on an error result,
  // since `result` was truthy (the error object) but `orderId` on it was undefined.
  if (!result || isError) return null;

  const shortOrderId = result.orderId.replace(/^order_/, "");
  const copy = PICKER_COPY[result.purpose ?? "return"];

  function toggle(objectID: string) {
    const item = result?.items.find((i) => i.objectID === objectID);
    if (item?.alreadyReturned) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(objectID)) next.delete(objectID);
      else next.add(objectID);
      return next;
    });
  }

  const returnableCount = result.items.filter((item) => !item.alreadyReturned).length;

  function submit() {
    if (selected.size === 0 || submittedItems || !result) return;
    const chosen = result.items.filter((item) => selected.has(item.objectID));
    setSubmittedItems(chosen);
    // Plain text into the chat, same as clicking an order-number chip (RichText above) —
    // the model re-derives the real price from these objectIDs itself (payment_issue_
    // return_refund / escalate_for_return_refund / payment_issue_refund /
    // escalate_for_policy_review), never trusts a dollar amount from here; this message
    // only ever carries the customer's own choice of WHICH items, the one part of
    // either flow that genuinely is their call to make.
    const list = chosen.map((item) => `${item.name} (${item.objectID})`).join(", ");
    appendIfIdle(runtime, copy.appendedMessage(shortOrderId, list));
  }

  if (submittedItems) {
    return (
      <div className="return-picker return-picker-done">
        <div className="return-picker-label">
          {copy.submittedPrefix}: {submittedItems.map((item) => item.name).join(", ")}
        </div>
      </div>
    );
  }

  return (
    <div className="return-picker">
      <div className="return-picker-label">{copy.heading(shortOrderId)}</div>
      <div className="return-picker-list">
        {result.items.map((item) => {
          const photo = item.images?.[0];
          const inputId = `return-item-${item.objectID}`;
          return (
            <label
              key={item.objectID}
              htmlFor={inputId}
              className="return-picker-item"
              data-disabled={item.alreadyReturned}
              aria-disabled={item.alreadyReturned}
            >
              <input
                id={inputId}
                type="checkbox"
                checked={selected.has(item.objectID)}
                disabled={item.alreadyReturned}
                onChange={() => toggle(item.objectID)}
              />
              {photo ? (
                // eslint-disable-next-line @next/next/no-img-element -- fixed local catalog photo, same as ProductSwatch elsewhere
                <img src={photo} alt="" className="return-picker-thumb" />
              ) : (
                <span className="return-picker-thumb-fallback" style={{ background: item.colourHex }} aria-hidden="true" />
              )}
              <span className="return-picker-item-name">{item.name}</span>
              {item.alreadyReturned ? (
                <span className="return-picker-item-tag">{copy.alreadyCoveredTag}</span>
              ) : (
                <span className="return-picker-item-price">{formatMoney(item.price, item.currency)}</span>
              )}
            </label>
          );
        })}
      </div>
      {returnableCount === 0 ? (
        <div className="return-picker-label">{copy.emptyState}</div>
      ) : (
        <button type="button" className="return-picker-submit" disabled={selected.size === 0} onClick={submit}>
          {copy.submitLabel}
        </button>
      )}
    </div>
  );
}

// The order-list card for commerce_list_orders_for_customer — same category of tool-UI
// as ReturnItemPicker above, registered the same way (components.tools.by_name, keyed by
// the tool's JS registration key, "commerceListOrdersForCustomer"). Shows the orders
// directly the moment the tool result lands, no confirm-first step — per explicit user
// instruction ("don't ask the user if they want to pull up recent orders, just show the
// orders"). getOrdersForCustomer (demo-data.ts) already returns them most-recent-first,
// so this renders them in that same order without re-sorting.
interface OrderListResult {
  orders: { id: string; items: string; orderDate: string }[];
}

function OrderListOffer({ result, isError }: ToolCallMessagePartProps<Record<string, never>, OrderListResult>) {
  const runtime = useContext(ChatRuntimeContext);

  // Same "nothing to render until the tool result actually lands" reasoning as
  // ReturnItemPicker — this is a normal, non-streaming Mastra tool. Same isError check
  // too — see ReturnItemPicker's comment for why `result` alone isn't a safe guard.
  if (!result || isError) return null;

  return (
    <div className="order-list-offer order-list-offer-revealed">
      {result.orders.map((order) => {
        const shortId = order.id.replace(/^order_/, "");
        return (
          <button
            key={order.id}
            type="button"
            className="order-list-offer-row"
            onClick={() => appendIfIdle(runtime, shortId)}
          >
            <span className="aui-order-chip order-list-offer-chip">#{shortId}</span>
            <span className="order-list-offer-items">{order.items}</span>
            <span className="order-list-offer-date">
              {new Date(order.orderDate).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function UserMessage() {
  return (
    <MessagePrimitive.Root className="aui-message aui-message-user">
      {/* MessagePrimitive.Content alone never renders attachments — a separate,
          explicit component for them, same split as the composer's own
          Attachments/Input. Without this, a customer's uploaded photo reaches the
          agent and the Escalation Desk transcript just fine (verified separately) but
          never appears in their OWN sent bubble — no confirmation it actually
          attached, not a limitation of how the file was chosen. */}
      <MessagePrimitive.Attachments>
        {({ attachment }) =>
          attachment.content?.map((part, i) =>
            part.type === "image" ? (
              // eslint-disable-next-line @next/next/no-img-element -- a data: URL from the customer's own device, not a file next/image could optimize
              <img key={i} src={part.image} alt="Photo you sent" className="aui-message-attachment-thumb" />
            ) : null
          )
        }
      </MessagePrimitive.Attachments>
      <MessagePrimitive.Content />
    </MessagePrimitive.Root>
  );
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="aui-message aui-message-assistant">
      <MessagePrimitive.Content
        components={{
          Text: RichText,
          tools: {
            by_name: {
              presentReturnItemPicker: ReturnItemPicker,
              commerceListOrdersForCustomer: OrderListOffer,
              respondToCustomer: RespondToCustomer,
              offerNewChat: OfferNewChat,
              offerEscalationToSupport: OfferEscalation,
            },
          },
        }}
      />
      {/* Renders only when this message's own status is {type:"incomplete", reason:
         "error"} — a turn that died before (or while) generating, e.g. the LLM API
         itself unreachable, a workflow/storage error, or a bug in a tool-call hook.
         A real, live-reproduced gap: none of this was ever rendered before, so a
         failed turn left the customer looking at nothing at all — no dots, no
         message, no error, just silence. Deliberately a fixed, generic apology, never
         the raw error object @assistant-ui makes available here — same "never surface
         internals to the customer" discipline as everywhere else in this app. */}
      <MessagePrimitive.Error>
        <FailedReply />
      </MessagePrimitive.Error>
    </MessagePrimitive.Root>
  );
}

// The body of a failed reply: the agent's customer-safe sentence, and a Try again button only when resending could
// work — a photo the API refused, or a spending cap, fails identically every time, so offering the button there just
// loops the customer (lib/chat-error.ts; the agent decides in mastra/chat-errors.ts).
function FailedReply() {
  const raw = useAuiState((s) => {
    const status = s.message.status;
    return status?.type === "incomplete" && status.reason === "error" ? status.error : undefined;
  });
  const { message, retryable } = parseChatError(raw);
  // Try again removes every message after the one it retries. A rep's question or decision that arrived after the failed message
  // would go with it, and the customer could no longer see what they were asked. So it is not offered once one has arrived: the
  // customer answers with a new message, and the failed message and the rep's notice both stay in the conversation.
  // The library shows a thread's error on its NEWEST assistant message, so when a rep's notice arrives the error moves onto the notice
  // itself. "Something went wrong" under a rep's question reads as if it were about the question, so nothing is drawn there.
  const ownIsRepNotice = useAuiState((s) => s.message.content.some((part) => part.type === "text" && isCaseNotice(part.text)));
  const repHasWrittenSince = useAuiState((s) => {
    const messages = s.thread.messages;
    const at = messages.findIndex((m) => m.id === s.message.id);
    return at >= 0 && messages.slice(at + 1).some((m) => m.role === "assistant" && m.content.some((part) => part.type === "text" && isCaseNotice(part.text)));
  });
  if (ownIsRepNotice) return null;
  return (
    <div className="aui-message-error">
      {message}
      {/* Regenerates this reply from the same conversation — the customer's last message, and any photo on it, are
          resent as they were, so nothing is retyped or re-attached. The library disables it while a turn is running. */}
      {retryable && !repHasWrittenSince && <ActionBarPrimitive.Reload className="aui-newchat-btn aui-retry-btn">Try again</ActionBarPrimitive.Reload>}
    </div>
  );
}

// Tool names that legitimately end a turn with nothing further for the customer to see —
// respondToCustomer's own message IS the reply; presentReturnItemPicker/
// commerceListOrdersForCustomer/offerNewChat/offerEscalationToSupport all end a turn
// silently, the card speaks for itself (see server.ts's stopWhen, which ends the turn right
// after one of them). Mastra's tool-calling loop makes one more model call after a tool result
// to decide whether to continue: after a respondToCustomer reply that trailing round-trip still
// happens (and still holds isRunning true) before the stream closes for real, but after a card
// tool the server stops the turn itself, so the stream closes at once.
const TURN_ENDING_TOOL_NAMES = new Set([
  "respondToCustomer",
  "presentReturnItemPicker",
  "commerceListOrdersForCustomer",
  "offerNewChat",
  "offerEscalationToSupport",
]);

// A persistent "working" indicator for any gap where the agent has nothing visible to show yet, not
// just while text streams. isRunning stays true across a tool call with no text alongside it (e.g. the
// turn after submitting a return item picker: payment_issue_return_refund, escalate_for_return_refund,
// then a reply), which would otherwise leave the chat looking stalled. useAuiState subscribes and
// re-renders on change (the documented replacement for the deprecated ThreadPrimitive.If), unlike
// appendWhenIdle's one-off getState() snapshot, which only needs the value at a single instant.
//
// isRunning tracks the raw stream connection, not "is more visible content coming": the trailing
// round-trip after a finished reply is invisible to the customer but keeps isRunning true, which left a
// lingering "..." under an already-complete reply ("Is there anything else I can help you with?"). So
// the indicator also hides when the LAST part of the LAST message is already a completed turn-ending
// tool call, even though the stream hasn't technically closed. It re-evaluates every render, so a
// genuine follow-up tool call (a second respondToCustomer) re-shows it immediately.
function TypingIndicator() {
  const isRunning = useAuiState((s) => s.thread.isRunning);
  const lastVisibleContentAlreadyShown = useAuiState((s) => {
    const messages = s.thread.messages;
    const last = messages[messages.length - 1];
    if (!last || last.role !== "assistant") return false;
    // A reply that has failed is over — its error bubble (with Try again) is the whole answer, so the dots and the
    // "Still working on it…" caption must not sit next to it for the debounce window below.
    if (last.status?.type === "incomplete" && last.status.reason === "error") return true;
    const parts = last.content;
    const lastPart = parts[parts.length - 1];
    return (
      !!lastPart &&
      lastPart.type === "tool-call" &&
      TURN_ENDING_TOOL_NAMES.has(lastPart.toolName) &&
      lastPart.result !== undefined &&
      !lastPart.isError
    );
  });

  // DEBOUNCED: isRunning itself flickers false for brief instants between a turn's own hidden internal
  // steps, and a plain `if (!isRunning) hide` toggled the indicator off and on each time, so the screen
  // "danced" up and down. Once shown, it stays through any brief false blip and hides only after isRunning
  // has stayed false for a short grace window: long enough to bridge two steps of the SAME turn, short
  // enough that a real end of turn still hides promptly. lastVisibleContentAlreadyShown (below) stays a
  // separate, IMMEDIATE override: once a real turn-ending tool call has resolved there is nothing further
  // to bridge to, so it hides right away.
  const [debouncedRunning, setDebouncedRunning] = useState(isRunning);
  useEffect(() => {
    if (isRunning) {
      setDebouncedRunning(true);
      return;
    }
    const timeout = setTimeout(() => setDebouncedRunning(false), 600);
    return () => clearTimeout(timeout);
  }, [isRunning]);

  // After SLOW_TURN_NOTICE_MS of the turn still running, tell the customer we are still working. The
  // server retries a failed model call with growing waits (wismo-agent.ts's maxRetries, about 15s in
  // all), so a customer on a bad connection would otherwise watch the dots for that long with no word.
  // Deliberately a plain timer on the turn, not a signal from the retry loop: a normally slow turn (p90
  // about 17s) gets the same reassurance, which is just as true for it.
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!debouncedRunning) {
      setSlow(false);
      return;
    }
    const timer = setTimeout(() => setSlow(true), SLOW_TURN_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [debouncedRunning]);

  if (lastVisibleContentAlreadyShown || !debouncedRunning) return null;
  return <TypingDots slow={slow} />;
}

const SLOW_TURN_NOTICE_MS = 12_000;

function TypingDots({ slow }: { slow: boolean }) {
  return (
    <div className="aui-typing-indicator" aria-live="polite" aria-label="WISMO is working on it">
      <span />
      <span />
      <span />
      {/* <small>, not <span>: .aui-typing-indicator span is the dots' own selector. */}
      {slow && <small className="aui-typing-caption">Still working on it…</small>}
    </div>
  );
}

// ---------------------------------------------------------------------------------------
// New chat after resolution / disagreement escalation
//
// An earlier, classifier-gated design held every post-resolution message back, invisibly,
// until a separate small model's verdict landed. That produced a visible gap before the
// message appeared, wiped a locally-held message once "sent" (startRun's own "regenerate"
// semantics), and kept the customer's disagreement out of the thread entirely, so it was
// removed rather than patched.
//
// The design now: wismoAgent itself gets two tools, offer_new_chat and
// offer_escalation_to_support (apps/agent/src/mastra/tools/), each rendering its own card as
// part of the agent's own normal, immediate reply — exactly the same pattern already proven
// for present_return_item_picker/commerce_list_orders_for_customer (registered the same way,
// via components.tools.by_name). No more classifier, no more gate, no more holding a message
// back before the agent ever sees it: every message reaches the agent normally, and the model
// itself decides — with the real conversation in front of it — whether to answer directly or
// render one of these two cards instead. Each tool's own deterministic guard (case-lookup.ts's
// summarizeConversationCases / findMostRecentResolvedCaseForConversation) still enforces
// exactly the same rules the old server-side gate did; only the mechanism for OFFERING moved.
// ---------------------------------------------------------------------------------------

// Used by both cards below: offer_new_chat needs the customer's own message that triggered
// it (to resend into the fresh thread); offer_escalation_to_support needs it too (to pass as
// the disagreement text to /chat/:agentId/escalate-disagreement). Customer messages never
// call tools, so only `type: "text"` parts are relevant — deliberately loose shapes, since
// this only ever reads one field back out of message history.
function lastUserMessageText(runtime: AssistantRuntime): string {
  const messages = runtime.thread.getState().messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "user") continue;
    return message.content
      .map((part) => ((part as { type?: string; text?: string }).type === "text" ? (part as { text?: string }).text ?? "" : ""))
      .join(" ")
      .trim();
  }
  return "";
}

// Shares conversationIdRef with the two cards below without threading it through props —
// same "read the exact instance ChatWidget created" reasoning as ChatRuntimeContext. Both
// cards need it: offer_new_chat regenerates it after switching threads; offer_escalation_to_
// support reads it to scope the ticket to the right conversation.
const ConversationIdContext = createContext<{ current: string } | null>(null);

// offer_new_chat's own card (mastra/tools/offer-new-chat.ts) — rendered exactly like
// present_return_item_picker's own tool-UI (components.tools.by_name), reusing the same
// aui-newchat/-actions/-btn CSS the old, hand-built NewChatQuestion bubble used. "Start new
// chat" swaps in a fresh assistant-ui thread and a fresh conversationId (the tab's own
// sessionId, and with it the live-push connection, is untouched), then resends the customer's
// own message that triggered this card. Deliberately does NOT carry over an attached photo —
// extracting a File back from an already-sent image part is more complex/risky than needed
// here, an accepted trade-off. "Cancel" is a purely local dismiss — nothing was held back, so
// there's nothing to undo; the conversation just continues normally in this same thread.
function OfferNewChat({ result, isError }: ToolCallMessagePartProps<{ message: string }, { message: string }>) {
  const runtime = useContext(ChatRuntimeContext);
  const conversationIdRef = useContext(ConversationIdContext);
  const [dismissed, setDismissed] = useState(false);
  const [starting, setStarting] = useState(false);
  const startingRef = useRef(false);
  const sentenceAlreadyShown = useSentenceAlreadyShown(result?.message);

  if (!result || isError || typeof result.message !== "string" || dismissed) return null;

  const start = async () => {
    if (!runtime || !conversationIdRef || startingRef.current) return;
    startingRef.current = true;
    setStarting(true);
    // Read before switching — the message that triggered this card is still sitting in the
    // OLD thread's own history at this point.
    const text = lastUserMessageText(runtime);
    try {
      await runtime.threads.switchToNewThread();
    } catch (error) {
      console.error("[chat] Could not start a new chat:", error);
      startingRef.current = false;
      setStarting(false);
      return;
    }
    conversationIdRef.current = generateSessionId();
    setDismissed(true);
    if (text) {
      const fresh = runtime.thread.composer;
      fresh.setText(text);
      fresh.send();
    }
  };

  return (
    <div className="aui-newchat">
      {!sentenceAlreadyShown && <div>{result.message}</div>}
      <div className="aui-newchat-actions">
        <button type="button" className="aui-newchat-btn" onClick={() => void start()} disabled={starting}>
          {starting ? "Starting…" : "Start new chat"}
        </button>
        <button type="button" className="aui-newchat-btn aui-newchat-btn-secondary" onClick={() => setDismissed(true)} disabled={starting}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// offer_escalation_to_support's own card (mastra/tools/offer-escalation.ts) — same shape as
// OfferNewChat above. "Escalate to support" calls the existing /chat/:agentId/escalate-
// disagreement route directly (a stub ticket call, not a workflow resume — the case behind a
// disagreement is already terminal), passing the customer's own disagreement text (already
// visible in the thread as a normal message, since nothing holds it back before the agent
// sees it any more). "Cancel" is a purely local dismiss — the conversation just continues
// normally in this same thread; there is no tool for the model to act on a disagreement about
// an already-closed case, so nothing further happens unless the customer raises something new.
// caseId: which decided case this card is for (offer_escalation_to_support's own output) — sent back with
// the click so a decision from an EARLIER chat can be escalated too; the route re-validates it.
function OfferEscalation({ result, isError }: ToolCallMessagePartProps<{ message: string }, { message: string; caseId?: string }>) {
  const runtime = useContext(ChatRuntimeContext);
  const conversationIdRef = useContext(ConversationIdContext);
  const [dismissed, setDismissed] = useState(false);
  const [escalating, setEscalating] = useState(false);
  const [ticketMessage, setTicketMessage] = useState<string | null>(null);
  const escalatingRef = useRef(false);
  const sentenceAlreadyShown = useSentenceAlreadyShown(result?.message);

  if (!result || isError || typeof result.message !== "string" || dismissed) return null;

  const escalate = async () => {
    if (!runtime || !conversationIdRef || escalatingRef.current) return;
    escalatingRef.current = true;
    setEscalating(true);
    try {
      const text = lastUserMessageText(runtime);
      const res = await fetch(`${AGENT_URL}/chat/wismoAgent/escalate-disagreement`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: conversationIdRef.current, caseId: result.caseId, message: text }),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`escalate-disagreement failed (${res.status})`);
      const { ticketId, contactWindowHours } = (await res.json()) as { ticketId?: string; contactWindowHours?: number };
      const ticket = ticketId ? ` (${ticketId})` : "";
      const window = contactWindowHours ? `${contactWindowHours} hours` : "shortly";
      setTicketMessage(`I've escalated this to our support team${ticket}. Someone will reach out within ${window}.`);
    } catch (error) {
      console.error("[chat] Could not escalate to support:", error);
      escalatingRef.current = false;
      setEscalating(false);
    }
  };

  if (ticketMessage) {
    return (
      <div className="aui-newchat">
        <div>{ticketMessage}</div>
      </div>
    );
  }

  return (
    <div className="aui-newchat">
      {!sentenceAlreadyShown && <div>{result.message}</div>}
      <div className="aui-newchat-actions">
        <button type="button" className="aui-newchat-btn" onClick={() => void escalate()} disabled={escalating}>
          {escalating ? "Escalating…" : "Escalate to support"}
        </button>
        <button type="button" className="aui-newchat-btn aui-newchat-btn-secondary" onClick={() => setDismissed(true)} disabled={escalating}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// crypto.randomUUID() only exists in secure contexts (HTTPS or localhost) — it throws on
// a plain-HTTP tunnel/IP host. This id is never used cryptographically, just as a
// per-tab key, so a Math.random fallback is fine there.
function generateSessionId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

export function ChatWidget() {
  const [open, setOpen] = useState(false);
  const composerInputRef = useRef<HTMLTextAreaElement>(null);

  // One per browser tab, for the tab's whole lifetime — not persisted anywhere (a reload
  // gets a fresh one), and never sent anywhere except this app's own agent. Scopes every
  // live push to the exact tab that created a case (see apps/agent's request-context.ts
  // SESSION_ID_KEY) rather than "any open chat for this customer," which leaked updates
  // into whichever tab happened to be open, not necessarily the one that created the
  // case — confirmed live.
  const [sessionId] = useState(generateSessionId);

  // One per CONVERSATION — a single thread of messages — as opposed to sessionId above,
  // which is one per browser tab. They start out both fresh and diverge the first time the
  // customer accepts "Start new chat" (see the block comment above generateSessionId): a new
  // conversation gets a new id here while sessionId, and with it the live-push connection,
  // stays put. Sent with every message so the agent can scope a case's transcript and its
  // "does this chat still have an open case" check to the chat it actually came from. A ref,
  // not state: nothing renders from it, and the transport below reads it at send time, so an
  // in-flight re-render can never send a stale one.
  const conversationIdRef = useRef("");
  if (!conversationIdRef.current) conversationIdRef.current = generateSessionId();

  // Per-case SLA state — see SlaRunContext above for why this tracks the latest known
  // deadline per runId, not just a pause reason: it's what lets an older SlaCountdown
  // message for a case tell it's been superseded by a fresher one, instead of resuming.
  const [slaRunStates, setSlaRunStates] = useState<Map<string, SlaRunState>>(new Map());

  // The panel is always mounted — open/closed is a CSS transform (see .chat-panel.open
  // in globals.css), not conditional rendering — so a plain `autoFocus` on the textarea
  // would only ever fire once, on first mount, not on every open. requestAnimationFrame
  // gives the "open" class one paint to apply before focusing, so this doesn't fire while
  // the panel is still off-screen.
  useEffect(() => {
    if (!open) return;
    const id = requestAnimationFrame(() => composerInputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open]);

  // Set when a photo can't be used (too big and unshrinkable) — shown above the composer, clears itself.
  const [photoProblem, setPhotoProblem] = useState<string | null>(null);
  useEffect(() => {
    if (!photoProblem) return;
    const timer = setTimeout(() => setPhotoProblem(null), 10_000);
    return () => clearTimeout(timer);
  }, [photoProblem]);
  const photoAdapter = useMemo(() => new ResizedImageAttachmentAdapter(setPhotoProblem), []);

  const runtime = useChatRuntime({
    // body is a function so every request reads the CURRENT conversationId — it changes when
    // the customer starts a new chat, and this transport object outlives that change.
    transport: new AssistantChatTransport({
      api: `${AGENT_URL}/chat/wismoAgent`,
      body: () => ({ sessionId, conversationId: conversationIdRef.current }),
    }),
    // Lets a customer attach a damage photo to the message box (a paperclip button next
    // to the composer, wired up below) — the one thing wismo-agent.ts now asks for on
    // every damage claim but that, before this, had no way to actually arrive: the chat
    // had zero attachment UI, so "send a photo" was a dead-end request. SimpleImageAdapter
    // reads the file as a data: URL client-side (@assistant-ui/core) — the same shape
    // demo-seed.ts's synthesized damage photos already use for a case's transcript
    // imageDataUrl, so a live-uploaded photo lands in the Escalation Desk exactly like a
    // seeded one, no server-side conversion needed.
    // ResizedImageAttachmentAdapter (lib/image-attachment.ts) = the library's SimpleImageAttachmentAdapter plus a
    // browser-side shrink to 1568px: a 10 MB phone photo made the whole turn fail at the API.
    adapters: { attachments: photoAdapter },
    // Default behavior groups consecutive separate assistant-role messages into one
    // rendered bubble (@assistant-ui/core's chunkExternalMessages) — found by reading the
    // installed source after the parentId fix alone didn't stop a pushed message from
    // merging into the model's own preceding reply with no separator. Never affects a
    // single turn's own multi-part reply (tool call + text) since that's already one
    // UIMessage entry, not two — this only ever mattered for exactly the case it's now
    // turned off for: an SSE-pushed message landing right after a completed turn.
    joinStrategy: "none",
  });

  // Genuine server push, not polling — see server.ts's /chat/:agentId/events. Held open
  // for the widget's whole lifetime (not just while the panel is open) so a case a rep
  // resolves while the customer is browsing elsewhere on the site is already sitting in
  // the thread by the time they open the panel again. The browser's own EventSource
  // reconnects with Last-Event-ID; the server replays updates missed during the gap.
  const lastCaseEventId = useRef("");
  useEffect(() => {
    // Left to the browser alone, a dropped connection is not reliably recovered: Firefox gives
    // up (readyState CLOSED, no further retries) when a retry lands while the agent is down —
    // exactly what a restart does. Nothing then ever reaches this tab again, silently: a rep's
    // decision never shows up and the countdown runs out into "opening a support ticket" with
    // nothing real behind it (as when the agent restarted ~25s before a rep
    // rejected a case). So the widget reconnects itself, backing off, from the last event it
    // RECEIVED — the server replays whatever was recorded after that cursor.
    //
    // lastReceivedId, not lastCaseEventId: that one only advances once a push has actually been
    // appended to the thread, which can wait behind a running turn — resuming from it would
    // replay events already received and show them twice.
    let source = null as EventSource | null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let retryDelayMs = 2000;
    let stopped = false;
    let lastReceivedId = "";
    const pendingUnsubscribes = new Set<() => void>();

    const appendPush = (id: string, buildMessage: Parameters<typeof appendWhenIdle>[1]) => {
      const unsubscribe = appendWhenIdle(runtime, () => {
        const message = buildMessage();
        lastCaseEventId.current = id;
        return message;
      });
      pendingUnsubscribes.add(unsubscribe);
    };

    const listen = (target: EventSource, type: string, handle: (raw: MessageEvent<string>) => void) => {
      target.addEventListener(type, (raw) => {
        const message = raw as MessageEvent<string>;
        lastReceivedId = message.lastEventId || lastReceivedId;
        handle(message);
      });
    };

    const connect = (cursor: string) => {
      const next = new EventSource(`${AGENT_URL}/chat/wismoAgent/events?sessionId=${encodeURIComponent(sessionId)}&cursor=${encodeURIComponent(cursor)}`);
      source = next;
      next.addEventListener("open", () => {
        retryDelayMs = 2000;
      });
      next.addEventListener("error", () => {
        // While readyState is CONNECTING the browser is already retrying on its own.
        if (stopped || next.readyState !== EventSource.CLOSED) return;
        next.close();
        retryTimer = setTimeout(() => connect(lastReceivedId || lastCaseEventId.current), retryDelayMs);
        retryDelayMs = Math.min(retryDelayMs * 2, 15000);
      });

      listen(next, "case-resolved", (raw) => {
        const event: CaseResolvedEvent = JSON.parse(raw.data);
        // Whatever this case's countdown was doing, it's done now — executed/denied are
        // terminal, and escalated_to_support already got its own "we've opened a ticket"
        // push. Without this, an old SlaCountdown for this runId just keeps ticking (and
        // can reach "past due / opening a support ticket" wording) after the case is
        // already fully resolved — a real bug, same shape as the request-more-info pause.
        // Only ever touches the LATEST widget for this runId (see SlaRunContext) — an
        // already-superseded older widget stays superseded, it doesn't need its own
        // "resolved" copy since it's already pointing at the newer one.
        setSlaRunStates((prev) => {
          const existing = prev.get(event.runId);
          if (!existing || existing.pauseReason === "resolved") return prev;
          return new Map(prev).set(event.runId, { ...existing, pauseReason: "resolved" });
        });
        // startRun: false — this message is already fully composed; appending it must not
        // trigger another model turn the way a real user message would.
        appendPush((raw as MessageEvent<string>).lastEventId, () => ({
          role: "assistant",
          content: [{ type: "text", text: caseResolvedMessage(event) }],
          startRun: false,
        }));
      });
      listen(next, "case-more-info", (raw) => {
        const event: CaseMoreInfoEvent = JSON.parse(raw.data);
        setSlaRunStates((prev) => {
          const existing = prev.get(event.runId);
          if (!existing || existing.pauseReason === "awaiting-customer") return prev;
          return new Map(prev).set(event.runId, { ...existing, pauseReason: "awaiting-customer" });
        });
        appendPush((raw as MessageEvent<string>).lastEventId, () => ({
          role: "assistant",
          content: [{ type: "text", text: caseMoreInfoMessage(event) }],
          startRun: false,
        }));
      });
      listen(next, "case-escalation-started", (raw) => {
        const event: CaseEscalationStartedEvent = JSON.parse(raw.data);
        // A "request more info" cycle re-fires this exact event, for the exact same runId,
        // once the customer answers (case-sync.ts) — this new deadlineIso becomes the run's
        // latest, which is what makes any EARLIER SlaCountdown message for this same runId
        // switch to its permanent "superseded" state on its own (see SlaRunContext / isLatest
        // above) instead of resuming from its own old, long-past deadline — a real bug, live-
        // reproduced, when this just cleared the pause flag instead.
        setSlaRunStates((prev) => new Map(prev).set(event.runId, { latestDeadlineIso: event.deadlineIso, pauseReason: undefined }));
        appendPush((raw as MessageEvent<string>).lastEventId, () => ({
          role: "assistant",
          content: [{ type: "text", text: slaCountdownMarker(event) }],
          startRun: false,
        }));
      });
    };

    connect(lastCaseEventId.current);
    return () => {
      stopped = true;
      clearTimeout(retryTimer);
      source?.close();
      pendingUnsubscribes.forEach((unsubscribe) => unsubscribe());
    };
  }, [runtime, sessionId]);

  return (
    <>
      <button
        className="chat-launcher"
        onClick={() => setOpen(true)}
        aria-hidden={open}
        tabIndex={open ? -1 : 0}
      >
        <ChatBubbleIcon />
        <span className="chat-launcher-label">Need help with an order?</span>
      </button>

      <div className={`chat-backdrop${open ? " open" : ""}`} onClick={() => setOpen(false)} aria-hidden="true" />

      <div className={`chat-panel${open ? " open" : ""}`} role="dialog" aria-modal="true" aria-label="Support chat" aria-hidden={!open}>
        <div className="chat-panel-header">
          <div>
            <div className="chat-panel-title">Waybound Support</div>
            <div className="chat-panel-sub">AI Assistant</div>
          </div>
          <span className="chat-panel-spacer" />
          <button className="chat-panel-close" onClick={() => setOpen(false)} aria-label="Close chat">
            <CloseIcon />
          </button>
        </div>

        <AssistantRuntimeProvider runtime={runtime}>
          <ChatRuntimeContext.Provider value={runtime}>
          <ConversationIdContext.Provider value={conversationIdRef}>
          <SlaRunContext.Provider value={slaRunStates}>
            <ThreadPrimitive.Root className="aui-root">
              <ThreadPrimitive.Viewport className="aui-viewport">
                <ThreadPrimitive.Empty>
                  <div className="aui-empty">
                    <strong>Where&rsquo;s my order?</strong>
                    Ask about tracking, a return, a replacement, or an exchange — I&rsquo;ll pull up your order and take it from there.
                  </div>
                  <div className="aui-empty-suggestions">
                    {["Where is my order?", "Help with an issue for an order", "Start a return"].map((prompt) => (
                      <button
                        key={prompt}
                        type="button"
                        className="aui-empty-suggestion"
                        onClick={() => appendIfIdle(runtime, prompt)}
                      >
                        {prompt}
                      </button>
                    ))}
                  </div>
                </ThreadPrimitive.Empty>
                <ThreadPrimitive.Messages>
                  {({ message }) => (message.role === "user" ? <UserMessage /> : <AssistantMessage />)}
                </ThreadPrimitive.Messages>
                <TypingIndicator />
              </ThreadPrimitive.Viewport>

              <ComposerPrimitive.Root className="aui-composer">
                {photoProblem && <div className="aui-composer-notice" role="alert">{photoProblem}</div>}
                <ComposerPrimitive.Attachments>
                  {() => (
                    <AttachmentPrimitive.Root className="aui-composer-attachment">
                      <AttachmentPrimitive.Name />
                      <AttachmentPrimitive.Remove className="aui-composer-attachment-remove" aria-label="Remove attachment">
                        ×
                      </AttachmentPrimitive.Remove>
                    </AttachmentPrimitive.Root>
                  )}
                </ComposerPrimitive.Attachments>
                <div className="aui-composer-row">
                  <ComposerPrimitive.AddAttachment className="aui-composer-attach" aria-label="Attach a photo">
                    <PaperclipIcon />
                  </ComposerPrimitive.AddAttachment>
                  <ComposerPrimitive.Input
                    ref={composerInputRef}
                    className="aui-composer-input"
                    placeholder="Type a message…"
                    rows={1}
                    autoComplete="off"
                    suppressHydrationWarning
                  />
                  <ComposerPrimitive.Send className="aui-composer-send" aria-label="Send message" suppressHydrationWarning>
                    <SendIcon />
                  </ComposerPrimitive.Send>
                </div>
              </ComposerPrimitive.Root>
            </ThreadPrimitive.Root>
          </SlaRunContext.Provider>
          </ConversationIdContext.Provider>
          </ChatRuntimeContext.Provider>
        </AssistantRuntimeProvider>
      </div>
    </>
  );
}
