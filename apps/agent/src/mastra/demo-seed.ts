// Shared by the CLI seed script (src/seed.ts, `npm run agent:seed`) and the storefront's
// Settings-page "Reset demo data" button (server.ts's POST /demo/reset) — one scenario
// list, one seeding routine, so the two entry points can never drift out of sync with
// each other.

import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Mastra } from "@mastra/core/mastra";
import { editProductPhotoForDamage } from "../lib/image-edit";
import { generateCaseId } from "./case-id";
import { clearDisagreementTickets } from "./disagreement-tickets";
import { clearAllThreads } from "./conversation-threads";

const __dirname = dirname(fileURLToPath(import.meta.url));
// The real generated catalog photos live in the storefront's own public dir (see
// demo-data.ts's header comment) — reused here as the starting point for a synthesized
// "customer's damage photo" rather than inventing an unrelated image from scratch.
const PRODUCT_PHOTOS_DIR = join(__dirname, "..", "..", "..", "storefront", "public", "products");
// A successful damage-photo generation is cached here, keyed by objectID — the image
// itself otherwise only ever lives embedded inside one specific workflow run's data
// (see attachDamagePhotos below), and every reset deletes every run before reseeding.
// Without a cache, a photo that generation succeeded on gets destroyed by the very next
// reset regardless — confirmed live: several photos generated earlier in this session
// were gone after later resets, since nothing had ever written them anywhere durable.
const DAMAGE_PHOTO_CACHE_DIR = join(__dirname, "..", "..", "data", "damage-photos");

interface TranscriptMessage {
  role: "customer" | "agent";
  text: string;
  timestamp?: string;
  imageDataUrl?: string;
}

// These scenarios are hand-authored, not a real conversation (see the Scenario comments
// below) — there's nothing real to derive a send time from. Staggered rather than
// identical so the Escalation Desk's per-message timestamps read as a real back-and-forth
// rather than everything landing in the same instant: 90 seconds apart, ending a couple
// of minutes ago so each case reads as something that just happened.
function stampSyntheticTimestamps(transcript: TranscriptMessage[]): TranscriptMessage[] {
  const INTERVAL_MS = 90_000;
  const END_OFFSET_MS = 120_000;
  const now = Date.now();
  return transcript.map((message, index) => ({
    ...message,
    timestamp: new Date(now - END_OFFSET_MS - (transcript.length - 1 - index) * INTERVAL_MS).toISOString(),
  }));
}

interface Scenario {
  orderId: string;
  // "refund" (default) runs the damage/fault policy; "delivery_dispute" always escalates
  // regardless of amount or fault — see the delivery dispute policy.
  caseType?: "refund" | "delivery_dispute";
  refundAmount: number;
  notCustomerFault: boolean;
  problemSummary: string;
  transcript: TranscriptMessage[];
  // Set only for "arrived damaged, not the customer's fault" scenarios — a real
  // fault claim is exactly the case where a rep would already have asked for photo
  // evidence before this ever reached the queue (see the refund policy:
  // fault attribution always requires photo review). photoMessageIndex is the
  // transcript entry that becomes the customer's photo reply.
  damagePhoto?: { objectID: string; description: string; photoMessageIndex: number };
}

