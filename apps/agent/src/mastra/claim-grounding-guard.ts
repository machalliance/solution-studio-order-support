import type { ToolHooks } from "@mastra/core/tools";
import { bumpGroundingCorrections, getTurnFacts } from "./request-context";
import { SAFE_FALLBACK_MESSAGE } from "./response-leak-guard";

// A deterministic check that the SPECIFICS in a reply — dollar amounts, durations, dates, ticket and
// refund ids — came from somewhere real: this conversation's tool results, or the customer's own
// words. Not a list of phrases the agent may not say. The things a customer acts on are a small,
// closed set (how much, how long, when, which id), and each can be checked against the facts without
// knowing how the sentence around it was worded — which is why this holds up where a blocklist of
// "processed" / "on its way" / "a few business days" and their hundred variants never could.
//
// Added after live tests where the agent told customers an approved refund was "already processed"
// and "should arrive within a few business days": this system only ever knows a refund was APPROVED
// (refund-ledger.ts) and has no payment or arrival data at all, so any such claim is invented.
// The sibling check for case ids is case-id-guard.ts; this one covers amounts, times, dates and the
// other id shapes (it leaves 6-character case ids to that guard).
//
// What it does NOT do, stated plainly: it cannot catch a claim with no number, date or id in it —
// "it has been processed" has nothing to ground. That wording is handled upstream, by giving the model
// the exact sentence to relay (customer-statements.ts) and by its instructions; this is the net
// underneath them for the specifics. Soft by design: it fails OPEN (an unexpected error never blocks
// a reply), and on a miss it hands the model a correction to rewrite rather than swapping in a canned
// line — only after repeated misses in one turn does it fall back to the safe message.

// Tools whose RESULT is just the model's own words echoed back: facts from them would let a reply
// launder an invented number through an earlier reply ("said $50 once, so $50 is now grounded").
const ECHO_TOOLS = new Set(["respondToCustomer", "offerEscalationToSupport", "offerNewChat"]);

// Numeric fields the system KNOWS but the agent is told never to say (wismo-agent.ts: never state the
// exact response window in minutes). Left out of the facts so a reply stating one is caught.
const UNSPEAKABLE_KEYS = new Set(["slaMinutes"]);

const MAX_CORRECTIONS_PER_TURN = 2;

const MONTHS = "Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?";
const MONTH_INDEX: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

