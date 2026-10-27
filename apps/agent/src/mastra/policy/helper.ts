import { parsePolicyJson } from "../../../../../shared/parse-policy-json";
// Calling logic for the Policy Helper agent — kept separate from the agent definition
// (agents/policy-helper.ts), same "calling logic lives apart from the agent
// definition" split this app uses elsewhere: this is where the one rule that matters
// most is visible in one place — nothing this returns is ever activated
// automatically. The caller (server.ts's authoring route) always runs this, shows the
// operator the resulting document + validation + diff, and activation is a distinct,
// later, human action.

import { mastra } from "../index";
import { policyHelperOutputSchema } from "../agents/policy-helper";
import { validatePolicyDocument, type ValidationResult } from "./validate";
import { describeCatalog } from "./catalog";
import { buildPolicySynopsis, type PolicySynopsis } from "./synopsis";
import type { PolicyDocument } from "./schema";

export interface PolicyHelperResult {
  understood: boolean;
  explanation: string;
  proposedDocument?: PolicyDocument;
  validation?: ValidationResult;
  // Only present once the proposal actually validates — buildPolicySynopsis assumes a
  // well-formed document, and an invalid one has nothing meaningful to summarize
  // anyway (the operator sees the validation issues instead).
  proposedSynopsis?: PolicySynopsis;
}

function buildPrompt(request: string, currentDocument: PolicyDocument): string {
  return [
    "Capability catalog (the ONLY fields/collections/operators/decisions you may use):",
    JSON.stringify(describeCatalog(), null, 2),
    "",
    "Current policy document:",
    JSON.stringify(currentDocument, null, 2),
    "",
    // Read-this-first notes, placed right beside the request on purpose: the same points are in the agent's
    // long instructions, but notes beside the request are what the model reliably acts on.
    "How to read the operator's words:",
    "- \"refund\", \"return\" and \"money back\" are one thing. A rule described in those terms without naming a kind (damaged, doesn't want it, never arrived) is ONE rule with no appliesTo — not a copy per reason. Add appliesTo only when the operator names the kind.",
    "- A new limit is a NEW rule, added to the list. Do not edit an existing rule to make it, unless the operator names that rule or asks to change what it does — and leave every existing rule exactly as it is.",
    "- Say only what the operator said. Do not carry conditions over from a similar existing rule that the operator did not mention: \"damage claims delivered more than 14 days ago\" means EVERY damage claim, whoever is at fault — so no fault conditions — and a rule that tests fault would miss some of them.",
    "- \"cannot\", \"must not\", \"no more than\", \"only once\": write a RESTRICTION (a person reviews it) unless the operator explicitly says to refuse automatically. Anything automatic must be an explicit decision rule with appliesTo; the fallback is always a person.",
    "",
    "Operator's request:",
    request,
  ].join("\n");
}

export async function runPolicyHelper(request: string, currentDocument: PolicyDocument): Promise<PolicyHelperResult> {
  const agent = mastra.getAgent("policyHelper");
  const result = await agent.generate(buildPrompt(request, currentDocument), {
    structuredOutput: { schema: policyHelperOutputSchema },
  });

  const parsed = policyHelperOutputSchema.safeParse(result.object);
  if (!parsed.success) {
    return { understood: false, explanation: "The Policy Helper's answer didn't match the expected shape — try rephrasing the request." };
  }

  if (!parsed.data.understood || !parsed.data.proposedDocumentJson) {
    return { understood: false, explanation: parsed.data.explanation };
  }

  // proposedDocumentJson is a raw string (see agents/policy-helper.ts's own comment on
  // why — Claude's structured-output feature rejects the real, recursive document
  // schema outright). Parsed and validated here against the FULL policyDocumentSchema
  // — the same deterministic gate every other path (repository.ts's activation,
  // server.ts's /validate route) already goes through. A model that returned
  // malformed JSON, or JSON that doesn't match the schema, surfaces as an ordinary
  // validation failure here, not a crash.
  let rawDocument: unknown;
  try {
    rawDocument = parsePolicyJson(parsed.data.proposedDocumentJson);
  } catch (err) {
    return {
      understood: true,
      explanation: parsed.data.explanation,
      validation: { valid: false, issues: [{ path: "proposedDocumentJson", message: `Not valid JSON: ${err instanceof Error ? err.message : String(err)}` }] },
    };
  }

  // Metadata stays under deterministic control, never trusted from the model's own
  // output — same "the customer agent never submits a policy version" discipline,
  // applied here to an admin-side agent instead: baseVersion is set here from the
  // REAL current document (not whatever the model echoed back), and version/createdAt
  // are finalized only at actual activation time (repository.ts), not here.
  const withControlledMetadata = {
    ...(rawDocument as Record<string, unknown>),
    // Deterministic, like the metadata: the language version is never the model's to choose.
    schemaVersion: 2,
    metadata: {
      ...((rawDocument as { metadata?: Record<string, unknown> }).metadata ?? {}),
      baseVersion: currentDocument.metadata.version,
    },
  };

  const validation = validatePolicyDocument(withControlledMetadata);
  return {
    understood: true,
    explanation: parsed.data.explanation,
    // Surfaced even when invalid — an operator reviewing a failed validation needs to
    // see what was actually proposed, not just an abstract issue list, to judge
    // whether to ask the Helper to fix it or fix it by hand. `validation.valid` is
    // what actually gates activation (repository.ts re-validates regardless, so this
    // is never trusted as the real safety check on its own).
    proposedDocument: (validation.document ?? withControlledMetadata) as PolicyDocument,
    validation,
    proposedSynopsis: validation.document ? buildPolicySynopsis(validation.document) : undefined,
  };
}