const scenarios: Scenario[] = [
  {
    // Maya Chen — damaged, not her fault, but delivered 34 days ago: outside the
    // return window, so escalate regardless of amount.
    orderId: "order_7731",
    refundAmount: 145.0,
    notCustomerFault: true,
    problemSummary: "Customer received a Packable Rain Shell with a torn seam and is requesting a full refund.",
    transcript: [
      { role: "customer", text: "Hi, my rain shell arrived with a tear in the underarm seam. I'd like a full refund." },
      { role: "agent", text: "I'm sorry to hear that. Could you send a photo of the damage so I can take a look?" },
      { role: "customer", text: "Sure, here you go." },
      { role: "agent", text: "Thanks — I can see the tear. This falls outside our standard return window, so I need to check with a manager on this one." },
    ],
    damagePhoto: {
      objectID: "jacket-001",
      description: "a torn seam along the underarm with fraying fabric at the tear",
      photoMessageIndex: 2,
    },
  },
  {
    // Owen Alvarez — a higher-dollar damage claim ($245). Escalates for photo review
    // the same way any damage claim does regardless of amount (the refund policy no
    // longer branches on the autonomous ceiling here — that ceiling gates the agent's
    // own autonomy, not what a rep should weigh) — the dollar figure still matters
    // for queue priority (the Settings page's highPriorityAmountThreshold), just not for this wording.
    orderId: "order_5561",
    refundAmount: 245.0,
    notCustomerFault: true,
    problemSummary: "Customer received a Full-Grain Leather Weekender Duffel with a broken zipper and wants a full refund.",
    transcript: [
      { role: "customer", text: "The duffel showed up with a broken zipper pull and a scuff on the front panel." },
      { role: "agent", text: "That's not okay — could you send a photo so I can see the extent of it?" },
      { role: "customer", text: "Here's a picture." },
      { role: "agent", text: "Thanks, I can see the zipper damage. This refund is above what I can approve on my own, so I'm getting a manager to sign off." },
    ],
    damagePhoto: {
      objectID: "accessories-001",
      description: "a broken zipper pull hanging loose and a visible scuff mark on the front leather panel",
      photoMessageIndex: 2,
    },
  },
  {
    // Priya Nair — VIP account, damage attributed to the customer (self-inflicted after
    // delivery, not an "arrived broken" claim): policy requires escalation regardless
    // of amount, purely because of VIP status. No photo request — this isn't a fault
    // claim that hinges on evidence.
    orderId: "order_9011",
    refundAmount: 48.0,
    notCustomerFault: false,
    problemSummary: "Customer damaged a Wool Trail Neck Gaiter after delivery and is requesting a refund anyway.",
    transcript: [
      { role: "customer", text: "I accidentally caught the neck gaiter on a zipper and it's torn. Can I still get a refund?" },
      { role: "agent", text: "I understand — let me take a look at your account and the order." },
      { role: "agent", text: "I want to make sure this gets the right level of review, so I'm checking with a manager." },
    ],
  },
  {
    // Sam Whitfield — the case that changed: within the return window, under the
    // dollar ceiling, and not the customer's fault. Before the fault-attribution fix,
    // this would have executed autonomously on the agent's own read of the
    // conversation. Now it always escalates, because confirming fault requires a
    // human to look at the photo — that IS the escalation, not a gap around it.
    // Deliberately NOT cust_demo_01 (the live-demo identity) — see demo-data.ts.
    orderId: "order_6651",
    refundAmount: 75.0,
    notCustomerFault: true,
    problemSummary: "Customer received a Trail Runner Canvas Sneaker with a split sole and wants a full refund.",
    transcript: [
      { role: "customer", text: "The sole on one of the sneakers is already coming apart, right out of the box." },
      { role: "agent", text: "That does sound like a manufacturing defect — could you send a photo of the sole?" },
      { role: "customer", text: "Attached." },
      { role: "agent", text: "Thanks, that does look like a defect. I'm going to check with a manager to confirm before issuing the refund." },
    ],
    damagePhoto: {
      objectID: "shoes-001",
      description: "the sole visibly separating and peeling away from the upper on one shoe",
      photoMessageIndex: 2,
    },
  },
  {
    // A couple of cases that belong to cust_demo_01 itself — the "logged in" identity
    // (name/email come from Settings, see demo-data.ts) — so a reset always leaves a
    // couple of cases waiting under "you," not just under fictional third parties.
    // order_4472 and order_4203 are deliberately left out of both, same reasoning
    // demo-data.ts already documents for leaving orders un-escalated: room to test
    // something fresh yourself (one single-item, one multi-item).
    orderId: "order_1181",
    refundAmount: 165.0,
    notCustomerFault: true,
    problemSummary: "Customer received a Canvas Chore Jacket with a broken zipper pull and wants a full refund.",
    transcript: [
      { role: "customer", text: "The chore jacket I ordered showed up with a busted zipper pull — it won't stay closed." },
      { role: "agent", text: "That's frustrating — could you send a photo of the zipper so I can take a look?" },
      { role: "customer", text: "Sure, here's a picture." },
      { role: "agent", text: "Thanks, I can see the damage. I'm going to check with a manager before issuing the refund." },
    ],
    damagePhoto: {
      objectID: "jacket-002",
      description: "a broken zipper pull hanging loose at the base of the zipper track",
      photoMessageIndex: 2,
    },
  },
  {
    // Same "delivered and signed for, customer says otherwise" shape as the
    // delivery-dispute path itself — see the delivery dispute policy. No damage photo:
    // this isn't a fault claim, so nothing hinges on photo evidence.
    orderId: "order_3401",
    caseType: "delivery_dispute",
    refundAmount: 70.0,
    notCustomerFault: true,
    problemSummary: "Customer says they never received order #3401 (Camp Slip-On Shoe). Carrier record shows it delivered and signed for in the customer's own name.",
    transcript: [
      { role: "customer", text: "I never got my order, 3401 — the shoes." },
      { role: "agent", text: "I checked the tracking and it shows delivered and signed for. Could someone else at your address have accepted it — a household member, neighbor, or building staff?" },
      { role: "customer", text: "No, nobody else would have. I never signed for anything and never received it." },
    ],
  },
];

