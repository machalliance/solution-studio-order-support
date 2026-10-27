"use client";

import { useEffect } from "react";
import { checkTimeouts } from "@/lib/api";

const POLL_INTERVAL_MS = 30_000;

// Polls server.ts's POST /escalations/check-timeouts every 30s for as long as this app
// is open — that route auto-resolves any case that's sat past the current SLA (the
// storefront's Settings page) with no rep decision, pushing a "we opened a support
// ticket" message into the customer's chat and pulling the case out of this queue. This
// is a stand-in for a real cron job hitting the exact same route on the same interval —
// the endpoint itself has no idea what's calling it, and doesn't need to: swapping a
// server-side cron in later means deleting this component, not changing server.ts.
// Rendered once in the root layout so it keeps running no matter which page of the Desk
// a rep is currently on, not just the queue list.
export function TimeoutPoller() {
  useEffect(() => {
    let cancelled = false;
    const check = () => {
      checkTimeouts()
        .then((result) => {
          if (!cancelled && result.timedOut > 0) {
            console.log(`[timeout-poll] ${result.timedOut} case(s) auto-escalated to a support ticket`, result.runs);
          }
        })
        // warn, not error: next dev counts every console.error as an "Issue" (the red badge),
        // and this fires whenever the agent is briefly unreachable (a restart, a hot reload) —
        // the next poll in 30s just retries, so there's nothing for a rep to act on.
        .catch((err) => console.warn("[timeout-poll] check failed:", err));
    };
    check();
    const id = setInterval(check, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return null;
}
