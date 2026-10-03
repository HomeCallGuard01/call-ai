// allocation.js — apportions a supplier AGGREGATE (e.g. Twilio's daily
// Media Streams usage-record total) across the items that caused it.
// Provider-neutral and pure.
//
// The result is always labelled provider_allocated by the caller, never
// provider_actual: the supplier priced the day, not each call. Shares are
// computed in integer micro-units (the ledger's 6 decimal places) with the
// largest-remainder method, so they always sum to exactly the supplier's
// total — no rounding drift between the ledger and the supplier's bill.
'use strict';

const MICRO = 1e6;

/**
 * @param {number} total - the supplier aggregate, as a positive magnitude
 * @param {Array<{ key: string, weight: number }>} shares - e.g. stream seconds per call
 * @returns {Array<{ key: string, weight: number, amount: number }>} same order as `shares`
 */
function apportion(total, shares) {
  if (!Number.isFinite(total) || total < 0) throw new Error('allocation total must be a non-negative number');
  const usable = shares.filter((s) => Number.isFinite(s.weight) && s.weight > 0);
  const weightSum = usable.reduce((sum, s) => sum + s.weight, 0);
  if (usable.length === 0 || weightSum === 0) {
    return shares.map((s) => ({ ...s, amount: 0 }));
  }

  const totalMicro = Math.round(total * MICRO);
  const raw = usable.map((s) => {
    const exact = (totalMicro * s.weight) / weightSum;
    return { key: s.key, floor: Math.floor(exact), remainder: exact - Math.floor(exact) };
  });
  let leftover = totalMicro - raw.reduce((sum, r) => sum + r.floor, 0);
  const byRemainder = [...raw].sort((a, b) => b.remainder - a.remainder || (a.key < b.key ? -1 : 1));
  for (const r of byRemainder) {
    if (leftover <= 0) break;
    r.floor += 1;
    leftover -= 1;
  }
  const micros = new Map(raw.map((r) => [r.key, r.floor]));
  return shares.map((s) => ({ ...s, amount: (micros.get(s.key) || 0) / MICRO }));
}

module.exports = { apportion };
