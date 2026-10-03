// usageNotifier.js — allowance warning points (default 75%, 90%, 100%).
//
// Each point is CLAIMED at most once per household per billing period in
// the database (claim_usage_notification, migration 056), before anything
// is delivered, so two simultaneous calls, a retry or a restart can never
// notify twice. Crossing several points at once claims all of them and
// reports only the highest, so a lower one can't arrive later, out of order.
//
// Delivery is NOT decided here. The claimed point is exposed to the app
// (allowanceStatus.lastWarningPoint) for Build 20 to show in-app / push;
// `deliver` is an optional injected function (e.g. a future push or an
// approved SMS). Customer wording is a product decision and is not
// written in this module.
'use strict';

const KIND_FOR_POINT = { 0.75: 'warn_75', 0.9: 'warn_90', 1: 'exhausted_100' };

function kindFor(point) {
  return KIND_FOR_POINT[point] || `warn_${Math.round(point * 100)}`;
}

/**
 * @returns {Promise<{claimed: string|null}>} the highest newly-claimed kind, if any
 */
async function notifyUsageThresholds({ householdId, periodStart, usedSeconds, allowanceSeconds, warningPoints = [0.75, 0.9], claim, deliver = null }) {
  if (!(allowanceSeconds > 0) || !householdId || !periodStart) return { claimed: null };
  const fraction = usedSeconds / allowanceSeconds;
  const crossed = [...warningPoints, 1].filter((p) => fraction >= p).sort((a, b) => a - b);
  if (!crossed.length) return { claimed: null };

  let highest = null;
  for (const point of crossed) {
    const kind = kindFor(point);
    if (!['warn_75', 'warn_90', 'exhausted_100'].includes(kind)) continue; // only kinds the schema knows
    if (await claim({ householdId, periodStart, kind })) highest = kind;
  }
  if (highest && typeof deliver === 'function') {
    await Promise.resolve().then(() => deliver({ householdId, kind: highest, usedSeconds, allowanceSeconds })).catch(() => {});
  }
  return { claimed: highest };
}

module.exports = { notifyUsageThresholds, kindFor };
