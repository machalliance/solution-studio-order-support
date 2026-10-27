// Structural (Zod, via schema.ts) validation, then semantic validation of references,
// types, capabilities, and dependency order: it rejects unknown sources/operators,
// duplicate IDs, reserved-name shadowing, incompatible units, invalid dates, excessive
// expression depth/collection size, and references to undefined facts, and requires
// derived facts to resolve in dependency order. A document that passes this is safe to
// save; it is NOT itself
// proof of correct business intent (the Policy Helper's own generated draft still
// needs a human to review the diff before activating).

import { policyDocumentSchema, ARITHMETIC_OPS, type PolicyDocument, type Condition, type ValueRef, type FactDefinition } from "./schema";
import { findField, findCollection, CATALOG_OPERATORS } from "./catalog";

export interface ValidationIssue {
  path: string;
  message: string;
}
const MAX_CONDITION_DEPTH = 6;
const MAX_FACTS = 50;

function isValidIsoDate(value: string): boolean {
  return !Number.isNaN(new Date(value).getTime());
}

// "top" outside a collection filter; inside one, the collection's own declared item fields
// (catalog.ts), so a misspelled "item.*" field is caught rather than silently matching nothing.
type Scope = "top" | { itemFields: Set<string> };

// scope: which field namespace is legal here — "top" outside a collection filter, the
// collection's item fields inside one (a filter's own leaves may ALSO reference the outer scope's
// settings/facts, just not another collection's "item.*" — only field refs are scope-
// restricted).
function walkValueRef(
  ref: ValueRef,
  scope: Scope,
  knownFactNames: Set<string>,
  settingNames: Set<string>,
  path: string,
  issues: ValidationIssue[]
): void {
  if (typeof ref !== "object") return; // literal — nothing to check
  if ("field" in ref) {
    if (scope !== "top") {
      if (!ref.field.startsWith("item.")) {
        issues.push({ path, message: `Inside a collection filter, a field reference must start with "item." — got "${ref.field}".` });
      } else if (!scope.itemFields.has(ref.field)) {
        // A typo like "item.completdAt" once passed and
        // silently matched nothing — a $330 history became $0 and the case approved.
        issues.push({ path, message: `"${ref.field}" is not a real field on this collection — known fields: ${[...scope.itemFields].join(", ")}.` });
      }
      return;
    }
    if (ref.field.startsWith("item.")) {
      issues.push({ path, message: `"${ref.field}" is only valid inside a collection filter, not here.` });
      return;
    }
    if (!findField(ref.field)) {
      issues.push({ path, message: `Unknown field reference: "${ref.field}" is not in the capability catalog.` });
    }
    return;
  }
  if ("setting" in ref) {
    if (!settingNames.has(ref.setting)) {
      issues.push({ path, message: `Reference to undefined setting: "${ref.setting}".` });
    }
    return;
  }
  if ("fact" in ref) {
    if (!knownFactNames.has(ref.fact)) {
      issues.push({ path, message: `Reference to undefined (or not-yet-declared) fact: "${ref.fact}". Facts can only reference facts declared earlier in the same document.` });
    }
    return;
  }
  if ("op" in ref && "operands" in ref) {
    if ((ref.op === "divide" || ref.op === "subtract") && ref.operands.length !== 2) {
      issues.push({ path, message: `"${ref.op}" takes exactly 2 operands (order matters — it's not commutative).` });
    }
    ref.operands.forEach((operand, i) => walkValueRef(operand, scope, knownFactNames, settingNames, `${path}.operands[${i}]`, issues));
    // Obvious invalid arithmetic, knowable from the document alone: dividing by something
    // that works out to a literal 0, or a literal-only expression with an invalid result
    // (0 / 0, 5 / (2 - 2)). Anything that depends on real order/customer data (a
    // denominator that's only zero for a $0 order) is left to evaluate.ts's runtime check,
    // which escalates. An operand already reported invalid isn't reported again here.
    const operandValues = ref.operands.map(literalNumber);
    if (operandValues.some((v) => v !== undefined && !Number.isFinite(v))) return;
    if (ref.op === "divide" && operandValues.slice(1).some((v) => v === 0)) {
      issues.push({ path, message: `Divides by zero — this always produces an invalid number.` });
      return;
    }
    const folded = literalNumber(ref);
    if (folded !== undefined && !Number.isFinite(folded)) {
      issues.push({ path, message: `This arithmetic always produces an invalid number (${folded}).` });
    }
    return;
  }
}

