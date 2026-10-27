"use client";

// The storefront's Account page (/account): the one demo customer the chat treats as logged in
// (GET /me) and their orders. There is no login — the demo has a single identity. The chat
// widget is mounted here, as on every page.

import { useEffect, useState } from "react";
import { getMe, daysAgo, type Customer, type Order } from "@/lib/api";
import { formatMoney } from "@/lib/money";
import { ChatWidget } from "@/components/ChatWidget";
import { SiteHeader } from "@/components/SiteHeader";
import { SiteFooter } from "@/components/SiteFooter";
import { ProductSwatch } from "@/components/ProductSwatch";

export default function AccountPage() {
  const [data, setData] = useState<{ customer: Customer; orders: Order[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getMe()
      .then(setData)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load your account"));
  }, []);

  return (
    <>
      <SiteHeader customer={data?.customer ?? null} />

      <div className="page">
        <h2>Account</h2>
        <p className="page-lede">This is who the storefront and support chat treat you as — no separate login for the demo.</p>

        {error && <p style={{ color: "var(--ink-soft)" }}>Couldn&rsquo;t reach the account API: {error}</p>}

        {data && (
          <>
            <div className="settings-card">
              <div className="settings-avatar">{data.customer.name.charAt(0)}</div>
              <div>
                <div className="settings-name">{data.customer.name}</div>
                <div className="settings-email">{data.customer.email}</div>
              </div>
            </div>
            <p className="settings-note">
              Set via <code>WISMO_DEMO_CUSTOMER_NAME</code> / <code>WISMO_DEMO_CUSTOMER_EMAIL</code> on the agent
              (see <code>.env.example</code>) — an editable form here is the natural next step once this
              needs to change without redeploying.
            </p>

            <h2 className="settings-orders-heading">Your Orders</h2>
            <p className="page-lede">Questions about any of these? The chat in the corner can look them up for you.</p>

            <ul className="order-list">
              {data.orders.map((order) => (
                <li key={order.id} className="order-card">
                  <div className="order-card-main">
                    {order.items.length === 1 ? (
                      <ProductSwatch product={order.items[0]} />
                    ) : (
                      <div className="order-card-swatch-stack">
                        {order.items.map((item) => (
                          <ProductSwatch key={item.objectID} product={item} size={32} />
                        ))}
                      </div>
                    )}
                    <div>
                      <div className="order-card-name">{order.items.map((item) => item.name).join(", ")}</div>
                      <div className="order-card-meta">Ordered {order.orderDate.slice(0, 10)}</div>
                    </div>
                    <span className="order-card-spacer" />
                    <div className="order-card-price">{formatMoney(order.amount, order.items[0].currency)}</div>
                  </div>
                  <div className="order-card-stub">
                    <span className="order-status">Delivered {daysAgo(order.deliveredDate)}d ago</span>
                    <span className="order-card-stub-spacer" />
                    <span className="order-id">#{order.id}</span>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      <SiteFooter />
      <ChatWidget />
    </>
  );
}
