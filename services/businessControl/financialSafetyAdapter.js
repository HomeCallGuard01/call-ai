// Money tab ← Pricing Safety's financial-safety layer (2026-09-29).
//
// Contract (feature/provider-neutral-billing-ledger, NOT merged):
//   services/finance/spendMonitor.js runSpendMonitor() returns
//     { ok, asOf, alerts[], protection{ name, reasons[], actions[],
//       thresholds, blocksCallDelivery:false }, metrics{ asOf, month,
//       currency:'GBP', protectionLevel, company{ todaySpendGbp,
//       monthToDateGbp, householdAttributedGbp, unallocatedGbp,
//       unknownItems, unconverted, entitledHouseholds, householdsWithCost,
//       projectedLossMakingHouseholds }, households[{ householdId,
//       monthToDateGbp, projectedMonthGbp, projectedContributionGbp,
//       trustedMinutes, unknownMinutes, monitoredMinutes, costGbp{
//       number_rental, inbound_trusted, inbound_unknown, … }, quality }] } }
//   Its wiring doc: a scheduled run persists the latest result; "the
//   dashboard reads metrics". The dashboard therefore needs ONE provider:
//     services/finance/latestSpendMonitorResult.js
//       → getLatestSpendMonitorResult(): Promise<result | null>
//   Until Finance ships it, every figure here is NOT CONNECTED.
//
// Rules (Finance's own, LEDGER_REPORTING_INTERFACE.md §1 and
// FINANCIAL_SAFETY_CONTROLS.md invariants):
//   - missing, failed or stale data is never £0: amounts are null and the
//     state says why; stale figures are shown only with their age;
//   - UNKNOWN (unpriced) items are counted, never summed;
//   - unallocated cost stays company-level;
//   - nothing here acts: recommended actions are displayed, never run.
// Pure except loadFinancialSafety().
'use strict';

const COMPONENT_LABELS = {
  number_rental: 'Number rental',
  inbound_trusted: 'Inbound — trusted calls',
  inbound_unknown: 'Inbound — unknown callers',
  inbound_unclassified: 'Inbound — not yet classified',
  app_leg: 'App leg',
  outbound_voice: 'Outbound voice',
  media_stream: 'Media streams (monitoring)',
  tts: 'Text-to-speech',
  sms: 'SMS',
  transcription: 'AI transcription',
  other: 'Other',
};
// Trusted-call cost = the PSTN leg of known-contact calls (+ app leg).
// Monitored-call cost = everything an unknown call adds: its PSTN leg,
// the media stream, transcription and TTS. Basis shown in the UI.
const TRUSTED_COMPONENTS = ['inbound_trusted', 'app_leg'];
const MONITORED_COMPONENTS = ['inbound_unknown', 'media_stream', 'transcription', 'tts'];
const LEVELS = ['NORMAL', 'WATCH', 'ALERT', 'EMERGENCY'];
const DATA_ALERTS = new Set(['COST_DATA_MISSING', 'COST_DATA_STALE', 'MONITOR_LOAD_FAILED']);
const DEFAULT_MAX_AGE_HOURS = 30; // spendAnomaly's maxDataAgeHours: ingestion should run at least daily

const r2 = (n) => (n === null || n === undefined || !Number.isFinite(Number(n)) ? null : Math.round(Number(n) * 100) / 100);

function notConnected(reason) {
  return { state: 'not_connected', reason, level: null, asOf: null, ageHours: null, company: null, components: null, split: null, outliers: [], warnings: [{ severity: 'info', text: reason }], actions: [], alerts: [] };
}

