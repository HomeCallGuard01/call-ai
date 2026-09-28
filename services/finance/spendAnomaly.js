// spendAnomaly.js — finds spend and usage that is abnormal relative to HCG's
// own history, complementing the fixed thresholds in spendGuard.js. Pure;
// provider-neutral (reads ledger categories and household accumulations).
// Alerts only: nothing here blocks a call or changes configuration.
//
// Fail-safe rule: missing or stale cost data is itself an alert. Absence of
// data is never read as "no spend".
'use strict';

const DEFAULT_ANOMALY_THRESHOLDS = {
  maxDataAgeHours: 30,          // ledger ingestion should run at least daily
  baselineDays: 14,
  minBaselineDays: 5,           // fewer days of history → no spike judgement (reported as such)
  spikeWarningMultiplier: 3,    // today vs trailing median
  spikeCriticalMultiplier: 6,
  spikeMinimumGbp: 2,           // ignore spikes smaller than this in absolute terms
  householdOutlierMultiplier: 5, // projected month cost vs household median
  householdOutlierMinimumGbp: 3.5, // ≈ the £4.99 store-channel after-fees revenue
  burstCalls: 10,               // inbound calls to one household …
  burstWindowMinutes: 10,       // … within this window (loop or flood)
  concurrentWarning: 3,         // a single forwarded mobile line rarely carries > 2
  concurrentCritical: 5,
  // Categories whose first appearance breaks a cost assumption in the model.
  architectureBreakingCategories: ['app_leg', 'outbound_voice', 'channel_capacity', 'platform_fee'],
};

function median(values) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/**
 * @param {object} input
 * @param {Date|string} input.now
 * @param {Date|string|null} input.lastIngestedAt  newest ledger write/finalisation seen
 * @param {{ date: string, category: string, amount: number|null, currency: string }[]} [input.dailyTotals]
 *        GBP ledger totals per day and category, covering the baseline window and `today`
 * @param {string} [input.today]  YYYY-MM-DD being judged (defaults to now's UTC date)
 * @param {object[]} [input.households]  accumulateHouseholdCosts(...).households
 * @param {{ household_id: string, started_at: string, leg_type: string }[]} [input.legs]  recent legs for burst detection
 */
