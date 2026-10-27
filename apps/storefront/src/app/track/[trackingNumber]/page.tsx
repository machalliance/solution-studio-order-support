"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { getMe, getTracking, type Customer, type ShipmentInfo } from "@/lib/api";
import { SiteHeader } from "@/components/SiteHeader";
import { SiteFooter } from "@/components/SiteFooter";
import { ChatWidget } from "@/components/ChatWidget";

const STATUS_LABEL: Record<ShipmentInfo["status"], string> = {
  delivered: "Delivered",
  in_transit: "In transit",
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

// The one landing page every tracking link (chat replies, the fake "email" a real
// carrier would send) points at — one route, one template, real order/shipment data
// resolved server-side from the tracking number (see apps/agent's GET
// /tracking/:trackingNumber). No login required, same as a real carrier's tracking page:
// the number itself is the capability.
export default function TrackingPage() {
  // See return-label/[trackingNumber]/page.tsx's own comment — useParams() hands back
  // the raw, still-percent-encoded segment, not the decoded value. Harmless in practice
  // for a plain "TRK-######" number (no reserved characters to encode), but decoding
  // once here keeps this page correct on the same footing as the one that isn't.
  const { trackingNumber: rawTrackingNumber } = useParams<{ trackingNumber: string }>();
  const trackingNumber = decodeURIComponent(rawTrackingNumber);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [shipment, setShipment] = useState<ShipmentInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getMe()
      .then((data) => setCustomer(data.customer))
      .catch(() => {});
    getTracking(trackingNumber)
      .then(setShipment)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load tracking details"));
  }, [trackingNumber]);

  return (
    <>
      <SiteHeader customer={customer} />

      <div className="page">
        <h2>Track your package</h2>
        <p className="page-lede">Tracking number {trackingNumber}</p>

        {error && <p className="tracking-error">{error}</p>}

        {!error && !shipment && <p className="page-lede">Loading tracking details…</p>}

        {shipment && (
          <div className="tracking-card">
            <div className="tracking-card-top">
              <span className={`tracking-status tracking-status-${shipment.status}`}>{STATUS_LABEL[shipment.status]}</span>
              <span className="tracking-number">{shipment.trackingNumber}</span>
            </div>

            <div className="tracking-product">{shipment.items}</div>

            <dl className="tracking-details">
              <div className="tracking-detail">
                <dt>Order placed</dt>
                <dd>{formatDate(shipment.orderDate)}</dd>
              </div>
              <div className="tracking-detail">
                <dt>{shipment.status === "delivered" ? "Delivered" : "Estimated delivery"}</dt>
                <dd>{formatDate(shipment.deliveredDate)}</dd>
              </div>
              {shipment.signedForBy && (
                <div className="tracking-detail">
                  <dt>Signed for by</dt>
                  <dd>{shipment.signedForBy}</dd>
                </div>
              )}
              <div className="tracking-detail">
                <dt>Order ID</dt>
                <dd className="tracking-order-id">{shipment.orderId}</dd>
              </div>
            </dl>
          </div>
        )}
      </div>

      <SiteFooter />
      <ChatWidget />
    </>
  );
}
