import { test } from "node:test";
import assert from "node:assert/strict";
import { sniffImageType } from "../../src/mastra/chat-images";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 1, 0]);
const WEBP = Buffer.from("RIFF\0\0\0\0WEBPVP8 ........", "latin1");

test("recognises the four types the API accepts, from their bytes", () => {
  assert.equal(sniffImageType(JPEG), "image/jpeg");
  assert.equal(sniffImageType(PNG), "image/png");
  assert.equal(sniffImageType(Buffer.from("GIF89a....")), "image/gif");
  assert.equal(sniffImageType(WEBP), "image/webp");
  assert.equal(sniffImageType(Buffer.from("not an image")), undefined);
  assert.equal(sniffImageType(Buffer.alloc(0)), undefined);
});
