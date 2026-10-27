// A small, file-backed policy repository: a versioned file store under the agent data
// directory — immutable policy versions, with the live one always at a single fixed path,
// replaced atomically on activation. Suits a single-process prototype. There are no saved
// drafts: a valid document is activated immediately, an invalid one changes nothing.
//
// NAMESPACED (a directory per namespace under apps/agent/data/policy/), which is what
// makes an "isolated test instance" for activation/runtime verification possible
// without a second server process: the demo Escalation Desk always reads/writes the
// "demo" namespace; anything verifying a Policy-Helper-generated draft end to end uses
// a distinct namespace (e.g. "test-<name>") whose own live document the demo UI never
// reads and never touches. "demo"'s active version DECIDES every live case
// (live-policy.ts) — so activating "demo" changes real customer-facing behavior, and
// every other namespace is the safe place to try a draft first.
//
// FILE-NAMING: the live/active document for a namespace is ALWAYS at the one fixed path
// "policy.json" — never a numbered file behind a separate pointer file. Superseded
// versions are archived alongside it as "policy_v<N>.json". The point isn't just
// simplicity: the live reader (live-policy.ts, via getActiveVersion) only ever needs to
// know ONE filename to find the real, current policy — it has no concept of "versions,"
// no pointer to resolve, and so nothing to trick it into reading an old version.
import { copyFile, mkdir, readFile, writeFile, readdir, rename, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PolicyDocument } from "./schema";
import { validatePolicyDocument, type ValidationResult } from "./validate";
import { createKeyedLock } from "../keyed-lock";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Where the policy namespaces live. WISMO_POLICY_DIR is for tests only (unset in normal use): it lets a test run the
// real workflow against its own policy in a temp folder, without touching the real "demo" policy or its version history.
const POLICY_DATA_ROOT = process.env.WISMO_POLICY_DIR ? resolve(process.env.WISMO_POLICY_DIR) : join(__dirname, "../../../data/policy");

const ACTIVE_FILENAME = "policy.json";
const ARCHIVE_PREFIX = "policy_v";

function namespaceDir(namespace: string): string {
  // Guard against a namespace string that could escape POLICY_DATA_ROOT (e.g. "../..")
  // — this is operator-facing data (a demo/test label), not customer input, but cheap
  // to be strict about regardless.
  if (!/^[a-zA-Z0-9_-]+$/.test(namespace)) throw new Error(`Invalid policy namespace: "${namespace}"`);
  return join(POLICY_DATA_ROOT, namespace);
}

function activePath(namespace: string): string {
  return join(namespaceDir(namespace), ACTIVE_FILENAME);
}

function archivePath(namespace: string, version: number): string {
  return join(namespaceDir(namespace), `${ARCHIVE_PREFIX}${version}.json`);
}

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

async function readJson<T>(path: string): Promise<T | null> {
  if (!existsSync(path)) return null;
  const raw = await readFile(path, "utf-8");
  return JSON.parse(raw) as T;
}

export interface VersionSummary {
  version: number;
  createdAt: string;
  description?: string;
}

// The full version history for a namespace is the union of whatever's currently live
// (policy.json, if anything's been activated yet) plus every archived policy_v<N>.json
// — there's no separate "versions/" directory any more, so both places have to be
// read to answer "what versions exist."
export async function listVersions(namespace: string): Promise<VersionSummary[]> {
  const dir = namespaceDir(namespace);
  if (!existsSync(dir)) return [];

  const summaries: VersionSummary[] = [];

  const active = await readJson<PolicyDocument>(activePath(namespace));
  if (active) summaries.push({ version: active.metadata.version, createdAt: active.metadata.createdAt, description: active.metadata.description });

  const files = await readdir(dir);
  for (const file of files) {
    if (!file.startsWith(ARCHIVE_PREFIX) || !file.endsWith(".json")) continue;
    const doc = await readJson<PolicyDocument>(join(dir, file));
    if (doc) summaries.push({ version: doc.metadata.version, createdAt: doc.metadata.createdAt, description: doc.metadata.description });
  }

  return summaries.sort((a, b) => b.version - a.version);
}

// null = nothing activated yet for this namespace (a legitimate initial state). The
// live document is always at the one fixed path — no pointer to resolve, so there's
// no "pointer exists but target missing" corruption mode any more for this specific
// read (a genuinely corrupt/truncated policy.json still throws from JSON.parse itself,
// which is the correct, loud failure for that case).
export async function getActiveVersion(namespace: string): Promise<PolicyDocument | null> {
  return readJson<PolicyDocument>(activePath(namespace));
}

