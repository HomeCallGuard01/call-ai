// allowanceState.js — the customer allowance STATE (WS2, 2026-10-10).
//
// Reads the deterministic state computed by the database
// (fortress_household_allowance_state, migration 076 — DRAFT) and maps it to
// the customer contract in docs/launch/2026-10-10-WS2-REPORT.md §A:
//   { version, state, percentUsed, screeningActive, unknownCallersDelivered,
//     trustedCallersDelivered, reserveRemaining{trustedPercent,unknownPercent},
//     serviceLimited, periodStart, resetsAt, since, thresholds, lastRefusal }
//
// Never exposes £ (HCG cost, not a customer price). Never throws: anything
// unreadable is state 'unavailable' with null booleans — never "protected".
'use strict';

const STATES = Object.freeze(['normal', 'screening_low', 'screening_paused', 'continuity', 'continuity_low', 'hard_ceiling', 'held']);

const iso = (v) => (v ? new Date(v).toISOString() : null);
const pct = (remaining, total) => {
  const r = Number(remaining); const t = Number(total);
  if (!Number.isFinite(t) || t <= 0 || !Number.isFinite(r)) return null;
  return Math.max(0, Math.min(100, Math.floor((r / t) * 100)));
};
const ratioPct = (v, fallback) => (Number.isFinite(Number(v)) ? Math.round(Number(v) * 100) : fallback);

function unavailable() {
  return {
    version: 1, state: 'unavailable', percentUsed: null, screeningActive: null, unknownCallersDelivered: null,
    trustedCallersDelivered: null, reserveRemaining: { trustedPercent: null, unknownPercent: null }, serviceLimited: null,
    periodStart: null, resetsAt: null, since: null, thresholds: { screeningLowPercent: null, continuityLowPercent: null }, lastRefusal: null,
  };
}

/** Pure: database state → customer contract. Unknown/malformed → unavailable. */
function toCustomerAllowanceState(s) {
  if (!s || typeof s !== 'object' || !STATES.includes(s.state)) return unavailable();
  const scope = s.deliveryReserveScope || 'none';
  return {
    version: 1,
    state: s.state,
    percentUsed: Number.isInteger(s.percentUsed) ? Math.max(0, Math.min(100, s.percentUsed)) : null,
    screeningActive: s.screeningActive === true,
    unknownCallersDelivered: s.unknownCallersDelivered === true,
    trustedCallersDelivered: s.trustedCallersDelivered === true,
    reserveRemaining: {
      trustedPercent: scope === 'none' ? null : pct(s.trustedReserveRemainingGbp, s.trustedReserveGbp),
      unknownPercent: pct(s.unknownReserveRemainingGbp, s.unknownReserveGbp),
    },
    serviceLimited: s.serviceLimited === true,
    periodStart: iso(s.periodStart),
    resetsAt: iso(s.periodEnd),
    since: iso(s.since),
    thresholds: {
      screeningLowPercent: ratioPct(s.thresholds && s.thresholds.screeningLowRatio, null),
      continuityLowPercent: ratioPct(s.thresholds && s.thresholds.continuityLowRatio, null),
    },
    lastRefusal: s.lastDenialReason ? { reason: String(s.lastDenialReason), at: iso(s.lastDenialAt) } : null,
  };
}

/**
 * Read + map with a hard timeout. deps.householdAllowanceState({householdId, now}) → db JSON.
 */
async function getCustomerAllowanceState({ householdId, deps, now = new Date(), timeoutMs = 2000 }) {
  if (!householdId || !deps || typeof deps.householdAllowanceState !== 'function') return unavailable();
  let timer;
  try {
    const s = await Promise.race([
      Promise.resolve().then(() => deps.householdAllowanceState({ householdId, now })),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('allowance state timed out')), timeoutMs); }),
    ]);
    return toCustomerAllowanceState(s);
  } catch {
    return unavailable();
  } finally {
    clearTimeout(timer);
  }
}

/** Express handler factory (household from the verified session only). */
function createAllowanceStateHandler({ deps, now = () => new Date() } = {}) {
  return async function allowanceStateHandler(req, res) {
    const householdId = req.household && req.household.id;
    const allowanceState = await getCustomerAllowanceState({ householdId, deps, now: now() });
    res.set('Cache-Control', 'no-store');
    res.json({ allowanceState });
  };
}

module.exports = { STATES, toCustomerAllowanceState, getCustomerAllowanceState, createAllowanceStateHandler, unavailable };
