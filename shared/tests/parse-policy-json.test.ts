import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePolicyJson } from "../parse-policy-json";

test("reject duplicate top-level, nested, and escaped property names", () => {
  for (const text of ['{"facts":[],"facts":[]}', '{"policies":[{"rules":[],"rules":[]}]}', '{"name":1,"\\u006eame":2}']) {
    assert.throws(() => parsePolicyJson(text), /Duplicate JSON property/);
  }
});
test("allow the same property in separate objects and preserve JSON values", () => {
  const text = '{"facts":[{"name":"one","value":null},{"name":"two","value":[true,false,-1.25e2,"a\\\"b"]}]}';
  assert.deepEqual(parsePolicyJson(text), JSON.parse(text));
});
test("invalid or excessively nested JSON is rejected", () => {
  assert.throws(() => parsePolicyJson('{"facts":}'));
  assert.throws(() => parsePolicyJson("[".repeat(130) + "0" + "]".repeat(130)), /too deeply/);
});
