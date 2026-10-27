import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { getOrder, orderItemsSummary, resolveOrderItems } from "../../fixtures/demo-data";
import { getSessionCustomerId, markOrderTouched } from "../request-context";
import { alreadyRefundedItemIds } from "../refund-ledger";

// A cosmetic, brand-consistent tracking domain the agent quotes in chat — reads as a
// real tracking link, and the storefront's ChatWidget rewrites it to wherever it's
// actually running (localhost, a LAN IP) at click time, since that's the one place that
// reliably knows its own real address. The agent server doesn't need to.
const TRACKING_LINK_HOST = "https://track.waybound.com";

// Stubbed shipping provider — no live carrier integration in the prototype.
// Deterministic fixture, no external call — but the
// shipment details it returns are real, not invented: delivery date, product, and
// signed-for name all come from the same order/customer system of record everything
// else in this app uses, same discipline as commerce.ts.

// The plain shipment-record helpers live in shipment-info.ts (see its header for why) and
// are re-exported here so existing callers keep importing from this file.
import { getShipmentInfo } from "./shipment-info";
export { getShipmentInfo, orderIdFromTrackingNumber } from "./shipment-info";

export const shippingGetTrackingInfo = createTool({
  id: "shipping_get_tracking_info",
  description: "Get real tracking and delivery details for one of the current customer's own orders, including a link to the tracking page.",
  inputSchema: z.object({ orderId: z.string() }),
  outputSchema: z.object({
    trackingNumber: z.string(),
    items: z.string(),
    status: z.enum(["delivered", "in_transit"]),
    orderDate: z.string(),
    deliveredDate: z.string(),
    signedForBy: z.string().optional(),
    trackingUrl: z.string(),
  }),
  execute: async ({ orderId }, context) => {
    const sessionCustomerId = getSessionCustomerId(context);
    const order = getOrder(orderId);
    if (!order) throw new Error(`No such order: ${orderId}`);
    if (order.customerId !== sessionCustomerId) throw new Error(`Order ${orderId} does not belong to the current customer.`);
    markOrderTouched(context, order.id);

    const info = getShipmentInfo(orderId)!;
    return { ...info, trackingUrl: `${TRACKING_LINK_HOST}/${info.trackingNumber}` };
  },
});

// Same cosmetic-domain trick as TRACKING_LINK_HOST above — reads as a real branded link
// in chat/the Desk, rewritten client-side to wherever the storefront is actually running
// at click time (ChatWidget.tsx's resolveHref, escalation-desk's own mirror of it).
// Previously pointed at a genuinely nonexistent "https://labels.example.com/...pdf" with
// no page behind it anywhere — clicking it just 404'd. Fixed to match tracking's own
// working pattern: a real stub page (apps/storefront's /return-label/[trackingNumber])
// backed by real order data (GET /returns/:trackingNumber below), not a dead link.
const RETURN_LABEL_LINK_HOST = "https://returns.waybound.com";

// returnTrackingNumber <-> orderId is the same deterministic, reversible transform as
// trackingNumberForOrder/orderIdFromTrackingNumber above, just with its own "RTN-" prefix
// so a return tracking number is never mistaken for a shipment tracking number. When the
// return is scoped to specific items (a damage claim's picked item(s), or a partial plain
// return) rather than the whole order, the real objectIDs are encoded after a "_"
// separator (never used inside an objectID or the order-digits segment), joined by "+" —
// e.g. "RTN-004203_socks-004+belt-001". Undecorated "RTN-004203" still means "the whole
// order," exactly as before this existed, so an already-generated whole-order label keeps
// working unchanged.
export function orderIdFromReturnTrackingNumber(trackingNumber: string): string {
  const withoutPrefix = trackingNumber.replace(/^RTN-/i, "");
  const digits = withoutPrefix.split("_")[0].replace(/^0*/, "");
  return `order_${digits}`;
}

// undefined means "the whole order" — same convention as resolveOrderItems/itemIds
// everywhere else in this app (see demo-data.ts's own comment on that).
export function itemIdsFromReturnTrackingNumber(trackingNumber: string): string[] | undefined {
  const parts = trackingNumber.split("_");
  if (parts.length < 2 || !parts[1]) return undefined;
  return parts[1].split("+");
}

export interface ReturnLabel {
  labelUrl: string;
  returnTrackingNumber: string;
}

