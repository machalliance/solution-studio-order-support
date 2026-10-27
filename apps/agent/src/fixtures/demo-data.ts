// Seeded demo data.
// This is the system of record the tools read from. Nothing here is ever inferred from
// what a customer types in chat (the anti-coercion rule: facts come from here, never the conversation).
//
// Products are loaded from real catalog output (data/catalog/algolia-*.json, one file per
// category), not hand-invented. Images live in apps/storefront/public/products/<objectID>.jpg —
// the catalog export's own image URLs don't apply here, so image paths are rewritten to
// /products/<file> (Next.js serves apps/storefront/public/ at that root).

import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { config } from "../config";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CATALOG_DIR = join(__dirname, "../../data/catalog");

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString();
}

export interface Customer {
  id: string;
  name: string;
  email: string;
  vip: boolean;
}

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
  // One or more line items — most orders here are single-item, but see order_4203 for a
  // real multi-item one. Never assume length 1; use orderItemsSummary() below instead of
  // reading items[0] directly wherever a human-readable name is needed.
  items: Product[];
  amount: number; // the order's charged total — normally equals the sum of items' prices
  orderDate: string;
  deliveredDate: string;
}

// A human-readable line naming what's in an order — the one item's own name for the
// common case, every item's name joined for a multi-item order. Use this anywhere a
// product name is needed, rather than reading items[0] directly, so a multi-item order
// never silently shows as if it only had one thing in it.
export function orderItemsSummary(order: Order): string {
  return order.items.map((item) => item.name).join(", ");
}

// Resolves a customer's return-item selection (objectIDs, from present_return_item_picker's
// checkbox UI) against the order's REAL line items — same anti-coercion principle as every
// other gating fact in this app (never taken from the conversation): which
// items to refund for is the customer's own choice, but their price is never trusted from
// anywhere but this lookup. Returns null (never partial results) if any given objectID
// doesn't actually belong to this order, or if the list is empty — a caller shouldn't guess
// at a partial match. Omit itemIds entirely (undefined) for "the whole order," the only
// return shape that existed before multi-item orders did.
export function resolveOrderItems(order: Order, itemIds: string[] | undefined): Product[] | null {
  if (itemIds === undefined) return order.items;
  if (itemIds.length === 0) return null;
  // Reject a repeated objectID the same way an unrecognized one is already rejected: the caller
  // (refund-policy-gate.ts) sums every resolved entry to compute the refund amount, so
  // ["item1","item1"] silently doubled it. Fixed at this single shared choke point rather than
  // downstream in payment.ts/refund-policy-gate.ts: every refund/return path already routes through
  // here before an amount is ever computed, so nothing downstream needs its own copy of this check.
  if (new Set(itemIds).size !== itemIds.length) return null;
  const matched = itemIds.map((id) => order.items.find((item) => item.objectID === id));
  if (matched.some((item) => item === undefined)) return null;
  return matched as Product[];
}

