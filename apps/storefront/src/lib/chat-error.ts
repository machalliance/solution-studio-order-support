// What the widget shows for a failed reply. The agent (apps/agent/src/mastra/chat-errors.ts) sends the customer-safe
// sentence AND whether a resend could work as a JSON string in the stream's error text; anything else the browser
// receives (a network failure, an HTTP error body) gets the generic apology and a Try again button.

export interface ChatErrorView {
  message: string;
  retryable: boolean;
}

const GENERIC_CHAT_ERROR = "I’m sorry, something went wrong on our end. Please try again in a moment.";

export function parseChatError(raw: unknown): ChatErrorView {
  const text = typeof raw === "string" ? raw : raw instanceof Error ? raw.message : typeof (raw as { message?: unknown } | null)?.message === "string" ? (raw as { message: string }).message : "";
  try {
    const parsed = JSON.parse(text) as Partial<ChatErrorView>;
    if (typeof parsed?.message === "string" && typeof parsed.retryable === "boolean") return { message: parsed.message, retryable: parsed.retryable };
  } catch {
    /* not our structured form */
  }
  return { message: GENERIC_CHAT_ERROR, retryable: true };
}
