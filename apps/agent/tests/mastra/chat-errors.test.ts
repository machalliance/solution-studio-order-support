import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyChatError, GENERIC_CHAT_ERROR, PHOTO_FORMAT_ERROR, PHOTO_REJECTED_ERROR, PHOTO_TOO_LARGE_ERROR, PHOTO_UNREADABLE_ERROR, UNAVAILABLE_CHAT_ERROR } from "../../src/mastra/chat-errors";

// Shaped like the AI SDK's APICallError, with the messages seen in the real trace history.
const api = (message: string, isRetryable: boolean, extra: object = {}) => Object.assign(new Error(message), { isRetryable, ...extra });

test("a dropped connection is worth retrying", () => {
  assert.deepEqual(classifyChatError(api("Cannot connect to API: ", true)), { message: GENERIC_CHAT_ERROR, retryable: true });
});

test("an image the API rejected is not retried, and the customer is told WHY", () => {
  const cases: Array<[string, string]> = [
    ["messages.18.content.1.image.source.base64: image exceeds 10 MB maximum: 13196844 bytes > 10485760 bytes", PHOTO_TOO_LARGE_ERROR],
    ["messages.2.content.1.image.source.base64: The image was specified using the image/jpeg media type, but the image appears to be a image/png image", PHOTO_FORMAT_ERROR],
    ["Could not process image", PHOTO_UNREADABLE_ERROR],
    ["messages.4.content.1.image: something else about the image", PHOTO_REJECTED_ERROR],
  ];
  for (const [message, expected] of cases) {
    assert.deepEqual(classifyChatError(api(message, false)), { message: expected, retryable: false }, message);
  }
});

test("a spending cap or credential problem is not, and is not described as a photo problem", () => {
  const result = classifyChatError(api("You have reached your specified API usage limits. You will regain access on 2026-10-01 at 00:00 UTC.", false));
  assert.deepEqual(result, { message: UNAVAILABLE_CHAT_ERROR, retryable: false });
});

test("the cause chain and the response body are read too", () => {
  const wrapped = new Error("stream failed", { cause: api("bad request", false, { responseBody: '{"error":{"message":"image exceeds 10 MB maximum"}}' }) });
  assert.equal(classifyChatError(wrapped).retryable, false);
  assert.equal(classifyChatError(wrapped).message, PHOTO_TOO_LARGE_ERROR);
});

test("a retryable error that merely mentions an image is still retried", () => {
  assert.equal(classifyChatError(api("overloaded while reading the image", true)).retryable, true);
});

test("another rejected request is not retried; an error with no hint (a tool error) is", () => {
  assert.equal(classifyChatError(api("output_config.format.schema: Invalid schema", false)).retryable, false);
  assert.equal(classifyChatError(new Error("A support ticket is already open for this")).retryable, true);
  assert.equal(classifyChatError("boom").retryable, true);
  assert.equal(classifyChatError(undefined).retryable, true);
});

test("only fixed customer-safe sentences are ever returned, never the raw error", () => {
  const safe = new Set([GENERIC_CHAT_ERROR, PHOTO_TOO_LARGE_ERROR, PHOTO_FORMAT_ERROR, PHOTO_UNREADABLE_ERROR, PHOTO_REJECTED_ERROR, UNAVAILABLE_CHAT_ERROR]);
  for (const error of [api("secret internal detail sk-ant-123", true), api("image: secret sk-ant-123", false), "raw string", undefined]) {
    assert.ok(safe.has(classifyChatError(error).message));
  }
});
