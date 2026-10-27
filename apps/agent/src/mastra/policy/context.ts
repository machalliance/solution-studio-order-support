// Builds the trusted fact context a policy evaluates against — the ONLY place real
// server data enters the evaluator. Every field here matches a catalog.ts entry
// exactly; nothing here is ever supplied by the customer or the model directly (same
// anti-coercion discipline as every other gating fact in this app).

import { getOrder, getCustomer, type Order, type Customer } from "../../fixtures/demo-data";
import { totalRefundedForOrder } from "../refund-ledger";
import { completedRefundFixturesForCustomer, COMPLETED_REFUND_HISTORY_START_DATE } from "../../fixtures/completed-refunds";

export interface CompletedRefundItem {
  amount: number;
  completedAt: string;
}

export interface PolicyContext {
  order: { amount: number; deliveredDate: string; alreadyRefundedAmount: number };
  request: { amount: number; faultKnown: boolean; notCustomerFault: boolean };
  customer: { vip: boolean; completedRefundHistoryStartDate: string };
  relatedCase: { pendingAmount: number };
  // Collections, keyed by catalog.ts's own `source` name — evaluate.ts looks these up
  // by that same string, never by a hardcoded field path.
  collections: {
    "customer.completedRefunds": CompletedRefundItem[];
  };
}

export interface BuildPolicyContextInput {
  orderId: string;
  requestAmount: number;
  faultKnown?: boolean;
  notCustomerFault?: boolean;
  // REQUIRED, no default: the refund amounts of every OTHER open case on this order. An omitted input must
  // never silently mean "no other cases" — live-policy.ts treats `undefined` as unavailable and escalates.
  pendingFromOtherCase: number;
}

export async function buildPolicyContext(input: BuildPolicyContextInput): Promise<PolicyContext> {
  const order = getOrder(input.orderId);
  if (!order) throw new Error(`No such order: ${input.orderId}`);
  const customer = getCustomer(order.customerId);
  if (!customer) throw new Error(`No such customer for order: ${input.orderId}`);

  // customer.completedRefunds is fixture-only. This app only ever knows a refund was "approved"
  // (never that an OMS payment actually completed; see payment.ts's header), so merging live
  // approvals in would relabel "approvedAt" as "completedAt" and let a policy's "$300 in COMPLETED
  // refunds" rule count refunds that may never have been paid. Until there is a real completion
  // signal (an OMS webhook, a "payment settled" event), the seeded historical records are the only
  // ones this app can honestly call "completed", matching the catalog's description of the
  // collection ("Deliberately excludes anything merely approved-and-pending").
  const fixtureRecords = completedRefundFixturesForCustomer(customer.id).map((record) => ({
    amount: record.amount,
    completedAt: record.completedAt,
  }));
  const alreadyRefundedOnThisOrder = await totalRefundedForOrder(order.id);

  return {
    order: { amount: order.amount, deliveredDate: order.deliveredDate, alreadyRefundedAmount: alreadyRefundedOnThisOrder },
    request: {
      amount: input.requestAmount,
      faultKnown: input.faultKnown ?? false,
      notCustomerFault: input.notCustomerFault ?? false,
    },
    customer: {
      vip: customer.vip,
      completedRefundHistoryStartDate: COMPLETED_REFUND_HISTORY_START_DATE,
    },
    relatedCase: { pendingAmount: input.pendingFromOtherCase },
    collections: {
      "customer.completedRefunds": fixtureRecords,
    },
  };
}

// A minimal helper so evaluate.ts can resolve "order.amount"-style dotted field paths
// generically against the flat context object above, without a hand-written switch
// statement per field.
export function readContextField(context: PolicyContext, field: string): unknown {
  const [group, key] = field.split(".");
  const bucket = (context as unknown as Record<string, Record<string, unknown>>)[group];
  return bucket ? bucket[key] : undefined;
}

export function readContextCollection(context: PolicyContext, source: string): Array<Record<string, unknown>> {
  const collection = (context.collections as unknown as Record<string, Array<Record<string, unknown>>>)[source];
  return collection ?? [];
}

