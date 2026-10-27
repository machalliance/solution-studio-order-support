import test from "node:test";
import assert from "node:assert/strict";
import { applyChanges, policyChanges, describeChanges } from "../../src/lib/policy-changes";
import type { PolicyDocument } from "../../src/lib/api";
const rule = (id: string) => ({kind:"restriction",id,description:id,when:{left:1,op:"eq",right:1},outcome:{decision:"escalate",reasonCode:id,explanation:id}});
const base: PolicyDocument = {
  schemaVersion:2,
  metadata:{name:"test",version:2,createdAt:"2026-09-24"},
  settings:{window:{value:30,description:"Window"}},
  facts:[],
  rules:[rule("a"),rule("b"),rule("c")],
  fallback:{decision:"escalate",reasonCode:"needs-a-person",explanation:"A person decides."},
};
test("applies new rules in the proposed order and preserves the base", () => {
  const original = structuredClone(base), next = structuredClone(base);
  next.facts.push({name:"refunds180",type:"number",source:"customer.completedRefunds",aggregate:"sum",aggregateField:"amount"});
  next.rules.unshift(rule("new"));
  next.settings.window.value = 45;
  assert.deepEqual(applyChanges(base, policyChanges(base,next)), next);
  assert.deepEqual(base,original);
});
test("round-trips removal, movement, replacement and insertion", () => {
  for (const ids of [["c","a"],["a"],[],["new","b","a","c"],["c","b","a"],["a","new","b"]]) {
    const next = structuredClone(base);
    next.rules=ids.map(rule);
    if (next.rules[0]) next.rules[0].description="Edited";
    assert.deepEqual(applyChanges(base,policyChanges(base,next)),next);
  }
});
test("a changed fallback round-trips", () => {
  const next = structuredClone(base);
  next.fallback = {...base.fallback, customerReason:"A specialist will follow up."};
  assert.deepEqual(applyChanges(base,policyChanges(base,next)),next);
});
test("blocks metadata, schema version, prototype paths, malformed operations and invalid positions", () => {
  for (const change of [
    {op:"replace",path:"/metadata/version",value:3},
    {op:"replace",path:"/schemaVersion",value:1},
    {op:"add",path:"/settings/__proto__",value:{}},
    {op:"add",path:"/settings/window",value:{}},
    {op:"replace",path:"/facts/4",value:{}},
    {op:"replace",path:"/settings/window/value"},
    {op:"move",path:"/settings/window"},
    {op:"add",path:"/policies/0",value:{}},
  ]) assert.throws(() => applyChanges(base,[change]));
});
test("interpretation includes changed decision text, scope and removal", () => {
  const next=structuredClone(base);
  next.rules[0]= {...rule("a"),appliesTo:["not_wanted"],outcome:{decision:"escalate",reasonCode:"changed",explanation:"Requires review",customerReason:"Please wait"}};
  const rows=describeChanges(base,policyChanges(base,next));
  assert.match(rows[0].after!,/Please wait/);
  assert.match(rows[0].after!,/Restriction for not wanted/);
  assert.match(rows[0].before!,/Restriction for every reason/);
  const removal=describeChanges(base,[{op:"remove",path:"/rules/0"}])[0];
  assert.equal(removal.action,"Remove");
  assert.equal(removal.after,undefined);
  assert.match(removal.before!,/Escalation Desk/);
});
test("a rule with no condition reads as always", () => {
  const next=structuredClone(base);
  const {when:_when,...unconditional}=rule("d");
  next.rules.push(unconditional);
  const [row]=describeChanges(base,policyChanges(base,next));
  assert.match(row.after!,/always/);
});
test("handles escaped setting names", () => {
  const next=structuredClone(base);
  next.settings["custom/window~days"]={value:60,description:"Custom"};
  assert.deepEqual(applyChanges(base,policyChanges(base,next)),next);
});
