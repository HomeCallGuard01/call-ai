// Deliberately WRONG model: read-then-write race on admission, no event
// dedupe, no input validation, fail-open on store outage, no ceiling, no
// breaker. The framework self-test requires the financial contract to
// FAIL this model — if it ever passes, the contract has stopped catching
// the classic exposure bugs and must not be trusted.

const tick = () => new Promise(r => setImmediate(r));

export async function createSubject() {
  const allowance = new Map();
  let storeAvailable = true;
  return {
    capabilities: new Set(['global-ceiling', 'store-outage', 'rate-breaker']),
    async setAllowance(h, s) { allowance.set(h, s); },
    async remaining(h) { return allowance.get(h) ?? 0; },
    async setGlobalCeiling() {},
    async addGlobalSpend() {},
    async setStoreAvailable(v) { storeAvailable = v; },
    async setRateLimit() {},
    async authorizeCall({ householdId }) {
      if (!storeAvailable) return { admitted: true, grantedSeconds: 60, reason: 'fail_open' };
      const rem = allowance.get(householdId) ?? 0; // read
      await tick();                                  // another instance interleaves here
      if (rem <= 0) return { admitted: false, grantedSeconds: 0 };
      return { admitted: true, grantedSeconds: Math.min(rem, 60) }; // check-only, never reserves
    },
    async recordUsage({ householdId, seconds }) {
      const rem = allowance.get(householdId) ?? 0;
      await tick();
      allowance.set(householdId, rem - Number(seconds));
      return { applied: true };
    },
  };
}
