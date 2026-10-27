// Dated completed-refund fixture records: the historical depth `customer.completedRefunds`
// (mastra/policy/context.ts) needs, since this app's own workflow-run history only goes back as
// far as its own testing, nowhere near a genuine 180-day lookback. Seeded explicitly: completed
// records are never derived by relabeling approvals as completed refunds.
//
// Every record is a COMPLETED refund only, never a pending approval or an escalated case, the same
// "approved means approved" discipline refund-ledger.ts applies to live data. `refundId` is
// prefixed `hist_` (never `re_`, the live-refund prefix) so a fixture can't be mistaken for a real one.
//
// COMPLETED_REFUND_HISTORY_START_DATE is the "explicit history coverage" fact: how far back this
// data is known to be complete, so a 180-day sum never implies 180 days of history just because
// SOME timestamps exist. It is set earlier than every fixture record and earlier than any window a
// policy might use, so an excluded record reads as "outside the window", not "no record at all".

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString();
}

export interface CompletedRefundFixture {
  refundId: string;
  customerId: string;
  amount: number;
  currency: string;
  completedAt: string;
}

export const COMPLETED_REFUND_HISTORY_START_DATE = daysAgo(210);

// cust_demo_01 (the storefront's own logged-in demo customer) gets a
// deliberately real scenario: two records inside a 180-day window summing to $330
// (over a $300 threshold), plus one older record OUTSIDE that window whose $400 would
// blow the sum way past correct if the date filter were ever wrong — a fixture
// specifically shaped to catch that class of bug, not just demonstrate a number.
const COMPLETED_REFUND_FIXTURES: CompletedRefundFixture[] = [
  { refundId: "hist_dm01_a", customerId: "cust_demo_01", amount: 180, currency: "USD", completedAt: daysAgo(45) },
  { refundId: "hist_dm01_b", customerId: "cust_demo_01", amount: 150, currency: "USD", completedAt: daysAgo(150) },
  // Outside a 180-day window — must be excluded by any correct lookback fact.
  { refundId: "hist_dm01_c", customerId: "cust_demo_01", amount: 400, currency: "USD", completedAt: daysAgo(190) },
];

export function completedRefundFixturesForCustomer(customerId: string): CompletedRefundFixture[] {
  return COMPLETED_REFUND_FIXTURES.filter((record) => record.customerId === customerId);
}