// The value of an expression built only from literal numbers, worked out now; undefined
// if any part depends on a field, setting, or fact.
function literalNumber(ref: ValueRef): number | undefined {
  if (typeof ref === "number") return ref;
  if (typeof ref !== "object" || !("op" in ref) || !("operands" in ref)) return undefined;
  const values = ref.operands.map(literalNumber);
  if (values.some((v) => v === undefined)) return undefined;
  const nums = values as number[];
  switch (ref.op) {
    case "add":
      return nums.reduce((sum, v) => sum + v, 0);
    case "subtract":
      return nums.reduce((acc, v, i) => (i === 0 ? v : acc - v));
    case "multiply":
      return nums.reduce((product, v) => product * v, 1);
    case "divide":
      return nums.reduce((acc, v, i) => (i === 0 ? v : acc / v));
    default:
      return undefined;
  }
}

function walkCondition(
  condition: Condition,
  scope: Scope,
  knownFactNames: Set<string>,
  settingNames: Set<string>,
  path: string,
  issues: ValidationIssue[],
  depth = 0
): void {
  if (depth > MAX_CONDITION_DEPTH) {
    issues.push({ path, message: `Condition nested too deeply (max ${MAX_CONDITION_DEPTH}).` });
    return;
  }
  if ("all" in condition) {
    condition.all.forEach((c, i) => walkCondition(c, scope, knownFactNames, settingNames, `${path}.all[${i}]`, issues, depth + 1));
    return;
  }
  if ("any" in condition) {
    condition.any.forEach((c, i) => walkCondition(c, scope, knownFactNames, settingNames, `${path}.any[${i}]`, issues, depth + 1));
    return;
  }
  if ("not" in condition) {
    walkCondition(condition.not, scope, knownFactNames, settingNames, `${path}.not`, issues, depth + 1);
    return;
  }
  // Leaf.
  if (!(CATALOG_OPERATORS as readonly string[]).includes(condition.op)) {
    issues.push({ path: `${path}.op`, message: `Unknown operator: "${condition.op}".` });
  }
  walkValueRef(condition.left, scope, knownFactNames, settingNames, `${path}.left`, issues);
  walkValueRef(condition.right, scope, knownFactNames, settingNames, `${path}.right`, issues);
  // Incompatible units: a date-comparison operator's right side should be a plain
  // number of days, and its left side (when a literal, not a field/fact) should be a
  // parseable date — catches the obvious "wrong shape" mistakes without a full type
  // system.
  if (condition.op === "withinDays" || condition.op === "olderThanDays") {
    if (typeof condition.left === "string" && !isValidIsoDate(condition.left)) {
      issues.push({ path: `${path}.left`, message: `"${condition.left}" is not a valid date for a ${condition.op} comparison.` });
    }
    // A literal on the right that isn't a number is definitely wrong; a field/setting/
    // fact/expression reference is left to runtime type checking — this catches only
    // the unambiguous literal-shape mistake.
    if ((typeof condition.right === "string" || typeof condition.right === "boolean")) {
      issues.push({ path: `${path}.right`, message: `${condition.op} expects a plain number of days on the right side.` });
    }
  }
}

