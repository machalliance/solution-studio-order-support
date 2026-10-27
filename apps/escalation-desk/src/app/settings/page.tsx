"use client";

import { useEffect, useState } from "react";
import { getSettings, updateSettings, resetDemoData } from "@/lib/api";
import { formatMoney } from "@/lib/money";

// Everything that lives OUTSIDE the policy document: the response-window timings, the
// queue's high-priority threshold (sorting, not policy), and the System Authority backstop
// (no automatic approval above $X). Everything that decides a
// case — return limits, damaged-item defaults, the autonomy on/off switches — is edited on
// the Policies page instead; per explicit user instruction, nothing is set in both places.
// In-memory only on the agent (runtime-settings.ts) — a server restart resets everything
// here back to its env-var default.
export default function SettingsPage() {
  const [error, setError] = useState<string | null>(null);
  const [currency, setCurrency] = useState("USD");

  const [slaMinutes, setSlaMinutes] = useState("");
  const [contactHours, setContactHours] = useState("");
  const [savingSla, setSavingSla] = useState(false);
  const [slaMessage, setSlaMessage] = useState<string | null>(null);

  // The System Authority backstop — beneath whatever the policy decides
  // (mastra/system-authority.ts on the agent side); no policy edit can exceed it.
  const [maxAutonomousAmount, setMaxAutonomousAmount] = useState("");

  const [priorityThreshold, setPriorityThreshold] = useState("");
  const [savingPriority, setSavingPriority] = useState(false);
  const [priorityMessage, setPriorityMessage] = useState<string | null>(null);
  const [savingAuthority, setSavingAuthority] = useState(false);
  const [authorityMessage, setAuthorityMessage] = useState<string | null>(null);

  const [resetting, setResetting] = useState(false);
  const [resetMessage, setResetMessage] = useState<string | null>(null);

  useEffect(() => {
    getSettings()
      .then((s) => {
        setSlaMinutes(String(s.escalationSlaMinutes));
        setContactHours(String(s.supportTicketContactHours));
        setMaxAutonomousAmount(String(s.maxAutonomousAmount));
        setPriorityThreshold(String(s.highPriorityAmountThreshold));
        setCurrency(s.currency);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load settings"));
  }, []);

  async function handleSaveSla() {
    const minutes = Number(slaMinutes);
    const hours = Number(contactHours);
    if (!Number.isFinite(minutes) || minutes <= 0 || !Number.isFinite(hours) || hours <= 0) {
      setSlaMessage("Enter a positive number for both fields.");
      return;
    }
    setSavingSla(true);
    setSlaMessage(null);
    try {
      const result = await updateSettings({ escalationSlaMinutes: minutes, supportTicketContactHours: hours });
      setSlaMinutes(String(result.escalationSlaMinutes));
      setContactHours(String(result.supportTicketContactHours));
      setSlaMessage(
        `Saved — new escalations now get ${result.escalationSlaMinutes} minute${result.escalationSlaMinutes === 1 ? "" : "s"} before auto-opening a support ticket, and customers are told to expect a reply within ${result.supportTicketContactHours} hour${result.supportTicketContactHours === 1 ? "" : "s"} of that.`
      );
    } catch (err) {
      setSlaMessage(err instanceof Error ? err.message : "Failed to save.");
    } finally {
      setSavingSla(false);
    }
  }

  async function handleSavePriority() {
    const amount = Number(priorityThreshold);
    if (!Number.isFinite(amount) || amount < 0) {
      setPriorityMessage("Enter a non-negative amount.");
      return;
    }
    setSavingPriority(true);
    setPriorityMessage(null);
    try {
      const result = await updateSettings({ highPriorityAmountThreshold: amount });
      setPriorityThreshold(String(result.highPriorityAmountThreshold));
      setCurrency(result.currency);
      setPriorityMessage(
        result.highPriorityAmountThreshold === 0
          ? "Saved — new cases are no longer marked high priority by amount. Delivery disputes still are."
          : `Saved — new escalated refunds and returns above ${formatMoney(result.highPriorityAmountThreshold, result.currency)} are marked high priority and sort to the top of the queue.`
      );
    } catch (err) {
      setPriorityMessage(err instanceof Error ? err.message : "Failed to save.");
    } finally {
      setSavingPriority(false);
    }
  }

  async function handleSaveAuthority() {
    const amount = Number(maxAutonomousAmount);
    if (!Number.isFinite(amount) || amount < 0) {
      setAuthorityMessage("Enter a non-negative amount.");
      return;
    }
    setSavingAuthority(true);
    setAuthorityMessage(null);
    try {
      const result = await updateSettings({ maxAutonomousAmount: amount });
      setMaxAutonomousAmount(String(result.maxAutonomousAmount));
      setCurrency(result.currency);
      setAuthorityMessage(
        result.maxAutonomousAmount === 0
          ? "Saved — no approval can happen automatically now. Every approval needs a rep, whatever the policy says."
          : `Saved — an automatic approval above ${formatMoney(result.maxAutonomousAmount, result.currency)} always needs a rep, whatever the policy says.`
      );
    } catch (err) {
      setAuthorityMessage(err instanceof Error ? err.message : "Failed to save.");
    } finally {
      setSavingAuthority(false);
    }
  }

  async function handleReset() {
    if (!window.confirm("This clears every case in the queue and reseeds the demo scenarios. Continue?")) return;
    setResetting(true);
    setResetMessage(null);
    try {
      const result = await resetDemoData();
      setResetMessage(`Done — cleared ${result.deletedRuns} case${result.deletedRuns === 1 ? "" : "s"}, seeded ${result.createdCases} new one${result.createdCases === 1 ? "" : "s"}.`);
    } catch (err) {
      setResetMessage(err instanceof Error ? err.message : "Reset failed.");
    } finally {
      setResetting(false);
    }
  }

  return (
    <div className="settings-page">
      <div className="queue-header">
        <h1>Settings</h1>
        <p>System limits and operating settings — business policy itself is on the Policies page. Changes take effect immediately, not persisted across a server restart.</p>
      </div>

      {error && <div className="detail-error">Couldn&rsquo;t reach the agent API: {error}</div>}

      <section className="settings-section">
        <h2>Support Response Window</h2>
        <p className="settings-lede">
          How long a specialist has to respond to an escalated case, or a customer has to answer a specialist&rsquo;s
          question, before it automatically opens a support ticket instead — shown to the customer as a live
          countdown in their chat — and what they&rsquo;re then told to expect once it actually has.
        </p>
        <div className="settings-row">
          <input
            type="number"
            min="1"
            step="1"
            className="settings-input"
            value={slaMinutes}
            onChange={(e) => setSlaMinutes(e.target.value)}
            aria-label="Support response window, in minutes"
          />
          <span className="settings-unit">minutes to respond, then</span>
          <input
            type="number"
            min="1"
            step="1"
            className="settings-input"
            value={contactHours}
            onChange={(e) => setContactHours(e.target.value)}
            aria-label="Support ticket contact window, in hours"
          />
          <span className="settings-unit">hours to follow up</span>
        </div>
        <button className="settings-save-button" onClick={handleSaveSla} disabled={savingSla}>
          {savingSla ? "Saving…" : "Save"}
        </button>
        {slaMessage && <p className="settings-status">{slaMessage}</p>}
      </section>

      <section className="settings-section">
        <h2>Queue Priority</h2>
        <p className="settings-lede">
          Escalated refunds and returns above this amount are marked high priority and sort to the top of the
          queue. Delivery disputes are always high priority. This only orders the queue — it never changes a
          decision. 0 turns it off.
        </p>
        <div className="settings-row">
          <span className="settings-unit">High priority above</span>
          <input
            type="number"
            min="0"
            step="1"
            className="settings-input"
            value={priorityThreshold}
            onChange={(e) => setPriorityThreshold(e.target.value)}
            aria-label={`High-priority threshold, in ${currency}`}
          />
          <span className="settings-unit">{currency}, 0 = off</span>
        </div>
        <button className="settings-save-button" onClick={handleSavePriority} disabled={savingPriority}>
          {savingPriority ? "Saving…" : "Save"}
        </button>
        {priorityMessage && <p className="settings-status">{priorityMessage}</p>}
      </section>

      <section className="settings-section">
        <h2>System Authority</h2>
        <p className="settings-lede">
          The one limit that sits outside the policy: no approval above this amount ever happens
          automatically, whatever the active policy says. Set it to 0 to stop every automatic approval at
          once. Everything else that decides a case — return limits, damaged-item defaults, and the
          autonomy switches — is on the Policies page.
        </p>
        <div className="settings-row">
          <span className="settings-unit">No autonomous approval above</span>
          <input
            type="number"
            min="0"
            step="1"
            className="settings-input"
            value={maxAutonomousAmount}
            onChange={(e) => setMaxAutonomousAmount(e.target.value)}
            aria-label={`Maximum autonomous approval amount, in ${currency}`}
          />
          <span className="settings-unit">{currency}</span>
        </div>
        <button className="settings-save-button" onClick={handleSaveAuthority} disabled={savingAuthority}>
          {savingAuthority ? "Saving…" : "Save"}
        </button>
        {authorityMessage && <p className="settings-status">{authorityMessage}</p>}
      </section>

      <section className="settings-section">
        <h2>Demo Data</h2>
        <p className="settings-lede">
          Clears every case in this queue and reseeds a fresh set — a few scripted customers, a couple under
          the storefront&rsquo;s own demo account, with damage photos where the scenario calls for one.
        </p>
        <button className="settings-save-button" onClick={handleReset} disabled={resetting}>
          {resetting ? "Resetting…" : "Reset demo data"}
        </button>
        {resetMessage && <p className="settings-status">{resetMessage}</p>}
      </section>
    </div>
  );
}
