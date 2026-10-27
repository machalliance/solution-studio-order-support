"use client";

// The Escalation Desk queue (/): every case still waiting on a decision. The agent returns
// them already ordered (GET /escalations: not yet ticketed first, then priority, then newest);
// this page re-fetches every 10s and only filters by the search box. Each card shows the
// response countdown, based on the response window set on the Settings page.

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { listEscalations, getSettings, type EscalationSummary } from "@/lib/api";
import { PriorityPill, timeAgo } from "@/components/PriorityPill";
import { ResponseCountdown } from "@/components/ResponseCountdown";

export default function QueuePage() {
  const router = useRouter();
  const [runs, setRuns] = useState<EscalationSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  // The countdown's own basis — fetched once, not on every 10s poll, since it only
  // changes when someone edits it from the Settings page (a rare, deliberate action, not
  // something worth a network round-trip on every queue refresh).
  const [slaMinutes, setSlaMinutes] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await listEscalations();
      setRuns(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load the queue");
    }
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, 10_000);
    return () => clearInterval(interval);
  }, [load]);

  useEffect(() => {
    getSettings()
      .then((s) => setSlaMinutes(s.escalationSlaMinutes))
      .catch(() => {});
  }, []);

  // Client-side only — the full list is already in memory from the existing 10s poll and
  // this dataset is small, so there's no need for a server-side search endpoint. Matches
  // an order number or a case (run) number, case-insensitive substring.
  const query = search.trim().toLowerCase();
  const visibleRuns = query ? runs?.filter((run) => run.orderId.toLowerCase().includes(query) || run.runId.toLowerCase().includes(query)) : runs;

  return (
    <>
      <div className="queue-header">
        <h1>Needs attention</h1>
        <p>
          {runs === null
            ? error
              ? "Couldn’t load the queue."
              : "Loading…"
            : `${runs.length} case${runs.length === 1 ? "" : "s"} waiting on a decision`}
        </p>
      </div>

      {error && <div className="detail-error">Couldn&rsquo;t reach the agent API: {error}</div>}

      {runs !== null && runs.length === 0 && !error && (
        <div className="queue-empty">Nothing waiting right now. Run <code>npm run agent:seed</code> to seed demo cases.</div>
      )}

      {runs !== null && runs.length > 0 && (
        <input
          type="search"
          className="queue-search"
          placeholder="Search by order or case number…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search the queue by order or case number"
        />
      )}

      {visibleRuns !== null && visibleRuns !== undefined && visibleRuns.length === 0 && query && (
        <div className="queue-empty">No case matches &ldquo;{search}&rdquo;.</div>
      )}

      <ul className="queue-list">
        {visibleRuns?.map((run) => (
          <li key={run.runId}>
            <button
              className="queue-card"
              onClick={() => router.push(`/runs/${run.runId}`)}
            >
              <div className="queue-card-top">
                <span className="queue-card-customer">{run.customerName}</span>
                {run.vip && <span className="pill-vip">VIP</span>}
                <span className="queue-card-order">{run.orderId}</span>
                <span className="queue-card-spacer" />
                <span className="queue-card-age">{timeAgo(run.suspendedAt)}</span>
              </div>
              <div className="queue-card-summary">{run.problemSummary}</div>
              <div className="queue-card-bottom">
                <PriorityPill priority={run.priority} />
                <span className="pill-action">{run.recommendedAction}</span>
                <span className="pill">{run.reasonCode.replace(/-/g, " ")}</span>
                {slaMinutes !== null && (
                  <ResponseCountdown reviewDeadlineIso={run.reviewDeadlineIso} suspendedAt={run.suspendedAt} slaMinutes={slaMinutes} reasonCode={run.reasonCode} />
                )}
              </div>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}