// Deterministic, not a real carrier call (same fixture-adapter discipline as the rest of
// this file) — a plain function, not just a tool's execute, so server.ts's
// resumeAndNotify can generate a label for an ESCALATED return the moment a rep approves
// it, not only for an autonomous one the agent handles inline. See wismo-agent.ts's
// instructions and CaseResolvedEvent's returnLabelUrl for why: a customer shouldn't have
// to ask for their label once a return is approved, whichever path approved it. itemIds
// omitted (or the whole order was selected, i.e. undefined) means the label covers the
// entire order, same as before item-scoping existed here — pass the real itemIds the
// customer/case actually picked whenever you have them, so the label (and its stub page)
// only shows what's actually being shipped back, not the full order regardless of what's
// returning.
export function generateReturnLabel(orderId: string, itemIds?: string[]): ReturnLabel {
  const orderDigits = orderId.replace(/\D/g, "").padStart(6, "0");
  const itemsSuffix = itemIds && itemIds.length > 0 ? `_${itemIds.join("+")}` : "";
  const returnTrackingNumber = `RTN-${orderDigits}${itemsSuffix}`;
  return {
    labelUrl: `${RETURN_LABEL_LINK_HOST}/${returnTrackingNumber}`,
    returnTrackingNumber,
  };
}

export interface ReturnLabelInfo {
  orderId: string;
  returnTrackingNumber: string;
  items: string;
  orderDate: string;
}

// Backs the storefront's /return-label/[trackingNumber] stub page and its GET
// /returns/:trackingNumber route (server.ts) — same "real order data, no login required,
// the number itself is the capability" shape as getShipmentInfo above. itemIds (decoded
// from the tracking number itself, see itemIdsFromReturnTrackingNumber) scopes `items` to
// just what's actually being returned — reuses resolveOrderItems, the same anti-coercion-
// safe resolver present_return_item_picker/payment.ts already use, so a tampered-with
// tracking number can't claim an objectID that isn't really on this order.
export function getReturnLabelInfo(orderId: string, itemIds?: string[]): ReturnLabelInfo | null {
  const order = getOrder(orderId);
  if (!order) return null;
  const items = resolveOrderItems(order, itemIds);
  if (!items) return null;
  return {
    orderId: order.id,
    returnTrackingNumber: generateReturnLabel(orderId, itemIds).returnTrackingNumber,
    items: orderItemsSummary({ ...order, items }),
    orderDate: order.orderDate,
  };
}

export const shippingGenerateReturnLabel = createTool({
  id: "shipping_generate_return_label",
  description:
    "Generate a return shipping label for an approved return. Call this immediately once a return is approved (autonomous or already-decided) and include the label link in your reply — never ask the customer whether they want one first. Pass the same itemIds the return was actually scoped to (omit for a whole-order return) so the label only covers what's really being shipped back.",
  inputSchema: z.object({ orderId: z.string(), itemIds: z.array(z.string()).optional() }),
  outputSchema: z.object({ labelUrl: z.string(), returnTrackingNumber: z.string() }),
  // Ownership + item-validity + approval checks. This once called generateReturnLabel directly with no
  // enforcement, unlike every other tool in this app (mock labels only, so the immediate stakes were low,
  // but a real inconsistency in this app's own discipline).
  execute: async ({ orderId, itemIds }, context) => {
    const sessionCustomerId = getSessionCustomerId(context);
    const order = getOrder(orderId);
    if (!order) throw new Error(`No such order: ${orderId}`);
    if (order.customerId !== sessionCustomerId) throw new Error(`Order ${orderId} does not belong to the current customer.`);
    const items = resolveOrderItems(order, itemIds);
    if (!items) throw new Error(`One or more itemIds are invalid or duplicated for order ${orderId}.`);
    // Tied to the ledger's derived history rather than inventing new state — this
    // matches the tool's own actual call pattern exactly: it's only ever called
    // immediately after payment_issue_refund/payment_issue_return_refund already
    // succeeded in the same turn, so the refund is always already durable by now. A
    // rep-approved case never reaches this tool at all — resumeAndNotify (server.ts)
    // calls generateReturnLabel directly, unaffected by this check.
    // EVERY item the label covers needs its own approved refund. (It used to need just one: a selection of
    // one approved item plus one never approved got a label for both, and omitting itemIds — the whole
    // order — got one after a single item's return.) A mismatch is
    // refused, never quietly narrowed or widened: the label must match what was actually approved.
    const alreadyCovered = await alreadyRefundedItemIds(order.id);
    const withoutRefund = items.filter((item) => !alreadyCovered.has(item.objectID));
    if (withoutRefund.length > 0) {
      const names = withoutRefund.map((item) => `${item.name} (${item.objectID})`).join(", ");
      throw new Error(
        `No refund on record yet for ${names} on order ${orderId} — only call this after payment_issue_refund/payment_issue_return_refund has already succeeded for EVERY item the label covers. Pass the itemIds the return was actually scoped to, and no others.`
      );
    }
    markOrderTouched(context, order.id);
    return generateReturnLabel(orderId, itemIds);
  },
});
