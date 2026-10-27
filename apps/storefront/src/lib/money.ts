// The one place a number becomes a currency string here — never hardcode a "$" at a call
// site. A product/order already carries its own currency (Product.currency, from the
// catalog fixture); a business-level figure (a refund ceiling, a settings value) comes
// from Settings.currency (apps/agent's WISMO_CUR) instead. Either way, pass the real
// currency in, don't assume one.
export function formatMoney(amount: number, currency: string, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(undefined, { style: "currency", currency, ...options }).format(amount);
}
