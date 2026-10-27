"use client";
import { parsePolicyJson } from "../../../../../shared/parse-policy-json";


import { useEffect, useRef, useState } from "react";
import { getPolicyNamespace, activatePolicyDraft, revertPolicyVersion, type PolicyNamespaceState, type PolicyDocument, type ValidationResult } from "@/lib/api";
import { PolicyHelperEditor } from "@/components/PolicyHelperEditor";
import { PolicyJson } from "@/components/PolicyJson";
import { PolicySynopsisView, PolicySettingsDetails } from "@/components/PolicySynopsisView";

// The live policy, and the one way to change it. Deliberately simple:
// no namespace switcher ("Policy workspace"), no saved drafts, no separate
// Validate / Save / Activate buttons — the draft editor loads the live policy JSON and has
// a single "Validate & Save": valid → it becomes the new live version immediately (the
// agent's /activate route validates it again server-side); invalid → the issues are shown
// and nothing changes. The Policy Helper's proposals drop into the same editor.
//
// "demo" is the live namespace — its active version (policy.json) decides every real case
// (agent side: mastra/policy/live-policy.ts). Other namespaces still exist on the agent as
// API-only sandboxes; this page no longer switches to them.
const LIVE_POLICY_NAMESPACE = "demo";
export default function PoliciesPage() {
  // "Policy" (the live policy + Helper + editor) vs. "Version history" — tabs per explicit
  // user request.
  const [activeTab, setActiveTab] = useState<"policy" | "history">("policy");
  const [state, setState] = useState<PolicyNamespaceState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // The draft editor — the complete policy JSON, loaded from the live version.
  const [editorJson, setEditorJson] = useState("");
  const [editorDirty, setEditorDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [issues, setIssues] = useState<ValidationResult["issues"] | null>(null);
  const dirtyRef = useRef(false);
  // The live version the editor's text was loaded from — sent as the new version's
  // baseVersion, so saving over a version someone else activated meanwhile is rejected as
  // stale instead of silently overwriting it.
  const loadedFrom = useRef<{ version: number; description?: string } | null>(null);
  const editorDetails = useRef<HTMLDetailsElement>(null);
  const editorText = useRef<HTMLTextAreaElement>(null);

  function markDirty(value: boolean) {
    dirtyRef.current = value;
    setEditorDirty(value);
  }
  function openEditor() {
    if (editorDetails.current) editorDetails.current.open = true;
    editorDetails.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    editorText.current?.focus({ preventScroll: true });
  }
  function applyHelperDraft(document: PolicyDocument) {
    if (saving) throw new Error("Wait for the current save to finish.");
    if (dirtyRef.current) throw new Error("The draft editor has unsaved edits. Save or discard them before applying this proposal.");
    setEditorJson(JSON.stringify(document, null, 2));
    markDirty(true); setEditorError(null); setIssues(null);
    setActionMessage("Helper changes added to the editor. Nothing is live yet — Validate & Save to make them live.");
    openEditor();
  }

  const loadSequence = useRef(0);
  function load() {
    const sequence = ++loadSequence.current;
    setLoadError(null);
    setLoading(true);
    getPolicyNamespace(LIVE_POLICY_NAMESPACE)
      .then((value) => { if (sequence === loadSequence.current) setState(value); })
      .catch((err) => { if (sequence === loadSequence.current) setLoadError(err instanceof Error ? err.message : "Failed to load the policy"); })
      .finally(() => { if (sequence === loadSequence.current) setLoading(false); });
  }
  useEffect(() => { load(); }, []);

  // Keep the editor showing the live policy unless someone is mid-edit.
  useEffect(() => {
    if (!state?.active || dirtyRef.current) return;
    setEditorJson(JSON.stringify(state.active, null, 2));
    loadedFrom.current = { version: state.active.metadata.version, description: state.active.metadata.description };
  }, [state]);

  async function handleValidateAndSave() {
    let document: PolicyDocument;
    try {
      document = parsePolicyJson(editorJson) as PolicyDocument;
    } catch (err) {
      setEditorError(err instanceof Error ? `Invalid JSON: ${err.message}` : "Invalid JSON");
      return;
    }
    setSaving(true); setEditorError(null); setIssues(null); setActionMessage(null);
    try {
      const base = loadedFrom.current;
      const description = document.metadata?.description;
      const candidate: PolicyDocument = {
        ...document,
        metadata: {
          ...document.metadata,
          ...(base ? { baseVersion: base.version } : {}),
          description: description && description !== base?.description ? description : "Saved from the Policies page editor.",
        },
      };
      const result = await activatePolicyDraft(LIVE_POLICY_NAMESPACE, candidate);
      if (result.ok) {
        markDirty(false);
        setActionMessage(`Saved — version ${result.version} is now the live policy.`);
        load();
      } else {
        setIssues(result.issues);
      }
    } catch (err) {
      setEditorError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  // Version history → Revert. History-keeping: the older version's content becomes a NEW live
  // version, and the version it replaces stays in history, so nothing is lost and a revert can
  // itself be reverted. Blocked while the draft editor has unsaved edits — reverting would
  // silently change the live policy those edits were written against.
  const [revertTarget, setRevertTarget] = useState<number | null>(null);
  const [reverting, setReverting] = useState(false);
  const [historyMessage, setHistoryMessage] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);

  function requestRevert(version: number) {
    setHistoryMessage(null);
    if (dirtyRef.current) {
      setHistoryError("The draft editor has unsaved edits. Save them, or reload the page to discard them, before reverting.");
      return;
    }
    setHistoryError(null);
    setRevertTarget(version);
  }
  async function handleRevert(version: number) {
    const was = state?.active?.metadata.version;
    setReverting(true); setHistoryError(null); setHistoryMessage(null);
    try {
      const result = await revertPolicyVersion(LIVE_POLICY_NAMESPACE, version);
      if (result.ok) {
        setRevertTarget(null);
        setHistoryMessage(`Reverted — version ${result.version} is now live, with the policy from version ${version}.${was ? ` Version ${was} stays in history.` : ""}`);
        load();
      } else {
        setHistoryError(result.issues.map((issue) => issue.message).join(" "));
      }
    } catch (err) {
      setHistoryError(err instanceof Error ? err.message : "Revert failed");
    } finally {
      setReverting(false);
    }
  }

  return (
    <div className="settings-page policy-refined">
      <div className="queue-header">
        <h1>Policies</h1>
        <p>
          Understand the current policy. Describe a change, review it, then choose what to activate.
        </p>
      </div>

      <div className="policy-tabs" role="tablist" aria-label="Policy views">
        <button role="tab" aria-selected={activeTab === "policy"} onClick={() => setActiveTab("policy")} suppressHydrationWarning>
          Policy
        </button>
        <button role="tab" aria-selected={activeTab === "history"} onClick={() => setActiveTab("history")} suppressHydrationWarning>
          Version history <span className="policy-tab-count">{state?.versions.length ?? 0}</span>
        </button>
      </div>

      <div hidden={activeTab !== "policy"}>
      <div className="policy-columns">
      <section className="policy-card">
        <div className="policy-panel-heading"><h2>Current policy</h2>{state?.active && <span className="policy-label">Version {state.active.metadata.version}</span>}</div>
        {loading ? <p role="status">Loading current policy…</p> : loadError ? <div role="alert"><p>{loadError}</p><button className="settings-save-button" onClick={load}>Try again</button></div> : state?.active ? (
          <>
            <p className="settings-lede">Version {state.active.metadata.version} — {state.active.metadata.description ?? "no description"}</p>
            {state.activeSynopsis && (
              <>
                <div className="policy-bubble">
                  <PolicySynopsisView synopsis={state.activeSynopsis} />
                </div>
                <PolicySettingsDetails settings={state.activeSynopsis.settings} />
              </>
            )}
            <details className="policy-document-preview">
              <summary>View full JSON</summary>
              <PolicyJson value={state.active} />
            </details>
          </>
        ) : (
          <p className="settings-status">No live policy found.</p>
        )}
      </section>

      <PolicyHelperEditor namespace={LIVE_POLICY_NAMESPACE} onApply={applyHelperDraft} onOpenDraft={openEditor} />
      </div>

      <section className="policy-card policy-manual-card">
        <details ref={editorDetails} className="policy-manual-edit-details">
          <summary>Draft editor · complete policy {editorDirty && <span className="policy-label">Unsaved edits</span>}</summary>
          <p className="settings-lede">
            The complete live policy. Edit it, then Validate &amp; Save — if it&rsquo;s valid it becomes the new live
            version right away; if not, the problems are listed and nothing changes. Reload the page to discard edits.
          </p>
          <textarea
            ref={editorText} disabled={saving} className="settings-input policy-manual-editor"
            value={editorJson}
            onChange={(e) => {
              setEditorJson(e.target.value); markDirty(true); setActionMessage(null); setIssues(null);
            }}
            spellCheck={false}
            autoComplete="off"
            suppressHydrationWarning
          />
          {actionMessage && <p className="settings-status" role="status">{actionMessage}</p>}
          {editorError && <p className="settings-status">{editorError}</p>}
          {issues && (
            <div className="policy-validation-error">
              <p>Not saved — validation failed:</p>
              <ul>
                {issues.map((issue, i) => (
                  <li key={i}>
                    <code>{issue.path}</code>: {issue.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="settings-row">
            <button className="settings-save-button" onClick={handleValidateAndSave} disabled={saving || !editorJson.trim()} suppressHydrationWarning>
              {saving ? "Saving…" : "Validate & Save"}
            </button>
          </div>
        </details>
      </section>
      </div>

      {activeTab === "history" && (
      <section className="policy-card">
        <h2>Version history</h2>
        {historyMessage && <p className="settings-status" role="status">{historyMessage}</p>}
        {historyError && <p className="settings-status" role="alert">{historyError}</p>}
        {state && state.versions.length > 0 ? (
          <ul className="policy-version-list">
            {state.versions.map((v) => {
              const liveVersion = state.active?.metadata.version;
              const isLive = v.version === liveVersion;
              return (
                <li key={v.version}>
                  <div className="policy-version-row">
                    <span className="policy-version-text">
                      v{v.version} — {new Date(v.createdAt).toLocaleString()}
                      {v.description ? ` — ${v.description}` : ""}
                    </span>
                    {isLive ? (
                      <span className="policy-label">Live</span>
                    ) : revertTarget !== v.version ? (
                      <button className="settings-save-button policy-secondary-action" disabled={reverting} onClick={() => requestRevert(v.version)} suppressHydrationWarning>
                        Revert to this version
                      </button>
                    ) : null}
                  </div>
                  {revertTarget === v.version && (
                    <div className="policy-revert-confirm" role="group" aria-label={`Confirm revert to version ${v.version}`}>
                      <p>
                        Make version {v.version} the live policy again? Everything changed since then (up to version {liveVersion}) stops
                        being live. It all stays in history, so you can revert again.
                      </p>
                      <div className="settings-row">
                        <button className="settings-save-button" disabled={reverting} onClick={() => handleRevert(v.version)} suppressHydrationWarning>
                          {reverting ? "Reverting…" : `Revert to version ${v.version}`}
                        </button>
                        <button className="settings-save-button policy-secondary-action" disabled={reverting} onClick={() => setRevertTarget(null)} suppressHydrationWarning>
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="settings-status">No versions yet.</p>
        )}
      </section>
      )}
    </div>
  );
}
