import { serve } from "@hono/node-server";
import { app } from "./server";
import { config, assertIdentityConfigured } from "./config";
import { ensureSeeded } from "./mastra/policy/repository";
import { buildBaseDraft } from "./mastra/policy/base-draft";

// The demo customer's and the rep's names come only from .env — stop here, with a clear message, if they are missing.
assertIdentityConfigured();

// Seeds the "demo" policy namespace with the migrated base draft — only if nothing is
// active there yet, never overwriting an operator's own activated version. Runs before
// the server starts accepting requests, same "don't let an early request race
// uninitialized state" discipline as the earlier refund-ledger fix. "demo"'s active
// version decides every live case (mastra/policy/live-policy.ts), so it must exist
// before the first request.
await ensureSeeded("demo", buildBaseDraft());

serve({ fetch: app.fetch, port: config.agentPort }, (info) => {
  console.log(`WISMO agent API listening on http://localhost:${info.port}`);
});
