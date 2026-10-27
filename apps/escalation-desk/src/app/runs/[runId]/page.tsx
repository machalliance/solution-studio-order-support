"use client";

// Case detail (/runs/[runId]) — the rep's view of one escalated case. Shows the conversation,
// order and customer context, the policy rule that applied, and the agent's trail. For an OPEN
// case it also shows the decision bar (approve / reject / modify / request more info / escalate
// to support), which POSTs to /escalations/:runId/resume; a RESOLVED case is read-only and shows
// its resolution instead. Polls its own case every 4s so a customer's reply to a follow-up
// question appears without a reload. This page only sends the rep's decision — the workflow
// decides what it does.

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { getEscalation, getEscalationTrace, resumeEscalation, getSettings, type EscalationDetail, type Decision, type TraceSpan } from "@/lib/api";
import { PriorityPill, timeAgo } from "@/components/PriorityPill";
import { ResponseCountdown } from "@/components/ResponseCountdown";
import { formatMoney } from "@/lib/money";
import { formatDay, daysAgo, daysAgoLabel } from "@/lib/dates";
import { PolicyRefBadge } from "@/components/PolicyRefBadge";
import { PersonIcon, TruckIcon, BoxIcon, ShieldIcon, ScaleIcon } from "@/components/icons";
import { initialsOf } from "@/lib/rep";

type DecisionKind = Decision["decision"];

const DECISION_LABELS: Record<DecisionKind, string> = {
  approve: "Approve",
  reject: "Reject",
  modify: "Modify",
  request_more_info: "Request more info",
  escalate_to_support: "Escalate to support",
};

// "Approved," not "Issued" — this app only ever knows an
// approval was recorded, never that a real OMS payment actually completed.
const OUTCOME_LABEL: Record<"approved" | "denied" | "error" | "escalated_to_support", string> = {
  approved: "Approved",
  denied: "Rejected",
  error: "Error",
  escalated_to_support: "Ticketed",
};

// A resolved case's outcome maps to one of three visual tones (green = good news,
// red = denied/error, blue = neutral handoff — no decision was actually made, so
// "escalated_to_support" reads as informational, not a failure). Centralized so the
// icon, the pill, and the resolution text color can't drift out of sync with each
// other the way individual inline ternaries would risk as outcomes are added.
function outcomeTone(outcome: EscalationDetail["outcome"]): "green" | "red" | "blue" {
  if (outcome === "approved") return "green";
  if (outcome === "escalated_to_support") return "blue";
  return "red";
}

// The one place that decides how to word a resolved outcome — used by the Resolution
// box, the case timeline's own resolved entry, and (for the partial case) the hero.
// requestedAmount vs. refundAmount can genuinely diverge once a "modify" decision
// approved less than the customer originally asked for — live-reported: a rep who
// approved $30 of a $48 damage claim couldn't tell that from this page at all (Order
// Summary showed $30 as if it were the item's own price, and nothing else restated
// either figure). Centralizing the wording here means the partial-refund framing can't
// drift between the three places it needs to show up.
function resolutionText(run: EscalationDetail): string {
  if (run.outcome === "approved") {
    const amount = formatMoney(run.refundAmount, run.currency);
    const isPartial = run.requestedAmount !== undefined && run.requestedAmount !== run.refundAmount;
    const base = isPartial
      ? `Partial refund approved: ${amount} of ${formatMoney(run.requestedAmount!, run.currency)} requested`
      : `Refund approved: ${amount}`;
    return run.refundId ? `${base} (${run.refundId}).` : `${base}.`;
  }
  if (run.outcome === "denied") return run.outcomeReason || "Refund request rejected.";
  if (run.outcome === "error") return run.outcomeReason || "Could not be resolved.";
  if (run.outcome === "escalated_to_support") {
    const ticket = run.ticketId ? ` (${run.ticketId})` : "";
    if (run.customerDidNotReply) {
      return `The customer did not answer your question within the response window — a support ticket${ticket} was opened automatically. This case did not get a refund decision.`;
    }
    if (run.repQuestion) {
      return `You asked the customer: “${run.repQuestion}” They weren't connected to the chat to receive it, so a support ticket${ticket} was opened and the case closed. This case did not get a refund decision.`;
    }
    if (run.resolvedBy === "rep") {
      return `A specialist determined this case needed additional support — a support ticket${ticket} was opened. This case did not get a refund decision.`;
    }
    return `No rep responded within the response window — a support ticket${ticket} was opened automatically. This case did not get a refund decision.`;
  }
  return "";
}

type InfoTab = "conversation" | "customer";

// A deterministic starting point, not a scored/confidence-based recommendation (no
// confidence indicator anywhere in this design, per explicit scope) — a delivery
// dispute always needs the carrier record checked before anything else, so "ask first"
// is the one sane default; a refund/plain-return case only reached a human because it
// was just outside an autonomous threshold, so approval is the common outcome. Easy to
// adjust once seen in real use.
function recommendedDecisionFor(caseType: string | undefined): DecisionKind {
  return caseType === "delivery_dispute" ? "request_more_info" : "approve";
}

// Delivery dispute keeps its own headline — the carrier record and the customer's
// account of events directly disagree here, so this isn't a yes/no "should we"
// question the way a refund decision is; it's a statement that the disagreement
// needs looking into before anything else. Explicit user correction: "we do not have
// the wording 'Should we'... we need to look into the delivery dispute" — a question
// framing here undersold that this always escalates and always needs the carrier
// record checked, unlike a refund/return where "should we approve" is the accurate
// question being asked.
function heroHeadlineFor(caseType: string | undefined, orderId: string): string {
  return caseType === "delivery_dispute"
    ? `We need to look into this delivery dispute for ${orderId}.`
    : `Should we approve a refund for ${orderId}?`;
}

