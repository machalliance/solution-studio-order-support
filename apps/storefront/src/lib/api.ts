// Derived from whatever hostname the browser actually used to reach this page, not a fixed env var.
// A hardcoded "localhost" only resolves when the browser and the agent are the same machine; from a
// phone on the LAN it means the phone itself, and every fetch fails silently. Matching the page's own
// hostname works for localhost, a LAN IP or anything else with no reconfiguration.
// NEXT_PUBLIC_AGENT_URL remains a valid override for a genuinely different host.
const AGENT_PORT_DEFAULT = process.env.NEXT_PUBLIC_AGENT_PORT || "3006";

function resolveAgentUrl(): string {
  if (process.env.NEXT_PUBLIC_AGENT_URL) return process.env.NEXT_PUBLIC_AGENT_URL;
  if (typeof window !== "undefined") {
    return `${window.location.protocol}//${window.location.hostname}:${AGENT_PORT_DEFAULT}`;
  }
  return `http://localhost:${AGENT_PORT_DEFAULT}`;
}

export const AGENT_URL = resolveAgentUrl();

export interface Customer {
  id: string;
  name: string;
  email: string;
  vip: boolean;
}

// Mirrors the catalog export's own item record shape — see
// apps/agent/src/fixtures/demo-data.ts for why.
export interface Product {
  objectID: string;
  name: string;
  brand: string;
  price: number;
  currency: string;
  category: string;
  colourFamily: string;
  colourHex: string;
  description: string;
  tags: string[];
  images: string[];
}

export interface Order {
  id: string;
  customerId: string;
  // Most orders here are single-item, but not all — never assume length 1.
  items: Product[];
  amount: number;
  orderDate: string;
  deliveredDate: string;
}

export async function getProducts(): Promise<Product[]> {
  const res = await fetch(`${AGENT_URL}/products`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to load products (${res.status})`);
  const data = await res.json();
  return data.products;
}

export async function getMe(): Promise<{ customer: Customer; orders: Order[] }> {
  const res = await fetch(`${AGENT_URL}/me`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to load account (${res.status})`);
  return res.json();
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

export async function getTracking(trackingNumber: string): Promise<ShipmentInfo> {
  const res = await fetch(`${AGENT_URL}/tracking/${encodeURIComponent(trackingNumber)}`, { cache: "no-store" });
  if (!res.ok) throw new Error(res.status === 404 ? "No shipment found for that tracking number." : `Failed to load tracking (${res.status})`);
  return res.json();
}

export interface ReturnLabelInfo {
  orderId: string;
  returnTrackingNumber: string;
  items: string;
  orderDate: string;
}

export async function getReturnLabel(trackingNumber: string): Promise<ReturnLabelInfo> {
  const res = await fetch(`${AGENT_URL}/returns/${encodeURIComponent(trackingNumber)}`, { cache: "no-store" });
  if (!res.ok) throw new Error(res.status === 404 ? "No return label found for that tracking number." : `Failed to load return label (${res.status})`);
  return res.json();
}

export function daysAgo(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
}

