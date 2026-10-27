// What the server accepts from the browser on each chat request: ONE new customer message, cleaned.
//
// The browser still sends its whole copy of the conversation (that is what the chat library does), but only the LAST message is
// read and only as a customer message: every other message, and every role, part type and field this module does not name, is
// dropped. The history the model sees comes from the server's own thread (conversation-threads.ts).
//
// This is STRUCTURAL cleaning, which can be guaranteed. It cannot remove prompt injection written in plain English; that
// stays covered by the design: money, ownership and policy are checked in code, reply guards check what is said, and the
// model's reading of fault is the one judgment that is never verified.

import { randomUUID } from "node:crypto";
import { MAX_PHOTOS_PER_MESSAGE } from "../../../../shared/chat-limits";
import { sniffImageType } from "./chat-images";
import type { StoredMessage } from "./conversation-threads";

export const MAX_TEXT_CHARS = 4000;
// The storefront stops the customer at the same number when they attach a photo (shared/chat-limits.ts).
export const MAX_IMAGES_PER_MESSAGE = MAX_PHOTOS_PER_MESSAGE;
// A photo arrives as a base64 data URL; the widget shrinks photos to ~1.5 MB, and the API itself refuses an image over 10 MB.
const MAX_IMAGE_URL_CHARS = 14_000_000;

export type SanitizeResult = { ok: true; message: StoredMessage } | { ok: false; status: 400; error: string; message: string };

// Whole categories of Unicode, not a list of ranges (a list is how Unicode tag characters slipped through): every control
// character (C0 and C1) except tab and newline; every "format" character, which covers zero-width characters, direction marks
// and overrides, the soft hyphen, the word joiner, the byte-order mark, interlinear annotation marks, the Mongolian vowel
// separator and the TAG characters (invisible text a model can read: a way to hide an instruction in an ordinary-looking
// message); the variation selectors, except the two that choose the plain or picture form of an emoji (U+FE0E, U+FE0F); and
// lone surrogates (broken text the model API rejects, which would break every later turn of the chat). Removing the
// joiners also removes the zero-width non-joiner and joiner that some scripts need (the Persian half-space, some Indic
// conjuncts): a deployment serving those languages should keep those two.
const INVISIBLE_OR_CONTROL = /(?![\t\n\uFE0E\uFE0F])[\p{Cc}\p{Cf}\p{Cs}\p{Variation_Selector}]/gu;

// Also used on the customer's words in a support ticket when there is no stored conversation to take them from.
export function cleanText(input: string): string {
  return input
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    // Line and paragraph separators are line breaks that most text handling does not treat as one.
    .replace(/[\u2028\u2029]/g, "\n")
    .replace(INVISIBLE_OR_CONTROL, "")
    // The widget turns "[[SLA:...]]" in an assistant message into a live countdown; a customer has no business typing one.
    // The whole run of brackets goes: replacing two at a time leaves "[[SLA:" behind in "[[[[SLA:".
    .replace(/\[{2,}(?=\s*SLA\s*:)/gi, "[")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const DATA_URL = /^data:([^;,]+)((?:;[^;,]+)*),/;

function fail(error: string, message: string): SanitizeResult {
  return { ok: false, status: 400, error, message };
}

// `raw` is the LAST element of the browser's `messages` array (or whatever the caller put there).
export function sanitizeIncomingMessage(raw: unknown): SanitizeResult {
  if (!raw || typeof raw !== "object") return fail("invalid_message", "I couldn't read that message. Please try sending it again.");
  const candidate = raw as { role?: unknown; parts?: unknown };
  if (candidate.role !== "user") return fail("invalid_message", "I couldn't read that message. Please try sending it again.");
  if (!Array.isArray(candidate.parts)) return fail("invalid_message", "I couldn't read that message. Please try sending it again.");

  const textChunks: string[] = [];
  const images: Array<{ type: "file"; mediaType: string; url: string }> = [];
  let sawUnreadableImage = false;

  for (const part of candidate.parts as Array<{ type?: unknown; text?: unknown; url?: unknown }>) {
    if (part?.type === "text" && typeof part.text === "string") {
      const cleaned = cleanText(part.text);
      if (cleaned.length > 0) textChunks.push(cleaned);
    } else if (part?.type === "file" && typeof part.url === "string") {
      const match = DATA_URL.exec(part.url);
      if (!match || !match[1].startsWith("image/") || !match[2].includes("base64") || part.url.length > MAX_IMAGE_URL_CHARS) {
        sawUnreadableImage = true;
        continue;
      }
      let head: Uint8Array;
      try {
        const payload = part.url.slice(match[0].length, match[0].length + 24);
        head = Buffer.from(payload.slice(0, payload.length - (payload.length % 4)), "base64");
      } catch {
        sawUnreadableImage = true;
        continue;
      }
      // The bytes decide the type, never the label.
      const actual = sniffImageType(head);
      if (!actual) {
        sawUnreadableImage = true;
        continue;
      }
      images.push({ type: "file", mediaType: actual, url: `data:${actual}${match[2]},${part.url.slice(match[0].length)}` });
    }
    // Every other part type (tool calls and results, reasoning, sources, anything else) is dropped without comment.
  }

  const text = textChunks.join("\n");
  if (text.length > MAX_TEXT_CHARS) return fail("message_too_long", "That message is too long. Please shorten it and try again.");
  if (images.length > MAX_IMAGES_PER_MESSAGE) return fail("too_many_photos", `Please attach at most ${MAX_IMAGES_PER_MESSAGE} photos in one message.`);
  if (text.length === 0 && images.length === 0) {
    return sawUnreadableImage ? fail("invalid_image", "I couldn't open that photo. Could you try sending a different one?") : fail("empty_message", "Please type a message before sending.");
  }

  const parts: StoredMessage["parts"] = [];
  if (text.length > 0) parts.push({ type: "text", text });
  parts.push(...images);
  return { ok: true, message: { id: randomUUID(), role: "user", parts } };
}