// Splits a deterministic, already-written sentence (problemSummary/explanation) into
// bullet-worthy lines for the comparison widget — not real NLP, just enough to turn one
// paragraph into a short list without needing a new backend field.
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// The order line shown in Shipping Info / Order Summary / Customer & Order — built here
// from the order's real timestamps, in the viewer's local time (lib/dates.ts), so it names
// the same days the storefront shows for the same order. orderContext (the server's own
// text, with UTC dates baked in) is only the fallback for an order record that's missing.
function orderLine(run: EscalationDetail): string {
  if (!run.orderItemsSummary || !run.orderDate || !run.deliveredDate) return run.orderContext;
  return `${run.orderItemsSummary} — ordered ${formatDay(run.orderDate)}, delivered ${formatDay(run.deliveredDate)}`;
}

// The AI in the conversation is the Wismo agent — never the rep who is logged in (their name is WISMO_REP_NAME, shown at the
// top right). Labelling it with the rep's name made it read as the human rep chatting with the customer.
const AGENT_NAME = "WISMO Agent";

interface TimelineEntry {
  date: string;
  label: string;
  desc?: string;
  dot: "blue" | "red" | "gray";
}

// Built entirely from fields EscalationDetail already carries (createdAt,
// relatedOpenCaseIds, the order's own orderDate/deliveredDate timestamps). Sorted
// newest-first, the same convention the queue itself already uses.
function buildTimelineEntries(run: EscalationDetail): TimelineEntry[] {
  const entries: TimelineEntry[] = [
    { date: run.createdAt, label: `Case ${run.runId} opened`, desc: run.problemSummary, dot: "blue" },
  ];
  for (const related of run.relatedOpenCaseIds ?? []) {
    entries.push({ date: related.createdAt, label: `Related case ${related.runId} opened`, desc: "Potential duplicate claim", dot: "red" });
  }
  if (run.deliveredDate) entries.push({ date: run.deliveredDate, label: "Order delivered", dot: "gray" });
  if (run.orderDate) entries.push({ date: run.orderDate, label: "Order placed", dot: "gray" });
  if (run.outcome !== undefined && run.resolvedAt) {
    entries.push({
      date: run.resolvedAt,
      label: `Case resolved — ${OUTCOME_LABEL[run.outcome]}`,
      // Previously just run.outcomeReason, which is always undefined for an "approved"
      // outcome — this timeline entry never showed a dollar figure at all, even a
      // straightforward full refund. resolutionText covers all four outcomes.
      desc: resolutionText(run),
      dot: run.outcome === "approved" ? "blue" : run.outcome === "escalated_to_support" ? "gray" : "red",
    });
  }
  return entries.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
}

// "43m ago" for a recent entry, an actual date once it's old enough that a relative
// time stops being useful at a glance — same cutoff feel as most activity feeds.
function timelineWhen(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  if (diffMs < 1000 * 60 * 60 * 24 * 6) return timeAgo(iso);
  return formatDay(iso);
}

