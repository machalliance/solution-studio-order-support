"use client";

// The Policies page's Policy Helper panel, a three-step flow: Describe -> Review -> Apply to
// draft. The operator describes a change in plain language and the agent's Policy Helper
// proposes a whole new document. This component shows only what CHANGED (policy-changes.ts),
// as plain English and as editable JSON (policy-review.ts), validates the edited result with
// the server, and hands the final document to the page's draft editor through onApply. It
// never saves or activates anything itself (the operator still presses Validate & Save in the
// draft editor), and it refuses to apply if the live policy changed while the proposal was
// being reviewed.

import { parsePolicyJson } from "../../../../shared/parse-policy-json";

import { useEffect, useRef, useState } from "react";
import { askPolicyHelper, getPolicyNamespace, validatePolicyDraft, type PolicyDocument } from "@/lib/api";
import { applyChanges, describeChanges, fingerprint, policyChanges, type Change } from "@/lib/policy-changes";

import { createPolicyReview, mergePolicyReview, type PolicyReview } from "@/lib/policy-review";

type Props = { namespace: string; onApply: (document: PolicyDocument) => void; onOpenDraft: () => void };
export function PolicyHelperEditor({ namespace, onApply, onOpenDraft }: Props) {
  const [mounted, setMounted] = useState(false);
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [view, setView] = useState<"english" | "json">("english");
  const [request, setRequest] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [base, setBase] = useState<PolicyDocument | null>(null);
  const [proposal, setProposal] = useState<PolicyDocument | null>(null);
  const [review, setReview] = useState<PolicyReview | null>(null);
  const [activeStamp, setActiveStamp] = useState("");
  const [text, setText] = useState("");
  const [checkedText, setCheckedText] = useState<string | null>(null);
  const [checkedChanges, setCheckedChanges] = useState<Change[]>([]);
  const [busy, setBusy] = useState<"generate" | "validate" | "apply" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const applyLatest = useRef(onApply);
  applyLatest.current = onApply;
  const lock = useRef(false);
  const alive = useRef(true);
  const panel = useRef<HTMLElement>(null);
  useEffect(() => { setMounted(true); alive.current = true; return () => { alive.current = false; }; }, []);
  const valid = checkedText === text && checkedChanges.length > 0;
  async function generate() {
    if (!request.trim() || lock.current) return;
    if (base && !window.confirm("Replace the existing proposal with a newly generated one? Your draft is unchanged.")) return;
    lock.current = true; setBusy("generate"); setError(null);
    try {
      const source = await getPolicyNamespace(namespace);
      const response = await askPolicyHelper(namespace, request.trim());
      if (!alive.current) return;
      if (!response.understood || !response.proposedDocument) throw new Error(response.explanation || "No proposal was returned. Please revise your request.");
      if (!response.baseDocument) throw new Error("The Helper service needs to reload before proposals can be reviewed. Try again shortly.");
      const changes = policyChanges(response.baseDocument, response.proposedDocument);
      if (!changes.length) throw new Error("The Helper proposed no policy changes. Try a more specific request.");
      const nextReview = createPolicyReview(response.baseDocument, response.proposedDocument);
      const json = JSON.stringify(nextReview.json, null, 2);
      setProposal(response.proposedDocument); setReview(nextReview);
      setBase(response.baseDocument); setActiveStamp(fingerprint(source.active)); setSubmitted(request.trim());
      setText(json); setCheckedText(null); setCheckedChanges([]); setStep(2); setView("json");
      const validation = await validatePolicyDraft(namespace, applyChanges(response.baseDocument, changes));
      if (!alive.current) return;
      if (validation.valid) { setCheckedText(json); setCheckedChanges(changes); setView("english"); }
      else setError(validation.issues.map(i => `${i.path}: ${i.message}`).join("\n"));
      panel.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : "Proposal generation failed. Please try again."); }
    finally { lock.current = false; if (alive.current) setBusy(null); }
  }
  async function validate() {
    if (!base || !proposal || !review || lock.current) return;
    lock.current = true; setBusy("validate"); setError(null); setCheckedText(null);
    try {
      const document = mergePolicyReview(proposal, review, parsePolicyJson(text));
      const changes = policyChanges(base, document);
      if (!changes.length) throw new Error("There are no changes to apply.");
      const validation = await validatePolicyDraft(namespace, document);
      if (!alive.current) return;
      if (!validation.valid) throw new Error(validation.issues.map(i => `${i.path}: ${i.message}`).join("\n"));
      setCheckedChanges(changes); setCheckedText(text); setView("english");
    } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : "Validation failed."); }
    finally { lock.current = false; if (alive.current) setBusy(null); }
  }
  async function apply() {
    if (!base || !valid || lock.current) return;
    lock.current = true; setBusy("apply"); setError(null);
    try {
      const latest = await getPolicyNamespace(namespace);
      if (!alive.current) return;
      if (fingerprint(latest.active) !== fingerprint(base) || fingerprint(latest.active) !== activeStamp) throw new Error("The live policy changed while you reviewed. Generate a new proposal from the latest version.");
      const document = applyChanges(base, checkedChanges);
      document.metadata = { ...document.metadata, baseVersion: latest.active?.metadata.version ?? base.metadata.version };
      applyLatest.current(document);
      setStep(3);
    } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : "Could not apply changes."); }
    finally { lock.current = false; if (alive.current) setBusy(null); }
  }
  // Create interactive controls after hydration so restored browser button states
  // cannot disagree with the server markup before React owns these elements.
  if (!mounted) return <section className="policy-card policy-helper-card" aria-label="Policy Helper" aria-busy="true" style={{ minHeight: 360 }}>
    <div className="policy-panel-heading"><h2><span aria-hidden="true">✦ </span>Policy Helper</h2><span className="policy-ai-label">AI ASSISTANT</span></div>
    <p className="settings-lede" role="status">Loading Policy Helper…</p>
  </section>;
  const rows = base && checkedText === text ? describeChanges(base, checkedChanges) : [];
  return <section ref={panel} className="policy-card policy-helper-card" aria-label="Policy Helper">
    <div className="policy-panel-heading"><h2><span aria-hidden="true">✦ </span>Policy Helper</h2><span className="policy-ai-label">AI ASSISTANT</span></div>
    <p className="settings-lede">Describe a change, review its JSON, then add it to the draft editor.</p>
    <ol className="policy-helper-steps" aria-label="Policy Helper progress">
      {(["Describe", "Review", "Apply to draft"] as const).map((label, i) => <li key={label}><button aria-current={step === i + 1 ? "step" : undefined} disabled={!!busy || step === 3 || i === 2 || (i === 1 && !base)} onClick={() => setStep((i + 1) as 1 | 2)}><span>{i + 1}</span>{label}</button></li>)}
    </ol>
    {error && <p className="policy-helper-error" role="alert">{error}</p>}
    {busy && <p role="status" aria-live="polite">{busy === "generate" ? "Preparing your proposal… You’ll move to Review automatically." : busy === "validate" ? "Validating your JSON…" : "Checking the latest draft…"}</p>}
    {step === 1 && <>
      <label className="policy-request-label" htmlFor="helper-request">What would you like to change?</label>
      <textarea id="helper-request" className="settings-input policy-helper-textarea" value={request} onChange={e => setRequest(e.target.value)} disabled={!!busy} rows={5} placeholder="Describe the rule, when it applies, and what should happen." />
      <button className="policy-example" disabled={!!busy} onClick={() => setRequest("If a customer has more than $300 in completed refunds over the last 180 days, escalate an ordinary return for review.")}>Try the 180-day refund-history example ↗</button>
      <button className="settings-save-button policy-generate" disabled={!!busy || !request.trim()} onClick={generate}>{busy === "generate" ? "Preparing proposal…" : base ? "Generate replacement proposal" : "Generate proposal →"}</button>
      <p className="settings-lede">Nothing is saved or activated by this step.</p>
    </>}
    {step === 2 && <>
      <blockquote className="policy-request"><span>Your request</span>{submitted}</blockquote>
      <div className="policy-review-tabs" role="tablist" aria-label="Proposed changes view">
        <button id="helper-english-tab" role="tab" aria-controls="helper-review-content" aria-selected={view === "english"} onClick={() => setView("english")}>English <small>Read-only</small></button>
        <button id="helper-json-tab" role="tab" aria-controls="helper-review-content" aria-selected={view === "json"} onClick={() => setView("json")}>JSON <small>Editable</small></button>
      </div>
      <div id="helper-review-content" role="tabpanel" aria-labelledby={view === "english" ? "helper-english-tab" : "helper-json-tab"}>
        {view === "english" ? valid ? <>
          <p className="settings-lede">Only the proposed changes are shown. This interpretation comes from the validated JSON.</p>
          <p className="policy-change-count">{rows.filter(r => r.action === "Add").length} additions · {rows.filter(r => r.action === "Change").length} changes · {rows.filter(r => r.action === "Remove").length} removals</p>
          <ol className="policy-change-list">{rows.map((r,i) => <li key={i}><strong>{r.action}: {r.label}</strong>{r.before !== undefined && <p><span>Before</span>{r.before}</p>}{r.after !== undefined && <p><span>{r.action === "Add" ? "New" : "After"}</span>{r.after}</p>}</li>)}</ol>
        </> : <p role="status">Validate the edited JSON to update its read-only interpretation.</p> : <>
          <label className="policy-request-label" htmlFor="helper-changes">Proposed policy JSON</label>
          <p className="settings-lede">These are the new or changed entries in the same format as your policy. Edit their values here. The merge preserves the proposed rule order; use the complete draft editor to add or remove other entries.</p>
          <textarea id="helper-changes" className="settings-input policy-change-editor" spellCheck={false} value={text} disabled={!!busy} onChange={e => { setText(e.target.value); setCheckedText(null); setError(null); }} />
        </>}
      </div>
      {review && review.removals.length > 0 && <div className="policy-helper-error"><strong>Also removed by this proposal</strong><ul>{review.removals.map(item => <li key={item}>{item}</li>)}</ul><p>These removals are included when you apply the proposal.</p></div>}
      <div className="settings-row policy-helper-actions">
        <button className="settings-save-button policy-secondary-action" disabled={!!busy} onClick={() => setStep(1)}>Back</button>
        {!valid && <button className="settings-save-button" disabled={!!busy} onClick={validate}>Validate changes</button>}
        <button className="settings-save-button" disabled={!!busy || !valid} onClick={apply}>Apply changes to draft →</button>
      </div>
    </>}
    {step === 3 && <div role="status"><h3>Changes added to the draft editor</h3><p>Not saved or live yet. The complete JSON is open in the draft editor below — Validate &amp; Save it to make it live, before starting another request.</p><div className="settings-row"><button className="settings-save-button" onClick={onOpenDraft}>Go to draft editor</button><button className="settings-save-button policy-secondary-action" onClick={() => {setStep(1);setBase(null);setProposal(null);setReview(null);setText("");setCheckedText(null);setCheckedChanges([]);setError(null);}}>Start another request</button></div></div>}
  </section>;
}