// Diffing and patching policy documents for the Policy Helper panel. policyChanges() turns two
// documents into a list of add / replace / remove changes (JSON-pointer paths, with array
// entries matched by id or name); applyChanges() applies such a list to a base document and
// rejects anything malformed or outside settings / facts / rules / fallback (metadata is the
// system's); describeChanges() renders each change as plain English for review; fingerprint()
// is a key-order-independent string for comparing two values. Pure functions with no I/O —
// whether the resulting document is a valid policy is the server's call.

import type { PolicyDocument } from "./api";
export type Change = { op: "add" | "replace" | "remove"; path: string; value?: unknown };
const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
export function fingerprint(x: unknown): string {
  if (Array.isArray(x)) return `[${x.map(fingerprint).join(",")}]`;
  if (object(x)) return `{${Object.keys(x).sort().map(k => `${JSON.stringify(k)}:${fingerprint(x[k])}`).join(",")}}`;
  return JSON.stringify(x) ?? "undefined";
}
// The parts of a policy document a change may touch. Metadata (name, version, dates) is the system's.
const EDITABLE = ["settings", "facts", "rules", "fallback"] as const;
const escape = (s: string) => s.replaceAll("~", "~0").replaceAll("/", "~1");
const identity = (x: unknown) => object(x) ? x.id ?? x.name : undefined;
export function policyChanges(base: PolicyDocument, next: PolicyDocument): Change[] {
  const changes: Change[] = [];
  function walk(a: unknown, b: unknown, path: string) {
    if (fingerprint(a) === fingerprint(b)) return;
    if (Array.isArray(a) && Array.isArray(b)) {
      const working = [...a];
      for (let i = 0; i < b.length; i++) {
        const key = identity(b[i]);
        if (key !== undefined && identity(working[i]) !== key) {
          const found = working.findIndex((v, j) => j >= i && identity(v) === key);
          if (found >= 0) { changes.push({ op: "remove", path: `${path}/${found}` }); working.splice(found, 1); }
          changes.push({ op: "add", path: `${path}/${i}`, value: b[i] }); working.splice(i, 0, b[i]);
        } else if (i >= working.length) {
          changes.push({ op: "add", path: `${path}/${i}`, value: b[i] }); working.push(b[i]);
        } else if (key !== undefined) {
          if (fingerprint(working[i]) !== fingerprint(b[i])) changes.push({ op: "replace", path: `${path}/${i}`, value: b[i] });
          working[i] = b[i];
        } else walk(working[i], b[i], `${path}/${i}`);
      }
      for (let i = working.length - 1; i >= b.length; i--) changes.push({ op: "remove", path: `${path}/${i}` });
    } else if (object(a) && object(b)) {
      for (const key of Object.keys(a)) if (!Object.hasOwn(b, key)) changes.push({ op: "remove", path: `${path}/${escape(key)}` });
      for (const key of Object.keys(b)) {
        const target = `${path}/${escape(key)}`;
        if (!Object.hasOwn(a, key)) changes.push({ op: "add", path: target, value: b[key] });
        else walk(a[key], b[key], target);
      }
    } else changes.push({ op: "replace", path, value: b });
  }
  for (const key of EDITABLE) walk(base[key], next[key], `/${key}`);
  return changes;
}
function parts(path: string): string[] {
  if (!path.startsWith("/") || /~(?![01])/.test(path)) throw new Error("Each change needs a valid JSON path.");
  const keys = path.slice(1).split("/").map(k => k.replaceAll("~1", "/").replaceAll("~0", "~"));
  if (!(EDITABLE as readonly string[]).includes(keys[0]) || keys.some(k => ["__proto__", "prototype", "constructor"].includes(k))) throw new Error("Changes may edit settings, facts, rules, or the fallback only.");
  return keys;
}
function own(container: unknown, key: string): unknown {
  if (!container || typeof container !== "object" || !Object.hasOwn(container, key)) throw new Error(`Change path does not exist: ${key}`);
  return (container as Record<string, unknown>)[key];
}
export function applyChanges(base: PolicyDocument, input: unknown): PolicyDocument {
  if (!Array.isArray(input) || input.length > 500) throw new Error("Changes must be a JSON array with at most 500 entries.");
  const result = structuredClone(base);
  for (const raw of input) {
    if (!object(raw) || !["add", "replace", "remove"].includes(String(raw.op)) || typeof raw.path !== "string") throw new Error("Each change needs an add, replace, or remove operation and a path.");
    if (Object.keys(raw).some(k => !["op", "path", "value"].includes(k))) throw new Error("Unknown change property. Use op, path, and value only.");
    if (raw.op !== "remove" && !Object.hasOwn(raw, "value")) throw new Error("Added or replaced values cannot be missing.");
    const keys = parts(raw.path), key = keys.pop()!;
    let parent: unknown = result;
    for (const part of keys) parent = own(parent, part);
    if (Array.isArray(parent)) {
      const index = key === "-" && raw.op === "add" ? parent.length : /^(0|[1-9]\d*)$/.test(key) ? Number(key) : -1;
      if (index < 0 || index > parent.length || (raw.op !== "add" && index === parent.length)) throw new Error("Change has an invalid array position.");
      if (raw.op === "add") parent.splice(index, 0, structuredClone(raw.value));
      else if (raw.op === "remove") parent.splice(index, 1);
      else parent[index] = structuredClone(raw.value);
    } else if (object(parent)) {
      if (raw.op === "add" && Object.hasOwn(parent, key)) throw new Error("Use replace to change an existing value.");
      if (raw.op !== "add") own(parent, key);
      if (raw.op === "remove") delete parent[key]; else parent[key] = structuredClone(raw.value);
    } else throw new Error("Change path does not identify an editable object.");
  }
  return result;
}
const words = (s: string) => s.replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("_", " ");
function interpret(value: unknown): string {
  if (!object(value)) return Array.isArray(value) ? value.map(interpret).join("; ") : String(value ?? "none");
  if (typeof value.field === "string") return words(value.field);
  if (typeof value.setting === "string") return `setting “${words(value.setting)}”`;
  if (typeof value.fact === "string") return `calculated “${words(value.fact)}”`;
  if (Array.isArray(value.all)) return value.all.map(v => `(${interpret(v)})`).join(" and ");
  if (Array.isArray(value.any)) return value.any.map(v => `(${interpret(v)})`).join(" or ");
  if (value.not) return `not (${interpret(value.not)})`;
  const operators: Record<string,string> = {eq:"equals",neq:"does not equal",gt:"is greater than",gte:"is at least",lt:"is less than",lte:"is at most",withinDays:"is within the past",olderThanDays:"is older than",add:"plus",subtract:"minus",multiply:"times",divide:"divided by"};
  if (Array.isArray(value.operands)) return value.operands.map(interpret).join(` ${operators[String(value.op)] ?? value.op} `);
  if ("left" in value) return `${interpret(value.left)} ${operators[String(value.op)] ?? value.op} ${interpret(value.right)}${["withinDays","olderThanDays"].includes(String(value.op)) ? " days" : ""}`;
  if ((value.kind === "restriction" || value.kind === "decision") && value.outcome) {
    const scope = Array.isArray(value.appliesTo) && value.appliesTo.length ? value.appliesTo.map(r => words(String(r))).join(" or ") : "every reason";
    const kind = value.kind === "restriction" ? "Restriction" : "Automatic decision";
    return `${kind} for ${scope}: ${value.when ? "when " + interpret(value.when) : "always"}, ${interpret(value.outcome)}.${value.description ? " Description: " + value.description : ""}`;
  }
  if (value.decision) {
    const decisions: Record<string,string> = {autonomous_approve:"approve automatically",autonomous_deny:"decline automatically",escalate:"send to the Escalation Desk for review",always_escalate:"always send to the Escalation Desk for review"};
    return (decisions[String(value.decision)] ?? String(value.decision)) + [value.reasonCode && " Reason code: " + value.reasonCode, value.explanation && " Explanation: " + value.explanation, value.customerReason && " Customer message: " + value.customerReason].filter(Boolean).join(";");
  }
  if (value.source) return `${value.aggregate === "count" ? "Count records" : `Sum ${words(String(value.aggregateField))}`} in ${words(String(value.source))}${value.filter ? ` where ${interpret(value.filter)}` : ""}.`;
  if ("value" in value) return interpret(value.value);
  return Object.entries(value).map(([k,v]) => `${words(k)}: ${interpret(v)}`).join("; ");
}
export function describeChanges(base: PolicyDocument, changes: Change[]) {
  let current = base;
  return changes.map(change => {
    const keys = parts(change.path);
    let before: unknown;
    try { before = keys.reduce<unknown>((o,k) => own(o,k), current); } catch { before = undefined; }
    const next = applyChanges(current, [change]);
    let after: unknown;
    try { after = keys.reduce<unknown>((o,k) => own(o,k), next); } catch { after = undefined; }
    const labelValue = change.op === "remove" ? before : after;
    const label = object(labelValue) && identity(labelValue) !== undefined ? words(String(identity(labelValue))) : keys.map(words).join(" / ");
    current = next;
    return { label, action: change.op === "add" ? "Add" : change.op === "remove" ? "Remove" : "Change", before: change.op === "add" ? undefined : interpret(before), after: change.op === "remove" ? undefined : interpret(after) };
  });
}