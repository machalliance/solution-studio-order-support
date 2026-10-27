// The base draft — the refund (damage/fault), plain-return and delivery-dispute policies as
// they were first written in code, migrated faithfully into the JSON structure, INCLUDING
// their real quirks:
//   - the damage/fault policy's return-window check applies ONLY inside the
//     notCustomerFault branch (customer-fault VIP/non-VIP are NOT window-gated);
//   - the plain-return policy's dollar-cap skip applies ONLY when percentCeiling>=100
//     AND amountCeiling<=0 together — a positive dollar cap at 100% still applies.
// This exists so the Policy Helper has real policy content to edit, and it's the seed for
// the "demo" namespace, whose active version decides every live case (live-policy.ts).
// Its rules were parity-checked against the original hardcoded functions (since deleted)
// before those were replaced: same decision and reasonCode on every tested combination of
// window, fault, VIP, ceilings, and amounts (tests/mastra/policy/parity.test.ts keeps that
// check running against a frozen copy of the old engine).
// The autonomy switches are policy settings, each tested by a restriction rule.
//
// Values below are the demo's own starting values (returnRefundPercentCeiling and
// returnRefundCeiling both 100), not a recommendation.

import type { PolicyDocument, Rule } from "./schema";

const BASE_SETTINGS: PolicyDocument["settings"] = {
  returnWindowDays: { value: 30, description: "How many days after delivery a return/damage claim may still be considered." },
  returnRefundPercentCeiling: { value: 100, description: "A plain return's cumulative total, as a percent of the order's own value, above which it needs human review. >=100 together with returnRefundCeiling<=0 means no dollar cap at all." },
  returnRefundCeiling: { value: 100, description: "A plain return's cumulative dollar total above which it needs human review, in the account's own currency." },
  requestDamagedItemReturn: { value: true, description: "When a rep approves a damage/fault claim, whether the \"ask the customer to send the item back\" box starts ticked. Only a request — the refund still goes out right away, and the rep can change it on each case." },
  damagedItemReturnThreshold: { value: 10, description: "Damage claims below this amount start with that box unticked — a cheap item usually isn't worth shipping back." },
  // The autonomy switches — policy settings, each tested by a restriction rule. Every
  // restriction is evaluated before any automatic decision wherever it sits in the list, so
  // the order of the rules can never bypass a switch.
  autonomousRefundsEnabled: { value: true, description: "Master switch for decisions made without a rep. Off: every refund, return and dispute goes to a rep, including automatic denials." },
  autonomousPlainReturnsEnabled: { value: true, description: "Whether a plain return can be approved automatically at all. Off: every plain return goes to a rep." },
  deliveryDisputesAlwaysEscalate: { value: true, description: "Delivery disputes always go to a rep — the carrier record and the customer's account disagree, and nothing can be verified from here. Turn off only alongside rules that decide disputes on their own." },
};

// Both facts are declared BEFORE any rule references them by name — evaluate.ts computes facts in
// this array order, and validate.ts rejects a forward reference, so this order is load-bearing.
const BASE_FACTS: PolicyDocument["facts"] = [
  {
    name: "returnCumulativeAmount",
    type: "number",
    description: "What this order's total refunded-or-pending amount would become if this request were approved: already refunded on this order + any other open case's pending amount + this request.",
    value: {
      op: "add",
      operands: [{ field: "order.alreadyRefundedAmount" }, { field: "relatedCase.pendingAmount" }, { field: "request.amount" }],
    },
  },
  {
    name: "returnPercentOfOrder",
    type: "number",
    description: "returnCumulativeAmount as a percent of the order's own total value.",
    value: {
      op: "multiply",
      operands: [{ op: "divide", operands: [{ fact: "returnCumulativeAmount" }, { field: "order.amount" }] }, 100],
    },
  },
];

