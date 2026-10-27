// Root layout for every Escalation Desk page: the top bar (navigation, and the signed-in rep's
// name from the agent's GET /rep) plus TimeoutPoller, which calls the agent's SLA sweep
// (POST /escalations/check-timeouts) every 30s while any Desk page is open. That sweep is
// what turns an unanswered case into a support ticket.

import type { Metadata } from "next";
import { TimeoutPoller } from "@/components/TimeoutPoller";
import { DeskNav } from "@/components/DeskNav";
import { RepStub } from "@/components/RepStub";
import "./globals.css";

export const metadata: Metadata = {
  title: "Escalation Desk — WISMO",
  description: "Human-in-the-loop review console for WISMO's escalated support cases.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Montserrat:ital,wght@0,300;0,400;0,500;0,600;0,700;1,400&family=JetBrains+Mono:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <TimeoutPoller />
        <div className="desk-shell">
          {/* No top nav tabs — per explicit scope call, replacing the old horizontal bar
              (Queue / Settings tabs) with this sidebar. The only thing still along the
              top is the rep-identity stub below, in its own slim strip above the page
              content — search stays where it already lives, inline atop the queue list
              itself, since it only ever makes sense on that one page. */}
          <aside className="desk-sidebar">
            <a className="nav-brand" href="https://machalliance.org/" target="_blank" rel="noopener noreferrer" title="MACH Alliance">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/mach-logo.svg" alt="MACH Alliance" />
              <span className="nav-logo">Escalation Desk</span>
            </a>
            <DeskNav />
            <span className="desk-sidebar-spacer" />
            <span className="nav-meta">WISMO · Agent Solution Studio</span>
          </aside>
          <div className="desk-content">
            <div className="desk-topbar">
              <span className="desk-topbar-spacer" />
              <RepStub />
            </div>
            <main className="desk-main">{children}</main>
          </div>
        </div>
      </body>
    </html>
  );
}
