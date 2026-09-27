// spendGuard.js — evaluates provider spend and usage against thresholds and
// returns alerts. Pure: callers pass in the figures (ledger daily totals,
// owned-number count, per-household usage); nothing here calls a provider,
// writes, blocks a call or changes configuration. Enforcement (call time
// limits, allowance cut-offs) belongs to the call path and its owners — see
// docs/finance/PROVIDER_SPEND_PROTECTION.md.
//
// Thresholds are proposals derived from the 2026-09 unit economics
// (break-even ≈ 220–320 total minutes/month per household at £4.99) and are
// all overridable. Every default is DECISION REQUIRED until Andrew confirms.
'use strict';

const DEFAULT_THRESHOLDS = {
  // Numbers owned beyond entitled households + an allowance for internal/test/quarantine.
  spareNumbersWarning: 3,
  spareNumbersCritical: 10,
  // Daily telephony spend (GBP, all provider categories).
  dailySpendFloorGbp: 3,
  dailySpendPerEntitledGbp: 0.15, // ≈ 2× the break-even daily run-rate per household
  criticalMultiplier: 3,
  // Month-to-date budget; defaults to £2.50 per entitled household if not set.
  monthlyBudgetGbp: null,
  monthlyBudgetPerEntitledGbp: 2.5,
  monthlyWarningShare: 0.8,
  // AI (transcription/analysis) daily spend.
  dailyAiFloorGbp: 1,
  dailyAiPerEntitledGbp: 0.05,
  // SMS per day.
  dailySmsFloor: 10,
  dailySmsPerEntitled: 1,
  // Per-household usage.
  householdDailyMinutesWarning: 120,
  householdDailyMinutesCritical: 300,
  householdMonthMinutesWarning: 250, // ≈ break-even
  householdMonthMinutesCritical: 500,
  longCallMinutesWarning: 60,
  longCallMinutesCritical: 180,
};

function level(value, warning, critical) {
  if (critical != null && value >= critical) return 'CRITICAL';
  if (warning != null && value >= warning) return 'WARNING';
  return null;
}

/**
 * @param {object} input
 * @param {number} input.entitledHouseholds
 * @param {number} [input.ownedNumbers]
 * @param {{ date: string, category: string, amount: number, currency: string, count?: number|null }[]} [input.dailyTotals]
 *        supplierDailyTotals(...).totals for ONE day (GBP rows only are summed).
 * @param {number} [input.monthToDateGbp]
 * @param {number} [input.aiSpendGbp] - the day's AI spend (estimated or actual)
 * @param {{ householdId: string, dayMinutes?: number, monthMinutes?: number, longestCallMinutes?: number }[]} [input.households]
 * @param {object} [overrides]
 * @returns {{ code: string, severity: 'WARNING'|'CRITICAL', value: number, threshold: number, subject?: string, detail: string }[]}
 */