// The namespace the Escalation Desk's Policies page edits: the only one that decides live cases. Every
// other namespace stays a sandbox. Defined here (not in live-policy.ts) so that response-leak-guard.ts
// can read the live policy without importing live-policy.ts, which would close an import cycle
// (live-policy -> context -> refund-ledger -> the Mastra instance -> the agent -> the guard).
export const LIVE_POLICY_NAMESPACE = "demo";

// Every reasonCode a policy document can produce: each rule's and the fallback's. Pure.
export function reasonCodesOf(document: PolicyDocument): string[] {
  const codes = [...document.rules.map((rule) => rule.outcome.reasonCode), document.fallback.reasonCode];
  return [...new Set(codes.filter((code): code is string => typeof code === "string" && code.length > 0))];
}

// The reason codes of the policy that is live right now, read fresh each call so a rule added or edited
// on the Policies page (or accepted from the Policy Helper) is covered the moment it is saved. Used by
// response-leak-guard.ts, which keeps internal codes out of customer replies. NEVER throws: an unreadable
// policy yields no extra codes (the guard's own fixed list still applies) rather than blocking a reply.
//
// "Fresh" without re-reading the file on every reply: the codes are kept per policy file and reused while the file is
// the same one. Activation writes a new file and renames it over policy.json, so a save changes the file's inode, size
// and modified time together; a stat() (no read, no parse) is all a reply pays.
const reasonCodesByFile = new Map<string, { identity: string; codes: string[] }>();

export async function liveReasonCodes(namespace: string = LIVE_POLICY_NAMESPACE): Promise<string[]> {
  try {
    const path = activePath(namespace);
    let identity: string;
    try {
      const info = await stat(path);
      identity = `${info.ino}:${info.size}:${info.mtimeMs}`;
    } catch {
      reasonCodesByFile.delete(path); // nothing active
      return [];
    }
    const cached = reasonCodesByFile.get(path);
    if (cached && cached.identity === identity) return cached.codes;
    const document = await getActiveVersion(namespace);
    const codes = document ? reasonCodesOf(document) : [];
    reasonCodesByFile.set(path, { identity, codes });
    return codes;
  } catch (error) {
    console.error(`[policy] couldn't read the reason codes of namespace "${namespace}":`, error);
    return [];
  }
}

// No saved drafts: a document is
// either validated and activated, or not stored at all.

export type ActivationResult = { ok: true; version: number } | { ok: false; issues: ValidationResult["issues"] };

// Per-namespace in-memory lock (createKeyedLock, the same shared primitive as payment.ts's orderLocks
// and server.ts's disagreementLocks): serializes concurrent activation attempts for the SAME
// namespace. Without it, two concurrent activations could both read the same `current` active
// version, both pass the baseVersion staleness check against it, then race on the archive/promote
// steps below and archive or overwrite each other's versions under the same version number. Scoped
// per namespace, not global, since two different namespaces' activations are genuinely independent
// (matches this app's "namespaced, fully isolated" design documented at the top of this file).
const namespaceLocks = createKeyedLock();

// Gives every rule/fallback without a policy number the next number above the highest in use,
// in this document or the currently live one, so a number freed by deleting the highest rule isn't
// handed straight back out. Existing numbers never change, and a removed rule just leaves a gap
// (simple numbering, no renumbering).
function fillPolicyNumbers(candidate: PolicyDocument, current: PolicyDocument | null): PolicyDocument {
  const numberOf = (n?: string) => (n ? Number(n.slice(1)) || 0 : 0);
  const used = [candidate, current].flatMap((doc) => (doc ? [...doc.rules.map((r) => numberOf(r.number)), numberOf(doc.fallback.number)] : []));
  let next = Math.max(0, ...used) + 1;
  return {
    ...candidate,
    rules: candidate.rules.map((rule) => (rule.number ? rule : ({ ...rule, number: `P${next++}` } as typeof rule))),
    fallback: candidate.fallback.number ? candidate.fallback : { ...candidate.fallback, number: `P${next++}` },
  };
}

// Validates the exact candidate against the current catalog (validate.ts) and rejects a stale
// base-version update (the candidate's metadata.baseVersion, when present, must match the CURRENT
// active version, otherwise someone activated a newer one in between).
//
// Activation: write the candidate to a per-attempt-unique temp file FIRST (before touching the
// active file), THEN copy what is at policy.json to policy_v<N>.json, THEN rename the temp file
// over policy.json. The rename is an atomic replace, so policy.json always exists and is never
// half-written. The unique temp name (randomUUID, not a shared ".tmp") protects against a
// concurrent activation of the SAME namespace clobbering another's temp file, on top of the
// namespaceLocks serialization above. An invalid candidate never reaches any of these steps.
export async function activatePolicy(namespace: string, candidate: PolicyDocument): Promise<ActivationResult> {
  const validation = validatePolicyDocument(candidate);
  if (!validation.valid) return { ok: false, issues: validation.issues };

  return namespaceLocks.withLock(namespace, () => activatePolicyLocked(namespace, validation.document!));
}

