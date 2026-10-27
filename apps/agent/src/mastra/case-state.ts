import { createKeyedLock } from "./keyed-lock";
import { getEscalationSlaMinutes } from "./runtime-settings";
// All application snapshot writes and resumes share this lock through persistence.
export const caseStateLocks = createKeyedLock();
export function newReviewDeadline(now = Date.now()): string {
  return new Date(now + getEscalationSlaMinutes() * 60_000).toISOString();
}
export function reviewDeadline(payload: { reviewDeadlineIso?: string; createdAt: string }): string {
  // Stable fallback for cases created before explicit deadlines were introduced.
  return payload.reviewDeadlineIso ?? newReviewDeadline(new Date(payload.createdAt).getTime());
}
