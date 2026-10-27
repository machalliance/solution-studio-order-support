// The wording of the two notices the chat shows when a rep acts on a case or asks the customer a question.
// Single-sourced here because two places must say exactly the same words: the storefront widget (it shows the notice
// the moment the push arrives) and the agent (it writes the same notice into the conversation's stored thread, so the
// model has "read" what the customer read). No imports: both apps load this file as it is.

export interface CaseResolvedNotice {
  orderId: string;
  action: "executed" | "denied" | "escalated_to_support";
  refundAmount?: number;
  currency?: string;
  reason?: string;
  returnLabelUrl?: string;
  // The rep's own message on an approve / modify.
  comment?: string;
  ticketId?: string;
  contactWindowHours?: number;
  resolvedBy?: "system" | "rep";
  // A rep's question that could not be asked live (no chat tab connected), so a support ticket opened instead.
  question?: string;
  // The case was waiting on the customer's answer to a rep's question and the response window ran out.
  customerDidNotReply?: boolean;
}

export interface CaseMoreInfoNotice {
  orderId: string;
  question: string;
}

// Each app formats money with its own formatMoney (lib/money.ts); passing it in keeps this file import-free.
export type FormatMoney = (amount: number, currency: string) => string;

// The agent's own closing-courtesy rule only governs the model's generated turns. It cannot reach a notice that is built
// by code the moment a rep acts with nobody live in the conversation, so it is added here for the final outcomes
// ("executed" and "denied"), not for "escalated_to_support", which is still an open case.
const ANYTHING_ELSE = " Is there anything else I can help you with?";

export function caseResolvedMessage(event: CaseResolvedNotice, formatMoney: FormatMoney): string {
  const shortOrderId = event.orderId.replace(/^order_/, "");
  if (event.action === "executed") {
    const amount =
      event.refundAmount !== undefined && event.currency
        ? ` — a ${formatMoney(event.refundAmount, event.currency)} refund has been approved`
        : "";
    // The trailing period lives inside the link sentence itself, because ANYTHING_ELSE starts a new sentence right after it.
    const label = event.returnLabelUrl ? ` Please send the item back using your return label: [Download your return label](${event.returnLabelUrl}).` : "";
    // The rep's own words, when they wrote any: a modified refund needs the explanation, or the customer just sees a smaller number than they asked for.
    const note = event.comment ? ` The specialist added: “${event.comment}”` : "";
    return `Update on order #${shortOrderId}: a rep reviewed your case and approved it${amount}.${note}${label}${ANYTHING_ELSE}`;
  }
  if (event.action === "escalated_to_support") {
    const ticket = event.ticketId ? ` (${event.ticketId})` : "";
    const window = event.contactWindowHours ? `${event.contactWindowHours} hours` : "shortly";
    // A rep's question the customer could not be asked in the chat: say what was asked, so the ticket does not read as a delay.
    if (event.question) {
      return `Update on order #${shortOrderId}: a specialist reviewing your case asked: “${event.question}” We couldn't reach you in the chat, so we've opened a support ticket for you${ticket}, and someone will reach out within ${window}.`;
    }
    if (event.customerDidNotReply) {
      return `Update on order #${shortOrderId}: a specialist asked you a question and we haven't heard back, so we've opened a support ticket for you${ticket}, and someone will reach out within ${window}.`;
    }
    if (event.resolvedBy === "rep") {
      return `Update on order #${shortOrderId}: a specialist reviewed your case and determined it needs additional support from our team. We've opened a support ticket for you${ticket}, and someone will reach out within ${window}.`;
    }
    return `We're sorry — this is taking a little longer than usual for order #${shortOrderId}. We've gone ahead and opened a support ticket for you${ticket}, and our team will reach out within ${window}.`;
  }
  const reason = event.reason ? ` Reason given: ${event.reason}` : "";
  return `Update on order #${shortOrderId}: a rep reviewed your case and wasn't able to approve the refund.${reason}${ANYTHING_ELSE}`;
}

// True for text that caseResolvedMessage or caseMoreInfoMessage built: a rep's question or decision, as opposed to anything the
// agent or the customer said. The widget uses it to tell the two apart. (shared/tests/case-notices.test.ts fails if the wording
// below and these builders ever drift apart.)
export function isCaseNotice(text: string): boolean {
  return /^(?:Update on order #|A specialist reviewing your order #|We're sorry — this is taking a little longer than usual for order #)/.test(text.trim());
}

export function caseMoreInfoMessage(event: CaseMoreInfoNotice): string {
  const shortOrderId = event.orderId.replace(/^order_/, "");
  return `A specialist reviewing your order #${shortOrderId} case has a follow-up question: "${event.question}"`;
}
