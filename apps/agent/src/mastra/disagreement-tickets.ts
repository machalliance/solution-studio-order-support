import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createKeyedLock } from "./keyed-lock";

// Durable record of a support ticket opened via the customer-initiated disagreement flow
// (offer_escalation_to_support / POST /chat/:agentId/escalate-disagreement, server.ts). The ORIGINAL
// case a disagreement is about is already terminal when this fires (Mastra can't resume a completed
// run), so nothing about the disagreement can be written onto that run. Without a separate durable
// store, a later status lookup (check_escalation_status, lookup_case_by_id) would see only the case's
// frozen, pre-disagreement outcome and recite it back, then ask the customer for a case ID for an
// escalation it had no way to know existed. Keyed by the ORIGINAL case's runId (not the ticketId),
// which is what a lookup already has in hand; there is at most one disagreement ticket per case
// (the route's idempotency check guarantees that).
//
// A plain JSON file under data/, the same on-disk pattern as policy/repository.ts and the damage-photo
// cache, deliberately NOT the in-memory treatment of case-events.ts / active-sessions.ts /
// runtime-settings.ts (genuinely ephemeral per-process state): this is closer to case history a
// customer would expect to survive a restart. Cleared on /demo/reset (demo-seed.ts's
// resetDemoData()), since a record about a case whose workflow run was just deleted means nothing.
export interface DisagreementTicketRecord {
  ticketId: string;
  orderId: string;
  customerId: string;
  createdAt: string;
}

// The stored record plus the map key it lives under — every accessor below returns this
// shape (not the bare record) so a caller never needs to separately track which case a
// given entry came from. `caseId` IS the original case's own runId (case-id.ts's short
// code), same "the ID is the runId, not a separate lookup key" convention this app
// already uses everywhere else.
export interface DisagreementTicketEntry extends DisagreementTicketRecord {
  caseId: string;
}

// WISMO_TICKETS_FILE is for tests only (unset in normal use): a test that creates disagreement tickets points it at a temp
// file so it can never write into the real demo data.
const FILE_PATH = process.env.WISMO_TICKETS_FILE ? resolve(process.env.WISMO_TICKETS_FILE) : join(process.cwd(), "data", "disagreement-tickets.json");

// One shared lock, not per-key — every write is a read-modify-write of the SAME whole file
// (there's no per-record file to lock separately), so two DIFFERENT disagreement tickets
// created at nearly the same moment would otherwise race on that read-modify-write and one
// could silently clobber the other. Low-volume in practice (a customer disagreement is a
// rare event), but cheap, real insurance — the identical class of gap this session already
// found and fixed for payment.ts's per-order lock and policy/repository.ts's per-namespace
// lock (both via the same createKeyedLock primitive this reuses).
const fileLock = createKeyedLock();
const LOCK_KEY = "disagreement-tickets.json";

async function readAll(): Promise<Record<string, DisagreementTicketRecord>> {
  try {
    return JSON.parse(await readFile(FILE_PATH, "utf-8"));
  } catch {
    // Missing file (first run, or just cleared by a demo reset) and malformed JSON are
    // both treated as "nothing recorded yet" — the same fail-open-to-empty behavior
    // policy/repository.ts's own readers use for a namespace with nothing active yet.
    return {};
  }
}

async function writeAll(data: Record<string, DisagreementTicketRecord>): Promise<void> {
  await mkdir(dirname(FILE_PATH), { recursive: true });
  // Write-temp-then-rename — same atomicity discipline as policy/repository.ts's own
  // activatePolicy: a crash or concurrent read mid-write can never observe a half-written
  // file, and the unique filename (randomUUID, not a shared static ".tmp") means two
  // overlapping writers (already serialized by fileLock above, but real independent
  // insurance regardless) can't clobber each other's own in-flight temp file either.
  const tmpPath = `${FILE_PATH}.${randomUUID()}.tmp`;
  await writeFile(tmpPath, JSON.stringify(data, null, 2), "utf-8");
  await rename(tmpPath, FILE_PATH);
}

export async function getDisagreementTicket(caseId: string): Promise<DisagreementTicketEntry | undefined> {
  const all = await readAll();
  const record = all[caseId];
  return record ? { caseId, ...record } : undefined;
}

// Real-implementation-shaped query surface, even though today's "database" is a flat
// JSON object — a rep-facing view or a future real ticketing-system adapter would want
// "every open disagreement for this order" and "every one for this customer" as
// first-class lookups, not just "does this ONE case I already know about have one."
// Fine to do a full scan-and-filter at this app's scale (see keyed-lock.ts's own note on
// this class of tradeoff being the right amount of machinery for a single-process demo).
export async function getDisagreementTicketsForOrder(orderId: string): Promise<DisagreementTicketEntry[]> {
  const all = await readAll();
  return Object.entries(all)
    .filter(([, record]) => record.orderId === orderId)
    .map(([caseId, record]) => ({ caseId, ...record }));
}

async function getDisagreementTicketsForCustomer(customerId: string): Promise<DisagreementTicketEntry[]> {
  const all = await readAll();
  return Object.entries(all)
    .filter(([, record]) => record.customerId === customerId)
    .map(([caseId, record]) => ({ caseId, ...record }));
}

export async function recordDisagreementTicket(caseId: string, record: DisagreementTicketRecord): Promise<void> {
  await fileLock.withLock(LOCK_KEY, async () => {
    const all = await readAll();
    all[caseId] = record;
    await writeAll(all);
  });
}

// Called by demo-seed.ts's resetDemoData() — every workflow run is about to be deleted, so
// any disagreement-ticket record keyed by a runId that's about to stop existing is dead
// weight, not history worth keeping across a reset the same way a real ticketing system's
// own records would survive a demo being replayed.
export async function clearDisagreementTickets(): Promise<void> {
  await fileLock.withLock(LOCK_KEY, async () => {
    await writeAll({});
  });
}