function walkFactValueRefs(fact: FactDefinition, knownFactNames: Set<string>, settingNames: Set<string>, issues: ValidationIssue[]): void {
  const path = `facts.${fact.name}`;
  if (fact.value !== undefined) {
    walkValueRef(fact.value, "top", knownFactNames, settingNames, `${path}.value`, issues);
  }
  if (fact.source !== undefined) {
    const collection = findCollection(fact.source);
    if (!collection) {
      issues.push({ path: `${path}.source`, message: `Unknown collection source: "${fact.source}".` });
    }
    if (!fact.aggregate) {
      issues.push({ path: `${path}.aggregate`, message: `A fact with a "source" must declare an "aggregate" (sum or count).` });
    }
    if (fact.aggregate === "sum" && !fact.aggregateField) {
      issues.push({ path: `${path}.aggregateField`, message: `aggregate "sum" requires an aggregateField.` });
    }
    // This once only checked that SOME aggregateField string was present, never that it names a REAL
    // field the catalog declares for this collection. A typo ("item.amout" for "item.amount") passed
    // validation, then silently evaluated every item's value as `undefined ?? 0`, so a policy meant to
    // sum real dollar history could activate as if the total were always zero. Checked against the
    // collection's own itemFields (catalog.ts), the one place these names are declared, not a
    // hand-maintained duplicate list here.
    if (fact.aggregate === "sum" && fact.aggregateField && collection && !collection.itemFields.some((f) => f.field === fact.aggregateField)) {
      const known = collection.itemFields.map((f) => f.field).join(", ");
      issues.push({ path: `${path}.aggregateField`, message: `"${fact.aggregateField}" is not a real field on collection "${fact.source}" — known fields: ${known}.` });
    }
    if (fact.filter && collection) {
      walkCondition(fact.filter, { itemFields: new Set(collection.itemFields.map((f) => f.field)) }, knownFactNames, settingNames, `${path}.filter`, issues);
    }
  }
  if (fact.value === undefined && fact.source === undefined) {
    issues.push({ path, message: `Fact "${fact.name}" declares neither a "value" nor a "source" — nothing to compute.` });
  }
}

// zod reports a value that matches none of the allowed shapes as just "Invalid input", at the
// path of the whole value — no hint which part is wrong. Once the Policy
// Helper answered with {"op": "conditional", …} inside a fact and the operator saw only
// "facts.2.value: Invalid input". So when the failure is a bad value, walk it and say what is
// actually unsupported, and point at the part that is wrong.
const VALUE_GRAMMAR =
  `A value is a number/string/true/false, {"field": …}, {"setting": …}, {"fact": …}, or arithmetic ` +
  `{"op": ${ARITHMETIC_OPS.map((op) => `"${op}"`).join(" | ")}, "operands": [two or more values]}. ` +
  `There is no if/then, min/max or other function inside a value — to branch on a condition, put it in a ` +
  `rule's "when" instead (combine checks with "any" / "all" / "not").`;

function describeBadValue(value: unknown, path: string): ValidationIssue | null {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return null;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { path, message: `${JSON.stringify(value) ?? String(value)} is not a valid value. ${VALUE_GRAMMAR}` };
  }
  const node = value as Record<string, unknown>;
  // The reference forms (schema.ts accepts extra keys on these, so only the one key matters).
  if (typeof node.field === "string" || typeof node.setting === "string" || typeof node.fact === "string") return null;
  if ("op" in node) {
    const op = String(node.op);
    if (!(ARITHMETIC_OPS as readonly string[]).includes(op)) {
      const isComparison = (CATALOG_OPERATORS as readonly string[]).includes(op);
      return {
        path: `${path}.op`,
        message: isComparison
          ? `"${op}" is a comparison, which can't be used inside a value. ${VALUE_GRAMMAR}`
          : `Unknown operator "${op}" inside a value. ${VALUE_GRAMMAR}`,
      };
    }
    if (!Array.isArray(node.operands) || node.operands.length < 2) {
      return { path: `${path}.operands`, message: `"${op}" needs an "operands" list of at least two values.` };
    }
    for (let i = 0; i < node.operands.length; i++) {
      const bad = describeBadValue(node.operands[i], `${path}.operands.${i}`);
      if (bad) return bad;
    }
    return null;
  }
  return { path, message: `This object isn't a recognised value (keys: ${Object.keys(node).join(", ") || "none"}). ${VALUE_GRAMMAR}` };
}

