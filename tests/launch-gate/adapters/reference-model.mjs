// Reference in-memory model that satisfies tests/launch-gate/financial-contract.mjs.
//
// NOT production code and not a proposal for HCG's implementation. It
// exists to prove the contract is satisfiable and internally consistent;
// the naive model next to it proves the contract is discriminating. The
// real proof requires binding the contract to the integrated
// implementation and its real store (Postgres via pglite, then staging).

const tick = () => new Promise(r => setImmediate(r));
const isNonNegInt = v => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

export async function createSubject() {
  const allowance = new Map();
  const seenEvents = new Set();
  let globalCeiling = Infinity;
  let globalSpend = 0;
  let storeAvailable = true;
  let rate = null;
  const admissions = [];
  const PER_CALL_RESERVATION = 60; // seconds reserved per admitted call
  let lock = Promise.resolve();
  const serial = fn => (lock = lock.then(fn, fn));

  return {
    capabilities: new Set(['global-ceiling', 'store-outage', 'rate-breaker']),
    async setAllowance(h, s) { allowance.set(h, s); },
    async remaining(h) { return allowance.get(h) ?? 0; },
    async setGlobalCeiling(p) { globalCeiling = p; },
    async addGlobalSpend(p) { globalSpend += p; },
    async setStoreAvailable(v) { storeAvailable = v; },
    async setRateLimit(r) { rate = r; },
    authorizeCall({ householdId }) {
      return serial(async () => {
        await tick();
        if (!storeAvailable) return { admitted: false, grantedSeconds: 0, reason: 'store_unavailable' };
        if (globalSpend >= globalCeiling) return { admitted: false, grantedSeconds: 0, reason: 'global_ceiling' };
        const now = Date.now();
        if (rate) {
          while (admissions.length && now - admissions[0] > rate.windowMs) admissions.shift();
          if (admissions.length >= rate.maxAdmissions) return { admitted: false, grantedSeconds: 0, reason: 'rate_breaker' };
        }
        const rem = allowance.get(householdId) ?? 0;
        if (rem <= 0) return { admitted: false, grantedSeconds: 0, reason: 'exhausted' };
        const grant = Math.min(rem, PER_CALL_RESERVATION);
        allowance.set(householdId, rem - grant); // reserve atomically
        admissions.push(now);
        return { admitted: true, grantedSeconds: grant };
      });
    },
    recordUsage({ householdId, eventId, seconds, costPence }) {
      return serial(async () => {
        await tick();
        if (typeof eventId !== 'string' || !eventId) throw new Error('eventId required');
        if (!isNonNegInt(seconds) || !isNonNegInt(costPence)) throw new Error('invalid usage');
        if (seconds > 4 * 3600 || costPence > 100_000) throw new Error('implausible usage');
        if (seenEvents.has(eventId)) return { applied: false };
        seenEvents.add(eventId);
        allowance.set(householdId, Math.max(0, (allowance.get(householdId) ?? 0) - seconds));
        globalSpend += costPence;
        return { applied: true };
      });
    },
  };
}
