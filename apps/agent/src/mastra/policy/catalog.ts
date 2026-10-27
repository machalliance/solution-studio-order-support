// The shared, machine-readable capability catalog — the ONE list of what a policy
// document is allowed to reference. Consumed by validate.ts (rejects any unregistered
// source/field), the Policy Helper (told exactly what it may use, nothing more), and
// the eventual Escalation Desk editor (what it offers an operator to pick from). Exposes an
// explicit, curated subset of application data — never an arbitrary object path into
// live fixtures.
//
// Every entry's `provenance` says where the value actually comes from:
// - "server-computed": derived entirely from trusted server-side data (an order's own
//   amount, a customer's VIP flag) — never something the customer or the model stated.
// - "customer-claim": something the customer said, not independently verified (the
//   damage-fault attribution). A policy may route on it, but it can never be trusted
//   the same way a server-computed fact is — same anti-coercion discipline as
//   everywhere else in this app.
// - "trusted-fixture": seeded demo data standing in for a real system of record
//   (completed-refund history) — real in shape, fixture in origin.

export type FieldType = "number" | "boolean" | "string";
export type Provenance = "server-computed" | "customer-claim" | "trusted-fixture";

export interface FieldDescriptor {
  field: string;
  type: FieldType;
  description: string;
  provenance: Provenance;
}

export interface CollectionDescriptor {
  source: string;
  description: string;
  provenance: Provenance;
  // Fields available as "item.<field>" inside a filter condition scoped to this
  // collection — a separate namespace from the outer context's own top-level fields,
  // so "item.completedAt" can never be confused with, say, "order.deliveredDate".
  itemFields: FieldDescriptor[];
}

// Scalar, single-value facts every policy rule may reference directly.
const CATALOG_FIELDS: FieldDescriptor[] = [
  { field: "order.amount", type: "number", description: "The order's own total value.", provenance: "server-computed" },
  { field: "order.deliveredDate", type: "string", description: "ISO date the order was delivered. It can be in the FUTURE (or missing) for an order that has not been delivered: \"withinDays\" is true only for a past date inside the window, while \"olderThanDays\" is false for a future date — so state eligibility with withinDays, never as \"not older than\".", provenance: "server-computed" },
  { field: "order.alreadyRefundedAmount", type: "number", description: "Cumulative amount already refunded on THIS order (from completed refunds only) — distinct from customer.completedRefunds, which is scoped to the customer across every one of their orders.", provenance: "server-computed" },
  { field: "request.amount", type: "number", description: "The server-computed refund/return amount for this specific request — never a customer- or model-stated number.", provenance: "server-computed" },
  { field: "request.faultKnown", type: "boolean", description: "Whether the customer stated who's at fault for the damage. False means genuinely unknown, not 'not their fault'.", provenance: "server-computed" },
  { field: "request.notCustomerFault", type: "boolean", description: "Only meaningful when request.faultKnown is true — whether the customer says the damage is NOT their own fault (a product/shipping defect). This is the customer's claim, not verified evidence.", provenance: "customer-claim" },
  { field: "customer.vip", type: "boolean", description: "Whether the customer's account is VIP.", provenance: "server-computed" },
  { field: "customer.completedRefundHistoryStartDate", type: "string", description: "ISO date this customer's completed-refund history is known to be complete FROM — a lookback window that reaches earlier than this date is not fully covered by known data, and should not be treated as if it were.", provenance: "trusted-fixture" },
  { field: "relatedCase.pendingAmount", type: "number", description: "Sum of every OTHER currently-open case's own requested amount on this same order — folded in so a request that's fine in isolation can't combine with a simultaneously-open case to exceed a ceiling unnoticed.", provenance: "server-computed" },
];

// Collections a fact may aggregate over (sum/count), each item optionally filtered.
const CATALOG_COLLECTIONS: CollectionDescriptor[] = [
  {
    source: "customer.completedRefunds",
    description:
      "Every COMPLETED refund for this customer, across all of their orders — seeded historical fixture records only. This app only ever knows a refund was APPROVED, never that an OMS payment actually completed, so a live-approved refund can't honestly be counted here. Deliberately excludes anything merely approved-and-pending, escalated, or denied: only a refund known to have actually completed. Never another customer's refunds.",
    provenance: "trusted-fixture",
    itemFields: [
      { field: "item.amount", type: "number", description: "The refunded amount, in the account's own currency.", provenance: "trusted-fixture" },
      { field: "item.completedAt", type: "string", description: "ISO date/time the refund completed.", provenance: "trusted-fixture" },
    ],
  },
];

export function findField(field: string): FieldDescriptor | undefined {
  return CATALOG_FIELDS.find((f) => f.field === field);
}

export function findCollection(source: string): CollectionDescriptor | undefined {
  return CATALOG_COLLECTIONS.find((c) => c.source === source);
}

import { ARITHMETIC_OPS, REASONS } from "./schema";

// Every operator the condition grammar supports — validate.ts rejects anything else,
// and this is exactly what the Policy Helper is told is available. These are the COMPARISONS
// used in a condition; arithmetic (CATALOG_ARITHMETIC) is a separate thing that builds a value.
export const CATALOG_OPERATORS = ["eq", "neq", "gt", "gte", "lt", "lte", "withinDays", "olderThanDays"] as const;

// The only operators allowed INSIDE a value (a fact's "value", or either side of a
// comparison). These were once missing from the catalog, so the Policy Helper only knew they
// existed from copying the two existing facts — and invented a {"op": "conditional"} by analogy.
const CATALOG_ARITHMETIC = ARITHMETIC_OPS;

// What a restriction may do (only send a case to a person) and what a decision may do (the only automatic outcomes).
const CATALOG_RESTRICTION_OUTCOMES = ["escalate", "always_escalate"] as const;
const CATALOG_DECISION_OUTCOMES = ["autonomous_approve", "autonomous_deny"] as const;
const CATALOG_AGGREGATES = ["sum", "count"] as const;

// A single, serializable summary — what actually gets handed to the Policy Helper (as
// part of its own prompt context) and could back a future Escalation Desk "available data" browser.
export function describeCatalog() {
  return {
    fields: CATALOG_FIELDS,
    collections: CATALOG_COLLECTIONS,
    operators: CATALOG_OPERATORS,
    arithmetic: CATALOG_ARITHMETIC,
    reasons: REASONS,
    ruleKinds: ["restriction", "decision"] as const,
    restrictionOutcomes: CATALOG_RESTRICTION_OUTCOMES,
    decisionOutcomes: CATALOG_DECISION_OUTCOMES,
    aggregates: CATALOG_AGGREGATES,
  };
}
