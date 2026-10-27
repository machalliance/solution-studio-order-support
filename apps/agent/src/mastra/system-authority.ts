import { getMaxAutonomousAmount } from "./runtime-settings";

// The System Authority backstop — the one autonomy limit that deliberately lives OUTSIDE
// the policy document (Settings page, not policy.json). Everything else that decides a case,
// including the switches that used to sit here (autonomous refunds / plain returns on-off,
// disputes always to a rep), is policy now — see live-policy.ts. Kept outside on purpose because the
// policy is drafted by the Policy Helper (a language model) and activated by a person, so there's one
// spending ceiling no policy edit can exceed, and one emergency brake that doesn't need a policy edit
// (set it to 0).
//
// Called by policy-review-workflow.ts right before any AUTOMATIC approval would move money,
// for every case type. An automatic denial moves no money and isn't checked here.
export type AutonomyClampResult =
  | { blocked: false }
  | { blocked: true; reasonCode: string; explanation: string };

export function checkMaxAutonomousAmount(amount: number): AutonomyClampResult {
  if (amount > getMaxAutonomousAmount()) {
    return {
      blocked: true,
      reasonCode: "exceeds-max-autonomous-amount",
      explanation: "Policy would approve this automatically, but it's above the system's autonomous-approval limit — needs a human decision.",
    };
  }
  return { blocked: false };
}
