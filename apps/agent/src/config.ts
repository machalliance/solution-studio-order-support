// Centralized, environment-driven configuration. Business-tunable values (queue sorting, the
// response windows, the System Authority backstop, the currency) are read from the environment
// here, never as literals at the call site. Some can also be changed at run time from the
// Settings page (runtime-settings.ts); what decides a case is not here at all — it is
// settings inside the active policy document.

function num(envVar: string, fallback: number): number {
  const raw = process.env[envVar];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const config = {
  // Dollar-shaped thresholds carry no currency in their own name — WISMO_CUR (below) is
  // the single place that decides what unit these numbers are actually in. lib/money.ts's
  // formatMoney() is what turns one of these into display text; nowhere else should ever
  // hardcode a "$" or a currency code.
  //
  // What decides a case (return window, return ceilings, the autonomy switches) is not here:
  // it is settings inside the active policy document, edited on the Policies page.
  // Queue sorting, not policy: an escalated refund or
  // return above this is flagged "high" and sorts first in the Escalation Desk queue.
  // Never changes a decision. 0 turns amount-based flagging off. Also live-adjustable from
  // the Settings page.
  highPriorityAmountThreshold: num("WISMO_HIGH_PRIORITY_THRESHOLD", 250),
  agentPort: num("AGENT_PORT", 3006),
  // How long a case waits for a rep response before it auto-escalates to a support
  // ticket (server.ts's POST /escalations/check-timeouts) — see policy-review-workflow.ts's
  // "timeout" decision.
  escalationSlaMinutes: num("WISMO_ESCALATION_SLA_MINUTES", 5),
  // What the customer is told to expect once a case has escalated that far — a real,
  // different commitment than the rep-response SLA above, not the same number relabeled.
  supportTicketContactHours: num("WISMO_SUPPORT_TICKET_CONTACT_HOURS", 24),
  // The System Authority backstop — the one autonomy limit kept OUTSIDE the policy
  // document (mastra/system-authority.ts): no automatic approval above this, whatever the
  // policy says. Everything else that decides a case — including the autonomy on/off
  // switches that used to live here — is in the active policy document. Also
  // live-adjustable from the Settings page. $500 sits deliberately above the demo policy's
  // own $100 return ceiling so it acts as a backstop, not a second limit, unless tightened.
  maxAutonomousAmount: num("WISMO_MAX_AUTONOMOUS_AMOUNT", 500),
  // ISO 4217 currency code — every dollar-shaped threshold above, every order amount, and
  // every refund is denominated in this. lib/money.ts's formatMoney() (Intl.NumberFormat
  // under the hood) is the only place that should turn a number + this code into display
  // text; changing this one value is meant to be the whole fix for a different market, not
  // the start of a find-and-replace for a hardcoded "$".
  currency: process.env.WISMO_CUR || "USD",
  // Who the demo customer is and who the Escalation Desk's rep is. Deliberately NO built-in value: they come from
  // .env (.env.example has placeholders), so no real person's name or address ships in the code.
  // assertIdentityConfigured() below stops the agent from starting without them.
  demoCustomerName: (process.env.WISMO_DEMO_CUSTOMER_NAME ?? "").trim(),
  demoCustomerEmail: (process.env.WISMO_DEMO_CUSTOMER_EMAIL ?? "").trim(),
  repName: (process.env.WISMO_REP_NAME ?? "").trim(),
};

const IDENTITY_VARS = ["WISMO_DEMO_CUSTOMER_NAME", "WISMO_DEMO_CUSTOMER_EMAIL", "WISMO_REP_NAME"] as const;

// Called once at agent start (index.ts). A missing name would otherwise show up as an empty "Hi, " in the storefront and a
// blank rep in the Desk, with nothing saying why — fail loudly, and say where the values come from.
export function assertIdentityConfigured(env: Record<string, string | undefined> = process.env): void {
  const missing = IDENTITY_VARS.filter((name) => !(env[name] ?? "").trim());
  if (missing.length > 0) {
    throw new Error(
      `Not set in .env: ${missing.join(", ")}. They name the demo customer and the support rep, and the code ships with no default for them — copy the lines from .env.example (cp .env.example .env).`
    );
  }
}
