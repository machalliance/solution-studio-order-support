// The editable "review" view of a Policy Helper proposal. createPolicyReview() builds a JSON
// object holding only the settings, facts, rules and fallback that differ from the live policy
// (plus a list of removals, shown but not editable) and remembers which entry in the review
// maps to which entry in the full proposed document. mergePolicyReview() writes the operator's
// edited entries back into the proposal, and rejects an edit that changes the review's
// structure (its sections or entry counts), so a partial edit can't silently drop or add rules.

import type { PolicyDocument } from "./api";
import { fingerprint } from "./policy-changes";

type Path = (string | number)[];
type Binding = { review: Path; document: Path };
export type PolicyReview = { json: Record<string, unknown>; bindings: Binding[]; removals: string[] };
const same = (a: unknown, b: unknown) => fingerprint(a) === fingerprint(b);
function at(root: unknown, path: Path): unknown {
  let value = root;
  for (const key of path) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, key)) throw new Error("Keep the review structure intact. Use the complete draft editor to add or remove entries.");
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}
function put(root: unknown, path: Path, value: unknown) {
  const parent = at(root, path.slice(0, -1)) as Record<string, unknown>;
  parent[path[path.length - 1]] = structuredClone(value);
}
// Display actual policy entries; array positions used for merging stay private.
export function createPolicyReview(base: PolicyDocument, next: PolicyDocument): PolicyReview {
  const json: Record<string, unknown> = {};
  const bindings: Binding[] = [];
  const removals: string[] = [];
  const bind = (review: Path, document: Path) => bindings.push({review, document});
  const settings: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(next.settings)) {
    if (!same(base.settings[name], value)) {
      Object.defineProperty(settings, name, {value, enumerable:true, writable:true, configurable:true});
      bind(["settings", name], ["settings", name]);
    }
  }
  if (Object.keys(settings).length) json.settings = settings;
  for (const name of Object.keys(base.settings)) if (!Object.hasOwn(next.settings, name)) removals.push("Setting: " + name);
  const facts: unknown[] = [];
  next.facts.forEach((fact, index) => {
    if (!same(base.facts.find(f => f.name === fact.name), fact)) {
      bind(["facts", facts.length], ["facts", index]); facts.push(fact);
    }
  });
  if (facts.length) json.facts = facts;
  for (const fact of base.facts) if (!next.facts.some(f => f.name === fact.name)) removals.push("Fact: " + fact.name);
  // Rules are one list, matched by id. A rule that changed is shown whole; if any surviving rule moved, every
  // rule is shown so the new order stays visible (order picks which reason is reported first and how a
  // reader scans the list — it never changes whether a request goes to a person).
  const oldOrder = base.rules.filter(r => next.rules.some(n => n.id === r.id)).map(r => r.id);
  const newOrder = next.rules.filter(r => base.rules.some(n => n.id === r.id)).map(r => r.id);
  const reordered = !same(oldOrder, newOrder);
  const rules: unknown[] = [];
  next.rules.forEach((rule, index) => {
    if (reordered || !same(base.rules.find(r => r.id === rule.id), rule)) {
      bind(["rules", rules.length], ["rules", index]);
      rules.push(rule);
    }
  });
  if (rules.length) json.rules = rules;
  for (const rule of base.rules) if (!next.rules.some(r => r.id === rule.id)) removals.push("Rule: " + rule.id);
  if (!same(base.fallback, next.fallback)) {
    json.fallback = next.fallback;
    bind(["fallback"], ["fallback"]);
  }
  return {json, bindings, removals};
}
export function mergePolicyReview(proposed: PolicyDocument, review: PolicyReview, edited: unknown): PolicyDocument {
  if (!edited || typeof edited !== "object" || Array.isArray(edited)) throw new Error("Enter a policy JSON object with settings, facts, rules, or the fallback.");
  const skeleton = structuredClone(review.json);
  const editedSkeleton = structuredClone(edited);
  const result = structuredClone(proposed);
  for (const binding of review.bindings) {
    const value = at(edited, binding.review);
    put(result, binding.document, value);
    put(skeleton, binding.review, null);
    put(editedSkeleton, binding.review, null);
  }
  if (!same(skeleton, editedSkeleton)) throw new Error("Keep the shown section names and entry counts intact. Edit their values here; use the complete draft editor for other structural changes.");
  return result;
}