function explainSchemaIssue(issue: { path: PropertyKey[]; message: string; code?: string }, raw: unknown): ValidationIssue {
  const plain: ValidationIssue = { path: issue.path.join("."), message: issue.message };
  if (issue.code !== "invalid_union") return plain;
  let at: unknown = raw;
  for (const key of issue.path) {
    at = (at as Record<PropertyKey, unknown> | undefined)?.[key];
    if (at === undefined) return plain;
  }
  const last = issue.path[issue.path.length - 1];
  const isValuePosition = last === "value" || last === "left" || last === "right" || (typeof last === "number" && issue.path[issue.path.length - 2] === "operands");
  if (isValuePosition) return describeBadValue(at, plain.path) ?? plain;
  // A comparison whose own condition failed: check its two sides.
  if (at && typeof at === "object" && ("left" in at || "right" in at)) {
    for (const side of ["left", "right"] as const) {
      const bad = describeBadValue((at as Record<string, unknown>)[side], `${plain.path}.${side}`);
      if (bad) return bad;
    }
  }
  return plain;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
  document?: PolicyDocument;
}

const MAX_RULES = 60;

// Fields that only mean something for a damage/fault claim. For every other reason the context
// reports faultKnown = false, so an UNSCOPED rule testing them would fire on every plain return.
const DAMAGE_ONLY_FIELDS = ["request.faultKnown", "request.notCustomerFault"];

// Does a condition depend on any of `names` — directly, OR through a named fact? A fact can be a plain
// rename of a field ("faultStated" = request.faultKnown) or arithmetic over several, and facts build on earlier
// ones, so a check that only looked for the field names written in the rule itself was walked round by one
// level of indirection.
type FactsByName = ReadonlyMap<string, FactDefinition>;

function conditionUsesFields(condition: Condition, names: string[], facts: FactsByName, seen: Set<string> = new Set()): boolean {
  if ("all" in condition) return condition.all.some((c) => conditionUsesFields(c, names, facts, seen));
  if ("any" in condition) return condition.any.some((c) => conditionUsesFields(c, names, facts, seen));
  if ("not" in condition) return conditionUsesFields(condition.not, names, facts, seen);
  return valueUsesFields(condition.left, names, facts, seen) || valueUsesFields(condition.right, names, facts, seen);
}

function valueUsesFields(ref: ValueRef, names: string[], facts: FactsByName, seen: Set<string>): boolean {
  if (typeof ref !== "object") return false;
  if ("field" in ref) return names.includes(ref.field);
  if ("fact" in ref) return factUsesFields(ref.fact, names, facts, seen);
  if ("operands" in ref) return ref.operands.some((operand) => valueUsesFields(operand, names, facts, seen));
  return false;
}

function factUsesFields(name: string, names: string[], facts: FactsByName, seen: Set<string>): boolean {
  if (seen.has(name)) return false; // already examined (or a cycle — facts may only use EARLIER ones, which is validated separately)
  seen.add(name);
  const fact = facts.get(name);
  if (!fact) return false;
  return (fact.value !== undefined && valueUsesFields(fact.value, names, facts, seen)) || (fact.filter !== undefined && conditionUsesFields(fact.filter, names, facts, seen));
}

