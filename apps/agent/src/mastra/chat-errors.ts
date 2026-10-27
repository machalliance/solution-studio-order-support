// What the customer is told when a chat turn dies, and whether "Try again" can possibly help.
//
// The widget used to show one fixed apology with a Try again button for every failure — but resending the same
// photo that the API rejected (or hitting a spending cap) fails identically every time, so a customer could loop on it
// forever (as a 13 MB phone photo once did). A retryable failure (a dropped connection, a 429, a 5xx) is
// already retried by the agent's maxRetries before it ever reaches this point; what arrives here is whatever was left.
//
// Only fixed, customer-safe sentences are ever returned — never the raw error (same "never surface internals" rule as
// everywhere else in this app).

export interface CustomerChatError {
  message: string;
  /** True when sending the same thing again could work. The widget shows "Try again" only then. */
  retryable: boolean;
}

export const GENERIC_CHAT_ERROR = "I'm sorry, something went wrong on our end. Please try again in a moment.";
// A photo the API refused — and, where the API's own message tells us, WHY, so the customer knows what to change
// instead of being told only that it didn't work.
export const PHOTO_TOO_LARGE_ERROR = "That photo is too large for me to open. Could you try a smaller one?";
export const PHOTO_FORMAT_ERROR = "That photo is in a format I can't read. Could you try a JPG or PNG instead?";
export const PHOTO_UNREADABLE_ERROR = "I couldn't read that photo — the file may be damaged. Could you try a different one?";
export const PHOTO_REJECTED_ERROR = "I couldn't use that photo. Could you try a different one?";
export const UNAVAILABLE_CHAT_ERROR = "I'm sorry, I can't help with this right now. Please try again later.";

// The error is usually an APICallError, sometimes wrapped (cause) — gather the text and the retry hints from the chain.
function inspect(error: unknown): { text: string; retryable: boolean | undefined } {
  const parts: string[] = [];
  let retryable: boolean | undefined;
  let current: any = error;
  for (let depth = 0; current && depth < 5; depth++) {
    if (typeof current === "string") {
      parts.push(current);
      break;
    }
    if (typeof current.message === "string") parts.push(current.message);
    if (typeof current.responseBody === "string") parts.push(current.responseBody);
    if (typeof current.isRetryable === "boolean" && retryable === undefined) retryable = current.isRetryable;
    current = current.cause;
  }
  return { text: parts.join(" "), retryable };
}

export function classifyChatError(error: unknown): CustomerChatError {
  const { text, retryable } = inspect(error);

  // A spending cap, billing or credential problem: nothing the customer can do, and it won't clear on a retry.
  if (/usage limits|credit balance|billing|spend limit|invalid x-api-key|authentication_error|permission_error/i.test(text)) {
    return { message: UNAVAILABLE_CHAT_ERROR, retryable: false };
  }
  // The API refused the photo itself (too large, corrupt, wrong type) — the same photo will be refused again.
  if (/\bimage\b/i.test(text) && retryable !== true) {
    if (/exceeds|maximum|too large|too big|\bmb\b/i.test(text)) return { message: PHOTO_TOO_LARGE_ERROR, retryable: false };
    if (/media type|appears to be|unsupported|not supported|format/i.test(text)) return { message: PHOTO_FORMAT_ERROR, retryable: false };
    if (/could not process|cannot process|corrupt|invalid|decode/i.test(text)) return { message: PHOTO_UNREADABLE_ERROR, retryable: false };
    return { message: PHOTO_REJECTED_ERROR, retryable: false };
  }
  // Anything else the API marked as not retryable (a rejected request) fails identically on a resend.
  return { message: GENERIC_CHAT_ERROR, retryable: retryable !== false };
}
