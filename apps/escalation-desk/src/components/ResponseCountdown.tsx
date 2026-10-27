"use client";

import { useEffect, useState } from "react";

// Live per-second countdown to when a case breaches escalationSlaMinutes (Settings) —
// the same clock server.ts's POST /escalations/check-timeouts sweeps against, computed
// here purely for display (the sweep, not this component, is what actually acts once it
// expires). Ticks on its own setInterval rather than waiting on the page's own poll (10s
// on the queue, 4s on case detail) so it doesn't visibly stall between polls.
interface ResponseCountdownProps {
  suspendedAt: string;
  reviewDeadlineIso?: string;
  slaMinutes: number;
  reasonCode: string;
}

export function ResponseCountdown({ suspendedAt, slaMinutes, reasonCode, reviewDeadlineIso }: ResponseCountdownProps) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // A case waiting on the CUSTOMER's answer to a rep's question counts down the same window, from when the question was sent
  // (server.ts's check-timeouts sweeps it like any other), so it is labelled as waiting on the customer rather than the specialist.
  // A case that's already timed out no longer shows up in this queue at all (the "timeout" branch resolves it straight to History).
  const waitingOnCustomer = reasonCode === "awaiting-customer-response";

  const deadline = reviewDeadlineIso ? new Date(reviewDeadlineIso).getTime() : new Date(suspendedAt).getTime() + slaMinutes * 60_000;
  const remainingMs = deadline - now;

  // Only ever a brief transient window — the 30s TimeoutPoller sweep auto-resolves a
  // case the moment it actually breaches — but still worth a real label rather than a
  // negative-looking countdown in that gap.
  if (remainingMs <= 0) {
    return <span className="response-countdown response-countdown-overdue">{waitingOnCustomer ? "Customer past due" : "Past due"}</span>;
  }

  const totalSeconds = Math.floor(remainingMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const time = minutes > 0 ? `${minutes}m ${seconds.toString().padStart(2, "0")}s left` : `${seconds}s left`;
  const label = waitingOnCustomer ? `Waiting on customer · ${time}` : time;

  return <span className={`response-countdown${remainingMs < 60_000 ? " response-countdown-urgent" : ""}`}>{label}</span>;
}