function evaluateSpend(input, overrides = {}) {
  const t = { ...DEFAULT_THRESHOLDS, ...overrides };
  const entitled = Math.max(0, Number(input.entitledHouseholds) || 0);
  const alerts = [];
  const push = (code, severity, value, threshold, detail, subject) => {
    if (severity) alerts.push({ code, severity, value, threshold, detail, ...(subject ? { subject } : {}) });
  };

  if (input.ownedNumbers != null) {
    const spare = input.ownedNumbers - entitled;
    const sev = level(spare, t.spareNumbersWarning, t.spareNumbersCritical);
    push('NUMBERS_ABOVE_ENTITLED', sev, spare, sev === 'CRITICAL' ? t.spareNumbersCritical : t.spareNumbersWarning,
      `${input.ownedNumbers} numbers owned for ${entitled} entitled households`);
  }

  const rows = input.dailyTotals || [];
  const nonGbp = rows.filter((r) => r.currency !== 'GBP');
  if (nonGbp.length) {
    push('SPEND_UNEVALUATED_CURRENCY', 'WARNING', nonGbp.length, 0, `${nonGbp.length} daily total(s) not in GBP were not evaluated`);
  }
  const gbp = rows.filter((r) => r.currency === 'GBP');
  if (gbp.length) {
    const total = gbp.reduce((s, r) => s + Number(r.amount), 0);
    const warn = Math.max(t.dailySpendFloorGbp, entitled * t.dailySpendPerEntitledGbp);
    const sev = level(total, warn, warn * t.criticalMultiplier);
    push('DAILY_TELEPHONY_SPEND', sev, round(total), round(sev === 'CRITICAL' ? warn * t.criticalMultiplier : warn), `telephony spend ${gbp[0].date}`);

    const smsRows = gbp.filter((r) => r.category === 'sms');
    const smsCount = smsRows.reduce((s, r) => s + (Number(r.count) || 0), 0);
    const smsWarn = Math.max(t.dailySmsFloor, entitled * t.dailySmsPerEntitled);
    const smsSev = level(smsCount, smsWarn, smsWarn * t.criticalMultiplier);
    push('SMS_VOLUME', smsSev, smsCount, smsSev === 'CRITICAL' ? smsWarn * t.criticalMultiplier : smsWarn, 'SMS messages in one day');
    // A failed-message fee means a warning SMS did not reach the customer
    // (2026-09: HCG's numbers are voice-only, error 21661) — a safety
    // failure as much as a cost.
    if (smsRows.some((r) => r.sourceCategory === 'failed-message-processing-fee' && Number(r.amount) > 0)) {
      push('SMS_DELIVERY_FAILING', 'CRITICAL', 1, 0, 'failed-message processing fees were charged: warning SMS are not being delivered');
    }
  }

  if (input.monthToDateGbp != null) {
    const budget = t.monthlyBudgetGbp != null ? t.monthlyBudgetGbp : Math.max(t.dailySpendFloorGbp * 30, entitled * t.monthlyBudgetPerEntitledGbp);
    const sev = level(input.monthToDateGbp, budget * t.monthlyWarningShare, budget);
    push('MONTHLY_BUDGET', sev, round(input.monthToDateGbp), round(budget), 'month-to-date provider spend against budget');
  }

  if (input.aiSpendGbp != null) {
    const warn = Math.max(t.dailyAiFloorGbp, entitled * t.dailyAiPerEntitledGbp);
    const sev = level(input.aiSpendGbp, warn, warn * t.criticalMultiplier);
    push('DAILY_AI_SPEND', sev, round(input.aiSpendGbp), round(sev === 'CRITICAL' ? warn * t.criticalMultiplier : warn), 'AI spend in one day');
  }

  for (const h of input.households || []) {
    if (h.dayMinutes != null) {
      const sev = level(h.dayMinutes, t.householdDailyMinutesWarning, t.householdDailyMinutesCritical);
      push('HOUSEHOLD_DAILY_MINUTES', sev, h.dayMinutes, sev === 'CRITICAL' ? t.householdDailyMinutesCritical : t.householdDailyMinutesWarning, 'call minutes today', h.householdId);
    }
    if (h.monthMinutes != null) {
      const sev = level(h.monthMinutes, t.householdMonthMinutesWarning, t.householdMonthMinutesCritical);
      push('HOUSEHOLD_MONTH_MINUTES', sev, h.monthMinutes, sev === 'CRITICAL' ? t.householdMonthMinutesCritical : t.householdMonthMinutesWarning, 'call minutes this month', h.householdId);
    }
    if (h.longestCallMinutes != null) {
      const sev = level(h.longestCallMinutes, t.longCallMinutesWarning, t.longCallMinutesCritical);
      push('LONG_CALL', sev, h.longestCallMinutes, sev === 'CRITICAL' ? t.longCallMinutesCritical : t.longCallMinutesWarning, 'longest single call (minutes)', h.householdId);
    }
  }

  const rank = { CRITICAL: 0, WARNING: 1 };
  return alerts.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

function round(n) {
  return Math.round(Number(n) * 100) / 100;
}

module.exports = { evaluateSpend, DEFAULT_THRESHOLDS };
