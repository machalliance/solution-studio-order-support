"use client";

import { useEffect, useState } from "react";
import { getMe, getProducts, type Customer, type Product } from "@/lib/api";
import { formatMoney } from "@/lib/money";
import { ChatWidget } from "@/components/ChatWidget";
import { SiteHeader } from "@/components/SiteHeader";
import { SiteFooter } from "@/components/SiteFooter";
import { ProductSwatch } from "@/components/ProductSwatch";

// A hand-picked teaser, not the full catalog — exactly 5, one magazine-style grid group
// (one larger feature + two columns of two stacked smaller items), so the whole page
// stays a single screenful rather than growing with every extra group. Deliberately
// excludes jacket-001 — that's already the hero's own featured piece above, so repeating
// it here would read as the same item twice before a visitor even started scrolling.
const FEATURED_OBJECT_IDS = ["top-002", "shoes-002", "top-003", "pants-002", "jacket-003"];

function featuredProducts(products: Product[]): Product[] {
  const byId = new Map(products.map((p) => [p.objectID, p]));
  return FEATURED_OBJECT_IDS.map((id) => byId.get(id)).filter((p): p is Product => Boolean(p));
}

export default function HomePage() {
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [products, setProducts] = useState<Product[] | null>(null);

  useEffect(() => {
    getMe()
      .then((data) => setCustomer(data.customer))
      .catch(() => {});
    getProducts()
      .then(setProducts)
      .catch(() => {});
  }, []);

  const featured = products ? featuredProducts(products) : [];
  const [large, ...rest] = featured;
  const [colA, colB] = [rest.slice(0, 2), rest.slice(2, 4)];

  return (
    <>
      <SiteHeader customer={customer} />

      <div className="hero">
        <div className="hero-copy">
          <p className="hero-eyebrow">Waybound — gear for the road</p>
          <h1>Gear for the road, the trailhead, and everywhere between.</h1>
          <p>Packed for weekend trips and light hikes, backed by a support team that can actually see your order — ask the chat in the corner anything.</p>
        </div>

        {/* Real catalog photography, not a stock hero image — one hero piece, shown
            whole rather than cropped, with its own name/price card the same way a rep
            would lay out today's featured gear on a table. Decorative: the copy above
            already carries everything a screen reader needs. */}
        <div className="hero-feature" aria-hidden="true">
          <div className="hero-feature-photo">
            <img src="/products/jacket-001.jpg" alt="" />
          </div>
          <div className="hero-feature-caption">
            <span className="hero-feature-name">Packable Rain Shell</span>
            <span className="hero-feature-price">Moss — $145</span>
          </div>
        </div>
      </div>

      {large && (
        <div className="collection" id="collection">
          <h2>Shop the collection</h2>
          <div className="collection-grid">
            <div className="tag-card tag-card-large">
              <ProductSwatch product={large} size="fill" />
              <span className="tag-card-hole" aria-hidden="true" />
              <div className="tag-card-body">
                <span className="tag-card-cat">{large.category}</span>
                <div className="tag-card-name">{large.name}</div>
                <div className="tag-card-price">{formatMoney(large.price, large.currency, { maximumFractionDigits: 0 })}</div>
              </div>
            </div>
            {[colA, colB].map((col, colIndex) => (
              <div key={colIndex} className="collection-grid-col">
                {col.map((p) => (
                  <div key={p.objectID} className="tag-card">
                    <ProductSwatch product={p} size="fill" />
                    <span className="tag-card-hole" aria-hidden="true" />
                    <div className="tag-card-body">
                      <span className="tag-card-cat">{p.category}</span>
                      <div className="tag-card-name">{p.name}</div>
                      <div className="tag-card-price">{formatMoney(p.price, p.currency, { maximumFractionDigits: 0 })}</div>
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}

      <SiteFooter />
      <ChatWidget />
    </>
  );
}
