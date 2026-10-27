// The plain edits an operator (or the Policy Helper) might make to the shipped starting policy, shared by the tests
// that run the real workflow against them. Built from buildBaseDraft() — code, not data/ — so a test never depends on
// whatever someone has since saved on the Policies page.

import assert from "node:assert/strict";
import { buildBaseDraft } from "../../../src/mastra/policy/base-draft";

const decide = (id: string, appliesTo: string[], when: unknown, outcome: Record<string, unknown>) =>
  ({ kind: "decision", id, description: `test rule ${id}`, appliesTo, when, outcome }) as any;
const amountIs = (op: "lte" | "gt", n: number) => ({ left: { field: "request.amount" }, op, right: n });

// - disputes are no longer always sent to a rep: a disputed order up to $50 is refunded, over $150 declined, the rest go to a person;
// - a damage claim that is not the customer's fault is approved automatically up to $250.
export function editedPolicy() {
  const doc = structuredClone(buildBaseDraft());
  doc.settings.deliveryDisputesAlwaysEscalate.value = false;
  const removed = ["disputes-always-escalate", "delivery-dispute-requires-investigation", "fault-requires-photo-review"];
  for (const id of removed) assert.ok(doc.rules.some((r) => r.id === id), `the starting policy no longer has "${id}"`);
  doc.rules = doc.rules.filter((r) => !removed.includes(r.id));
  doc.rules.push(
    decide("dispute-small-auto-refund", ["not_delivered"], amountIs("lte", 50), {
      decision: "autonomous_approve", reasonCode: "dispute-small-auto-refund", explanation: "A small disputed order is refunded without a rep.",
    }),
    decide("dispute-large-auto-decline", ["not_delivered"], amountIs("gt", 150), {
      decision: "autonomous_deny", reasonCode: "dispute-large-auto-decline", explanation: "A large disputed order is declined without a rep.",
      customerReason: "We're not able to refund this one automatically.",
    }),
    decide(
      "damage-auto-approve",
      ["damaged_or_defective"],
      { all: [{ left: { field: "request.faultKnown" }, op: "eq", right: true }, { left: { field: "request.notCustomerFault" }, op: "eq", right: true }, amountIs("lte", 250)] },
      { decision: "autonomous_approve", reasonCode: "damage-auto-approve", explanation: "A small damage claim, not the customer's fault, is approved without a rep." }
    )
  );
  return doc;
}
