// The one place a number becomes a currency string here — never hardcode a "$" or "USD"
// at a call site. Every case carries its own currency (EscalationSummary.currency, from
// apps/agent's WISMO_CUR) — always format against that, not an assumed unit.
export function formatMoney(amount: number, currency: string): string {
  return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(amount);
}