interface CatalogFixtureItem {
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

function loadCatalog(): Record<string, Product> {
  const catalog: Record<string, Product> = {};
  let files: string[] = [];
  try {
    files = readdirSync(CATALOG_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    return catalog; // no catalog exported yet — an empty storefront is a valid state
  }
  for (const file of files) {
    const raw = JSON.parse(readFileSync(join(CATALOG_DIR, file), "utf-8")) as { hits: CatalogFixtureItem[] };
    for (const item of raw.hits ?? []) {
      catalog[item.objectID] = {
        objectID: item.objectID,
        name: item.name,
        brand: item.brand,
        price: item.price,
        currency: item.currency || "USD",
        category: item.category,
        colourFamily: item.colourFamily,
        colourHex: item.colourHex,
        description: item.description,
        tags: item.tags ?? [],
        images: (item.images ?? []).filter(Boolean).map((src) => `/products/${basename(src)}`),
      };
    }
  }
  return catalog;
}

export const products: Record<string, Product> = loadCatalog();

function mustGetProduct(objectID: string): Product {
  const product = products[objectID];
  if (!product) throw new Error(`demo-data: no catalog product "${objectID}" (has catalog-generator's export landed in data/catalog/?)`);
  return product;
}

// cust_demo_01 is the single "logged in" identity the storefront prepopulates with. Its
// name and email come ONLY from .env (WISMO_DEMO_CUSTOMER_NAME / _EMAIL — config.ts; the
// agent refuses to start
// without them), never from a value in the code. The others are fictional, pre-existing
// customers whose cases are already seeded into the Escalation Desk queue.
export const customers: Record<string, Customer> = {
  cust_demo_01: {
    id: "cust_demo_01",
    name: config.demoCustomerName,
    email: config.demoCustomerEmail,
    vip: false,
  },
  cust_1042: { id: "cust_1042", name: "Maya Chen", email: "maya.chen@example.com", vip: false },
  cust_2210: { id: "cust_2210", name: "Owen Alvarez", email: "owen.alvarez@example.com", vip: false },
  cust_3387: { id: "cust_3387", name: "Priya Nair", email: "priya.nair@example.com", vip: true },
  cust_5521: { id: "cust_5521", name: "Sam Whitfield", email: "sam.whitfield@example.com", vip: false },
};

// Every order ID's own last digit is its item count — order_3401 has one item,
// order_4203 has three — a deliberate mnemonic so a case/order number alone tells you
// which shape of order you're looking at, without a lookup. Keep this true of any order
// added later.
//
// order_3401 / order_1181 / order_4472 / order_4203 / order_2001 belong to cust_demo_01,
// the live-demo identity. None of them are escalated here — that only happens through a
// live chat conversation, or via mastra/demo-seed.ts's reset routine (see server.ts's
// POST /demo/reset / the storefront's Settings-page button), which deliberately leaves
// all five alone so there's always at least one single-item and one multi-item order
// left to test something fresh yourself.
const orders: Record<string, Order> = {
  order_7731: { id: "order_7731", customerId: "cust_1042", items: [mustGetProduct("jacket-001")], amount: 145.0, orderDate: daysAgo(40), deliveredDate: daysAgo(34) },
  order_5561: { id: "order_5561", customerId: "cust_2210", items: [mustGetProduct("accessories-001")], amount: 245.0, orderDate: daysAgo(10), deliveredDate: daysAgo(6) },
  order_9011: { id: "order_9011", customerId: "cust_3387", items: [mustGetProduct("scarf-001")], amount: 48.0, orderDate: daysAgo(16), deliveredDate: daysAgo(12) },
  order_6651: { id: "order_6651", customerId: "cust_5521", items: [mustGetProduct("shoes-001")], amount: 75.0, orderDate: daysAgo(5), deliveredDate: daysAgo(2) },
  order_3401: { id: "order_3401", customerId: "cust_demo_01", items: [mustGetProduct("shoes-002")], amount: 70.0, orderDate: daysAgo(5), deliveredDate: daysAgo(2) },
  order_1181: { id: "order_1181", customerId: "cust_demo_01", items: [mustGetProduct("jacket-002")], amount: 165.0, orderDate: daysAgo(20), deliveredDate: daysAgo(16) },
  // Two items, deliberately straddling the $100/60% return-refund ceiling (see
  // the return refund policy) so there's always a ready-made "one under, one over"
  // pair to test a partial return against without reconfiguring anything: the sweater
  // alone ($85, 37% of this order) clears both ceilings on its own; the rain shell
  // alone ($145, 63%) fails both.
  order_4472: {
    id: "order_4472",
    customerId: "cust_demo_01",
    items: [mustGetProduct("top-001"), mustGetProduct("jacket-001")],
    amount: 230.0,
    orderDate: daysAgo(35),
    deliveredDate: daysAgo(30),
  },
  order_4203: {
    id: "order_4203",
    customerId: "cust_demo_01",
    items: [mustGetProduct("pants-002"), mustGetProduct("socks-004"), mustGetProduct("belt-001")],
    amount: 189.99,
    orderDate: daysAgo(12),
    deliveredDate: daysAgo(8),
  },
  // Single-item, well under every return-refund ceiling on its own ($19.99 vs. the
  // default $100/60% thresholds) — added so a cumulative-ceiling test (an order that
  // already has ANOTHER open case, approved or still pending) has a genuinely small,
  // otherwise-autonomous-eligible item to try it with, without reusing an item that's
  // already tied up in an existing open case on order_4203.
  order_2001: { id: "order_2001", customerId: "cust_demo_01", items: [mustGetProduct("socks-004")], amount: 19.99, orderDate: daysAgo(6), deliveredDate: daysAgo(3) },
};

export function getCustomer(customerId: string): Customer | undefined {
  return customers[customerId];
}

// Accepts the canonical "order_1188" form, a bare number "1188", or the customer-facing
// "#1188" the agent and the storefront's chat now use — see wismo-agent.ts's
// instructions and ChatWidget.tsx's order-number chips. Normalizing here, at the one
// place every order lookup in the app routes through, means every caller (tools, the
// policy-review workflow, the tracking-number resolver) benefits without each having to
// remember to do it themselves.
function normalizeOrderId(input: string): string {
  const trimmed = input.trim();
  if (trimmed.startsWith("order_")) return trimmed;
  return `order_${trimmed.replace(/^#/, "")}`;
}

export function getOrder(orderId: string): Order | undefined {
  return orders[normalizeOrderId(orderId)];
}

export function getOrdersForCustomer(customerId: string): Order[] {
  // Most recent first — fixture declaration order isn't date order, and every caller
  // (the storefront's Account page via GET /me, and commerce_list_orders_for_customer
  // in chat) wants the newest order on top, not whatever order it happens to be
  // declared in below.
  return Object.values(orders)
    .filter((o) => o.customerId === customerId)
    .sort((a, b) => new Date(b.orderDate).getTime() - new Date(a.orderDate).getTime());
}
