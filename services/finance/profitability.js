// profitability.js — per-household profitability read model (WS2, 2026-10-10).
//
// Pure. Implements the WS4 contract in docs/launch/2026-10-10-WS2-REPORT.md §B:
// per household per billing period (UTC calendar month) —
//   net revenue  = gross subscription (VAT removed) − platform fee − leakage
//                  + top-up net revenue − refunded top-ups
//   attributable = Fortress committed usage (conservative: Fortress charges
//                  max(estimate × uplift, provider actual)) + number rental
//                  + fixed allocation
//   contribution, margin, projected period-end, heavy-user flags, allowance.
//
// Revenue is COUNTED only when it is provably real: a Stripe price listed in
// FINANCE_STRIPE_LIVE_PRICES (live price ids only — a test-mode price is never
// listed), or an Apple/Google entitlement whose RevenueCat environment is
// 'production'. Sandbox, test, trial, complimentary and unknown prices count
// £0 with an explicit reasonNotCounted — never a guess.
'use strict';

const register = require('./economicsRegister');
const { CHANNELS } = require('./unitEconomics');

const FLAGS = Object.freeze(['heavy_user', 'loss_making', 'projected_loss', 'held', 'hard_ceiling', 'actual_exceeds_estimate', 'revenue_not_counted', 'reconciliation_gap']);
const r2 = (n) => Math.round(Number(n) * 100) / 100;
const r4 = (n) => Math.round(Number(n) * 1e4) / 1e4;
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

