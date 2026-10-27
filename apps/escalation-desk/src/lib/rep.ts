// The "logged in" rep. There is no real auth in this prototype, so this is a cosmetic label — but the NAME is not
// written anywhere in the Desk's code: it is WISMO_REP_NAME in .env, served by the agent (GET /rep) and read here at
// run time. (Reading it from the agent rather than from the Desk's own environment keeps it correct under Docker too,
// where a NEXT_PUBLIC_ value would be frozen into the build.) Not tied to who resolves a case — a rep's decision
// records no reviewer identity today.
import { useEffect, useState } from "react";
import { getRep } from "@/lib/api";

export interface Rep {
  name: string;
  initials: string;
  status: "online" | "away" | "offline";
}

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts[parts.length - 1]?.[0] ?? "")).toUpperCase();
}

// One request per page load, shared by everything that shows the rep; a failed request is not remembered, so the next
// caller tries again.
let loading: Promise<Rep> | undefined;
function loadRep(): Promise<Rep> {
  loading ??= getRep()
    .then(({ name }) => ({ name, initials: initialsOf(name), status: "online" as const }))
    .catch((error) => {
      loading = undefined;
      throw error;
    });
  return loading;
}

// null until the name has arrived (or if the agent can't be reached) — callers render nothing, or a generic label, for it.
export function useRep(): Rep | null {
  const [rep, setRep] = useState<Rep | null>(null);
  useEffect(() => {
    let active = true;
    loadRep().then((loaded) => active && setRep(loaded)).catch(() => {});
    return () => {
      active = false;
    };
  }, []);
  return rep;
}
