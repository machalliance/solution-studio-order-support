"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { InboxIcon, HistoryIcon, FileCheckIcon, SettingsIcon } from "./icons";

// Deliberately just these four — no "Customers" or "Orders" items the way the reference
// mockup (new_ED_UI.png) had, per explicit scope call: this app has no customer/order
// management surface, only lookup through existing cases, so a nav item implying one
// would point at nothing. History and Policies are placeholder routes for now (Phases 5
// and 6 of the same pass this nav redesign belongs to) — linked here already so the
// sidebar doesn't need a second pass once they're built out.
const LINKS = [
  { href: "/", label: "Needs attention", Icon: InboxIcon },
  { href: "/history", label: "History", Icon: HistoryIcon },
  { href: "/policies", label: "Policies", Icon: FileCheckIcon },
  { href: "/settings", label: "Settings", Icon: SettingsIcon },
];

export function DeskNav() {
  const pathname = usePathname();
  return (
    <nav className="desk-sidebar-links" aria-label="Escalation Desk">
      {LINKS.map(({ href, label, Icon }) => (
        <Link key={href} href={href} data-active={pathname === href}>
          <Icon className="desk-sidebar-link-icon" />
          {label}
        </Link>
      ))}
    </nav>
  );
}
