import type { ToolHooks } from "@mastra/core/tools";
import { ALPHABET, LENGTH } from "./case-id";
import { mastra } from "./index";
import { getIssuedCaseIds, getSessionCustomerId } from "./request-context";
import { SAFE_FALLBACK_MESSAGE } from "./response-leak-guard";
import { findCaseForCustomer } from "./tools/case-lookup";
import { messageText } from "./tools/chat-transcript";

// A deterministic check that no case ID reaches the customer unless it is REAL. The model once
// told a customer "I've created case 7K3PQR" (an example ID copied from its own instructions)
// while the escalation tool had returned a different runId. A wrong case ID is worse than none
// (the customer quotes it back and nothing is found), and reminding the model harder isn't a
// guarantee, so this sits in code on the same respond_to_customer hook seam response-leak-guard.ts
// uses (wismo-agent.ts composes them). That guard skips case-ID-shaped tokens; this one checks them.
//
// A case-ID-shaped token in a reply is fine if EITHER
//   - it is a real case belonging to this customer — case-lookup.ts's findCaseForCustomer
//     against the durable workflow runs (the case ID IS the runId, so this covers a case just
//     created this turn, one from earlier in the chat, and one from an earlier chat alike), OR
//   - the customer wrote it themselves in this conversation — the agent may repeat an ID it was
//     given even when it turns out not to exist ("I couldn't find a case with that number").
// Anything else is unverified: an invented ID, a character dropped or swapped in transit, or
// another customer's case.
//
// What happens to an unverified one:
//   - REPAIRED in place when there is no ambiguity: exactly one unverified token, and exactly one
//     case was opened by an escalation tool this turn (request-context.ts's markCaseIdIssued)
//     whose ID isn't already in the message. The intent is unmistakable — the model was quoting the
//     case it had just been handed — and the customer gets the right number instead of a stall.
//   - otherwise the message is replaced with the same safe fallback response-leak-guard.ts uses.
// Both are logged loudly; a real one of these is worth reading about.
//
// Known limits, stated plainly. It can't tell two of a customer's OWN real cases apart (quoting
// the wrong one of two still passes). It only looks at uppercase tokens of the case-ID shape with
// at least one letter, so an invented all-digit ID slips through — a purely numeric run is far
// more likely a tracking number than an ID (1 in ~1,000 real IDs is all digits). And an
// all-caps six-letter word made only of case-ID characters would be flagged; the model doesn't
// write those, and the cost of a false positive is one safe-fallback reply, never a wrong fact.
// Finally, only whole six-character tokens are examined — a TRUNCATED ID ("XS51H") or a padded
// one isn't ID-shaped, so it passes; the instructions' "never shorten it" is all that covers that.

const CASE_ID_PATTERN = new RegExp(`\\b[${ALPHABET}]{${LENGTH}}\\b`, "g");

// Legitimate things that CONTAIN case-ID-shaped substrings but aren't case IDs — removed before
// scanning. The support ticket one matters most: escalate-support-ticket.ts builds them as
// "TKT-" plus six base-36 characters, so roughly half of all ticket numbers look exactly like a
// case ID and the agent is told to state them.
const NOT_A_CASE_ID_PATTERNS = [
  /https?:\/\/\S+/g, // return-label / tracking links
  /\bre_[a-z0-9_]+\b/gi, // refund ids (payment.ts)
  /\bTKT-[A-Z0-9]+\b/g, // support ticket ids
  /\b(?:TRK|RTN)-\S+/g, // tracking numbers, including the multi-item form RTN-004203_pants-002+belt-001
];

// Exported for direct use from a scratch script, like response-leak-guard.ts's detector.
function extractCaseIdCandidates(message: string): string[] {
  let stripped = message;
  for (const pattern of NOT_A_CASE_ID_PATTERNS) stripped = stripped.replace(pattern, " ");
  const tokens = stripped.match(CASE_ID_PATTERN) ?? [];
  return [...new Set(tokens)].filter((token) => /[A-Z]/.test(token));
}

// Everything the customer has said in this conversation, uppercased — an ID they typed in any
// case is an ID they gave us. A beforeToolCall hook's context.messages is the same resent
// history refund-policy-gate.ts reads for its transcript.
function customerSaid(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  return (messages as { role?: string }[])
    .filter((m) => m?.role === "user")
    .map((m) => messageText(m as Parameters<typeof messageText>[0]))
    .join("\n")
    .toUpperCase();
}

export const caseIdGuard: NonNullable<ToolHooks<any, any, any>["beforeToolCall"]> = async ({ toolName, input, context }) => {
  if (toolName !== "respondToCustomer") return;
  const { message } = input as { message?: unknown };
  if (typeof message !== "string") return;

  const candidates = extractCaseIdCandidates(message);
  if (candidates.length === 0) return;

  const said = customerSaid(context.messages);
  const customerId = getSessionCustomerId(context);
  const workflow = mastra.getWorkflow("policyReviewWorkflow");

  const unverified: string[] = [];
  for (const token of candidates) {
    if (said.includes(token)) continue;
    if (workflow && (await findCaseForCustomer(workflow, token, customerId))) continue;
    unverified.push(token);
  }
  if (unverified.length === 0) return;

  const opened = getIssuedCaseIds(context);
  if (unverified.length === 1 && opened.length === 1 && !message.includes(opened[0])) {
    const repaired = message.replace(new RegExp(`\\b${unverified[0]}\\b`, "g"), opened[0]);
    console.error(`[case-id-guard] Corrected a case ID that matches no real case (${unverified[0]}) to the one opened this turn (${opened[0]}). Original: ${JSON.stringify(message)}`);
    return { proceed: false as const, output: { message: repaired } };
  }

  console.error(`[case-id-guard] Blocked a customer-facing message stating a case ID that matches no real case (${unverified.join(", ")}). Original: ${JSON.stringify(message)}`);
  return { proceed: false as const, output: { message: SAFE_FALLBACK_MESSAGE } };
};