async function attachDamagePhotos(scenario: Scenario): Promise<void> {
  if (!scenario.damagePhoto) return;
  const { objectID, description, photoMessageIndex } = scenario.damagePhoto;

  const cachePath = join(DAMAGE_PHOTO_CACHE_DIR, `${objectID}.png`);
  if (existsSync(cachePath)) {
    scenario.transcript[photoMessageIndex].imageDataUrl = `data:image/png;base64,${readFileSync(cachePath).toString("base64")}`;
    console.log(`  [${scenario.orderId}] reused cached damage photo for ${objectID}`);
    return;
  }

  if (!process.env.OPENAI_API_KEY) {
    console.warn(`  [${scenario.orderId}] OPENAI_API_KEY not set — seeding this case without a damage photo`);
    return;
  }

  try {
    const original = readFileSync(join(PRODUCT_PHOTOS_DIR, `${objectID}.jpg`));
    const base64 = await editProductPhotoForDamage(original, description);
    // gpt-image-1 returns PNG bytes regardless of the source photo's format — mislabeling
    // this as image/jpeg happened to still render (browsers sniff the real bytes), but was
    // wrong and worth getting right in stored data, not just in what happens to work.
    mkdirSync(DAMAGE_PHOTO_CACHE_DIR, { recursive: true });
    writeFileSync(cachePath, Buffer.from(base64, "base64"));
    scenario.transcript[photoMessageIndex].imageDataUrl = `data:image/png;base64,${base64}`;
    console.log(`  [${scenario.orderId}] generated and cached a damage photo for ${objectID}`);
  } catch (err) {
    console.warn(`  [${scenario.orderId}] damage photo generation failed, seeding without one:`, err instanceof Error ? err.message : err);
  }
}

export interface ResetSummary {
  deletedRuns: number;
  createdCases: number;
}

// Wipes every existing workflow run — pending or already resolved — and reseeds the
// scenarios above, so a reset always lands on the same known state rather than layering
// on top of whatever real testing left behind. Callable from the CLI script and from the
// storefront's Settings-page button alike; does NOT flush observability or shut down
// Mastra itself (this app's single shared instance stays alive for the HTTP caller).
export async function resetDemoData(mastra: Mastra): Promise<ResetSummary> {
  const workflow = mastra.getWorkflow("policyReviewWorkflow");
  if (!workflow) throw new Error("policyReviewWorkflow is not registered");

  // No separate ledger to reset anymore —
  // refund-ledger.ts now derives every fact live from workflow-run history, so once
  // the runs below are deleted, those derived facts are automatically empty for a
  // freshly-reseeded order that happens to reuse the same objectIDs. Nothing left to
  // clear separately.
  const { runs: existingRuns } = await workflow.listWorkflowRuns({});
  // Independent deletes, no reason to serialize them — this was most of a full reset's
  // wall-clock time once enough test runs had accumulated. clearDisagreementTickets()
  // (mastra/disagreement-tickets.ts) is thrown in alongside them — every run is about
  // to be deleted, so any disagreement-ticket record keyed by a runId that's about to
  // stop existing is dead weight, not history worth keeping across a reset.
  // The stored chat threads (conversation-threads.ts) go with them: they hold conversations about cases that no longer exist.
  await Promise.all([...existingRuns.map((run) => workflow.deleteWorkflowRunById(run.runId)), clearDisagreementTickets(), clearAllThreads()]);

  // The dominant cost by far: each damage-photo scenario is a real OpenAI image-edit
  // call, several seconds each, plus its own internal retry-on-failure (see
  // image-edit.ts) — that retry burns real time even when it's guaranteed to fail (e.g.
  // no API credits). Independent across scenarios, so running them together rather than
  // one after another is what actually matters here; everything else in this function is
  // fast, local workflow/storage calls.
  await Promise.all(scenarios.map(attachDamagePhotos));

  let createdCases = 0;
  for (const scenario of scenarios) {
    const caseId = await generateCaseId(workflow);
    const run = await workflow.createRun({ runId: caseId });
    const result = await run.start({
      inputData: {
        orderId: scenario.orderId,
        caseType: scenario.caseType ?? ("refund" as const),
        refundAmount: scenario.refundAmount,
        notCustomerFault: scenario.notCustomerFault,
        problemSummary: scenario.problemSummary,
        threadId: `thread_${run.runId}`,
        // No live chat tab created these — they're seed data. This never matches a real
        // ChatWidget-generated sessionId (server.ts's SSE endpoint filters on an exact
        // match), so a seeded case correctly never gets a live push either.
        sessionId: "seed",
        createdAt: new Date().toISOString(),
        // REQUIRED by the policy (a missing figure is "unavailable", so the case escalates with a generic
        // policy-evaluation-error instead of its real reason). Every
        // scenario here is on its own order, so nothing else is open on it.
        relatedOpenCaseRefundAmount: 0,
        transcript: stampSyntheticTimestamps(scenario.transcript),
      },
    });

    console.log(`${scenario.orderId} -> case ${run.runId}: ${result.status}`);
    if (result.status === "suspended") {
      createdCases++;
    } else {
      console.warn(`  expected this scenario to suspend, got "${result.status}" instead — check the policy thresholds in .env`);
    }
  }

  return { deletedRuns: existingRuns.length, createdCases };
}
