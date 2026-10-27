// Order and delivery dates are real instants (full ISO timestamps). Shown as the viewer's
// own local calendar day — exactly what the storefront does for the same order (its chat
// order list, tracking page, and return-label page all format in local time) — so the two
// apps never show different days for the same order. The server can't do this itself: it
// doesn't know the viewer's timezone, which is why orderContext's baked-in UTC date isn't
// used for display anywhere on this app anymore.
export function formatDay(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// Whole calendar days between that local date and today's local date — not elapsed
// 24-hour periods, which can disagree by one with the date shown right beside it (an order
// placed at 11pm yesterday is "1 day ago", not "0").
export function daysAgo(iso: string): number {
  const then = new Date(iso);
  const now = new Date();
  const thenDay = Date.UTC(then.getFullYear(), then.getMonth(), then.getDate());
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((today - thenDay) / 86_400_000);
}

export function daysAgoLabel(iso: string): string {
  const days = daysAgo(iso);
  return days === 0 ? "today" : `${days} day${days === 1 ? "" : "s"} ago`;
}
