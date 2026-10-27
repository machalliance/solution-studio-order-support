// Mastra's own runId defaults to a random UUID — accurate, but nothing a customer can
// read off a screen or a rep can read back over a call. createRun({ runId }) accepts any
// string (see @mastra/core's Workflow.createRun — "Optional custom run ID, defaults to a
// random UUID"), so the short code generated here IS the runId end to end: no separate
// mapping table, every existing lookup (getWorkflowRunById, /escalations/:runId, resume)
// just works unchanged.
//
// Crockford's Base32 alphabet — excludes I, L, O, U so a case number read aloud or typed
// back never gets confused between a letter and a digit (1/I/L, 0/O). 32^6 ≈ 1.07 billion
// codes, comfortably more than this app will ever need while staying short enough to
// actually read and retype.
// Exported so response-leak-guard.ts builds its "does this look like a real case ID" pattern
// from the actual alphabet and length rather than a second hand-typed copy.
export const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const LENGTH = 6;
const MAX_ATTEMPTS = 5;

function randomCandidate(): string {
  let id = "";
  for (let i = 0; i < LENGTH; i++) {
    id += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return id;
}

// Collisions are astronomically unlikely at this app's scale, but checking against real
// stored runs (rather than assuming) is cheap and makes the uniqueness guarantee real.
export async function generateCaseId(workflow: { getWorkflowRunById(runId: string): Promise<unknown> }): Promise<string> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const candidate = randomCandidate();
    const existing = await workflow.getWorkflowRunById(candidate);
    if (!existing) return candidate;
  }
  throw new Error("Could not generate a unique case ID after several attempts.");
}
