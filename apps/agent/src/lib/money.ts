// The one place a number becomes a currency string. Never hardcode a "$" or any other
// symbol at a call site — Intl.NumberFormat already knows the right symbol, decimal, and
// grouping rules for any ISO 4217 code, so the currency itself (config.ts's WISMO_CUR)
// is the only thing that ever needs to change.
export function formatMoney(amount: number, currency: string): string {
  return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(amount);
}
