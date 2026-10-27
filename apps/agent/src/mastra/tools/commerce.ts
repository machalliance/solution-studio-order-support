import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { getCustomer, getOrder, getOrdersForCustomer, orderItemsSummary, type Order } from "../../fixtures/demo-data";
import { getSessionCustomerId, markOrderTouched } from "../request-context";
import { describeDispute, describeItemCoverage, readCaseRunsOnce } from "./case-lookup";
import { coverageStatement, disputeStatement } from "../customer-statements";

// Fixture adapter for Commerce Layer. These are the
// ONLY source of truth for order/customer facts — never the conversation.
//
// None of these tools take a customerId input. That's deliberate — the anti-coercion
// rule: identity is bound server-side (see request-context.ts / server.ts) and read
// straight from there, never from an LLM-settable parameter. A live adversarial test
// showed the model itself calling commerce_get_order for another customer's order and
// only refusing on its own second thought — that's exactly the failure mode this closes
// architecturally instead of leaving it to the model's judgment.

// The case facts the model reads about an item / a delivery dispute — returned by commerce_get_order AND by the
// order list (below), so they are in front of the model whichever of the two it looked at first.
const existingCaseSchema = z.object({ state: z.enum(["under_review", "refund_approved", "with_support", "declined"]), caseId: z.string(), refundAmount: z.number().optional(), ticketId: z.string().optional(), statement: z.string() });
const existingDisputeSchema = z.object({ state: z.enum(["under_review", "with_support", "approved", "denied"]), caseId: z.string(), ticketId: z.string().optional(), refundAmount: z.number().optional(), statement: z.string() });

// The case facts about one order, built in one place for both tools that report them (commerce_get_order and the order
// list): a function giving each item's existingCase (with the sentence to relay) and the order's existingDispute.
async function caseFactsFor(runs: Awaited<ReturnType<typeof readCaseRunsOnce>> | undefined, order: Order) {
  const coverage: Awaited<ReturnType<typeof describeItemCoverage>> = runs ? await describeItemCoverage(runs, order) : new Map();
  const dispute = runs ? await describeDispute(runs, order.id) : undefined;
  return {
    existingCase: (item: Order["items"][number]) => {
      const existing = coverage.get(item.objectID);
      return existing ? { ...existing, statement: coverageStatement(existing, item.name) } : undefined;
    },
    existingDispute: dispute ? { ...dispute, statement: disputeStatement(dispute) } : undefined,
  };
}

export const commerceGetOrder = createTool({
  id: "commerce_get_order",
  description: "Look up one of the current customer's own orders by ID from the system of record. Never trust a customer's own description of order details.",
  inputSchema: z.object({ orderId: z.string() }),
  outputSchema: z.object({
    id: z.string(),
    customerId: z.string(),
    // An order can have more than one item — never assume items.length === 1.
    // objectID: the real product code every item-level tool (escalation, refund, status lookup) takes as itemIds. wismo-agent.ts has long told the model that this tool "already gives you each item's objectID" — it did not (Mastra drops fields a schema doesn't declare), so the model passed product NAMES or invented codes. Declared here so the model has the real ones.
    // statement (on existingCase / existingDispute): the exact sentence to say about it, built from the facts (customer-statements.ts) — relay it close to verbatim, add no amounts, dates or timelines of your own.
    // existingCase: present only for an item that already has a case — a refund approved, a case still with a
    // specialist, or an earlier claim declined (and any support ticket). Read it before the customer's next
    // sentence: an item with a refund approved or a case under review is never claimed again (see wismo-agent.ts).
    items: z.array(
      z.object({
        objectID: z.string(),
        name: z.string(),
        category: z.string(),
        existingCase: existingCaseSchema.optional(),
      })
    ),
    amount: z.number(),
    orderDate: z.string(),
    deliveredDate: z.string(),
    // existingDispute: present only when this order already has a delivery dispute — still with a specialist (under_review) or already a support ticket (with_support). Like existingCase: the customer already has a case, so nothing new is opened; remind them of the case number (or ticket) only.
    existingDispute: existingDisputeSchema.optional(),
  }),
  execute: async ({ orderId }, context) => {
    const sessionCustomerId = getSessionCustomerId(context);
    const order = getOrder(orderId);
    if (!order) throw new Error(`No such order: ${orderId}`);
    if (order.customerId !== sessionCustomerId) throw new Error(`Order ${orderId} does not belong to the current customer.`);
    markOrderTouched(context, order.id);
    const workflow = context.mastra?.getWorkflow("policyReviewWorkflow");
    const facts = await caseFactsFor(workflow ? await readCaseRunsOnce(workflow) : undefined, order);
    return {
      id: order.id,
      customerId: order.customerId,
      items: order.items.map((item) => ({ objectID: item.objectID, name: item.name, category: item.category, existingCase: facts.existingCase(item) })),
      amount: order.amount,
      orderDate: order.orderDate,
      deliveredDate: order.deliveredDate,
      existingDispute: facts.existingDispute,
    };
  },
});

