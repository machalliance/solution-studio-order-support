"use client";

import { useRep } from "@/lib/rep";

// The top-right "someone's logged in" touch from the reference mockup. No real auth in this prototype; the name is
// WISMO_REP_NAME from .env (lib/rep.ts). Renders nothing until the name has arrived rather than flashing a placeholder.
export function RepStub() {
  const rep = useRep();
  if (!rep) return null;
  return (
    <span className="rep-stub">
      <span className="rep-stub-avatar" aria-hidden="true">{rep.initials}</span>
      <span className="rep-stub-info">
        <span className="rep-stub-name">{rep.name}</span>
        <span className={`rep-stub-status rep-stub-status-${rep.status}`}>
          <span className="rep-stub-dot" aria-hidden="true" />
          {rep.status[0].toUpperCase() + rep.status.slice(1)}
        </span>
      </span>
    </span>
  );
}
