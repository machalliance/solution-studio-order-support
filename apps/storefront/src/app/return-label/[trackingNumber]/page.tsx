"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { getMe, getReturnLabel, type Customer, type ReturnLabelInfo } from "@/lib/api";
import { SiteHeader } from "@/components/SiteHeader";
import { SiteFooter } from "@/components/SiteFooter";
import { ChatWidget } from "@/components/ChatWidget";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

// The one landing page every return-label link (chat replies, the Escalation Desk's own
// case detail view) points at — mirrors /track/[trackingNumber]'s exact shape: one route,
// real order data resolved server-side from the tracking number (GET
// /returns/:trackingNumber), no login required, since the number itself is the
// capability, same as a real carrier's own tracking/label page. Replaces an earlier
// version that pointed straight at a nonexistent "https://labels.example.com/...pdf" —
// clicking it just 404'd, since nothing was ever behind that URL.
export default function ReturnLabelPage() {
  // Next.js's useParams() hands back the RAW, still-percent-encoded path segment for a
  // dynamic route, not the decoded value — confirmed live: a multi-item return's
  // tracking number (RTN-004203_pants-002+belt-001, joined with a literal "+" — see
  // shipping.ts's generateReturnLabel) came back from useParams() as
  // "...pants-002%2Bbelt-001" verbatim, which then failed to parse on the agent side
  // (itemIdsFromReturnTrackingNumber splits on a literal "+", not "%2B") and displayed
  // the encoded form to the customer. decodeURIComponent once here fixes both.
  const { trackingNumber: rawTrackingNumber } = useParams<{ trackingNumber: string }>();
  const trackingNumber = decodeURIComponent(rawTrackingNumber);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [label, setLabel] = useState<ReturnLabelInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getMe()
      .then((data) => setCustomer(data.customer))
      .catch(() => {});
    getReturnLabel(trackingNumber)
      .then(setLabel)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load this return label"));
  }, [trackingNumber]);

  // window.print() opens the browser's real OS print dialog — that dialog IS the
  // feedback that the click did something, so no extra on-page indicator is needed
  // alongside it. An earlier version added a "Printing…" toast here on the assumption
  // that nothing real would visibly happen on click; once print is a real, visible
  // native dialog, a toast on top of it is redundant, not a fallback for a case that
  // doesn't exist.
  function handlePrint() {
    window.print();
  }

  return (
    <>
      <SiteHeader customer={customer} />

      <div className="page">
        <h2>Your return label</h2>
        <p className="page-lede">Return tracking number {trackingNumber}</p>

        {error && <p className="tracking-error">{error}</p>}

        {!error && !label && <p className="page-lede">Loading your return label…</p>}

        {label && (
          <div className="tracking-card">
            <div className="tracking-card-top">
              <span className="tracking-status tracking-status-return">Ready to ship</span>
              <span className="tracking-number">{label.returnTrackingNumber}</span>
            </div>

            <div className="tracking-product">{label.items}</div>

            <dl className="tracking-details">
              <div className="tracking-detail">
                <dt>Order placed</dt>
                <dd>{formatDate(label.orderDate)}</dd>
              </div>
              <div className="tracking-detail">
                <dt>Order ID</dt>
                <dd className="tracking-order-id">{label.orderId}</dd>
              </div>
            </dl>

            <p className="return-label-instructions">
              Attach this label to your package and drop it off at any carrier location. Your refund issues
              automatically once we receive it back.
            </p>

            <button type="button" className="return-label-print" onClick={handlePrint}>
              Print label
            </button>
          </div>
        )}
      </div>

      <SiteFooter />
      <ChatWidget />
    </>
  );
}