const AMOUNT = /(?:[$€£]|US\$|USD\s?)\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?|(\d+(?:\.\d{1,2})?)\s?(?:USD|dollars?|euros?|pounds?)\b/gi;
const DURATION = /\b(\d+)(?:\s*(?:-|–|—|to)\s*(\d+))?\s*(?:business\s+|working\s+|calendar\s+)?(?:minutes?|hours?|days?|weeks?|months?)\b/gi;
const VAGUE_DURATION = /\b(?:a\s+)?(?:few|couple(?:\s+of)?|several|handful\s+of)\s+(?:business\s+|working\s+)?(?:minutes?|hours?|days?|weeks?)\b/gi;
const RELATIVE_PROMISE = /\b(?:tomorrow|tonight|next\s+(?:business\s+)?(?:day|week|month)|by\s+(?:the\s+)?end\s+of\s+(?:the\s+)?(?:day|week|month))\b/gi;
const DATE = new RegExp(`\\b(${MONTHS})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, "gi");
const TICKET_ID = /\bTKT-[A-Z0-9]{4,}\b/g;
const REFUND_ID = /\bre_[a-z0-9_]+\b/gi;
const TRACKING_ID = /\b(?:RTN|TRK)-[A-Za-z0-9_+-]+/g;

interface Facts {
  toolText: string;
  customerText: string;
  numbers: Set<number>;
  dates: Set<string>; // "month-day" — every ISO date in a tool result, plus the day either side (time zones)
  customerDates: Set<string>;
}

function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part: any) => (typeof part?.text === "string" ? part.text : "")).join(" ");
}

const monthDay = (month: number, day: number) => `${month}-${day}`;

function monthNumber(name: string): number {
  return MONTH_INDEX[name.slice(0, 3).toLowerCase()];
}

// Numbers inside timestamps, long digit runs, product codes (belt-001) and order ids would make
// "2 days" or "4 hours" look grounded by coincidence — strip them before collecting the numbers.
function numbersIn(text: string): Set<number> {
  const scrubbed = text
    // Links and ids first: the digits inside a return-label link, a ticket, refund or case id are not
    // facts about amounts or time ("RTN-004203_belt-001" once made "1 day" look grounded).
    .replace(/https?:\/\/[^\s"\\]+/g, " ")
    .replace(/\b(?:RTN|TRK|TKT)-[A-Za-z0-9_+-]+/g, " ")
    .replace(/\bre_[a-z0-9_]+\b/gi, " ")
    .replace(/\b(?=[A-Z0-9]*[A-Z])[A-Z0-9]{6}\b/g, " ")
    .replace(/\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?/g, " ")
    .replace(/\b[a-z]+-\d+\b/gi, " ")
    .replace(/\border_\d+\b/gi, " ")
    .replace(/\b\d{5,}\b/g, " ");
  const found = new Set<number>();
  for (const match of scrubbed.match(/\d+(?:\.\d+)?/g) ?? []) found.add(Number(Number(match).toFixed(2)));
  return found;
}

function collectFacts(messages: unknown[], turnToolText = ""): Facts {
  let toolText = ` ${turnToolText}`;
  let customerText = "";
  for (const message of messages as any[]) {
    if (message?.role === "user") {
      customerText += ` ${textOfContent(message.content ?? message.parts)}`;
    } else if (message?.role === "tool" && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part?.type !== "tool-result" || ECHO_TOOLS.has(part.toolName)) continue;
        toolText += ` ${JSON.stringify(part.output, (key, value) => (UNSPEAKABLE_KEYS.has(key) ? undefined : value))}`;
      }
    }
  }

  const dates = new Set<string>();
  for (const [, y, m, d] of toolText.matchAll(/(\d{4})-(\d{2})-(\d{2})/g)) {
    const base = Date.UTC(Number(y), Number(m) - 1, Number(d));
    for (const offset of [-1, 0, 1]) {
      const day = new Date(base + offset * 86400000);
      dates.add(monthDay(day.getUTCMonth() + 1, day.getUTCDate()));
    }
  }
  const customerDates = new Set<string>();
  for (const [, month, day] of customerText.matchAll(DATE)) customerDates.add(monthDay(monthNumber(month), Number(day)));

  return { toolText, customerText, numbers: numbersIn(`${toolText} ${customerText}`), dates, customerDates };
}

// The tool results of the steps ALREADY COMPLETED this turn, from the turn loop's own `steps` (server.ts's
// prepareStep passes them in before each step). The hook's `context.messages` is only the conversation
// as it stood when the request arrived — it does NOT include this turn's earlier steps — so without this
// a reply written right after a lookup in the same turn (the normal case) was judged against facts that
// left out the very lookup it relied on, and flagged its own correct amounts (found by running it).
export function turnToolText(steps: unknown[]): string {
  let text = "";
  for (const step of steps as any[]) {
    for (const result of step?.toolResults ?? []) {
      if (ECHO_TOOLS.has(result?.toolName)) continue;
      text += ` ${JSON.stringify(result?.output, (key, value) => (UNSPEAKABLE_KEYS.has(key) ? undefined : value))}`;
    }
  }
  return text;
}

const grounded = (facts: Facts, value: number) => facts.numbers.has(Number(value.toFixed(2)));
const mentioned = (facts: Facts, phrase: string) => {
  const wanted = phrase.toLowerCase();
  return facts.customerText.toLowerCase().includes(wanted) || facts.toolText.toLowerCase().includes(wanted);
};

// Returns a short description of each specific in `message` that isn't in the facts (empty = fine).
function findUngroundedClaims(message: string, facts: Facts): string[] {
  const text = message.replace(/https?:\/\/\S+/g, " ");
  const problems: string[] = [];

  for (const match of text.matchAll(AMOUNT)) {
    const whole = match[1] ? Number(match[1].replace(/,/g, "") + (match[2] ? `.${match[2]}` : "")) : Number(match[3]);
    if (!grounded(facts, whole)) problems.push(`the amount "${match[0].trim()}"`);
  }

  for (const match of text.matchAll(DURATION)) {
    const before = text.slice(Math.max(0, match.index! - 12), match.index!).toLowerCase();
    const after = text.slice(match.index! + match[0].length, match.index! + match[0].length + 6).toLowerCase();
    // Time already elapsed ("8 days ago", "in the last 30 days") is arithmetic on a date, not a promise.
    if (/\bago\b|\bold\b/.test(after) || /\b(?:last|past|previous|since)\s*$/.test(before)) continue;
    const numbers = [Number(match[1]), ...(match[2] ? [Number(match[2])] : [])];
    if (!numbers.every((n) => grounded(facts, n))) problems.push(`the timeframe "${match[0].trim()}"`);
  }

  for (const match of text.matchAll(VAGUE_DURATION)) {
    if (!mentioned(facts, match[0])) problems.push(`the timeframe "${match[0].trim()}"`);
  }
  for (const match of text.matchAll(RELATIVE_PROMISE)) {
    if (!mentioned(facts, match[0])) problems.push(`the timing "${match[0].trim()}"`);
  }

  for (const match of text.matchAll(DATE)) {
    const key = monthDay(monthNumber(match[1]), Number(match[2]));
    if (!facts.dates.has(key) && !facts.customerDates.has(key)) problems.push(`the date "${match[0].trim()}"`);
  }

  for (const pattern of [TICKET_ID, REFUND_ID, TRACKING_ID]) {
    for (const match of text.matchAll(pattern)) {
      if (!mentioned(facts, match[0])) problems.push(`the reference "${match[0]}"`);
    }
  }

  return [...new Set(problems)];
}

export const claimGroundingGuard: NonNullable<ToolHooks<any, any, any>["beforeToolCall"]> = async ({ toolName, input, context }) => {
  if (toolName !== "respondToCustomer") return;
  const { message } = input as { message?: unknown };
  if (typeof message !== "string") return;

  // Fails OPEN: this is a heuristic net, so a bug in it must never become a customer-visible failure
  // (the sibling guards fail closed because a leak or a wrong id is worse than a stall; a missed
  // specific is not).
  let problems: string[];
  try {
    problems = findUngroundedClaims(message, collectFacts(Array.isArray(context.messages) ? context.messages : [], getTurnFacts(context)));
  } catch (error) {
    console.error("[claim-grounding-guard] check failed, letting the reply through:", error);
    return;
  }
  if (problems.length === 0) return;

  const attempt = bumpGroundingCorrections(context);
  console.error(`[claim-grounding-guard] reply #${attempt} this turn states ${problems.join(", ")} — not in any tool result or the customer's words. Original: ${JSON.stringify(message)}`);
  if (attempt > MAX_CORRECTIONS_PER_TURN) {
    return { proceed: false as const, output: { message: SAFE_FALLBACK_MESSAGE } };
  }

  // `error: true` is how the rest of the app already reads "this call delivered nothing": the widget
  // renders no bubble, the transcript skips it, and the turn loop forces another reply instead of
  // counting this one as said. The model sees this text as the tool's result and rewrites.
  return {
    proceed: false as const,
    output: {
      error: true,
      message:
        `Not sent. Your reply stated ${problems.join(", ")}, which is not in what the tools returned or what the customer said. ` +
        `Say only what the tool results say — use a result's "statement" where there is one — and give no amount, date, time or timeline of your own. ` +
        `For what happens next, say a specialist will follow up, with no number unless a tool returned one. Rewrite the reply without it and call respond_to_customer again.`,
    },
  };
};
