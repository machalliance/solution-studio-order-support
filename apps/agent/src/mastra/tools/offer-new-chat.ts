import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { getConversationId } from "../request-context";
import { summarizeConversationCases } from "./case-lookup";

// Lets the agent itself, mid-reply, offer a fresh chat for a GENUINELY separate topic
// once something in this conversation has been resolved. Every message reaches the agent
// immediately and normally — an earlier design held the customer's message back until a
// separate classifier ruled on it, which produced a visible gap before the message
// appeared and a history the model never saw. Same "silent tool call, the card speaks
// for itself" pattern as present_return_item_picker/commerce_list_orders_for_customer
// (see wismo-agent.ts's own SILENT tool list and server.ts's matching one) — call this
// INSTEAD of respond_to_customer for this one turn, never alongside it.
//
// The deterministic guard below is the part that is never left to the model: a model's
// own judgment is never trusted to break a conversation into a fresh one while
// something is still genuinely pending — a customer must never lose the thread a
// specialist's own follow-up question is about to land in. Reused directly from
// case-lookup.ts rather than re-implemented, so this can't drift from the identical
// guard `offer-escalation.ts` relies on.
export const offerNewChat = createTool({
  id: "offer_new_chat",
  description:
    "Render a card offering the customer a fresh chat, for when something has already been resolved in THIS conversation and they now raise something that's a genuinely SEPARATE matter — a different order, a different item, an unrelated question — not a follow-up about what was just resolved. Call this INSTEAD of respond_to_customer for this turn, never alongside it; don't do any lookups or other tool calls first, since the point is to ask before doing anything about the new topic at all. Never call this for a question ABOUT the resolution itself (\"when will my refund arrive?\", \"how do I use the label?\", \"why was this denied?\") or a flat rejection of it (that's a disagreement — see offer_escalation_to_support) — those stay in this same conversation and get answered directly.",
  inputSchema: z.object({
    message: z
      .string()
      .describe(
        'A short, warm, one- or two-sentence explanation of why you\'re asking — e.g. "That sounds like a separate issue from what we just resolved — want to start a fresh chat for it?" Never invent policy details, numbers, or timelines here.'
      ),
  }),
  outputSchema: z.object({ message: z.string() }),
  execute: async ({ message }, context) => {
    const conversationId = getConversationId(context);
    const workflow = context.mastra?.getWorkflow("policyReviewWorkflow");
    const cases = workflow ? await summarizeConversationCases(workflow, conversationId) : { open: 0, resolved: 0 };
    if (cases.open > 0) {
      throw new Error(
        "Don't offer a new chat right now — there's still an open case in this conversation waiting on a specialist or on your own next reply. Just answer the customer directly instead; never break the thread a follow-up question might land in."
      );
    }
    if (cases.resolved === 0) {
      throw new Error("Don't offer a new chat — nothing has actually been resolved yet in this conversation. Just answer the customer directly instead.");
    }
    return { message };
  },
});
