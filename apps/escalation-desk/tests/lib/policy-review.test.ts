import test from "node:test";
import assert from "node:assert/strict";
import { createPolicyReview, mergePolicyReview } from "../../src/lib/policy-review";
import type { PolicyDocument } from "../../src/lib/api";
const rule = (id:string) => ({kind:"restriction",id,when:{left:1,op:"eq",right:1},outcome:{decision:"escalate"}});
const base:PolicyDocument = {
  schemaVersion:2,
  metadata:{name:"test",version:1,createdAt:"2026-09-24"},
  settings:{window:{value:30,description:"Days"}},
  facts:[{name:"existing",type:"number",value:5}],
  rules:[rule("first"),rule("last")],
  fallback:{decision:"escalate",reasonCode:"needs-a-person"},
};
test("review uses native policy JSON and merges edited values at the original insertion point",()=>{
  const next=structuredClone(base);
  next.facts.push({name:"recentRefundTotal",type:"number",source:"customer.completedRefunds",aggregate:"sum",aggregateField:"item.amount"});
  next.rules.splice(1,0,{...rule("history"),when:{left:1,op:"gt",right:300}});
  const review=createPolicyReview(base,next);
  assert.deepEqual(review.json,{facts:[next.facts[1]],rules:[next.rules[1]]});
  assert.deepEqual(mergePolicyReview(next,review,review.json),next);
  const edited=structuredClone(review.json) as unknown as {rules:Array<{when:{right:number}}>};
  edited.rules[0].when.right=400;
  const merged=mergePolicyReview(next,review,edited);
  assert.deepEqual(merged.rules.map(r=>r.id),["first","history","last"]);
  assert.equal((merged.rules[1].when as {right:number}).right,400);
  assert.deepEqual(merged.facts[0],base.facts[0]);
  assert.equal((next.rules[1].when as {right:number}).right,300);
});
test("removals stay explicit and are preserved by the merge",()=>{
  const next=structuredClone(base);
  next.facts=[]; next.rules.splice(0,1);
  const review=createPolicyReview(base,next);
  assert.deepEqual(review.removals,["Fact: existing","Rule: first"]);
  assert.deepEqual(mergePolicyReview(next,review,review.json),next);
});
test("rejects unexpected fragment structure instead of silently dropping edits",()=>{
  const next=structuredClone(base); next.settings.window.value=45;
  const review=createPolicyReview(base,next);
  assert.throws(()=>mergePolicyReview(next,review,{}));
  assert.throws(()=>mergePolicyReview(next,review,{...review.json,metadata:{version:99}}));
});
test("reordered rules remain visible and keep their proposed order",()=>{
  const next=structuredClone(base); next.rules.reverse();
  const review=createPolicyReview(base,next);
  assert.deepEqual(review.json.rules,next.rules);
  assert.deepEqual(mergePolicyReview(next,review,review.json),next);
});
test("a changed fallback is reviewable and editable",()=>{
  const next=structuredClone(base); next.fallback={...base.fallback,customerReason:"A specialist will follow up."};
  const review=createPolicyReview(base,next);
  assert.deepEqual(review.json,{fallback:next.fallback});
  const edited={fallback:{...next.fallback,customerReason:"Someone will be in touch."}};
  assert.equal((mergePolicyReview(next,review,edited).fallback as {customerReason:string}).customerReason,"Someone will be in touch.");
});
test("an unchanged document has an empty review",()=>{
  const review=createPolicyReview(base,structuredClone(base));
  assert.deepEqual(review.json,{});
  assert.deepEqual(review.removals,[]);
});
