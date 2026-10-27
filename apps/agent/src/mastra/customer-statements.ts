import { config } from "../config";
import { formatMoney } from "../lib/money";
import { getSupportTicketContactHours } from "./runtime-settings";
import type { DisputeCoverage, ItemCoverage } from "./tools/case-lookup";

// The sentence the agent may say about where a case stands — built here, once, from the FACTS, so
// every place the agent learns a status (the order lookup, the status check, the "already has a case"
// refusals) hands it the same wording instead of leaving it to improvise one. Same instinct as
// the return refund policy's `customerReason`: a deterministic, ready-to-say line the model relays
// close to verbatim, which is what keeps it from inventing the parts a customer might act on — that
// money has been paid or "processed", how long it will take, a date. All this system knows about a
// refund is that it was APPROVED (never that money moved: see refund-ledger.ts), and the only
// timeline it has is the support contact window; nothing here says more than that.
//
// A statement is a SUGGESTION the model may warm up, never a gate: the grounding check
// (claim-grounding-guard.ts) is what independently verifies that whatever amounts, times, dates and
// ids a reply does contain came from these facts.

const hours = () => getSupportTicketContactHours();
const ticketLine = (ticketId: string) => `A support ticket (${ticketId}) is open for it — they will hear back within ${hours()} hours.`;

export function coverageStatement(coverage: ItemCoverage, itemName: string): string {
  switch (coverage.state) {
    case "refund_approved": {
      const amount = coverage.refundAmount !== undefined ? ` of ${formatMoney(coverage.refundAmount, config.currency)}` : "";
      const base = `A refund${amount} was approved for the ${itemName} (case ${coverage.caseId}).`;
      return coverage.ticketId ? `${base} ${ticketLine(coverage.ticketId)}` : base;
    }
    case "under_review":
      return `The ${itemName} already has an open case (${coverage.caseId}), and a specialist is reviewing it.`;
    case "with_support":
      return `A support ticket (${coverage.ticketId}) is already open for the ${itemName} (case ${coverage.caseId}) — they will hear back within ${hours()} hours.`;
    case "declined":
      return `An earlier request for the ${itemName} (case ${coverage.caseId}) was reviewed and was not approved.`;
  }
}

export function disputeStatement(dispute: DisputeCoverage): string {
  if (dispute.state === "under_review") {
    return `Case ${dispute.caseId} is already open for this order's delivery issue, and a specialist is reviewing it.`;
  }
  if (dispute.state === "denied") return `This order's delivery issue (case ${dispute.caseId}) was already reviewed and was not approved.`;
  if (dispute.state === "approved") {
    const amount = dispute.refundAmount !== undefined ? ` of ${formatMoney(dispute.refundAmount, config.currency)}` : "";
    return `This order's delivery issue (case ${dispute.caseId}) was already reviewed and a refund${amount} was approved.`;
  }
  const ticket = dispute.ticketId ? ` (${dispute.ticketId})` : "";
  return `A support ticket${ticket} is already open for this order's delivery issue (case ${dispute.caseId}) — they will hear back within ${hours()} hours.`;
}

// For check_escalation_status: one line for whatever it found. Deliberately says nothing about
// processing, payment or timing beyond what the facts hold.
export function caseStatusStatement(result: {
  status?: "pending" | "approved" | "denied" | "unclear";
  caseId?: string;
  refundAmount?: number;
  ticketId?: string;
  awaitingCustomerReply?: boolean;
}): string | undefined {
  const { status, caseId, refundAmount, ticketId, awaitingCustomerReply } = result;
  if (!caseId) return undefined;
  if (ticketId) {
    return `A support ticket (${ticketId}) is open for this (case ${caseId}) — they will hear back within ${hours()} hours.`;
  }
  if (status === "pending") {
    return awaitingCustomerReply
      ? `Case ${caseId} is waiting on the customer's reply to the specialist's question.`
      : `Case ${caseId} is with a specialist, who is reviewing it.`;
  }
  if (status === "approved") {
    const amount = refundAmount !== undefined ? ` of ${formatMoney(refundAmount, config.currency)}` : "";
    return `A refund${amount} was approved on case ${caseId}.`;
  }
  if (status === "denied") return `Case ${caseId} was reviewed and the request was not approved.`;
  return `Case ${caseId} is on file.`;
}
