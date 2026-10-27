"use client";

// Resolved cases (/history): automatic approvals and rep decisions alike, from
// GET /escalations/history. Same list style as the queue; a card opens the (read-only) case
// page. Re-fetches every 10s, and the search box filters the list.

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { listEscalationHistory, type HistorySummary } from "@/lib/api";
import { timeAgo } from "@/components/PriorityPill";
import { formatMoney } from "@/lib/money";

const OUTCOME_LABEL: Record<HistorySummary["outcome"], string> = {
  approved: "Approved",
  denied: "Rejected",
  error: "Error",
  escalated_to_support: "Ticketed",
};

export default function HistoryPage() {
  const router = useRouter();
  const [runs, setRuns] = useState<HistorySummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    try {
      const data = await listEscalationHistory();
      setRuns(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load history");
    }
  }, []);

  useEffect(() => {
    load();
    // Same 10s cadence as the queue page — a resolved case appearing here shortly
    // after a rep (or the agent, autonomously) resolves it is the whole point.
    const interval = setInterval(load, 10_000);
    return () => clearInterval(interval);
  }, [load]);

  const query = search.trim().toLowerCase();
  const visibleRuns = query ? runs?.filter((run) => run.orderId.toLowerCase().includes(query) || run.runId.toLowerCase().includes(query)) : runs;

  return (
    <>
      <div className="queue-header">
        <h1>History</h1>
        <p>
          {runs === null
            ? error
              ? "Couldn’t load history."
              : "Loading…"
            : `${runs.length} resolved case${runs.length === 1 ? "" : "s"}`}
        </p>
      </div>

      {error && <div className="detail-error">Couldn&rsquo;t reach the agent API: {error}</div>}

      {runs !== null && runs.length === 0 && !error && (
        <div className="queue-empty">Nothing resolved yet — approved and decided cases will show up here.</div>
      )}

      {runs !== null && runs.length > 0 && (
        <input
          type="search"
          className="queue-search"
          placeholder="Search by order or case number…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search history by order or case number"
        />
      )}

      {visibleRuns !== null && visibleRuns !== undefined && visibleRuns.length === 0 && query && (
        <div className="queue-empty">No case matches &ldquo;{search}&rdquo;.</div>
      )}

      <ul className="queue-list">
        {visibleRuns?.map((run) => (
          <li key={run.runId}>
            <button className="queue-card" onClick={() => router.push(`/runs/${run.runId}`)}>
              <div className="queue-card-top">
                <span className="queue-card-customer">{run.customerName}</span>
                {run.vip && <span className="pill-vip">VIP</span>}
                <span className="queue-card-order">{run.orderId}</span>
                <span className="queue-card-spacer" />
                <span className="queue-card-age">{timeAgo(run.resolvedAt)}</span>
              </div>
              <div className="queue-card-summary">{run.problemSummary}</div>
              {run.repComment && <div className="queue-card-summary queue-card-rep-message">Message to customer: “{run.repComment}”</div>}
              <div className="queue-card-bottom">
                <span className={`outcome-pill outcome-pill-${run.outcome}`}>{OUTCOME_LABEL[run.outcome]}</span>
                {run.resolvedBy && <span className="pill">{run.resolvedBy === "agent" ? "Agent" : run.resolvedBy === "rep" ? "Rep" : "System"}</span>}
                <span className="pill-action">
                  {run.requestedAmount !== undefined && run.requestedAmount !== run.refundAmount
                    ? `${formatMoney(run.refundAmount, run.currency)} of ${formatMoney(run.requestedAmount, run.currency)}`
                    : formatMoney(run.refundAmount, run.currency)}
                </span>
                {run.outcomeReason && <span className="pill">{run.outcomeReason}</span>}
              </div>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}