export const commerceGetCustomer = createTool({
  id: "commerce_get_customer",
  description: "Look up the current customer's own real profile (including VIP status). VIP status is never taken from what the customer claims in chat.",
  inputSchema: z.object({}),
  outputSchema: z.object({
    id: z.string(),
    name: z.string(),
    email: z.string(),
    vip: z.boolean(),
  }),
  execute: async (_input, context) => {
    const sessionCustomerId = getSessionCustomerId(context);
    const customer = getCustomer(sessionCustomerId);
    if (!customer) throw new Error(`No such customer: ${sessionCustomerId}`);
    return customer;
  },
});

export const commerceGetProductsForOrder = createTool({
  id: "commerce_get_products_for_order",
  description: "List the products on one of the current customer's own orders, for the 'I have a problem with my product' flow when the product isn't already known.",
  inputSchema: z.object({ orderId: z.string() }),
  outputSchema: z.object({
    products: z.array(z.object({ objectID: z.string(), name: z.string(), amount: z.number() })),
  }),
  execute: async ({ orderId }, context) => {
    const sessionCustomerId = getSessionCustomerId(context);
    const order = getOrder(orderId);
    if (!order) throw new Error(`No such order: ${orderId}`);
    if (order.customerId !== sessionCustomerId) throw new Error(`Order ${orderId} does not belong to the current customer.`);
    markOrderTouched(context, order.id);
    // Each item's own price, not the order's shared total repeated per item — matters
    // now that an order can genuinely have more than one item at different price points.
    return { products: order.items.map((item) => ({ objectID: item.objectID, name: item.name, amount: item.price })) };
  },
});

export const commerceListOrdersForCustomer = createTool({
  id: "commerce_list_orders_for_customer",
  description:
    "Offer to show the current customer their recent orders, for 'where is my order' or picking which order has a problem when no order ID is given. Renders its own confirm-then-pick UI (a \"want me to pull up your orders?\" card with a Yes button, then clickable order chips) — call this instead of asking in your own words or listing the orders yourself, and don't restate anything about the result once it's shown; wait for their reply (clicking a chip sends its short order number, e.g. \"4203\") before continuing.",
  inputSchema: z.object({}),
  outputSchema: z.object({
    // existingCases / existingDispute: the same facts commerce_get_order returns, present only on an order that has them.
    // The customer usually types their problem right after this list, and the model answers from what it has already
    // seen — without these it never learned that the item already had a case or a ticket until it filed the claim.
    orders: z.array(
      z.object({
        id: z.string(),
        items: z.string(),
        orderDate: z.string(),
        existingCases: z.array(existingCaseSchema.extend({ objectID: z.string(), name: z.string() })).optional(),
        existingDispute: existingDisputeSchema.optional(),
      })
    ),
  }),
  execute: async (_input, context) => {
    const sessionCustomerId = getSessionCustomerId(context);
    const workflow = context.mastra?.getWorkflow("policyReviewWorkflow");
    // One read of the case runs serves every order: each lookup below would otherwise read and parse them all again.
    const cached = workflow ? await readCaseRunsOnce(workflow) : undefined;
    const orders = await Promise.all(
      getOrdersForCustomer(sessionCustomerId).map(async (o) => {
        const facts = await caseFactsFor(cached, o);
        const existingCases = o.items.flatMap((item) => {
          const existingCase = facts.existingCase(item);
          return existingCase ? [{ objectID: item.objectID, name: item.name, ...existingCase }] : [];
        });
        return {
          id: o.id,
          items: orderItemsSummary(o),
          orderDate: o.orderDate,
          existingCases: existingCases.length > 0 ? existingCases : undefined,
          existingDispute: facts.existingDispute,
        };
      })
    );
    return { orders };
  },
});
