import { getOrder } from "../fixtures/demo-data";

// request-context.ts's markOrderTouched only sees THIS turn's tool calls, so it is blind to a casual
// follow-up where the model re-calls nothing because it "knows" the answer from earlier (the model once
// told a customer their detail was "added to the case" when nothing had re-synced, because no tool ran
// that turn). The AI SDK UIMessage carries the full structured record, not just text: every earlier tool
// call in the conversation is still in the resent history as a part shaped
// `{ type: "tool-<name>", input, output?, ... }` (or `{ type: "dynamic-tool", toolName, input, output? }`;
// see the 'ai' package's ToolUIPart / DynamicToolUIPart). Scanning the WHOLE conversation for those
// closes the gap without new persistence: an order looked up three turns ago is still "in play".
//
// The streamed toolName is the tool's REGISTRATION KEY in wismo-agent.ts's tools object (camelCase,
// "commerceGetOrder"), not the snake_case id passed to createTool({ id }) that the agent's instructions
// and the server routes otherwise use. A first version used the snake_case ids and silently matched
// nothing.
const ORDER_ARG_TOOL_NAMES = new Set([
  "commerceGetOrder",
  "commerceGetProductsForOrder",
  "shippingGetTrackingInfo",
  "checkEscalationStatus",
  // Both can create/touch a case directly now (refund-policy-gate.ts) — previously only
  // escalateForPolicyReview did, and escalateForReturnRefund was never added here at all
  // (a pre-existing gap, fixed as a side effect of this list now needing an update
  // anyway).
  "paymentIssueRefund",
  "paymentIssueReturnRefund",
  "escalateForDeliveryDispute",
]);

interface ToolLikePart {
  type?: string;
  toolName?: string;
  input?: { orderId?: unknown; caseId?: unknown };
  output?: { orderId?: unknown };
}

function toolNameOf(part: ToolLikePart): string | undefined {
  if (part.type === "dynamic-tool") return part.toolName;
  if (typeof part.type === "string" && part.type.startsWith("tool-")) return part.type.slice("tool-".length);
  return undefined;
}

// The model calls these with whatever short form it has ("3401", not "order_3401" — see
// commerce_get_order's own real captured input) — getOrder() normalizes every accepted
// form to the canonical id, the same lookup every tool already routes every orderId
// through, so this stays correct even if that convention changes.
function normalize(rawOrderId: unknown): string | undefined {
  return typeof rawOrderId === "string" ? getOrder(rawOrderId)?.id : undefined;
}

export function touchedOrderIdsFromHistory(messages: unknown[]): string[] {
  const orderIds = new Set<string>();
  for (const message of messages as Array<{ parts?: unknown }>) {
    const parts = Array.isArray(message?.parts) ? (message.parts as ToolLikePart[]) : [];
    for (const part of parts) {
      const name = toolNameOf(part);
      if (!name) continue;
      if (ORDER_ARG_TOOL_NAMES.has(name)) {
        const orderId = normalize(part.input?.orderId);
        if (orderId) orderIds.add(orderId);
      }
      // lookupCaseById takes a caseId, not an orderId — the order only shows up in its
      // output once resolved.
      if (name === "lookupCaseById") {
        const orderId = normalize(part.output?.orderId);
        if (orderId) orderIds.add(orderId);
      }
    }
  }
  return [...orderIds];
}
