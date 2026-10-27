"use client";

// The storefront's top bar: the Waybound wordmark, the nav links, a greeting for the demo
// customer, and a menu toggle that shows the same links on a phone.

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { Customer } from "@/lib/api";
import { WaymarkIcon } from "./WaymarkIcon";

function MenuIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M4 7h16M4 12h16M4 17h16" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}

const LINKS = [
  { href: "/", label: "Home" },
  { href: "/#collection", label: "Shop" },
  { href: "/account", label: "Account" },
];

export function SiteHeader({ customer }: { customer: Customer | null }) {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className="site-bar">
      <span className="site-wordmark-group">
        <WaymarkIcon size={58} />
        <span className="site-wordmark">WAYBOUND</span>
      </span>

      <nav className="site-nav">
        {LINKS.map((link) => (
          <Link key={link.href} href={link.href} data-active={pathname === link.href}>
            {link.label}
          </Link>
        ))}
      </nav>

      <span className="site-bar-spacer" />

      {customer && (
        <span className="site-account">
          Hi, <strong>{customer.name.split(" ")[0]}</strong>
        </span>
      )}

      <button
        className="site-menu-toggle"
        onClick={() => setMenuOpen((v) => !v)}
        aria-expanded={menuOpen}
        aria-label={menuOpen ? "Close menu" : "Open menu"}
      >
        {menuOpen ? <CloseIcon /> : <MenuIcon />}
      </button>

      {menuOpen && (
        <nav className="site-menu-mobile" aria-label="Mobile">
          {LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              data-active={pathname === link.href}
              onClick={() => setMenuOpen(false)}
            >
              {link.label}
            </Link>
          ))}
        </nav>
      )}
    </div>
  );
}