// Pure. `result` is runSpendMonitor()'s return value (or null).
function adaptSpendMonitorResult(result, { now = new Date(), maxAgeHours = DEFAULT_MAX_AGE_HOURS, outlierLimit = 5 } = {}) {
  if (!result) return notConnected('Financial safety data not connected (spend monitor not deployed or not yet run).');
  const alerts = (result.alerts || []).map((a) => ({ code: a.code, severity: a.severity, detail: a.detail, subject: a.subject || null }));
  const protection = result.protection || null;
  const level = protection && LEVELS.includes(protection.name) ? protection.name : null;
  const actions = ((protection && protection.actions) || []).map((a) => ({ id: a.id, label: a.label || a.id, status: a.status, kind: a.kind || null }));

  const asOf = result.asOf || (result.metrics && result.metrics.asOf) || null;
  const asOfMs = asOf ? new Date(asOf).getTime() : NaN;
  const ageHours = Number.isFinite(asOfMs) ? Math.round(((now.getTime() - asOfMs) / 3600000) * 10) / 10 : null;

  if (!result.ok || !result.metrics) {
    const failed = alerts.find((a) => a.code === 'MONITOR_LOAD_FAILED');
    return { ...notConnected(failed ? `Spend monitor could not load cost data: ${failed.detail}` : 'Spend monitor returned no metrics.'), state: 'load_failed', level, asOf, ageHours, alerts, actions };
  }

  const m = result.metrics;
  const warnings = [];
  const dataAlerts = alerts.filter((a) => DATA_ALERTS.has(a.code));
  const runStale = ageHours === null || ageHours > maxAgeHours;
  const stale = runStale || dataAlerts.length > 0;
  if (runStale) warnings.push({ severity: 'critical', text: ageHours === null ? 'Spend monitor result has no timestamp: treat every figure as unverified.' : `Spend monitor last ran ${ageHours}h ago (limit ${maxAgeHours}h): spend since then is unobserved, not zero.` });
  for (const a of dataAlerts) warnings.push({ severity: 'critical', text: a.detail });
  if (m.currency && m.currency !== 'GBP') warnings.push({ severity: 'critical', text: `Metrics are in ${m.currency}; the dashboard shows GBP only — not displayed as £.` });

  const c = m.company || {};
  if (Number(c.unknownItems) > 0) warnings.push({ severity: 'warning', text: `${c.unknownItems} cost item(s) not yet priced by the provider — counted, not included as £0.` });
  const unconverted = c.unconverted && typeof c.unconverted === 'object' ? Object.entries(c.unconverted).filter(([, v]) => Number(v) > 0) : [];
  if (unconverted.length) warnings.push({ severity: 'warning', text: `Not converted to GBP (no rate): ${unconverted.map(([cur, v]) => `${cur} ${Number(v).toFixed(2)}`).join(', ')} — excluded from £ totals.` });

  const households = m.households || [];
  // Component totals: household-attributed components; unallocated stays
  // its own line (never spread across customers).
  const components = Object.keys(COMPONENT_LABELS).map((key) => {
    const vals = households.map((h) => (h.costGbp ? h.costGbp[key] : undefined)).filter((v) => v !== undefined && v !== null);
    return { key, label: COMPONENT_LABELS[key], amountGbp: households.length === 0 ? null : r2(vals.reduce((s, v) => s + Number(v), 0)) };
  });
  components.push({ key: 'unallocated', label: 'Unallocated (no household — e.g. staging/orphan numbers, account fees)', amountGbp: r2(c.unallocatedGbp) });
  const sumOf = (keys) => (households.length === 0 ? null : r2(components.filter((x) => keys.includes(x.key)).reduce((s, x) => s + (x.amountGbp || 0), 0)));

  // Projected month-end: the ESTIMATE is only formed from observed data.
  let projectedMonthEndGbp = null;
  let projectionBasis = 'not available';
  const mtd = r2(c.monthToDateGbp);
  if (mtd !== null && !stale && asOf) {
    const d = new Date(asOf);
    const day = d.getUTCDate() - 1 + (d.getUTCHours() * 60 + d.getUTCMinutes()) / 1440;
    const daysInMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    if (day >= 1) {
      projectedMonthEndGbp = r2((mtd / day) * daysInMonth);
      projectionBasis = `ESTIMATED: month-to-date ÷ ${day.toFixed(1)} days × ${daysInMonth} (linear)`;
    } else {
      projectionBasis = 'too early in the month to project';
    }
  } else if (stale) {
    projectionBasis = 'not projected: cost data is stale or missing';
  }

  const outliers = households
    .filter((h) => Number.isFinite(Number(h.projectedMonthGbp)))
    .sort((a, b) => Number(b.projectedMonthGbp) - Number(a.projectedMonthGbp))
    .slice(0, outlierLimit)
    .map((h) => ({
      householdRef: String(h.householdId || '').slice(0, 8),
      householdId: h.householdId,
      monthToDateGbp: r2(h.monthToDateGbp),
      projectedMonthGbp: r2(h.projectedMonthGbp),
      projectedContributionGbp: r2(h.projectedContributionGbp),
      lossMaking: Number(h.projectedContributionGbp) < 0,
      trustedMinutes: h.trustedMinutes ?? null,
      monitoredMinutes: h.monitoredMinutes ?? null,
      unknownItems: h.quality ? h.quality.unknownItems || 0 : null,
    }));

  return {
    state: stale ? 'stale' : 'ok',
    reason: stale ? 'Figures shown with their age; spend after that is unobserved.' : null,
    level,
    levelReasons: (protection && protection.reasons) || [],
    blocksCallDelivery: false,
    asOf,
    ageHours,
    month: m.month || null,
    company: {
      todaySpendGbp: r2(c.todaySpendGbp),
      monthToDateGbp: mtd,
      projectedMonthEndGbp,
      projectionBasis,
      householdAttributedGbp: r2(c.householdAttributedGbp),
      unallocatedGbp: r2(c.unallocatedGbp),
      unknownItems: Number.isFinite(Number(c.unknownItems)) ? Number(c.unknownItems) : null,
      entitledHouseholds: c.entitledHouseholds ?? null,
      householdsWithCost: c.householdsWithCost ?? null,
      projectedLossMakingHouseholds: c.projectedLossMakingHouseholds ?? null,
    },
    components,
    split: {
      trustedCallCostGbp: sumOf(TRUSTED_COMPONENTS),
      monitoredCallCostGbp: sumOf(MONITORED_COMPONENTS),
      numberRentalGbp: sumOf(['number_rental']),
      basis: 'Trusted = inbound leg of known-contact calls + app leg. Monitored = unknown-caller inbound leg + media stream + transcription + TTS. Rental = household-attributed numbers only; unattributed rental is in "Unallocated".',
    },
    outliers,
    warnings,
    actions,
    alerts,
  };
}

// Loader: the one provider Finance is expected to add. Absent → not
// connected. Any error → load_failed (never zero).
async function loadFinancialSafety({ now = new Date(), requireProvider = () => require('../finance/latestSpendMonitorResult') } = {}) {
  let provider;
  try {
    provider = requireProvider();
  } catch (err) {
    return notConnected('Financial safety layer not connected: feature/provider-neutral-billing-ledger (spend monitor, ledger 051) is not merged or deployed.');
  }
  try {
    const result = await provider.getLatestSpendMonitorResult();
    return adaptSpendMonitorResult(result, { now });
  } catch (err) {
    return { ...notConnected(`Could not read the latest spend monitor result: ${String(err && err.message || err).slice(0, 160)}`), state: 'load_failed' };
  }
}

module.exports = { adaptSpendMonitorResult, loadFinancialSafety, COMPONENT_LABELS, TRUSTED_COMPONENTS, MONITORED_COMPONENTS, DEFAULT_MAX_AGE_HOURS };
