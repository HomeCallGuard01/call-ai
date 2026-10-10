// Integration 2026-10-10: WS2's profitability portfolio (contract §B,
// docs/launch/2026-10-10-WS2-REPORT.md) → the shape the Financial Control
// Centre page (WS4, admin-financial-control.html) renders, contract
// "ws2-profitability-v1" (docs/launch/2026-10-10-WS4-REPORT.md §7). Pure and
// read-only. Unknown values stay null (the page shows "—"), never zero: a
// cost breakdown the model doesn't have (telephony/AI/SMS split) is null, and
// provider reconciliation is reported unavailable because production has no
// provider-actuals feed (WS2 finding 2).
'use strict';

const CONTRACT_VERSION = 'ws2-profitability-v1';
const PRICE_LABELS = { standard_599: '£5.99', grandfathered_499: '£4.99 (grandfathered)' };
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const pctOf = (part, whole) => (num(part) !== null && num(whole) !== null && whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);

function toCustomer(row) {
  const r = row || {};
  const revenue = r.revenue || {};
  const cost = r.cost || {};
  const contribution = r.contribution || {};
  const projection = r.projection || {};
  const allowance = r.allowance || {};
  return {
    householdId: r.householdId || null,
    accountNumber: r.accountNumber || null,
    segment: r.profile || null,
    channel: r.channel || null,
    priceLabel: PRICE_LABELS[r.pricePoint] || null,
    grandfathered: r.pricePoint === 'grandfathered_499',
    joinedAt: null,
    revenue: {
      grossGbp: revenue.counted ? num(revenue.grossInclVatGbp) : null,
      netGbp: num(revenue.netRevenueGbp),
      basis: revenue.counted ? 'actual' : `not_counted:${revenue.reasonNotCounted || 'unknown'}`,
    },
    cost: {
      attributableGbp: num(cost.totalGbp),
      telephonyGbp: null,
      aiGbp: null,
      smsGbp: null,
      numberRentalGbp: num(cost.numberRentalGbp),
      basis: 'fortress_committed_conservative',
    },
    margin: {
      actualGbp: num(contribution.gbp),
      actualPct: num(contribution.marginPct),
      projectedGbp: num(projection.projectedContributionGbp),
      projectedPct: pctOf(num(projection.projectedContributionGbp), num(revenue.netRevenueGbp)),
    },
    allowance: {
      usedPercent: num(allowance.percentUsed),
      remainingGbp: num(allowance.budgetRemainingGbp),
      budgetGbp: num(allowance.budgetGbp),
      topUpsGbp: num(allowance.topUpCreditGbp),
      resetsAt: null,
    },
    flags: Array.isArray(r.flags) ? r.flags.slice() : [],
  };
}

const SIGNAL_RULES = [
  ['loss_making', 'red', 'Loss-making this period'],
  ['hard_ceiling', 'red', 'Reached the hard ceiling'],
  ['held', 'red', 'Household on financial hold'],
  ['reconciliation_gap', 'amber', 'Provider actuals differ from the ledger'],
  ['actual_exceeds_estimate', 'amber', 'Provider actual exceeded the Fortress estimate'],
  ['projected_loss', 'amber', 'Projected to be loss-making by period end'],
  ['heavy_user', 'amber', 'Heavy user'],
];

/** Pure: WS2 portfolio → control-centre v1. */
function toControlCentreV1(portfolio) {
  const p = portfolio || {};
  const t = p.totals || {};
  const period = p.period || {};
  const customers = (Array.isArray(p.households) ? p.households : []).map(toCustomer);
  const signals = [];
  for (const c of customers) {
    for (const [flag, severity, title] of SIGNAL_RULES) {
      if (c.flags.includes(flag)) signals.push({ severity, title, detail: flag, accountNumber: c.accountNumber });
    }
  }
  for (const w of Array.isArray(p.warnings) ? p.warnings : []) signals.push({ severity: 'info', title: 'Data warning', detail: String(w), accountNumber: null });
  for (const c of customers) {
    if (!c.allowance.resetsAt && period.end) c.allowance.resetsAt = period.end;
  }
  return {
    contractVersion: CONTRACT_VERSION,
    generatedAt: p.generatedAt || null,
    period: { label: typeof period.start === 'string' ? period.start.slice(0, 7) : null, start: period.start || null, end: period.end || null },
    currency: 'GBP',
    basis: (p.assumptions && p.assumptions.usageCostBasis) || null,
    totals: {
      customers: num(t.households),
      revenueNetGbp: num(t.netRevenueGbp),
      attributableCostGbp: num(t.attributableCostGbp),
      marginGbp: num(t.contributionGbp),
      marginPct: num(t.marginPct),
      projectedMarginPct: pctOf(num(t.projectedContributionGbp), num(t.netRevenueGbp)),
    },
    customers,
    providerReconciliation: { available: false, reason: 'No provider-actuals feed in production yet; offline reconciliation only (WS2).', rows: [] },
    signals,
    // Advisory text only — hard limits are enforced by the Fortress, never here.
    recommendations: [],
  };
}

module.exports = { toControlCentreV1, CONTRACT_VERSION };
