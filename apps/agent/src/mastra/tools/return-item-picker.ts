import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { getOrder } from "../../fixtures/demo-data";
import { getSessionCustomerId, markOrderTouched } from "../request-context";
import { alreadyRefundedItemIds } from "../refund-ledger";

// The client-facing half of item-level returns AND item-level damage claims: this
// tool's own output is never used for a policy decision (that's payment_issue_
// return_refund / escalate_for_return_refund / payment_issue_refund /
// escalate_for_policy_review, all re-derived server-side from the objectIDs the
// customer actually picks) — its only job is handing the storefront enough of each
// product's real data (photo, price, name) to render an interactive checkbox card in
// the chat, so the customer clicks which item(s) they mean instead of typing a
// description the model has to interpret. See ChatWidget.tsx's tool-UI registration for
// "presentReturnItemPicker" (the tool's JS registration key in wismo-agent.ts, not this
// snake_case id — the same gotcha touched-orders-from-history.ts hit first).
//
// purpose is display-only — it changes the CARD'S OWN COPY (ChatWidget.tsx's
// ReturnItemPicker: "return this?" vs. "which one was damaged?", "Submit return" vs.
// "Confirm") and the plain-text message it appends once submitted, nothing about which
// items are shown or how selection works; a damage claim and a return both use the same
// checkbox mechanism, just worded for what's actually being asked. Choosing/display
// (this tool) stays fully separate from computing an amount or deciding policy (the
// escalation/payment tools) either way — this tool never sums a price or checks a
// ceiling for either purpose.
export const presentReturnItemPicker = createTool({
  id: "present_return_item_picker",
  description:
    "Show the customer a checkbox list of the items on one of their own orders, so they can click which one(s) they mean instead of typing it out. Call it as soon as the customer has said which kind of problem it is. If all you know is that they're unhappy or have an issue, ask what's wrong first instead: the card's submit text is sent as the customer's own words, so a wrong purpose puts a claim in their mouth. Call this whenever you already know the order and need the customer to identify which item(s) — either they want to return something (purpose: \"return\") or they're reporting damage and haven't already named the one item (purpose: \"damage_claim\") — and don't ask them to describe which item first. After this, wait for their selection (they'll reply once they've picked and submitted) before calling payment_issue_return_refund / escalate_for_return_refund or payment_issue_refund / escalate_for_policy_review with those same itemIds.",
  inputSchema: z.object({
    orderId: z.string(),
    purpose: z
      .enum(["return", "damage_claim"])
      .default("return")
      .describe("Which flow this selection is for — changes only the card's own wording, not its behavior. Must match what the customer actually said (damaged/defective → damage_claim; wants to return it → return); if they haven't said, ask first."),
  }),
  outputSchema: z.object({
    orderId: z.string(),
    purpose: z.enum(["return", "damage_claim"]),
    items: z.array(
      z.object({
        objectID: z.string(),
        name: z.string(),
        price: z.number(),
        currency: z.string(),
        images: z.array(z.string()),
        colourFamily: z.string(),
        colourHex: z.string(),
        // True when this item is already covered by an earlier refund (refund-ledger.ts)
        // — the checkbox card (ChatWidget.tsx) greys these out rather than letting the
        // customer pick one and only finding out it's a no-op after they submit. Applies
        // regardless of purpose: an item already refunded via a return can't also be
        // claimed as damaged (or vice versa) — issueRefund's own ledger check would
        // reject it either way, this just surfaces that up front.
        alreadyReturned: z.boolean(),
      })
    ),
  }),
  execute: async ({ orderId, purpose }, context) => {
    const sessionCustomerId = getSessionCustomerId(context);
    const order = getOrder(orderId);
    if (!order) throw new Error(`No such order: ${orderId}`);
    if (order.customerId !== sessionCustomerId) throw new Error(`Order ${orderId} does not belong to the current customer.`);
    // Instructing the model to skip this tool for a single-item order (wismo-agent.ts)
    // is advisory, not enforced — live-reproduced: a vague "I would like to return" with
    // no item named, after an unrelated tracking/signature exchange, still called this
    // tool for a genuinely single-item order and showed the customer a one-checkbox card
    // for something already unambiguous. Same fix pattern as findOpenCaseForOrder's
    // duplicate-escalation guard: make the skip a deterministic tool-level error instead
    // of trusting the instruction alone, so it can't be missed regardless of how the
    // customer phrases the request. ReturnItemPicker (ChatWidget.tsx) only renders once
    // `result` exists, so an error here never reaches the customer as a broken card —
    // the model just gets an error result back and proceeds directly, same turn.
    if (order.items.length === 1) {
      throw new Error(
        `Order ${orderId} has only one item (objectID ${order.items[0].objectID}) — never call present_return_item_picker for a single-item order, there's nothing to choose between. Proceed directly (omit itemIds entirely — that means "the whole order," which is correct here) without showing the customer anything about a picker.`
      );
    }
    markOrderTouched(context, order.id);
    const alreadyReturned = await alreadyRefundedItemIds(order.id);
    return {
      orderId: order.id,
      purpose,
      items: order.items.map((item) => ({
        objectID: item.objectID,
        name: item.name,
        price: item.price,
        currency: item.currency,
        images: item.images,
        colourFamily: item.colourFamily,
        colourHex: item.colourHex,
        alreadyReturned: alreadyReturned.has(item.objectID),
      })),
    };
  },
});