export function validatePolicyDocument(raw: unknown): ValidationResult {
  const parsed = policyDocumentSchema.safeParse(raw);
  if (!parsed.success) {
    return { valid: false, issues: parsed.error.issues.map((issue) => explainSchemaIssue(issue, raw)) };
  }
  const doc = parsed.data;
  const issues: ValidationIssue[] = [];
  const settingNames = new Set(Object.keys(doc.settings));

  if (doc.facts.length > MAX_FACTS) {
    issues.push({ path: "facts", message: `Too many facts declared (${doc.facts.length}, max ${MAX_FACTS}).` });
  }
  // Facts: duplicate names, reserved-name shadowing, and dependency order — exactly as in the legacy validator.
  const seenFactNames = new Set<string>();
  const knownFactNamesSoFar = new Set<string>();
  for (const fact of doc.facts) {
    if (seenFactNames.has(fact.name)) issues.push({ path: `facts.${fact.name}`, message: `Duplicate fact name: "${fact.name}".` });
    seenFactNames.add(fact.name);
    if (findField(fact.name)) issues.push({ path: `facts.${fact.name}`, message: `"${fact.name}" shadows an existing catalog field name — choose a distinct fact name.` });
    walkFactValueRefs(fact, knownFactNamesSoFar, settingNames, issues);
    knownFactNamesSoFar.add(fact.name);
  }

  const factsByName: FactsByName = new Map(doc.facts.map((fact) => [fact.name, fact]));

  if (doc.rules.length > MAX_RULES) {
    issues.push({ path: "rules", message: `Too many rules (${doc.rules.length}, max ${MAX_RULES}).` });
  }

  // Rule ids and policy numbers are unique across the WHOLE document (one list now, not one per section).
  const seenIds = new Set<string>();
  const seenNumbers = new Map<string, string>();
  const noteNumber = (number: string | undefined, path: string) => {
    if (!number) return;
    if (seenNumbers.has(number)) issues.push({ path, message: `Policy number ${number} is already used (${seenNumbers.get(number)}) — each rule needs its own number.` });
    else seenNumbers.set(number, path);
  };

  for (const [index, rule] of doc.rules.entries()) {
    const path = `rules[${index}]`;
    if (seenIds.has(rule.id)) issues.push({ path, message: `Duplicate rule id: "${rule.id}".` });
    seenIds.add(rule.id);
    noteNumber(rule.number, `${path}.number`);

    if (rule.when) walkCondition(rule.when, "top", knownFactNamesSoFar, settingNames, `${path}.when`, issues);

    if (rule.appliesTo && new Set(rule.appliesTo).size !== rule.appliesTo.length) {
      issues.push({ path: `${path}.appliesTo`, message: `"${rule.id}" lists the same reason more than once.` });
    }

    // A rule testing a damage-only field must be scoped to damage claims, or it leaks into every other reason.
    if (rule.when && conditionUsesFields(rule.when, DAMAGE_ONLY_FIELDS, factsByName)) {
      const scoped = rule.appliesTo !== undefined && rule.appliesTo.every((reason) => reason === "damaged_or_defective");
      if (!scoped) {
        issues.push({
          path: `${path}.appliesTo`,
          message: `"${rule.id}" tests ${DAMAGE_ONLY_FIELDS.join(" / ")}, which only mean something for a damage claim (this rule reaches them directly or through a calculated fact) — add "appliesTo": ["damaged_or_defective"], or it would also apply to returns and disputes (where fault is always "unknown").`,
        });
      }
    }

    if (rule.kind === "decision" && rule.outcome.decision === "autonomous_deny") {
      if (!rule.outcome.customerReason) {
        issues.push({ path: `${path}.outcome.customerReason`, message: `An autonomous_deny outcome must carry a customer-safe reason — a customer needs an honest answer, not silence.` });
      }
      // The workflow has no automatic-denial path for a plain return (it would escalate), so the document may not claim one.
      if (rule.appliesTo.includes("not_wanted")) {
        issues.push({ path: `${path}.appliesTo`, message: `A plain return ("not_wanted") can't be denied automatically — "${rule.id}" may not apply to it. Use a restriction (escalate) instead.` });
      }
    }
  }
  noteNumber(doc.fallback.number, "fallback.number");

  return { valid: issues.length === 0, issues, document: issues.length === 0 ? doc : undefined };
}
