import { useId } from "react";
import type { PolicyRef } from "@/lib/api";

// The policy rule that decided a case, by its P-number. Hover (or focus/tap — a button, so it
// works on a phone too) shows the rule's plain-English wording as it stood when it decided
// this case, snapshotted by the agent (live-policy.ts), so later policy edits don't rewrite
// what a past case says.
export function PolicyRefBadge({ policy }: { policy: PolicyRef }) {
  const tipId = useId();
  return (
    <span className="policy-ref">
      <button type="button" className="policy-ref-number" aria-describedby={tipId}>
        {policy.number}
      </button>
      <span role="tooltip" id={tipId} className="policy-ref-text">
        <strong>{policy.number}</strong> · {policy.text}
        {policy.basis === "conflict" && <span className="policy-ref-version">Two automatic rules disagreed, so a person decided.</span>}
        {policy.matches && policy.matches.length > 1 && (
          <span className="policy-ref-version">Also matched: {policy.matches.filter((m) => m.number !== policy.number).map((m) => m.number ?? m.id).join(", ")}</span>
        )}
        <span className="policy-ref-version">Policy version {policy.version}</span>
      </span>
    </span>
  );
}
