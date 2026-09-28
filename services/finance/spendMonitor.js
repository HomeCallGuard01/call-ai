// spendMonitor.js — one evaluation of HCG's financial safety: loads the
// month's ledger rows, accumulates per-household cost, runs the fixed
// thresholds (spendGuard), the anomaly detector (spendAnomaly) and the
// company protection level (companySpendProtection), sends NEW critical
// alerts once, and returns dashboard-ready metrics.
//
// NOT SCHEDULED and not wired into server.js. Everything is injected
// (load, sendCriticalAlert, previous state) so it runs identically from a
// script, a scheduled job, or a test. It never writes to the ledger, never
// touches the call path and never changes a provider setting.
//
// Fail-safe: if loading fails, the result is ALERT with MONITOR_LOAD_FAILED
// (spend unobserved), never a clean bill of health.
'use strict';

const { evaluateSpend } = require('./spendGuard');
const { detectAnomalies } = require('./spendAnomaly');
const { assessProtection } = require('./companySpendProtection');
const { accumulateHouseholdCosts, householdContribution } = require('./householdCosts');

// GBP daily totals per category from ledger entries (for spikes / new categories).
function dailyTotalsFromEntries(entries, fx = {}) {
  const map = new Map();
  for (const e of entries) {
    if (e.entry_class !== 'cost' && e.entry_class !== 'fee') continue;
    if (e.native_amount == null) continue;
    const when = e.occurred_at || e.period_start;
    if (!when) continue;
    let amount = Number(e.native_amount);
    if (e.native_currency !== 'GBP') {
      if (!Number.isFinite(fx[e.native_currency])) continue;
      amount *= fx[e.native_currency];
    }
    const date = new Date(when).toISOString().slice(0, 10);
    const sourceCategory = (e.evidence && (e.evidence.usage_category || e.evidence.source_category)) || null;
    const key = `${date}|${e.category}|${sourceCategory || ''}`;
    const row = map.get(key) || { date, category: e.category, sourceCategory, amount: 0, currency: 'GBP', count: 0 };
    row.amount += amount;
    row.count += 1;
    map.set(key, row);
  }
  return [...map.values()];
}

/**
 * @param {object} deps
 * @param {() => Promise<{ entries, legs, calls, entitledHouseholds, ownedNumbers?, lastIngestedAt, householdChannels? }>} deps.load
 *        entries/legs should cover the current month AND the anomaly baseline window (≥ 14 days back)
 * @param {(type: string, message: string, context: object) => Promise<boolean>} [deps.sendCriticalAlert]
 *        services/alerting.js sendCriticalAlert (never throws; false = not delivered or rate-limited)
 * @param {Date} [deps.now]
 * @param {{ protection?: object, sentKeys?: string[] }} [deps.state]  from the previous run
 * @param {object} [deps.config]  { fx, guard, anomaly, protection, priceGbp, defaultChannel }
 */