export default function RunDetailPage() {
  const { runId } = useParams<{ runId: string }>();
  const router = useRouter();

  const [run, setRun] = useState<EscalationDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [trace, setTrace] = useState<TraceSpan[] | null>(null);
  const [traceError, setTraceError] = useState<string | null>(null);

  const [activeDecision, setActiveDecision] = useState<DecisionKind | null>(null);
  const [comment, setComment] = useState("");
  const [reason, setReason] = useState("");
  const [modifiedAmount, setModifiedAmount] = useState("");
  const [requestItemReturn, setRequestItemReturn] = useState(false);
  const [question, setQuestion] = useState("");
  const [supportNote, setSupportNote] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [resultMessage, setResultMessage] = useState<string | null>(null);

  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const threadListRef = useRef<HTMLDivElement>(null);
  const [agentTrailOpen, setAgentTrailOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<InfoTab>("conversation");

  // Agent Trail's own floating button sits "just above" the decision bar — but that
  // bar's height genuinely varies (collapsed with no decision picked vs. expanded with
  // a modify/request-more-info field), so a fixed pixel offset would either leave a gap
  // or risk overlapping it depending on which state the rep is in. Measuring the bar's
  // real rendered height (only while it exists — a resolved case has no floating bar at
  // all) keeps the button pinned exactly above it in every state, not just the common one.
  //
  // A callback ref, not a useEffect + useRef: the bar only exists once the case has
  // loaded, and the effect this replaced was keyed on `run?.outcome` — which is `undefined`
  // both before AND after an open case loads, so it never re-ran when the bar appeared, the
  // observer never attached, and the height stayed 0 for every open case. The button then
  // sat a fixed 16px from the bottom of the screen, on top of the bar (visible on desktop,
  // and across the second row of buttons on a phone where they wrap). A callback ref runs
  // exactly when the bar mounts and unmounts, whatever else changes.
  const decisionBarObserver = useRef<ResizeObserver | null>(null);
  const [decisionBarHeight, setDecisionBarHeight] = useState(0);
  const decisionBarRef = useCallback((el: HTMLDivElement | null) => {
    decisionBarObserver.current?.disconnect();
    decisionBarObserver.current = null;
    if (!el) {
      setDecisionBarHeight(0);
      return;
    }
    // ResizeObserver fires once on observe() and again on every size change (a decision's
    // fields expanding/collapsing, a validation error appearing, buttons re-wrapping on a
    // narrow screen). The border-box height: the bar's own top border counts too.
    const observer = new ResizeObserver(() => setDecisionBarHeight(el.getBoundingClientRect().height));
    observer.observe(el);
    decisionBarObserver.current = observer;
  }, []);

  // See page.tsx's own copy of this — fetched once, not on every poll.
  const [slaMinutes, setSlaMinutes] = useState<number | null>(null);

  useEffect(() => {
    getEscalation(runId)
      .then((data) => {
        setRun(data);
        setModifiedAmount(String(data.refundAmount));
        setRequestItemReturn(data.suggestedRequestItemReturn === true);
      })
      .catch((err) => setLoadError(err instanceof Error ? err.message : "Failed to load this case"));
    getEscalationTrace(runId)
      .then(setTrace)
      .catch((err) => setTraceError(err instanceof Error ? err.message : "Failed to load activity"));
    getSettings()
      .then((s) => setSlaMinutes(s.escalationSlaMinutes))
      .catch(() => {});
  }, [runId]);

  // Nothing else pushes a live update to this page — a customer's reply to a "request
  // more info" question, for instance, only ever reaches the case's own stored snapshot
  // (case-sync.ts), not this open tab. Without a poll, a rep who sent that question and
  // stayed on (or came back to) this exact page would keep seeing "awaiting customer
  // response" indefinitely even after the reply landed. Deliberately doesn't touch
  // modifiedAmount — only the initial load above should seed that field, never overwrite
  // whatever the rep is actively typing into it.
  useEffect(() => {
    const id = setInterval(() => {
      getEscalation(runId)
        .then(setRun)
        .catch(() => {
          // A case a rep just resolved from this same page (or another rep/the SLA
          // sweep resolved elsewhere) 404s/409s here once it's no longer suspended —
          // expected, not worth surfacing as a load error on an otherwise-fine page.
        });
    }, 4000);
    return () => clearInterval(id);
  }, [runId]);

  // The transcript loads async (getEscalation above) — scrolling on mount would fire
  // before there's anything to scroll. This runs once run.transcript actually has
  // content, landing on the most recent message the same way a real chat client would.
  useEffect(() => {
    if (!run?.transcript.length) return;
    const el = threadListRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [run?.transcript.length]);

  useEffect(() => {
    if (!lightboxSrc) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setLightboxSrc(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightboxSrc]);

  useEffect(() => {
    if (!agentTrailOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setAgentTrailOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [agentTrailOpen]);

  if (loadError) {
    return (
      <>
        <BackLink />
        <div className="detail-error">{loadError}</div>
      </>
    );
  }

  if (!run) {
    return (
      <>
        <BackLink />
        <div className="detail-loading">Loading case…</div>
      </>
    );
  }

  async function submit() {
    if (!activeDecision) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      let decision: Decision;
      switch (activeDecision) {
        case "approve":
          decision = { decision: "approve", comment: comment || undefined, requestItemReturn: isDamageClaim ? requestItemReturn : undefined };
          break;
        case "reject":
          decision = { decision: "reject", reason: reason || undefined };
          break;
        case "modify":
          decision = { decision: "modify", modifiedAmount: Number(modifiedAmount), comment: comment || undefined, requestItemReturn: isDamageClaim ? requestItemReturn : undefined };
          break;
        case "request_more_info":
          decision = { decision: "request_more_info", question };
          break;
        case "escalate_to_support":
          decision = { decision: "escalate_to_support", note: supportNote || undefined };
          break;
      }
      const { notification } = await resumeEscalation(runId, decision);
      const notifyLine = notification ? ` Customer notified by ${notification.channel} (${notification.sentTo}).` : "";
      const resultText =
        activeDecision === "request_more_info"
          ? "Question sent back to the customer — this case will return to the queue once they reply."
          : activeDecision === "escalate_to_support"
          ? "Escalated to support — this case is closed out and moved to History."
          : "Decision recorded. Returning to the queue…";
      setResultMessage(resultText + notifyLine);
      setTimeout(() => router.push("/"), 1200);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Failed to submit the decision");
    } finally {
      setSubmitting(false);
    }
  }

  // The real value of whatever this case actually covers — a rep's "modify" amount
  // can never exceed what was actually purchased. run.items already resolves to the
  // covered item(s) specifically (server.ts's resolveOrderItems, not just every item
  // on the whole order), so summing it here is the same real cap the server itself
  // enforces on submit — this just stops the rep from even trying to send one that's
  // too high, rather than letting them submit and find out from an error afterward.
  const maxModifyAmount = run.items?.reduce((sum, item) => sum + item.price, 0);
  const modifyAmountTooHigh = maxModifyAmount !== undefined && Number(modifiedAmount) > maxModifyAmount;

  // Damage/fault claims only: a plain return already always gets its label on approval,
  // and a delivery dispute has no item to send back — so the checkbox would be misleading
  // (unticking it wouldn't suppress anything) anywhere else.
  const isDamageClaim = run.caseType === "refund";
  const requestItemReturnField = isDamageClaim ? (
    <div className="decision-checkbox-field">
      <label className="decision-checkbox-label">
        <input type="checkbox" checked={requestItemReturn} onChange={(e) => setRequestItemReturn(e.target.checked)} />
        <span>
          Also ask the customer to send the item back
          <span className="decision-checkbox-hint">A return label is generated and sent with the approval. The refund still goes out right away.</span>
        </span>
      </label>
    </div>
  ) : null;

  const canSubmit =
    activeDecision !== null &&
    !submitting &&
    (activeDecision !== "request_more_info" || question.trim().length > 0) &&
    (activeDecision !== "modify" || (modifiedAmount.trim().length > 0 && !modifyAmountTooHigh));

  const timelineEntries = buildTimelineEntries(run);
  const orderText = orderLine(run);
  // A rep checking a return/damage claim against the return window wants the actual day
  // count, not PriorityPill's minute-tuned timeAgo() ("5d ago").
  const deliveredLabel = run.deliveredDate ? `Delivered ${daysAgoLabel(run.deliveredDate)}` : null;
  const deliveredDays = run.deliveredDate ? daysAgo(run.deliveredDate) : null;
  // Order Summary's own pill (below) shows WHEN it was ordered, not delivered — a
  // customer's return-window eligibility and a rep's own sense of "how old is this
  // order" both key off the order date, not the delivery date the Shipping Info box
  // already covers.
  const orderedLabel = run.orderDate ? `Ordered ${formatDay(run.orderDate)} — ${daysAgoLabel(run.orderDate)}` : null;
  // Present ONLY for an already-resolved run (see api.ts's own comment on
  // EscalationDetail.outcome) — no policy verdict is ever persisted once a case
  // resolves, so reasonCode/explanation/recommendedAction/priority/suspendedAt below
  // are meaningless placeholders whenever this is true. Everything past this point
  // must branch on it before touching any of those.
  const isResolved = run.outcome !== undefined;
  // Disagreement tickets about a DIFFERENT, earlier case on this order — split out from
  // a ticket about THIS exact case (rendered as its own, more urgent banner below) so
  // neither the JSX nor a rep reading it has to repeatedly re-derive which is which.
  const otherDisagreementTickets = run.disagreementTickets?.filter((ticket) => ticket.caseId !== run.runId) ?? [];
  const ownDisagreementTicket = run.disagreementTickets?.find((ticket) => ticket.caseId === run.runId);

  function viewFullTimeline() {
    setAgentTrailOpen(true);
  }

  return (
    <>
      <BackLink resolved={isResolved} />

      <div className="detail-header">
        <div>
          <h1>
            {run.customerName}
            {run.vip && <span className="pill-vip">VIP</span>}
          </h1>
          <div className="detail-sub">
            {run.orderId} · case {run.runId} · opened {timeAgo(run.createdAt)}
          </div>
        </div>
        <div className="detail-header-spacer" />
        {isResolved ? (
          <>
            <span className={`outcome-pill outcome-pill-lg outcome-pill-${run.outcome}`}>{OUTCOME_LABEL[run.outcome!]}</span>
            <span className="detail-sub">resolved {timeAgo(run.resolvedAt!)}</span>
          </>
        ) : (
          <>
            {slaMinutes !== null && (
              <ResponseCountdown reviewDeadlineIso={run.reviewDeadlineIso} suspendedAt={run.suspendedAt} slaMinutes={slaMinutes} reasonCode={run.reasonCode} />
            )}
            <PriorityPill priority={run.priority} />
          </>
        )}
      </div>

      <div className="detail-body">
      <div className="detail-main">
      {/* "reconcile them before deciding" only means something while a decision is still
          pending — once THIS case resolves there's nothing left to reconcile, regardless
          of whether the other case is still open. Live-reported: a resolved case
          (outcome "Approved") kept showing "Another open case on this order" for a related
          case that had ALSO since resolved — the banner never re-checked either case's
          live status, just rendered whatever was frozen into this case's own payload at
          link time. See server.ts's own fix for the still-suspended half of this (the
          related case's OWN current status, checked fresh on every load of an
          unresolved case) — this isResolved gate covers the other half. */}
      {/* Fraud-relevant, shown regardless of isResolved — an escalated case can involve
          an already-refunded item just as easily as a resolved one, and that's exactly
          the pattern this exists to surface. Live-reported: a rep reviewing a case had
          no way to tell it overlapped a prior refund at all, just an aggregate dollar
          total buried in policy-exception text ("this order's total is over the
          ceiling") with no indication any of that total was a refund already paid out
          — indistinguishable from an ordinary large-but-legitimate request. */}
      {run.orderRefundHistory && run.orderRefundHistory.length > 0 && (
        <div className="related-case-banner refund-history-banner">
          <span className="related-case-icon" aria-hidden="true">⚠</span>
          <div className="related-case-body">
            <div className="related-case-title">
              {run.orderRefundHistory.length === 1 ? "Already refunded on this order" : `${run.orderRefundHistory.length} refunds already approved on this order`}
            </div>
            <div className="related-case-desc">
              {run.orderRefundHistory.map((record, i) => (
                <span key={record.refundId}>
                  {i > 0 && "; "}
                  {record.items.join(", ")} — {formatMoney(record.amount, run.currency)}, {timeAgo(record.approvedAt)} ({record.refundId})
                </span>
              ))}
              {" "}— check this isn't the same item(s) being claimed again before deciding.
            </div>
          </div>
        </div>
      )}

      {/* Stub-backed (mastra/disagreement-tickets.ts) — no real ticketing system behind
          this, and a ticket's status never changes on its own once created. Split into
          two cases rather than one generic list: a ticket about THIS exact case (the
          customer disagreed with the resolution being viewed right now) reads very
          differently from a ticket about a DIFFERENT, earlier case on the same order —
          conflating them would either bury the more urgent "this is disputed" fact
          inside a list, or make a case wrongly appear to link to itself via the "View
          case" button. */}
      {ownDisagreementTicket && (
        <div className="related-case-banner refund-history-banner">
          <span className="related-case-icon" aria-hidden="true">⚠</span>
          <div className="related-case-body">
            <div className="related-case-title">Customer disagreed with this resolution</div>
            <div className="related-case-desc">
              Support ticket {ownDisagreementTicket.ticketId} is open — the customer was not satisfied with this outcome and asked to escalate.
            </div>
          </div>
        </div>
      )}

      {otherDisagreementTickets.length > 0 && (
        <div className="related-case-banner">
          <span className="related-case-icon" aria-hidden="true">⚠</span>
          <div className="related-case-body">
            <div className="related-case-title">
              {otherDisagreementTickets.length === 1 ? "Open support ticket on this order" : `${otherDisagreementTickets.length} open support tickets on this order`}
            </div>
            <div className="related-case-desc">
              {otherDisagreementTickets.map((ticket, i) => (
                <span key={ticket.caseId}>
                  {i > 0 && "; "}
                  Case {ticket.caseId} — ticket {ticket.ticketId}, opened {timeAgo(ticket.createdAt)}
                </span>
              ))}
              {" "}— a different case on this order was disputed and escalated to support separately.
            </div>
          </div>
          {otherDisagreementTickets.length === 1 && (
            <button type="button" className="related-case-view-btn" onClick={() => router.push(`/runs/${otherDisagreementTickets[0].caseId}`)}>
              View case {otherDisagreementTickets[0].caseId} ↗
            </button>
          )}
        </div>
      )}

      {!isResolved && run.relatedOpenCaseIds && run.relatedOpenCaseIds.length > 0 && (
        <div className="related-case-banner">
          <span className="related-case-icon" aria-hidden="true">⚠</span>
          <div className="related-case-body">
            <div className="related-case-title">
              {run.relatedOpenCaseIds.length === 1 ? "Another open case on this order" : `${run.relatedOpenCaseIds.length} other open cases on this order`}
            </div>
            <div className="related-case-desc">
              {run.relatedOpenCaseIds.map((related, i) => (
                <span key={related.runId}>
                  {i > 0 && ", "}
                  Case {related.runId} opened {timeAgo(related.createdAt)}
                </span>
              ))}
              {" "}— these claims may conflict, so reconcile them before deciding.
            </div>
          </div>
          {run.relatedOpenCaseIds.length === 1 && (
            <button type="button" className="related-case-view-btn" onClick={() => router.push(`/runs/${run.relatedOpenCaseIds![0].runId}`)}>
              View case {run.relatedOpenCaseIds[0].runId} ↗
            </button>
          )}
        </div>
      )}

      {resultMessage && <div className="result-banner">{resultMessage}</div>}

      {isResolved && (
        <div className={`decision-hero decision-hero-${run.outcome}`}>
          <div className="decision-hero-icon">
            <ScaleIcon />
          </div>
          <div>
            <div className="decision-hero-label">Resolved</div>
            <h2 className="decision-hero-headline">
              {run.outcome === "approved"
                ? `A ${formatMoney(run.refundAmount, run.currency)} refund was approved for ${run.orderId}.`
                : run.outcome === "denied"
                  ? `The refund request for ${run.orderId} was rejected.`
                  : run.outcome === "escalated_to_support"
                    ? run.customerDidNotReply
                      ? `The customer did not answer your question about ${run.orderId} in time — a support ticket was opened automatically.`
                      : run.repQuestion
                      ? `You asked the customer a question about ${run.orderId}, but they weren't connected to receive it — a support ticket was opened.`
                      : run.resolvedBy === "rep"
                        ? `A rep sent ${run.orderId} to support — a support ticket was opened.`
                        : `No rep responded in time for ${run.orderId} — a support ticket was opened automatically.`
                    : `Something went wrong resolving ${run.orderId}.`}
            </h2>
            {run.outcomeReason && <p className="decision-hero-desc">{run.outcomeReason}</p>}
            {run.outcome === "approved" && run.requestedAmount !== undefined && run.requestedAmount !== run.refundAmount && (
              <p className="decision-hero-desc">
                Originally requested {formatMoney(run.requestedAmount, run.currency)} — approved as a partial refund.
              </p>
            )}
          </div>
        </div>
      )}

      {!isResolved && (
        <div className="decision-hero">
          <div className="decision-hero-icon">
            <ScaleIcon />
          </div>
          <div>
            <div className="decision-hero-label">Decision needed</div>
            <h2 className="decision-hero-headline">{heroHeadlineFor(run.caseType, run.orderId)}</h2>
            <p className="decision-hero-desc">{run.recommendedAction}</p>
          </div>
        </div>
      )}

      <div className="info-box-grid">
        <div className="info-box">
          <div className="info-box-header">
            <span className="info-box-icon info-box-icon-blue">
              <PersonIcon />
            </span>
            <h3>Customer Request</h3>
          </div>
          <p>{run.problemSummary}</p>
          {!isResolved && <span className="info-box-pill info-box-pill-red">{run.reasonCode.replace(/-/g, " ")}</span>}
        </div>
        <div className="info-box">
          <div className="info-box-header">
            <span className="info-box-icon info-box-icon-green">
              <TruckIcon />
            </span>
            <h3>Shipping Info</h3>
          </div>
          {/* No dedicated shipping field on an open case — a return's label is only
             ever generated at the moment it's approved (issued immediately, not held
             open waiting for the item back), so there's nothing to show here while a
             decision is still pending. The order line already carries the delivery date. */}
          <p>{orderText}</p>
          {deliveredLabel && <span className="info-box-pill info-box-pill-green">{deliveredLabel}</span>}
        </div>
        <div className="info-box">
          <div className="info-box-header">
            <span className="info-box-icon info-box-icon-blue">
              <BoxIcon />
            </span>
            <h3>Order Summary</h3>
          </div>
          <p>{orderText}</p>
          {/* The item's own claim value — requestedAmount when present (a resolved run,
              set from the original ask) so a later partial "modify" doesn't make this box
              read as if the item itself were only ever worth the reduced amount. Falls
              back to refundAmount for an unresolved case, where the two are always equal
              since nothing's been decided yet. */}
          <p className="info-box-amount">{formatMoney(run.requestedAmount ?? run.refundAmount, run.currency)}</p>
          {orderedLabel && <span className="info-box-pill info-box-pill-green">{orderedLabel}</span>}
        </div>
        {isResolved ? (
          // No policy verdict text survives once a run resolves (see server.ts's
          // buildResolvedEntry) — this box shows the actual resolution instead of a
          // Policy Exception there's no longer any data for.
          <div className="info-box info-box-policy">
            <div className="info-box-header">
              <span className={`info-box-icon info-box-icon-${outcomeTone(run.outcome)}`}>
                <ShieldIcon />
              </span>
              <h3>Resolution</h3>
              {run.policy && <PolicyRefBadge policy={run.policy} />}
            </div>
            {/* .info-box-policy p is red by default (right for the unresolved "Policy
                Exception" box below, always framed as a caution) — override it back to
                normal text color whenever the tone above isn't red, so a partial-refund
                or ticketed-but-neutral sentence doesn't read as bad news just because it
                shares the box's CSS class. denied/error keep the inherited red,
                consistent with their red icon/pill right above. */}
            <p className={outcomeTone(run.outcome) !== "red" ? "resolution-text-ok" : undefined}>{resolutionText(run)}</p>
            {run.repComment && (
              <p className={`resolution-rep-message${outcomeTone(run.outcome) !== "red" ? " resolution-text-ok" : ""}`}>
                <strong>Message sent to the customer:</strong> “{run.repComment}”
              </p>
            )}
            <span className={`info-box-pill info-box-pill-${outcomeTone(run.outcome)}`}>
              {OUTCOME_LABEL[run.outcome!]}
            </span>
            {run.resolvedBy && (
              <span className="info-box-pill info-box-pill-blue">
                {run.resolvedBy === "agent" ? "Resolved by Agent" : run.resolvedBy === "rep" ? "Resolved by Rep" : "Auto-ticketed by system"}
              </span>
            )}
          </div>
        ) : (
          <div className="info-box info-box-policy">
            <div className="info-box-header">
              <span className="info-box-icon info-box-icon-red">
                <ShieldIcon />
              </span>
              <h3>Policy Exception</h3>
              {run.policy && <PolicyRefBadge policy={run.policy} />}
            </div>
            <p>{run.explanation}</p>
            <span className="info-box-pill info-box-pill-red">Refund decision pending</span>
          </div>
        )}
      </div>

      <div className="case-context-row">
        {/* No explanation survives a resolved run (see buildResolvedEntry), so
           there's nothing real for "System Info" to show — skip the whole widget
           rather than compare against empty/stale text. */}
        {!isResolved && (
          <div className="side-by-side-block">
            <h3 className="side-by-side-heading">Side by side</h3>
            <div className={`comparison-widget${run.caseType === "delivery_dispute" ? "" : " comparison-widget-no-vs"}`}>
              <div className="comparison-col comparison-col-customer">
                <h4>
                  <span className="info-box-icon info-box-icon-red">
                    <PersonIcon />
                  </span>
                  Customer Info
                </h4>
                <ul>
                  {splitSentences(run.problemSummary).map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ul>
              </div>
              {run.caseType === "delivery_dispute" && <div className="comparison-vs">VS</div>}
              <div className="comparison-col comparison-col-system">
                <h4>
                  <span className="info-box-icon info-box-icon-green">
                    <TruckIcon />
                  </span>
                  System Info
                </h4>
                <ul>
                  {splitSentences(run.explanation).map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        )}

        <div className="case-timeline-box">
          <div className="case-timeline-header">
            <h3>Case timeline</h3>
            <button type="button" className="case-timeline-view-all" onClick={viewFullTimeline}>
              View full timeline →
            </button>
          </div>
          <ul className="case-timeline-list">
            {timelineEntries.map((entry, i) => (
              <li key={i} className="case-timeline-item">
                <span className={`case-timeline-dot case-timeline-dot-${entry.dot}`} aria-hidden="true" />
                <div>
                  <div className="case-timeline-when">{timelineWhen(entry.date)}</div>
                  <div className="case-timeline-label">{entry.label}</div>
                  {entry.desc && <div className="case-timeline-desc">{entry.desc}</div>}
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
      </div>

      <aside className="detail-side">
        <div className="detail-tabs">
          <button type="button" data-active={activeTab === "conversation"} onClick={() => setActiveTab("conversation")}>
            Conversation
          </button>
          <button type="button" data-active={activeTab === "customer"} onClick={() => setActiveTab("customer")}>
            Customer & Order
          </button>
        </div>

        <div className="detail-side-content">
          {activeTab === "conversation" ? (
            <div className="thread-list" ref={threadListRef}>
              {run.transcript.map((msg, i) => (
                <div key={i} className={`thread-row ${msg.role}`}>
                  <span className="thread-avatar">{msg.role === "customer" ? initialsOf(run.customerName) : "WA"}</span>
                  <div className={`thread-msg ${msg.role}`}>
                    <div className="thread-msg-header">
                      <span className="thread-msg-role">{msg.role === "customer" ? run.customerName : AGENT_NAME}</span>
                      {msg.timestamp && <span className="thread-msg-time" title={new Date(msg.timestamp).toLocaleString()}>{timeAgo(msg.timestamp)}</span>}
                    </div>
                    {msg.text}
                    {msg.imageDataUrl && (
                      <button
                        type="button"
                        className="thread-msg-photo-btn"
                        onClick={() => setLightboxSrc(msg.imageDataUrl!)}
                        aria-label="View supporting photo full size"
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element -- a data: URL embedded in the run snapshot, not a file next/image could optimize */}
                        <img src={msg.imageDataUrl} alt="Customer-submitted supporting photo — click to enlarge" className="thread-msg-photo" />
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="customer-order-tab">
              <div className="cust-order-header">
                <span className="cust-order-avatar">{initialsOf(run.customerName)}</span>
                <div>
                  <div className="cust-order-name">
                    {run.customerName}
                    {run.vip && <span className="pill-vip" style={{ marginLeft: 8 }}>VIP</span>}
                  </div>
                  <div className="cust-order-sub">Customer</div>
                </div>
              </div>

              <div className="cust-order-section-label">Order {run.orderId}</div>
              <div className="cust-order-dates">
                {orderText}
                {deliveredDays !== null && ` — ${deliveredDays} day${deliveredDays === 1 ? "" : "s"} since delivery`}
              </div>

              <ul className="cust-order-items">
                {(run.items ?? []).map((item, i) => (
                  <li key={i} className="cust-order-item-row">
                    <span>{item.name}</span>
                    <span className="cust-order-item-price">{formatMoney(item.price, run.currency)}</span>
                  </li>
                ))}
              </ul>

              <div className="cust-order-total-row">
                {/* "Approved amount" (not "Refund amount"): this
                   app only ever knows an approval was recorded, never that a real OMS
                   payment actually completed, so "Refund amount" overclaimed even once
                   resolved. Only accurate once actually resolved+approved
                   (isResolved && outcome === "approved") — every other state here is
                   still pending a decision. Live-reported bug once already: this used
                   to read as if the refund had already happened. */}
                <span>{isResolved && run.outcome === "approved" ? "Approved amount" : "Requested amount"}</span>
                <span>{formatMoney(run.refundAmount, run.currency)}</span>
              </div>
            </div>
          )}
        </div>
      </aside>
      </div>

      {/* A resolved case has nothing left to decide — no floating action bar, so no
         need to reserve space under one either; just normal breathing room at the
         bottom of the page. */}
      {isResolved && <div style={{ height: 40 }} />}

      {!isResolved && (
      <>
      {/* Reserves space at the bottom of the scrollable content so the fixed floating
         action bar below never covers the left column's own last content. Agent Trail
         used to live inline down here too (hence the old, since-removed warning about
         it needing to be the last element before this spacer) — now that it's a
         floating overlay instead, it no longer competes with this spacer for position
         in the document at all. */}
      <div className="detail-floating-spacer" />

      <div className="decision-floating-bar" ref={decisionBarRef}>
        <div className="decision-panel">
            <div className="decision-panel-top">
              <div className="decision-panel-heading">
                <strong>Make a decision</strong>
                <span>Choose the best next step based on the evidence.</span>
              </div>
              <div className="decision-panel-divider" />
              <div className="decision-tabs">
                {(Object.keys(DECISION_LABELS) as DecisionKind[]).map((kind) => {
                  const recommended = kind === recommendedDecisionFor(run.caseType);
                  return (
                    <span key={kind} className="decision-tab-wrap">
                      {recommended && <span className="recommended-badge">Recommended</span>}
                      <button
                        type="button"
                        className="decision-tab"
                        data-decision={kind}
                        data-active={activeDecision === kind}
                        data-recommended={recommended}
                        onClick={() => setActiveDecision(kind)}
                      >
                        {DECISION_LABELS[kind]}
                      </button>
                    </span>
                  );
                })}
              </div>
            </div>

            {activeDecision === "approve" && (
              <>
                {requestItemReturnField}
                <div className="decision-field">
                  <label htmlFor="comment">Message to the customer (optional)</label>
                  <textarea id="comment" rows={2} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Shown to the customer in their chat and in the email — e.g. why the amount differs." />
                </div>
              </>
            )}

            {activeDecision === "reject" && (
              <div className="decision-field">
                <label htmlFor="reason">Reason (optional)</label>
                <textarea id="reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
              </div>
            )}

            {activeDecision === "modify" && (
              <>
                <div className="decision-field">
                  <label htmlFor="modifiedAmount">
                    Modified refund amount ({run.currency})
                    {maxModifyAmount !== undefined && <span className="decision-field-hint"> — up to {formatMoney(maxModifyAmount, run.currency)}</span>}
                  </label>
                  <input
                    id="modifiedAmount"
                    type="number"
                    step="0.01"
                    max={maxModifyAmount}
                    aria-invalid={modifyAmountTooHigh}
                    value={modifiedAmount}
                    onChange={(e) => setModifiedAmount(e.target.value)}
                  />
                  {modifyAmountTooHigh && (
                    <p className="decision-field-error">
                      Can&rsquo;t exceed the covered item(s)&rsquo; value ({formatMoney(maxModifyAmount!, run.currency)}).
                    </p>
                  )}
                </div>
                {requestItemReturnField}
                <div className="decision-field">
                  <label htmlFor="comment">Message to the customer (optional)</label>
                  <textarea id="comment" rows={2} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Shown to the customer in their chat and in the email — e.g. why the amount differs." />
                </div>
              </>
            )}

            {activeDecision === "request_more_info" && (
              <div className="decision-field">
                <label htmlFor="question">Question for the customer</label>
                <textarea id="question" rows={2} value={question} onChange={(e) => setQuestion(e.target.value)} />
                {run.customerConnected === false && (
                  <p className="decision-note" role="note">
                    {run.seeded
                      ? "This is a demo case with no live chat behind it, so the customer cannot see your question. Sending it opens a support ticket and closes the case."
                      : "This customer is not connected to the chat right now, so they cannot see your question. Sending it opens a support ticket (they are emailed) and closes the case."}
                  </p>
                )}
              </div>
            )}

            {activeDecision === "escalate_to_support" && (
              <div className="decision-field">
                <label htmlFor="supportNote">Note for support (optional)</label>
                <textarea id="supportNote" rows={2} value={supportNote} onChange={(e) => setSupportNote(e.target.value)} />
              </div>
            )}

            {activeDecision && (
              <>
                {submitError && <div className="detail-error" style={{ padding: 0, marginBottom: 12 }}>{submitError}</div>}
                <button type="button" className="decision-submit" data-decision={activeDecision} disabled={!canSubmit} onClick={submit}>
                  {submitting ? "Submitting…" : `Submit: ${DECISION_LABELS[activeDecision]}`}
                </button>
              </>
            )}
        </div>
      </div>
      </>
      )}

      <AgentTrail
        spans={trace}
        error={traceError}
        seeded={run.seeded}
        open={agentTrailOpen}
        onToggle={() => setAgentTrailOpen((v) => !v)}
        onClose={() => setAgentTrailOpen(false)}
        bottomOffset={isResolved ? 24 : decisionBarHeight + 16}
      />

      {lightboxSrc && (
        <div className="photo-lightbox" onClick={() => setLightboxSrc(null)}>
          <button type="button" className="photo-lightbox-close" onClick={() => setLightboxSrc(null)} aria-label="Close">
            ×
          </button>
          {/* eslint-disable-next-line @next/next/no-img-element -- a data: URL, not a file next/image could optimize */}
          <img
            src={lightboxSrc}
            alt="Customer-submitted supporting photo, full size"
            className="photo-lightbox-img"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </>
  );
}

// A floating button + expandable panel (bottom-right, pinned just above the decision
// bar — see the caller's own decisionBarRef/ResizeObserver comment) rather than an
// inline, scroll-to-reach section. Named "Agent Trail," not "Activity Log"/"Audit
// Log" — it's every tool call and model interaction behind this case today (still
// genuinely useful, still worth a rep's look), but it isn't a formal audit record yet;
// the name should read as something that could grow into one later without needing
// another rename when it does.
function AgentTrail({
  spans,
  error,
  seeded,
  open,
  onToggle,
  onClose,
  bottomOffset,
}: {
  spans: TraceSpan[] | null;
  error: string | null;
  seeded?: boolean;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  bottomOffset: number;
}) {
  return (
    <>
      <button
        type="button"
        className="agent-trail-fab"
        style={{ bottom: bottomOffset }}
        onClick={onToggle}
        aria-expanded={open}
      >
        Agent Trail {spans ? `(${spans.length})` : ""}
      </button>

      {open && <div className="agent-trail-backdrop" onClick={onClose} />}

      {open && (
        <div className="agent-trail-panel" style={{ bottom: bottomOffset + 44 }}>
          <div className="agent-trail-panel-header">
            <div>
              <strong>Agent Trail</strong>
              <span className="agent-trail-panel-note">every tool call and model interaction behind this case, via Mastra Observability</span>
            </div>
            <button type="button" className="agent-trail-panel-close" onClick={onClose} aria-label="Close">
              ×
            </button>
          </div>
          <div className="agent-trail-panel-body">
            {error && <div className="detail-error" style={{ padding: "8px 0 0" }}>{error}</div>}
            {/* This case was seeded directly for the demo (demo-seed.ts) rather than created
                through a real chat conversation — there's genuinely no tool-call activity to
                show beyond the bare policy decision below, not a broken/incomplete trace. */}
            {!error && seeded && (
              <p className="agent-trail-empty">
                This is a pre-loaded demo case, seeded directly without a real conversation behind it — there's no
                tool-call activity to show beyond the case's own policy decision below.
              </p>
            )}
            {!error && spans && spans.length === 0 && (
              <p className="agent-trail-empty">No traced activity for this run yet.</p>
            )}
            {spans && spans.length > 0 && (
              <ul className="agent-trail-list">
                {spans.map((span) => (
                  <li key={span.spanId} className="agent-trail-row">
                    <span className={`agent-trail-status agent-trail-status-${span.status.toLowerCase()}`}>{span.status}</span>
                    <span className="agent-trail-name">{span.name}</span>
                    <span className="agent-trail-type">{span.spanType}</span>
                    <span className="agent-trail-duration">{span.durationMs !== null ? `${span.durationMs}ms` : "—"}</span>
                    <span className="agent-trail-time">{new Date(span.startedAt).toLocaleTimeString()}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </>
  );
}

// This page is reachable from both the queue and History now — router.back() returns
// to whichever one actually linked here, instead of a hardcoded destination that was
// only ever correct when the queue was the only way in.
function BackLink({ resolved }: { resolved?: boolean }) {
  const router = useRouter();
  return (
    <button className="detail-back" onClick={() => router.back()}>
      ← {resolved ? "History" : "Needs attention"}
    </button>
  );
}