// =====================================================================================
// The base policy: one rule list scoped by reason — restrictions first, explicit decisions, a fallback that
// is always a person.
//
// It was translated mechanically and ORDER-PRESERVING from the original three-section policy: for each reason, the applicable rules keep exactly
// their legacy relative order, so decisions and primary reason codes are unchanged (proven against
// the legacy engine in parity.test.ts). What changed: the two automatic FALLBACKS (P6 deny, P12
// approve) are now explicit decision rules; the three copies of the autonomy guard (P5, P10, P14)
// are one rule; the dispute fallback (P15) is an explicit restriction; and the fallback is a person.
// Policy numbers are lookup handles ("show me P7"), not stable identities: they are assigned fresh, in
// document order, when the document is built.
// ===================================================================================

const GENERIC_PERSON = "A specialist will take a look and follow up with you.";

export function buildBaseDraft(version = 1, options: { oneReturnPerOrder?: boolean } = {}): PolicyDocument {
  const { oneReturnPerOrder = true } = options;

  const oneReturnRule: Rule = {
    kind: "restriction",
    id: "one-return-per-order",
    description: "An order may be refunded or returned only once, however many items are on it. Any approved refund on the order (of any kind) or any other open case counts; the current request does not count against itself.",
    when: {
      any: [
        { left: { field: "order.alreadyRefundedAmount" }, op: "gt", right: 0 },
        { left: { field: "relatedCase.pendingAmount" }, op: "gt", right: 0 },
      ],
    },
    outcome: {
      decision: "escalate",
      reasonCode: "one-return-per-order",
      explanation: "This order already has an approved refund or another open case — an order may only be refunded or returned once, so a person needs to decide.",
      customerReason: "This order already has a refund or return in progress, so a specialist needs to review this request.",
    },
  };

  const rules: Rule[] = [
    // --- restrictions (escalate only). Document order picks which match is REPORTED first; it never decides whether a case escalates.
    {
      kind: "restriction",
      id: "disputes-always-escalate",
      description: "Delivery disputes always go to a rep (deliveryDisputesAlwaysEscalate).",
      appliesTo: ["not_delivered"],
      when: { left: { setting: "deliveryDisputesAlwaysEscalate" }, op: "eq", right: true },
      outcome: {
        decision: "always_escalate",
        reasonCode: "delivery-dispute-requires-investigation",
        explanation: "Carrier record and customer account of events disagree — investigate with the carrier before any refund or reship; do not act on the claim alone.",
        customerReason: "A specialist will investigate this with the shipping carrier and follow up with you.",
      },
    },
    ...(oneReturnPerOrder ? [oneReturnRule] : []),
    {
      kind: "restriction",
      id: "fault-unknown",
      description: "Fault attribution wasn't provided at all — escalate rather than assume either party is at fault.",
      appliesTo: ["damaged_or_defective"],
      when: { left: { field: "request.faultKnown" }, op: "eq", right: false },
      outcome: {
        decision: "escalate",
        reasonCode: "fault-unknown",
        explanation: "Fault attribution wasn't provided — escalating rather than assuming either party is at fault.",
        customerReason: "We need a specialist to take a closer look at this one.",
      },
    },
    {
      kind: "restriction",
      id: "damage-outside-return-window",
      description: "Not the customer's fault, but delivered too long ago for the standard return window.",
      appliesTo: ["damaged_or_defective"],
      when: {
        all: [
          { left: { field: "request.faultKnown" }, op: "eq", right: true },
          { left: { field: "request.notCustomerFault" }, op: "eq", right: true },
          { left: { field: "order.deliveredDate" }, op: "olderThanDays", right: { setting: "returnWindowDays" } },
        ],
      },
      outcome: {
        decision: "escalate",
        reasonCode: "damage-outside-return-window",
        explanation: "Delivered past the return window — policy requires escalation regardless of amount or fault.",
        customerReason: "This is outside our standard return window, so a specialist needs to take a look.",
      },
    },
    {
      kind: "restriction",
      id: "fault-requires-photo-review",
      description: "Not the customer's fault, within the window — always needs a human to review photo evidence and confirm fault; there's no automated verification for this claim type.",
      appliesTo: ["damaged_or_defective"],
      when: {
        all: [
          { left: { field: "request.faultKnown" }, op: "eq", right: true },
          { left: { field: "request.notCustomerFault" }, op: "eq", right: true },
        ],
      },
      outcome: {
        decision: "escalate",
        reasonCode: "fault-requires-photo-review",
        explanation: "Damage attributed to the product, not the customer — a specialist needs to review the photo evidence to confirm fault before a refund can be approved.",
        customerReason: "This needs a specialist to review the photo evidence before we can proceed.",
      },
    },
    {
      kind: "restriction",
      id: "customer-fault-vip",
      description: "The customer's own fault, but the account is VIP — escalate for a full refund anyway, as a courtesy. Not window-gated, unlike the not-their-fault branch above.",
      appliesTo: ["damaged_or_defective"],
      when: {
        all: [
          { left: { field: "request.faultKnown" }, op: "eq", right: true },
          { left: { field: "request.notCustomerFault" }, op: "eq", right: false },
          { left: { field: "customer.vip" }, op: "eq", right: true },
        ],
      },
      outcome: {
        decision: "escalate",
        reasonCode: "customer-fault-vip",
        explanation: "Damage attributed to the customer, but the account is VIP — policy requires escalating for a full refund regardless of amount, as a customer courtesy.",
        customerReason: GENERIC_PERSON,
        recommendedAction: "Approve full refund of {amount} (VIP courtesy)",
      },
    },
    {
      kind: "restriction",
      id: "return-outside-window",
      description: "Delivered too long ago for the standard return window.",
      appliesTo: ["not_wanted"],
      when: { left: { field: "order.deliveredDate" }, op: "olderThanDays", right: { setting: "returnWindowDays" } },
      outcome: {
        decision: "escalate",
        reasonCode: "return-outside-window",
        explanation: "Past the standard return window — needs a human decision.",
        customerReason: "This is outside our standard return window, so a specialist needs to take a look.",
      },
    },
    {
      kind: "restriction",
      id: "return-refunds-disabled",
      description: "Autonomous return refunds are turned off — either the percent ceiling is at/below zero, or the dollar ceiling is at/below zero without the deliberate 100%/0 'no dollar cap' combination.",
      appliesTo: ["not_wanted"],
      when: {
        any: [
          { left: { setting: "returnRefundPercentCeiling" }, op: "lte", right: 0 },
          {
            all: [
              { left: { setting: "returnRefundCeiling" }, op: "lte", right: 0 },
              { left: { setting: "returnRefundPercentCeiling" }, op: "lt", right: 100 },
            ],
          },
        ],
      },
      outcome: {
        decision: "escalate",
        reasonCode: "return-refunds-disabled",
        explanation: "Autonomous return refunds are turned off — every plain return needs a human decision.",
        customerReason: "Returns currently need a quick review from our team before they're processed.",
      },
    },
    {
      kind: "restriction",
      id: "exceeds-return-refund-ceiling",
      description: "Cumulative total (already refunded on this order, plus any other pending case, plus this request) exceeds the percent-of-order ceiling, or exceeds the flat dollar ceiling (unless the deliberate 100%/0 'no dollar cap' combination is active).",
      appliesTo: ["not_wanted"],
      when: {
        any: [
          { left: { fact: "returnPercentOfOrder" }, op: "gt", right: { setting: "returnRefundPercentCeiling" } },
          {
            all: [
              { not: { all: [{ left: { setting: "returnRefundPercentCeiling" }, op: "gte", right: 100 }, { left: { setting: "returnRefundCeiling" }, op: "lte", right: 0 }] } },
              { left: { fact: "returnCumulativeAmount" }, op: "gt", right: { setting: "returnRefundCeiling" } },
            ],
          },
        ],
      },
      outcome: {
        decision: "escalate",
        reasonCode: "exceeds-return-refund-ceiling",
        explanation: "Requested refund would bring this order's cumulative total over the configured ceiling — needs a human decision.",
        customerReason: "This return is larger than what we can approve automatically, so a specialist needs to take a look.",
      },
    },
    {
      kind: "restriction",
      id: "autonomous-refunds-disabled",
      description: "Decisions without a rep are switched off (autonomousRefundsEnabled) — every refund, return and dispute goes to a person.",
      when: { left: { setting: "autonomousRefundsEnabled" }, op: "eq", right: false },
      outcome: {
        decision: "escalate",
        reasonCode: "autonomous-refunds-disabled",
        explanation: "Decisions without a rep are switched off in policy — this needs a human decision.",
        customerReason: GENERIC_PERSON,
      },
    },
    {
      kind: "restriction",
      id: "autonomous-plain-returns-disabled",
      description: "Automatic approval of plain returns is switched off (autonomousPlainReturnsEnabled).",
      appliesTo: ["not_wanted"],
      when: { left: { setting: "autonomousPlainReturnsEnabled" }, op: "eq", right: false },
      outcome: {
        decision: "escalate",
        reasonCode: "autonomous-plain-returns-disabled",
        explanation: "Automatic approval of plain returns is switched off in policy — every plain return needs a human decision.",
        customerReason: "Returns currently need a quick review from our team before they're processed.",
      },
    },
    {
      kind: "restriction",
      id: "delivery-dispute-requires-investigation",
      description: "A delivery dispute is never decided automatically: the carrier record and the customer's account disagree and nothing can be verified from here.",
      appliesTo: ["not_delivered"],
      outcome: {
        decision: "always_escalate",
        reasonCode: "delivery-dispute-requires-investigation",
        explanation: "Carrier record and customer account of events disagree — investigate with the carrier before any refund or reship; do not act on the claim alone.",
        customerReason: "A specialist will investigate this with the shipping carrier and follow up with you.",
      },
    },

    // --- decisions: the ONLY way anything is decided automatically. Reached only when no restriction matched.
    {
      kind: "decision",
      id: "customer-fault-non-vip",
      description: "The damage is the customer's own fault and the account is not VIP — a polite automatic refusal. (Unknown fault and VIP customers are restrictions above, so they never reach this.)",
      appliesTo: ["damaged_or_defective"],
      when: {
        all: [
          { left: { field: "request.faultKnown" }, op: "eq", right: true },
          { left: { field: "request.notCustomerFault" }, op: "eq", right: false },
        ],
      },
      outcome: {
        decision: "autonomous_deny",
        reasonCode: "customer-fault-non-vip",
        explanation: "Damage attributed to the customer, and the account is not VIP — policy specifies an autonomous, polite rejection; no human review needed.",
        customerReason: "We're sorry, but we're not able to offer a refund for this — the damage isn't related to a manufacturing defect or shipping issue, so it falls outside what we can cover.",
      },
    },
    {
      kind: "decision",
      id: "within-return-refund-ceiling",
      description: "A plain return that no restriction above blocked — delivered within the window, inside both ceilings — is approved automatically.",
      appliesTo: ["not_wanted"],
      // The approval states for ITSELF what must be true of the delivery date, rather than relying on the
      // restrictions to catch every bad one: "outside the window" there is `olderThanDays`, which a date in the
      // FUTURE is never (a return on an order "delivered" tomorrow was once approved). withinDays is
      // true only for a past date inside the window, so a future, missing or invalid date cannot be approved —
      // it falls through to the fallback, a person.
      when: { left: { field: "order.deliveredDate" }, op: "withinDays", right: { setting: "returnWindowDays" } },
      outcome: {
        decision: "autonomous_approve",
        reasonCode: "within-return-refund-ceiling",
        explanation: "Within the return window and both configured ceilings.",
      },
    },
  ];

  // Fresh, dense, in document order.
  rules.forEach((rule, index) => {
    rule.number = `P${index + 1}`;
  });

  return {
    schemaVersion: 2,
    metadata: {
      name: "wismo-default",
      version,
      createdAt: new Date().toISOString(),
      description: "One rule list scoped by reason: restrictions first, explicit decisions, otherwise a person.",
    },
    settings: structuredClone(BASE_SETTINGS),
    facts: structuredClone(BASE_FACTS),
    rules,
    fallback: {
      number: `P${rules.length + 1}`,
      decision: "escalate",
      reasonCode: "needs-a-person",
      explanation: "No rule authorizes an automatic outcome for this request — a person needs to decide.",
      customerReason: GENERIC_PERSON,
    },
  };
}
