import { config } from "../config";

// Runtime-adjustable, in-memory only — no persistence across a restart, same
// "demo data resets to a known default" philosophy as the rest of this app. Starts at
// config.escalationSlaMinutes (the env-var default) and can be changed live via the
// storefront's Settings page (server.ts's GET/POST /settings) without redeploying —
// exactly the kind of value demo-data.ts's own comment on cust_demo_01's name/email
// already anticipated this page growing to control.
let escalationSlaMinutes = config.escalationSlaMinutes;
let supportTicketContactHours = config.supportTicketContactHours;
let maxAutonomousAmount = config.maxAutonomousAmount;
let highPriorityAmountThreshold = config.highPriorityAmountThreshold;

export function getEscalationSlaMinutes(): number {
  return escalationSlaMinutes;
}

export function setEscalationSlaMinutes(minutes: number): void {
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new Error("escalationSlaMinutes must be a positive number");
  }
  escalationSlaMinutes = minutes;
}

// The commitment stated once a case has actually escalated to a support ticket — a
// separate, longer-timescale promise from the rep-response SLA above, not the same
// number reused. Told to the customer via CaseResolvedEvent.contactWindowHours
// (case-events.ts), read fresh at the moment a case times out, not baked into any
// message text ahead of time.
export function getSupportTicketContactHours(): number {
  return supportTicketContactHours;
}

export function setSupportTicketContactHours(hours: number): void {
  if (!Number.isFinite(hours) || hours <= 0) {
    throw new Error("supportTicketContactHours must be a positive number");
  }
  supportTicketContactHours = hours;
}

// Queue sorting only — see config.ts's highPriorityAmountThreshold. 0 turns amount-based
// "high" flagging off (disputes are still always high).
export function getHighPriorityAmountThreshold(): number {
  return highPriorityAmountThreshold;
}

export function setHighPriorityAmountThreshold(amount: number): void {
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error("highPriorityAmountThreshold must be a non-negative number");
  }
  highPriorityAmountThreshold = amount;
}

// Everything that decides a case — return ceilings, the damaged-item "ask for it back"
// default, and the autonomy switches (autonomous refunds / plain returns on-off, disputes
// always to a rep) — lives in the active policy document (Policies page), not here; see
// mastra/policy/live-policy.ts. The one exception is below.

// The System Authority backstop — see mastra/system-authority.ts, the one place it's read
// to decide a case. 0 is a real, distinct value: no automatic approval ever clears the bar
// (an emergency brake that doesn't need a policy edit). Automatic DENIALS move no money and
// aren't affected — those are governed by the policy's own autonomousRefundsEnabled switch.
export function getMaxAutonomousAmount(): number {
  return maxAutonomousAmount;
}

export function setMaxAutonomousAmount(amount: number): void {
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error("maxAutonomousAmount must be a non-negative number");
  }
  maxAutonomousAmount = amount;
}
