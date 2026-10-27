import type { Product } from "@/lib/api";

// Real catalog photos (apps/storefront/public/products/<objectID>.jpg) are the
// common case. The colourHex swatch is only a fallback — for a product with no generated
// image yet, so the UI degrades to a colour chip instead of a broken image.
//
// size is a fixed pixel box for icon-style contexts (order-card thumbnails); pass "fill"
// in a responsive grid cell instead — that drops the inline width/height so the element's
// own CSS (width: 100%, aspect-ratio) controls its size rather than being pinned in px.
export function ProductSwatch({ product, size = 44 }: { product: Product; size?: number | "fill" }) {
  const photo = product.images?.[0];
  const dims = size === "fill" ? {} : { width: size, height: size };

  if (photo) {
    // eslint-disable-next-line @next/next/no-img-element -- fixed square catalog photos, not worth next/image's remote-loader setup for a local dev catalog
    return <img src={photo} alt={product.name} className="product-swatch" {...dims} />;
  }

  return (
    <svg
      viewBox="0 0 44 44"
      className="product-swatch"
      role="img"
      aria-label={`${product.colourFamily} ${product.name}`}
      {...dims}
    >
      <rect x="1" y="1" width="42" height="42" rx="9" fill={product.colourHex} />
      <path d="M1 27 L18 10 L43 10 L43 34 L1 34 Z" fill="white" opacity="0.08" />
      <rect x="1" y="1" width="42" height="42" rx="9" fill="none" stroke="black" strokeOpacity="0.08" />
    </svg>
  );
}
