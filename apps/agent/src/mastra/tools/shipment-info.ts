import { getCustomer, getOrder, orderItemsSummary } from "../../fixtures/demo-data";

// Plain shipment-record helpers — facts from the order/customer fixtures, no agent, tool, or
// storage imports. Split out of shipping.ts (which re-exports them, so its callers are
// unchanged) because shipping.ts imports refund-ledger → the Mastra instance → the agent,
// which imports shipping.ts's tools: anything the workflow or live-policy.ts needs from
// here would otherwise close that import cycle and crash module initialization whenever
// live-policy.ts happened to load first.

// trackingNumber <-> orderId is a deterministic, reversible transform — not a real
// carrier's opaque number, but enough for GET /tracking/:trackingNumber (server.ts,
// backing the storefront's own tracking landing page) to resolve back to a real order
// without a separate lookup table. Demo order IDs are "order_<digits>", so stripping the
// prefix and zero-padding round-trips cleanly.
function trackingNumberForOrder(orderId: string): string {
  return `TRK-${orderId.replace(/\D/g, "").padStart(6, "0")}`;
}
export function orderIdFromTrackingNumber(trackingNumber: string): string {
  const digits = trackingNumber.replace(/^TRK-0*/i, "");
  return `order_${digits}`;
}

export interface ShipmentInfo {
  orderId: string;
  trackingNumber: string;
  items: string;
  orderDate: string;
  deliveredDate: string;
  status: "delivered" | "in_transit";
  signedForBy?: string;
}

// Shared by the agent tool below and server.ts's public /tracking/:trackingNumber route
// — deliberately takes no session/ownership input itself; that check belongs in each
// caller (the tool enforces it, the public tracking-page route intentionally doesn't —
// see its comment in server.ts).
export function getShipmentInfo(orderId: string): ShipmentInfo | null {
  const order = getOrder(orderId);
  if (!order) return null;
  const customer = getCustomer(order.customerId);
  const delivered = new Date(order.deliveredDate).getTime() <= Date.now();
  return {
    orderId: order.id,
    trackingNumber: trackingNumberForOrder(order.id),
    items: orderItemsSummary(order),
    orderDate: order.orderDate,
    deliveredDate: order.deliveredDate,
    status: delivered ? "delivered" : "in_transit",
    signedForBy: delivered ? customer?.name : undefined,
  };
}

// One factual sentence about what the carrier record says, for a rep reviewing a delivery
// dispute (live-policy.ts appends it to the policy's own explanation). Facts only — what to
// DO about a dispute is the policy's call, not this function's.
export function carrierRecordSummary(orderId: string): string {
  const info = getShipmentInfo(orderId);
  if (!info || info.status !== "delivered") {
    return "Not shown as delivered yet — this may be a delayed shipment rather than a dispute; check current tracking first.";
  }
  const signed = info.signedForBy ? ` and signed for by ${info.signedForBy}` : "";
  return `Shows it delivered${signed} on ${new Date(info.deliveredDate).toLocaleDateString()}, which contradicts the customer's claim.`;
}
