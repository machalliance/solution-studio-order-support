// A tiny per-key in-process mutex — chains a Promise per key so calls for the SAME
// key run strictly one-at-a-time, while calls for DIFFERENT keys never block each
// other. Shared by payment.ts's per-order refund lock, policy/repository.ts's
// per-namespace activation lock, and server.ts's per-case disagreement-ticket lock, so
// the pattern lives in one place instead of three copies to keep in sync by hand.
//
// Deliberately just this — no timeout, no fairness/priority queueing, no cross-process
// coordination. This app is explicitly single-process (multi-process deployment is out
// of scope — see docs/production-considerations.md), so an in-memory lock is the
// right amount of machinery: it closes the overwhelmingly likely race (two overlapping
// calls for the same key, within this one process) without pretending to be a
// distributed lock this prototype has no use for. A lock's own map is never persisted
// or cleared on /demo/reset — same "ephemeral coordination state, not business data"
// reasoning as case-events.ts's listeners and active-sessions.ts's connection counts:
// losing it on a restart is correct (a crashed process holds nothing to release), and
// there is nothing here a customer/rep record would ever need to read back.
export function createKeyedLock() {
  const locks = new Map<string, Promise<unknown>>();

  function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = locks.get(key) ?? Promise.resolve();
    const current = previous.then(fn, fn);
    // Swallow so a rejected call never poisons the chain for the NEXT caller on this
    // same key — the real result/error still propagates to THIS call's own caller via
    // the returned `current` promise, untouched.
    locks.set(key, current.catch(() => {}));
    return current;
  }

  return { withLock };
}
