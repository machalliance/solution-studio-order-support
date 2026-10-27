import type { PolicySynopsis, SynopsisGroup, SynopsisRuleEntry, SynopsisSetting } from "@/lib/api";

// Renders the plain-English synopsis (mastra/policy/synopsis.ts), shaped the way a request is decided:
// RESTRICTIONS first (any one sends the request to a person), grouped by who they apply to; then the
// explicit automatic DECISIONS; then the fallback, which is always a person. Purely descriptive: this
// component never feeds anything back into a decision, it only displays what the server already
// computed from the document's own real fields. Settings are a sibling disclosure (PolicySettingsDetails,
// below) that sits OUTSIDE the scrollable bubble this renders into.

const DECISION_TONE: Record<string, "green" | "red" | "blue"> = {
  autonomous_approve: "green",
  autonomous_deny: "red",
  escalate: "blue",
  always_escalate: "blue",
};

function DecisionBadge({ decision, label }: { decision: string; label: string }) {
  const tone = DECISION_TONE[decision] ?? "blue";
  return <span className={`policy-synopsis-badge policy-synopsis-badge-${tone}`}>{label}</span>;
}

function RuleRow({ rule, whenText }: { rule: SynopsisRuleEntry; whenText?: string }) {
  return (
    <div className="policy-synopsis-rule">
      <div className="policy-synopsis-when">
        {rule.number && <span className="policy-synopsis-number">{rule.number}</span>}
        {whenText ?? rule.when}
      </div>
      <div className="policy-synopsis-then">
        <DecisionBadge decision={rule.decision} label={rule.decisionLabel} /> {rule.then}
      </div>
    </div>
  );
}

function GroupSection({ heading, intro, groups, empty }: { heading: string; intro: string; groups: SynopsisGroup[]; empty?: string }) {
  return (
    <section className="policy-synopsis-section">
      <h3 className="policy-synopsis-heading">{heading}</h3>
      <p className="settings-lede">{intro}</p>
      {groups.length === 0 && empty && <p className="settings-status">{empty}</p>}
      {groups.map((group) => (
        <div key={group.title} className="policy-synopsis-case">
          <h4 className="policy-synopsis-group-title">{group.title}</h4>
          <div className="policy-synopsis-rules">
            {group.rules.map((rule, i) => (
              <RuleRow key={`${rule.number ?? i}`} rule={rule} />
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}

export function PolicySynopsisView({ synopsis }: { synopsis: PolicySynopsis }) {
  return (
    <div className="policy-synopsis">
      {synopsis.description && <p className="settings-lede">{synopsis.description}</p>}

      <GroupSection
        heading="1 · Restrictions"
        intro="Every one of these is checked first. If any applies, a person decides and nothing automatic happens — wherever it sits in the list."
        groups={synopsis.restrictions}
        empty="No restrictions."
      />
      <GroupSection
        heading="2 · Automatic decisions"
        intro="Only when no restriction applied. These are the only rules that approve or decline on their own."
        groups={synopsis.decisions}
        empty="Nothing is decided automatically."
      />
      <section className="policy-synopsis-section">
        <h3 className="policy-synopsis-heading">3 · Otherwise</h3>
        <div className="policy-synopsis-rules">
          <RuleRow rule={synopsis.fallback} whenText="No restriction applied and no rule authorized an automatic outcome" />
        </div>
      </section>
    </div>
  );
}

// The settings list — a SIBLING of the bubble PolicySynopsisView renders inside, not
// nested in it, matching the mockup's own "Policy settings" details positioned after
// .ed-policy-body rather than inside the scrollable rules area. Exported separately so
// each of the three call sites (page.tsx) can place it right after its own bubble.
export function PolicySettingsDetails({ settings }: { settings: SynopsisSetting[] }) {
  if (settings.length === 0) return null;
  return (
    <details className="policy-settings-details">
      <summary>Policy settings</summary>
      {settings.map((s) => (
        <div key={s.name} className="policy-settings-row">
          <span>{s.description}</span>
          <strong>
            <code>{typeof s.value === "boolean" ? (s.value ? "on" : "off") : s.value}</code>
          </strong>
        </div>
      ))}
    </details>
  );
}