function parseJson(raw, fallback) {
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

function resolveProfitabilityConfig(env = process.env) {
  const live = parseJson(env.FINANCE_STRIPE_LIVE_PRICES, {});
  const stripeLivePrices = {};
  for (const [id, gbp] of Object.entries(live && typeof live === 'object' ? live : {})) {
    if (/^price_[A-Za-z0-9]+$/.test(id) && Number.isFinite(Number(gbp)) && Number(gbp) > 0 && Number(gbp) < 100) stripeLivePrices[id] = Number(gbp);
  }
  const posNum = (v, d, max = 100) => (Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= max && v !== '' && v !== undefined ? Number(v) : d);
  return {
    vatRate: register.value('vatRate'),
    pricePoints: { standard_599: register.value('priceIncVatGbp'), grandfathered_499: 4.99 },
    stripeLivePrices,
    appleGrossGbp: posNum(env.FINANCE_APPLE_PRICE_GBP, 4.99),
    googleGrossGbp: posNum(env.FINANCE_GOOGLE_PRICE_GBP, register.value('priceIncVatGbp')),
    numberRentalGbpPerMonth: register.value('numberRentalGbpPerMonth'),
    fixedAllocationGbpPerHousehold: register.value('infrastructureAllocationGbpPerCustomer'),
    leakageRate: register.value('revenueLeakageRate'),
    feeModels: { stripe: 'stripe', apple: CHANNELS[env.FINANCE_APPLE_FEE_MODEL] ? env.FINANCE_APPLE_FEE_MODEL : 'apple30', google: 'store15' },
    heavyUserProjectedUsageGbp: posNum(env.FINANCE_HEAVY_PROJECTED_USAGE_GBP, 3.0),
  };
}

function publicAssumptions(c) {
  return {
    vatRate: c.vatRate, pricePoints: c.pricePoints, numberRentalGbpPerMonth: c.numberRentalGbpPerMonth,
    fixedAllocationGbpPerHousehold: c.fixedAllocationGbpPerHousehold, leakageRate: c.leakageRate, feeModels: c.feeModels,
    usageCostBasis: 'fortress_committed_conservative', heavyUserProjectedUsageGbp: c.heavyUserProjectedUsageGbp,
    stripeLivePricesConfigured: Object.keys(c.stripeLivePrices).length,
  };
}

/** UTC calendar month for 'YYYY-MM' (or the month containing `now`). null if invalid. */
function resolvePeriod(month, now = new Date()) {
  let y; let m;
  if (month === undefined || month === null || month === '') { y = now.getUTCFullYear(); m = now.getUTCMonth(); }
  else {
    const mt = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(String(month));
    if (!mt) return null;
    y = Number(mt[1]); m = Number(mt[2]) - 1;
  }
  const start = new Date(Date.UTC(y, m, 1));
  const end = new Date(Date.UTC(y, m + 1, 1));
  const elapsed = Math.min(1, Math.max(0, (now.getTime() - start.getTime()) / (end.getTime() - start.getTime())));
  return { start: start.toISOString(), end: end.toISOString(), elapsedFraction: r4(elapsed), basis: 'calendar_month_utc' };
}

function channelOf(entitlement) {
  const s = String((entitlement && entitlement.source) || '');
  if (s === 'stripe') return 'stripe';
  if (s === 'apple_revenuecat' || s === 'apple') return 'apple';
  if (/google/.test(s)) return 'google';
  return s ? 'other' : 'none';
}

function pricePointFor(gross, c) {
  if (Math.abs(gross - c.pricePoints.standard_599) < 0.005) return 'standard_599';
  if (Math.abs(gross - c.pricePoints.grandfathered_499) < 0.005) return 'grandfathered_499';
  return 'other';
}

function feeFor(channel, gross, net, c) {
  const model = CHANNELS[c.feeModels[channel]];
  return model ? model.fee(gross, net) : 0;
}

/** Subscription revenue for the period. Pure. */
function subscriptionRevenue({ entitlement, subscription }, c) {
  const none = (reason, channel = channelOf(entitlement)) => ({ counted: false, reasonNotCounted: reason, channel, pricePoint: 'none', grossInclVatGbp: 0, vatGbp: 0, netExVatGbp: 0, platformFeeGbp: 0, leakageGbp: 0 });
  if (!entitlement) return none('no_entitlement', 'none');
  const type = entitlement.entitlement_type;
  if (['complimentary', 'partner', 'staff'].includes(type)) return { ...none('complimentary'), channel: 'complimentary' };
  if (type === 'free_trial') return none('trial');
  const channel = channelOf(entitlement);
  let gross = null;
  if (channel === 'stripe') {
    const priceId = subscription && subscription.stripe_price_id;
    if (!priceId || !c.stripeLivePrices[priceId]) return none('unknown_price');
    if (subscription && ['incomplete', 'incomplete_expired', 'unpaid'].includes(subscription.status)) return none('unpaid');
    gross = c.stripeLivePrices[priceId];
  } else if (channel === 'apple' || channel === 'google') {
    if (entitlement.revenuecat_environment !== 'production') return none('sandbox');
    if (entitlement.store_refunded_at) return none('refunded');
    gross = channel === 'apple' ? c.appleGrossGbp : c.googleGrossGbp;
  } else {
    return none('unknown_channel');
  }
  const net = gross / (1 + c.vatRate);
  const fee = feeFor(channel, gross, net, c);
  return { counted: true, reasonNotCounted: null, channel, pricePoint: pricePointFor(gross, c), grossInclVatGbp: r4(gross), vatGbp: r4(gross - net),
    netExVatGbp: r4(net), platformFeeGbp: r4(fee), leakageGbp: r4(net * c.leakageRate) };
}

/** Top-up revenue in the period (production GBP only). Pure. */
function topUpRevenue(credits, c) {
  let netGbp = 0; let refundsGbp = 0; let creditGbp = 0;
  const byTxn = new Map();
  for (const cr of credits || []) {
    if (cr.environment !== 'production') continue;
    if (cr.kind === 'topup') {
      creditGbp += num(cr.applied_budget_gbp);
      if (String(cr.currency || '').toLowerCase() === 'gbp' && Number.isInteger(cr.amount_minor) && cr.amount_minor > 0) {
        const gross = cr.amount_minor / 100;
        const net = gross / (1 + c.vatRate);
        const channel = cr.source === 'stripe' ? 'stripe' : cr.source;
        const v = net - feeFor(channel, gross, net, c);
        byTxn.set(`${cr.source}:${cr.provider_transaction_id}`, v);
        netGbp += v;
      }
    } else if (cr.kind === 'topup_reversal') {
      creditGbp += num(cr.applied_budget_gbp);
      const v = byTxn.get(`${cr.source}:${cr.provider_transaction_id}`);
      if (v !== undefined) refundsGbp += v;
    }
  }
  return { topUpNetGbp: r4(netGbp), refundsGbp: r4(refundsGbp), topUpCreditGbp: r4(creditGbp) };
}

/** Deterministic allowance state from an account snapshot (no live worst cases). Mirrors 076. */
function snapshotState(a, { held = false, lowRatio = 0.8, callCost = 0.071339, screenCost = 0.337616 } = {}) {
  if (held) return 'held';
  if (!a) return 'normal';
  const budget = num(a.base_budget_gbp) + num(a.adjustments_gbp);
  const used = num(a.consumed_gbp) + num(a.reserved_gbp);
  const avail = budget - used;
  const T = num(a.delivery_reserve_gbp); const U = num(a.unscreened_reserve_gbp);
  const scope = a.delivery_reserve_scope || 'trusted_only';
  const trustedRem = scope === 'none' ? 0 : Math.max(0, Math.min(T, avail + T));
  const unsRem = Math.max(0, U - num(a.unscreened_consumed_gbp) - num(a.unscreened_reserved_gbp));
  const canCall = avail >= callCost;
  const trusted = canCall || (scope !== 'none' && avail + T >= callCost);
  const unknown = canCall || (scope === 'all' && avail + T >= callCost) || unsRem >= callCost;
  if (!trusted && !unknown) return 'hard_ceiling';
  const tUsed = T > 0 && scope !== 'none' ? 1 - trustedRem / T : 0;
  const uUsed = U > 0 ? 1 - unsRem / U : 0;
  if (!canCall) return tUsed >= lowRatio || uUsed >= lowRatio ? 'continuity_low' : 'continuity';
  if (avail < screenCost) return 'screening_paused';
  return budget > 0 && used / budget >= lowRatio ? 'screening_low' : 'normal';
}

/**
 * One household row. input: { household, entitlement, subscription, accounts[], credits[], held, numbersHeld, reconciliation? }
 */
function computeHouseholdProfitability(input, period, c) {
  const { household, entitlement = null, subscription = null, accounts = [], credits = [], held = false, numbersHeld = 0, reconciliation = null } = input;
  const sub = subscriptionRevenue({ entitlement, subscription }, c);
  const tu = topUpRevenue(credits, c);
  const netRevenue = sub.netExVatGbp - sub.platformFeeGbp - sub.leakageGbp + tu.topUpNetGbp - tu.refundsGbp;

  let committed = 0; let reserved = 0; let actual = 0; let authorisation = 0;
  for (const a of accounts) {
    committed += num(a.consumed_gbp) + num(a.essential_consumed_gbp) + num(a.unscreened_consumed_gbp);
    reserved += num(a.reserved_gbp) + num(a.essential_reserved_gbp) + num(a.unscreened_reserved_gbp);
    actual += num(a.actual_gbp);
    authorisation += num(a.base_budget_gbp) + num(a.adjustments_gbp) + num(a.delivery_reserve_gbp) + num(a.essential_reserve_gbp) + num(a.unscreened_reserve_gbp);
  }
  const usage = Math.max(committed, actual);
  const rental = numbersHeld * c.numberRentalGbpPerMonth;
  const fixed = entitlement ? c.fixedAllocationGbpPerHousehold : 0;
  const totalCost = usage + rental + fixed;
  const contribution = netRevenue - totalCost;

  const f = Math.max(period.elapsedFraction, 1 / 31);
  // Fortress cannot authorise beyond the account's total, so a projection is
  // bounded by it (plus the in-flight reservations already counted).
  const projectedUsage = authorisation > 0 ? Math.min(usage / f, Math.max(usage, authorisation)) : usage / f;
  const projectedTotal = projectedUsage + rental + fixed;
  const projectedContribution = netRevenue - projectedTotal;
  const current = accounts.length ? accounts[accounts.length - 1] : null;
  const state = snapshotState(current, { held });
  const budget = current ? num(current.base_budget_gbp) + num(current.adjustments_gbp) : 0;
  const used = current ? num(current.consumed_gbp) + num(current.reserved_gbp) : 0;

  const flags = [];
  if (projectedUsage >= c.heavyUserProjectedUsageGbp) flags.push('heavy_user');
  if (contribution < 0) flags.push('loss_making');
  if (projectedContribution < 0) flags.push('projected_loss');
  if (held) flags.push('held');
  if (state === 'hard_ceiling') flags.push('hard_ceiling');
  if (actual > committed + 1e-4) flags.push('actual_exceeds_estimate');
  if (!sub.counted) flags.push('revenue_not_counted');
  if (reconciliation && reconciliation.flagged) flags.push('reconciliation_gap');

  return {
    householdId: household.id,
    accountNumber: household.account_number || null,
    profile: current ? current.profile : null,
    channel: sub.channel,
    pricePoint: sub.pricePoint,
    revenue: {
      counted: sub.counted, reasonNotCounted: sub.reasonNotCounted,
      grossInclVatGbp: r2(sub.grossInclVatGbp), vatGbp: r2(sub.vatGbp), netExVatGbp: r2(sub.netExVatGbp),
      platformFeeGbp: r2(sub.platformFeeGbp), leakageGbp: r2(sub.leakageGbp), topUpNetGbp: r2(tu.topUpNetGbp), refundsGbp: r2(tu.refundsGbp),
      netRevenueGbp: r2(netRevenue),
    },
    cost: {
      fortressCommittedGbp: r2(committed), fortressReservedGbp: r2(reserved), providerActualGbp: r2(actual),
      attributableUsageGbp: r2(usage), numberRentalGbp: r2(rental), fixedAllocationGbp: r2(fixed), totalGbp: r2(totalCost),
    },
    contribution: { gbp: r2(contribution), marginPct: sub.netExVatGbp > 0 ? Math.round((contribution / sub.netExVatGbp) * 1000) / 10 : null },
    projection: { projectedUsageGbp: r2(projectedUsage), projectedTotalCostGbp: r2(projectedTotal), projectedContributionGbp: r2(projectedContribution) },
    allowance: {
      state, percentUsed: budget > 0 ? Math.min(100, Math.floor((used / budget) * 100)) : null,
      budgetGbp: current ? r2(current.base_budget_gbp) : null, topUpCreditGbp: r2(tu.topUpCreditGbp),
      budgetRemainingGbp: current ? r2(budget - used) : null,
      trustedReserveRemainingGbp: current ? r2(Math.max(0, Math.min(num(current.delivery_reserve_gbp), budget - used + num(current.delivery_reserve_gbp)))) : null,
      unknownReserveRemainingGbp: current ? r2(Math.max(0, num(current.unscreened_reserve_gbp) - num(current.unscreened_consumed_gbp) - num(current.unscreened_reserved_gbp))) : null,
      held: Boolean(held),
    },
    flags,
  };
}

/** Portfolio (contract §B.2). rows = computeHouseholdProfitability outputs. */
function buildPortfolio(rows, { period, config, flag = null, limit = 100, offset = 0, now = new Date(), warnings = [] }) {
  const filtered = flag ? rows.filter((r) => r.flags.includes(flag)) : rows;
  const sum = (fn) => r2(filtered.reduce((s, r) => s + fn(r), 0));
  const netRevenue = sum((r) => r.revenue.netRevenueGbp);
  const cost = sum((r) => r.cost.totalGbp);
  const netExVat = filtered.reduce((s, r) => s + r.revenue.netExVatGbp, 0);
  const flagCounts = Object.fromEntries(FLAGS.map((f) => [f, filtered.filter((r) => r.flags.includes(f)).length]));
  return {
    version: 1,
    generatedAt: now.toISOString(),
    period,
    assumptions: publicAssumptions(config),
    totals: {
      households: filtered.length,
      countedRevenueHouseholds: filtered.filter((r) => r.revenue.counted).length,
      netRevenueGbp: netRevenue,
      attributableCostGbp: cost,
      contributionGbp: r2(netRevenue - cost),
      marginPct: netExVat > 0 ? Math.round(((netRevenue - cost) / netExVat) * 1000) / 10 : null,
      projectedContributionGbp: sum((r) => r.projection.projectedContributionGbp),
      lossMakingHouseholds: flagCounts.loss_making,
      projectedLossHouseholds: flagCounts.projected_loss,
      heavyHouseholds: flagCounts.heavy_user,
      flagCounts,
    },
    households: filtered.slice(offset, offset + limit),
    page: { limit, offset, total: filtered.length },
    warnings,
  };
}

module.exports = {
  FLAGS, resolveProfitabilityConfig, publicAssumptions, resolvePeriod, subscriptionRevenue, topUpRevenue,
  snapshotState, computeHouseholdProfitability, buildPortfolio,
};
