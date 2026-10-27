import { test } from "node:test";
import assert from "node:assert/strict";
import { caseMoreInfoMessage, caseResolvedMessage, isCaseNotice } from "../case-notices";

const money = (amount: number, currency: string) => `${currency} ${amount.toFixed(2)}`;

test("an approved case says the amount, then the rep's note, then the label, then the closing question", () => {
  assert.equal(
    caseResolvedMessage({ orderId: "order_2001", action: "executed", refundAmount: 45, currency: "USD", comment: "Partial, as the box was only dented.", returnLabelUrl: "https://example.test/label" }, money),
    "Update on order #2001: a rep reviewed your case and approved it — a USD 45.00 refund has been approved. The specialist added: “Partial, as the box was only dented.” Please send the item back using your return label: [Download your return label](https://example.test/label). Is there anything else I can help you with?",
  );
});

test("an approved case with nothing extra is just the approval and the closing question", () => {
  assert.equal(caseResolvedMessage({ orderId: "1188", action: "executed" }, money), "Update on order #1188: a rep reviewed your case and approved it. Is there anything else I can help you with?");
});

test("a declined case gives the rep's reason when there is one", () => {
  assert.equal(
    caseResolvedMessage({ orderId: "order_3401", action: "denied", reason: "The carrier shows it was delivered." }, money),
    "Update on order #3401: a rep reviewed your case and wasn't able to approve the refund. Reason given: The carrier shows it was delivered. Is there anything else I can help you with?",
  );
});

test("a case sent to support is still open: no closing question, and the wording depends on who decided", () => {
  const byRep = caseResolvedMessage({ orderId: "order_1", action: "escalated_to_support", resolvedBy: "rep", ticketId: "TKT-ABC123", contactWindowHours: 24 }, money);
  assert.equal(byRep, "Update on order #1: a specialist reviewed your case and determined it needs additional support from our team. We've opened a support ticket for you (TKT-ABC123), and someone will reach out within 24 hours.");
  const byTimeout = caseResolvedMessage({ orderId: "order_1", action: "escalated_to_support", resolvedBy: "system", ticketId: "TKT-ABC123", contactWindowHours: 24 }, money);
  assert.equal(byTimeout, "We're sorry — this is taking a little longer than usual for order #1. We've gone ahead and opened a support ticket for you (TKT-ABC123), and our team will reach out within 24 hours.");
  assert.ok(!byRep.includes("anything else") && !byTimeout.includes("anything else"));
});

test("a follow-up question from a specialist quotes the question", () => {
  assert.equal(caseMoreInfoMessage({ orderId: "order_2001", question: "Could you send a photo of the label?" }), 'A specialist reviewing your order #2001 case has a follow-up question: "Could you send a photo of the label?"');
});

test("a rep's question that could not be asked in the chat is quoted, and does not read as a delay", () => {
  const text = caseResolvedMessage({ orderId: "order_1181", action: "escalated_to_support", resolvedBy: "rep", question: "Could you send a photo of the zipper?", ticketId: "TKT-ABC123", contactWindowHours: 24 }, money);
  assert.equal(
    text,
    "Update on order #1181: a specialist reviewing your case asked: “Could you send a photo of the zipper?” We couldn't reach you in the chat, so we've opened a support ticket for you (TKT-ABC123), and someone will reach out within 24 hours.",
  );
  assert.ok(!/longer than usual/.test(text), "it is not the timeout apology");
  assert.ok(isCaseNotice(text), "the widget still recognises it as a rep's notice");
});

test("a customer who did not answer a rep's question in time is told so, not given the delay apology", () => {
  const text = caseResolvedMessage({ orderId: "order_1181", action: "escalated_to_support", resolvedBy: "system", customerDidNotReply: true, ticketId: "TKT-ABC123", contactWindowHours: 24 }, money);
  assert.equal(text, "Update on order #1181: a specialist asked you a question and we haven't heard back, so we've opened a support ticket for you (TKT-ABC123), and someone will reach out within 24 hours.");
  assert.ok(!/longer than usual/.test(text));
  assert.ok(isCaseNotice(text));
});

test("a message is recognised as a rep's notice exactly when the notice builders wrote it", () => {
  const built = [
    caseResolvedMessage({ orderId: "order_2001", action: "executed", refundAmount: 45, currency: "USD", comment: "Partial.", returnLabelUrl: "https://example.test/l" }, money),
    caseResolvedMessage({ orderId: "order_2001", action: "executed" }, money),
    caseResolvedMessage({ orderId: "order_3401", action: "denied", reason: "Delivered." }, money),
    caseResolvedMessage({ orderId: "order_1", action: "escalated_to_support", resolvedBy: "rep", ticketId: "TKT-ABC123", contactWindowHours: 24 }, money),
    caseResolvedMessage({ orderId: "order_1", action: "escalated_to_support", resolvedBy: "system", ticketId: "TKT-ABC123", contactWindowHours: 24 }, money),
    caseMoreInfoMessage({ orderId: "order_2001", question: "Could you send a photo?" }),
  ];
  for (const text of built) assert.ok(isCaseNotice(text), `not recognised: ${text.slice(0, 60)}`);
  for (const text of ["Where is my order?", "Your return has been approved for \$19.99.", "Let me check on that for you.", "I have passed this to a specialist who will review it.", "", "Update on my life"]) {
    assert.ok(!isCaseNotice(text), `wrongly recognised: ${text}`);
  }
});