async function activatePolicyLocked(namespace: string, candidate: PolicyDocument): Promise<ActivationResult> {
  const dir = namespaceDir(namespace);
  await ensureDir(dir);

  const current = await getActiveVersion(namespace);
  if (current && candidate.metadata.baseVersion !== undefined && candidate.metadata.baseVersion !== current.metadata.version) {
    return {
      ok: false,
      issues: [
        {
          path: "metadata.baseVersion",
          message: `This draft was based on version ${candidate.metadata.baseVersion}, but version ${current.metadata.version} is now active — re-base the draft before activating.`,
        },
      ],
    };
  }

  const nextVersion = (current?.metadata.version ?? 0) + 1;
  const numbered = fillPolicyNumbers(candidate, current);
  const finalDoc: PolicyDocument = { ...numbered, metadata: { ...numbered.metadata, version: nextVersion, createdAt: new Date().toISOString() } };

  const tmpPath = `${activePath(namespace)}.${randomUUID()}.tmp`;
  await writeFile(tmpPath, JSON.stringify(finalDoc, null, 2), "utf-8");

  // Archive a COPY of the current live file first, then atomically replace policy.json with the new
  // one (rename over an existing file is atomic on POSIX). Renaming policy.json INTO the archive first
  // and then the new file in would leave a moment with no policy.json at all, where a live case would
  // find no policy (and escalate), or a crash in between would leave it missing. Now it always exists.
  if (current) {
    await copyFile(activePath(namespace), archivePath(namespace, current.metadata.version));
  }
  await rename(tmpPath, activePath(namespace)); // atomic replace — never missing, never half-written

  return { ok: true, version: nextVersion };
}

// Revert is activation of a previously saved version through the exact same validated, atomic
// path, never a special case. It KEEPS HISTORY: the old content becomes a NEW live version (N+1),
// the version being replaced (N) is archived like any activation, and the version reverted to (K)
// stays in its own archive, so nothing is deleted and a revert can itself be reverted. A true
// rewind that deleted K+1..N was rejected: cases record the version and P-number of the rule that
// decided them, so a later save could reuse "version 7" or "P14" for different content. The
// archive of `version` is what is read; if that version is the one currently live there is no
// archive under its number yet, which correctly reports "no version N saved" instead of
// reactivating what is already active. The new version's description says it is a revert, so
// history can tell the two apart.
export async function rollbackTo(namespace: string, version: number): Promise<ActivationResult> {
  const doc = await readJson<PolicyDocument>(archivePath(namespace, version));
  if (!doc) return { ok: false, issues: [{ path: "version", message: `No version ${version} saved for namespace "${namespace}".` }] };
  if ((doc as { schemaVersion?: number }).schemaVersion !== 2) {
    return { ok: false, issues: [{ path: "schemaVersion", message: `Version ${version} is in an older policy format (no "schemaVersion": 2) and can't be reverted to — the policy structure has changed since it was saved.` }] };
  }
  const current = await getActiveVersion(namespace);
  const was = current ? ` (was version ${current.metadata.version})` : "";
  // Reverting is always allowed regardless of the current active version — it's a
  // deliberate operator action, not a stale concurrent edit — so baseVersion is
  // omitted here rather than carried from the old document's own recorded base.
  return activatePolicy(namespace, { ...doc, metadata: { ...doc.metadata, baseVersion: undefined, description: `Reverted to version ${version}${was}.` } });
}

// Seeds a namespace with an initial active version ONLY if it has no active version
// yet — never overwrites an existing one. Used to bootstrap "demo" (and any fresh test
// namespace) with the migrated base draft so the Policy Helper always has real policy
// content to edit, per "preserves existing rules."
export async function ensureSeeded(namespace: string, seedDocument: PolicyDocument): Promise<void> {
  const existing = await getActiveVersion(namespace).catch(() => null);
  if (existing) return;
  const result = await activatePolicy(namespace, seedDocument);
  if (!result.ok) {
    throw new Error(`Failed to seed policy namespace "${namespace}": ${JSON.stringify(result.issues)}`);
  }
}


