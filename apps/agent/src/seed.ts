// CLI entry point for the shared reset routine — see mastra/demo-seed.ts for the actual
// scenario data and seeding logic (also used by the storefront's Settings-page "Reset
// demo data" button via server.ts's POST /demo/reset). Run with `npm run agent:seed`
// from the repo root. Triggers the policy-review workflow directly (bypassing the
// conversational agent), so this needs no chat-model API key — it's exercising the real
// suspend/resume mechanism and the real policy checks, not a live conversation.

import { mastra } from "./mastra";
import { resetDemoData } from "./mastra/demo-seed";

async function seed() {
  const summary = await resetDemoData(mastra);
  console.log(`Reset complete: deleted ${summary.deletedRuns} old run(s), created ${summary.createdCases} case(s).`);

  // The observability exporter batches spans; process.exit() right after seeding would
  // kill the process before that batch flushes, silently losing every trace this seed
  // run just generated. Flush explicitly (while storage is still open) rather than
  // relying on mastra.shutdown() to sequence this correctly on its own — a first attempt
  // at just calling shutdown() closed the storage client before the observability flush
  // ran, and every span in the batch failed to persist as a result.
  await mastra.observability.flush();
  await mastra.shutdown();
}

seed()
  .then(() => {
    console.log("Seed complete.");
    process.exit(0);
  })
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exit(1);
  });