function detectAnomalies(input, overrides = {}) {
  const t = { ...DEFAULT_ANOMALY_THRESHOLDS, ...overrides };
  const now = new Date(input.now);
  const today = input.today || now.toISOString().slice(0, 10);
  const alerts = [];
  const push = (code, severity, value, threshold, detail, subject) =>
    alerts.push({ code, severity, value, threshold, detail, ...(subject ? { subject } : {}) });

  // 1. Freshness (fail-safe).
  if (!input.lastIngestedAt) {
    push('COST_DATA_MISSING', 'CRITICAL', null, t.maxDataAgeHours, 'no ledger cost data has been ingested: spend is unobserved, not zero');
  } else {
    const ageHours = (now - new Date(input.lastIngestedAt)) / 3600000;
    if (ageHours > t.maxDataAgeHours) {
      push('COST_DATA_STALE', 'CRITICAL', Math.round(ageHours), t.maxDataAgeHours, `newest ledger data is ${Math.round(ageHours)}h old: spend since then is unobserved`);
    }
  }

  // 2. Company spend spike vs trailing median, and never-seen categories.
  const rows = (input.dailyTotals || []).filter((r) => r.currency === 'GBP' && r.amount != null);
  const byDay = new Map();
  const seenBefore = new Set();
  for (const r of rows) {
    byDay.set(r.date, (byDay.get(r.date) || 0) + Number(r.amount));
    if (r.date < today && Number(r.amount) > 0) seenBefore.add(r.category);
  }
  const start = new Date(`${today}T00:00:00Z`).getTime() - t.baselineDays * 86400000;
  const baselineDays = [...byDay.entries()].filter(([d]) => d < today && new Date(`${d}T00:00:00Z`).getTime() >= start);
  const todayTotal = byDay.get(today);
  if (todayTotal != null) {
    if (baselineDays.length < t.minBaselineDays) {
      push('SPIKE_BASELINE_INSUFFICIENT', 'WARNING', baselineDays.length, t.minBaselineDays, 'too little history to judge a spend spike; fixed thresholds still apply');
    } else {
      const base = median(baselineDays.map(([, v]) => v));
      const ratio = base > 0 ? todayTotal / base : Infinity;
      const excess = todayTotal - (base || 0);
      if (excess >= t.spikeMinimumGbp) {
        const sev = ratio >= t.spikeCriticalMultiplier ? 'CRITICAL' : ratio >= t.spikeWarningMultiplier ? 'WARNING' : null;
        if (sev) push('SPEND_SPIKE', sev, round(todayTotal), round((base || 0) * (sev === 'CRITICAL' ? t.spikeCriticalMultiplier : t.spikeWarningMultiplier)),
          `£${round(todayTotal)} on ${today} vs trailing median £${round(base || 0)} (${Number.isFinite(ratio) ? ratio.toFixed(1) + '×' : 'from zero'})`);
      }
    }
    const hadHistory = rows.some((r) => r.date < today);
    for (const r of rows.filter((x) => x.date === today && Number(x.amount) > 0)) {
      if (hadHistory && !seenBefore.has(r.category)) {
        const breaking = t.architectureBreakingCategories.includes(r.category);
        push('NEW_COST_CATEGORY', breaking ? 'CRITICAL' : 'WARNING', round(r.amount), 0,
          breaking ? `${r.category} is now being charged: the unit-cost model assumes it is £0 — re-run unit economics` : `${r.category} charged for the first time`, r.category);
      }
    }
  }

  // 3. Household outliers against the household median.
  const hhs = input.households || [];
  const med = median(hhs.map((h) => h.projectedMonthGbp));
  for (const h of hhs) {
    const floor = t.householdOutlierMinimumGbp;
    if (h.projectedMonthGbp >= floor && med != null && h.projectedMonthGbp >= med * t.householdOutlierMultiplier) {
      push('HOUSEHOLD_COST_OUTLIER', 'WARNING', round(h.projectedMonthGbp), round(Math.max(floor, med * t.householdOutlierMultiplier)),
        `projected £${round(h.projectedMonthGbp)} this month vs household median £${round(med)}; trusted share ${Math.round((h.trustedShareOfCost || 0) * 100)}%`, h.householdId);
    }
    if (h.peakConcurrentInbound != null) {
      const sev = h.peakConcurrentInbound >= t.concurrentCritical ? 'CRITICAL' : h.peakConcurrentInbound >= t.concurrentWarning ? 'WARNING' : null;
      if (sev) push('CONCURRENT_CALLS', sev, h.peakConcurrentInbound, sev === 'CRITICAL' ? t.concurrentCritical : t.concurrentWarning,
        'simultaneous inbound calls to one household number (flood, loop or direct dialling of the HCG number)', h.householdId);
    }
  }

  // 4. Call bursts (forwarding loop or flood) from raw legs.
  const byHousehold = new Map();
  for (const l of input.legs || []) {
    if (l.leg_type !== 'inbound_pstn' || !l.household_id || !l.started_at) continue;
    if (!byHousehold.has(l.household_id)) byHousehold.set(l.household_id, []);
    byHousehold.get(l.household_id).push(new Date(l.started_at).getTime());
  }
  const windowMs = t.burstWindowMinutes * 60000;
  for (const [id, times] of byHousehold) {
    times.sort((a, b) => a - b);
    let best = 0;
    for (let i = 0, j = 0; j < times.length; j++) {
      while (times[j] - times[i] > windowMs) i++;
      best = Math.max(best, j - i + 1);
    }
    if (best >= t.burstCalls) {
      push('CALL_BURST', 'CRITICAL', best, t.burstCalls, `${best} inbound calls within ${t.burstWindowMinutes} min (forwarding loop or call flood)`, id);
    }
  }

  const rank = { CRITICAL: 0, WARNING: 1 };
  return alerts.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

function round(n) { return Math.round(Number(n) * 100) / 100; }

module.exports = { detectAnomalies, DEFAULT_ANOMALY_THRESHOLDS, median };