async function runSpendMonitor({ load, sendCriticalAlert = null, now = new Date(), state = {}, config = {} }) {
  const fx = config.fx || {};
  const today = now.toISOString().slice(0, 10);
  let data;
  try {
    data = await load();
  } catch (err) {
    const alerts = [{ code: 'MONITOR_LOAD_FAILED', severity: 'CRITICAL', value: null, threshold: null, detail: `could not load ledger data: ${String(err && err.message || err).slice(0, 200)}` }];
    const protection = assessProtection({ alerts, entitledHouseholds: 0, previous: state.protection }, config.protection);
    const sent = await notify(alerts, { sendCriticalAlert, sentKeys: state.sentKeys || [], today, protection });
    return { ok: false, asOf: now.toISOString(), alerts, protection, metrics: null, state: { protection: protection.state, sentKeys: sent.sentKeys }, notified: sent.notified };
  }

  const accumulation = accumulateHouseholdCosts({ entries: data.entries, legs: data.legs, calls: data.calls, asOf: now, fx });
  const daily = dailyTotalsFromEntries(data.entries, fx);
  const todayRows = daily.filter((r) => r.date === today);
  const monthPrefix = today.slice(0, 7);
  const monthToDateGbp = daily.filter((r) => r.date.startsWith(monthPrefix)).reduce((s, r) => s + r.amount, 0);
  const todaySpendGbp = todayRows.reduce((s, r) => s + r.amount, 0);
  const aiToday = todayRows.filter((r) => r.category === 'transcription' || r.category === 'ai_inference').reduce((s, r) => s + r.amount, 0);

  const guardAlerts = evaluateSpend({
    entitledHouseholds: data.entitledHouseholds,
    ownedNumbers: data.ownedNumbers,
    dailyTotals: todayRows.filter((r) => r.category !== 'transcription' && r.category !== 'ai_inference'),
    monthToDateGbp,
    aiSpendGbp: aiToday,
    households: accumulation.households.map((h) => ({ householdId: h.householdId, dayMinutes: h.todayMinutes, monthMinutes: h.monthMinutes, longestCallMinutes: Math.round(h.longestCallMinutes) })),
  }, config.guard);
  const anomalyAlerts = detectAnomalies({
    now, today, lastIngestedAt: data.lastIngestedAt, dailyTotals: daily, households: accumulation.households,
    legs: (data.legs || []).filter((l) => l.started_at && now - new Date(l.started_at) <= 48 * 3600000),
  }, config.anomaly);

  // Internal-only loss-making flag (never shown to or enforced on a customer).
  const channels = data.householdChannels || {};
  const perHousehold = accumulation.households.map((h) => ({
    ...h, contribution: householdContribution(h, { priceGbp: config.priceGbp || 4.99, channel: channels[h.householdId] || config.defaultChannel || 'store15' }),
  }));
  const lossAlerts = perHousehold.filter((h) => h.contribution.projectedLossMaking).map((h) => ({
    code: 'HOUSEHOLD_PROJECTED_LOSS', severity: 'WARNING', value: h.projectedMonthGbp, threshold: h.contribution.afterFeesGbp,
    detail: `projected cost £${h.projectedMonthGbp.toFixed(2)} exceeds after-fees revenue £${h.contribution.afterFeesGbp.toFixed(2)} (${h.contribution.channel}); internal fair-use review only`, subject: h.householdId,
  }));

  const alerts = [...guardAlerts, ...anomalyAlerts, ...lossAlerts].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'CRITICAL' ? -1 : 1));
  const protection = assessProtection({ alerts, entitledHouseholds: data.entitledHouseholds, todaySpendGbp, monthToDateGbp, previous: state.protection }, config.protection);
  const sent = await notify(alerts, { sendCriticalAlert, sentKeys: state.sentKeys || [], today, protection });

  const metrics = {
    asOf: now.toISOString(),
    month: accumulation.month,
    currency: 'GBP',
    protectionLevel: protection.name,
    company: {
      todaySpendGbp: r2(todaySpendGbp),
      monthToDateGbp: r2(monthToDateGbp),
      householdAttributedGbp: r2(accumulation.company.householdCostGbp),
      unallocatedGbp: r2(accumulation.company.unallocatedGbp),
      unknownItems: accumulation.company.unknownItems,
      unconverted: accumulation.company.unconverted,
      entitledHouseholds: data.entitledHouseholds,
      householdsWithCost: perHousehold.length,
      projectedLossMakingHouseholds: lossAlerts.length,
    },
    households: perHousehold.map((h) => ({
      householdId: h.householdId,
      monthToDateGbp: r2(h.monthToDateGbp),
      projectedMonthGbp: r2(h.projectedMonthGbp),
      projectedContributionGbp: r2(h.contribution.projectedContributionGbp),
      trustedMinutes: h.minutes.trustedBilled,
      unknownMinutes: h.minutes.unknownBilled,
      monitoredMinutes: r2(h.minutes.monitored),
      unmonitoredUnknownMinutes: r2(h.minutes.unmonitoredUnknown),
      costGbp: h.costGbp,
      quality: h.quality,
      peakConcurrentInbound: h.peakConcurrentInbound,
      longestCallMinutes: r2(h.longestCallMinutes),
    })),
  };

  return { ok: true, asOf: now.toISOString(), alerts, protection, metrics, state: { protection: protection.state, sentKeys: sent.sentKeys }, notified: sent.notified };
}

// Send each CRITICAL alert once per day per (code, subject); keep the last 7 days of keys.
async function notify(alerts, { sendCriticalAlert, sentKeys, today, protection }) {
  const keys = new Set(sentKeys.filter((k) => k.slice(0, 10) >= isoDaysBefore(today, 7)));
  const fresh = alerts.filter((a) => a.severity === 'CRITICAL' && !keys.has(`${today}|${a.code}|${a.subject || ''}`));
  let notified = 0;
  if (fresh.length && sendCriticalAlert) {
    const message = `Spend protection ${protection.name}: ${fresh.length} new critical item(s) — ${fresh.map((a) => a.code).join(', ')}`;
    const context = {
      level: protection.name,
      alerts: fresh.map((a) => ({ code: a.code, household: a.subject || null, value: a.value, threshold: a.threshold, detail: a.detail })),
      recommendedActionsNothingExecuted: protection.actions.map((x) => ({ id: x.id, status: x.status })),
    };
    let delivered = false;
    try {
      delivered = await sendCriticalAlert('spend_protection', message, context);
    } catch (err) {
      console.error('SPEND MONITOR ALERT DELIVERY FAILED:', err && err.message);
    }
    // Not delivered (or rate-limited): keys are NOT recorded, so the next run retries.
    if (delivered) {
      notified = fresh.length;
      for (const a of fresh) keys.add(`${today}|${a.code}|${a.subject || ''}`);
    }
  }
  return { sentKeys: [...keys], notified };
}

function isoDaysBefore(day, n) {
  return new Date(new Date(`${day}T00:00:00Z`).getTime() - n * 86400000).toISOString().slice(0, 10);
}
function r2(n) { return Math.round(Number(n) * 100) / 100; }

module.exports = { runSpendMonitor, dailyTotalsFromEntries };
