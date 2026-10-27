// The one Mastra instance: LibSQL storage (workflow runs and traces; the Escalation Desk's
// queue is simply the suspended runs in here), the chat agent, the Policy Helper, the
// policy-review workflow, and observability. Several modules in this cluster import each other,
// so anything that needs the workflow looks it up through here at call time rather than at
// import time.

import { Mastra } from "@mastra/core/mastra";
import { LibSQLStore } from "@mastra/libsql";
import { Observability, MastraStorageExporter, SensitiveDataFilter } from "@mastra/observability";
import { policyReviewWorkflow } from "./workflows/policy-review-workflow";
import { wismoAgent } from "./agents/wismo-agent";
import { policyHelperAgent } from "./agents/policy-helper";

const storage = new LibSQLStore({
  id: "wismo-storage",
  url: process.env.AGENT_DB_URL ?? "file:./mastra.db",
});

export const mastra = new Mastra({
  storage,
  // policyHelper is registered (rather than just constructed where it's used) so its
  // calls are traced by the same Observability config as every other agent run — the
  // admin-side policy-authoring assistant (policy/helper.ts), deliberately NOT
  // registered on wismoAgent's own tool list, and never reachable from the
  // customer-facing chat path at all.
  agents: { wismoAgent, policyHelper: policyHelperAgent },
  workflows: { policyReviewWorkflow },
  // Traces every agent run, workflow step, and tool call — the "governance and
  // traceability" role Mastra plays here, separate
  // from its role as the agentic framework. MastraStorageExporter keeps traces in the
  // same LibSQL file, queryable via mastra.getStorage().listTraces()/.getTrace() — no
  // new infra, same fixture-first instinct as everything else here. External exporters
  // (Langfuse, Datadog, OTel) are live-adapter territory for later, not needed now.
  observability: new Observability({
    configs: {
      default: {
        serviceName: "wismo",
        exporters: [new MastraStorageExporter()],
        // The default sensitiveFields list is credential-focused (password, token,
        // secret, apikey, jwt, ssn, ...) — it does NOT cover customer PII, which is
        // the actual governance concern here (order-lookup spans carry name/email).
        // Extend, don't replace, so credential redaction still applies too.
        spanOutputProcessors: [
          new SensitiveDataFilter({
            sensitiveFields: [
              "password", "token", "secret", "key", "apikey", "auth", "authorization",
              "bearer", "bearertoken", "jwt", "credential", "clientsecret", "privatekey",
              "refresh", "ssn",
              "email", "customerEmail",
            ],
            redactionStyle: "partial",
          }),
        ],
      },
    },
  }),
});
