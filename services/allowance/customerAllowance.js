// customerAllowance.js — the canonical server-side customer allowance read
// model (customer allowance workstream, 2026-10-03). Every customer surface
// (web /dashboard-data, mobile /api/v1/me/dashboard and
// /api/v1/me/allowance) shows THIS object; none of them computes usage,
// remaining, warnings or top-up eligibility itself.
//
// It CONSUMES Financial Fortress (056): the numbers come from
// getHouseholdAllowance (services/usage/householdAllowance.js), which
// reads the same counters begin_monitoring_session enforces on. Nothing
// here can loosen enforcement — it only describes it. Top-up and
// adjustment credits (063) are already inside Fortress's allowance total
// (bonus_monitored_seconds); this model only breaks them out for display.
//
// Never throws. If anything can't be read, status is 'unavailable' and
// monitoringActive is null — never a guess of "protected".
//
// Shape (version 1) — see docs/handovers/2026-10-03-customer-allowance-
// billing-handover.md §6 for the field contract.
'use strict';

const { getHouseholdAllowance } = require('../usage/householdAllowance');
const { resolvePlanForEntitlement } = require('../usage/plans');
const { resolveEntitlementState } = require('./entitlementState');
const { resolveTopUpProducts } = require('./productCatalog');
const { fromFortressHouseholdStatus } = require('./fortressAdapter');

const PLATFORM_CHANNEL = { web: 'stripe', ios: 'apple', android: 'google' };
const ENTITLED_STATES = new Set(['active', 'trial', 'complimentary', 'cancelling', 'payment_issue']);

function statusFor(monitoring, membership) {
  if (!ENTITLED_STATES.has(membership.state)) return 'inactive';
  if (monitoring.state === 'unavailable') return 'unavailable';
  // Fortress (£ budget) only: budget AND delivery reserve exhausted — new
  // calls may be refused, so this must never read as "calls continue".
  if (monitoring.callsContinue === false) return 'calls_limited';
  if (monitoring.overAllowance) return 'used_up';
  if (monitoring.state === 'paused') return 'paused';
  const highest = [...monitoring.warningPoints].filter((p) => p < 100 && monitoring.usedPercent >= p).pop();
  if (highest === undefined) return 'ok';
  // The highest configured point below 100 is "very low"; any lower one is "low".
  const below100 = monitoring.warningPoints.filter((p) => p < 100);
  return highest === below100[below100.length - 1] && below100.length > 1 ? 'very_low' : 'low';
}

function toneFor(status) {
  if (status === 'ok') return 'good';
  if (status === 'low') return 'caution';
  if (status === 'very_low' || status === 'used_up' || status === 'paused' || status === 'calls_limited') return 'critical';
  return 'neutral';
}

function topUpOffer({ membership, monitoring, platform, now, env }) {
  const off = (reason) => ({ available: false, reason, products: [], expiresAtReset: true });
  if (env.ALLOWANCE_TOPUPS_ENABLED !== 'true') return off('not_enabled');
  const channel = PLATFORM_CHANNEL[platform];
  if (!channel) return off('unknown_platform');
  if (membership.testPurchase) return off('test_membership');
  if (membership.state === 'payment_issue') return off('payment_issue');
  if (!ENTITLED_STATES.has(membership.state)) return off('not_entitled');
  if (monitoring.state === 'unavailable' || !monitoring.resetsAt) return off('unavailable');
  const { products, economics } = resolveTopUpProducts(env);
  const hoursToReset = (Date.parse(monitoring.resetsAt) - now.getTime()) / 3600000;
  if (hoursToReset < economics.minHoursBeforeReset) return off('reset_soon');
  const offered = products
    .filter((p) => p.active && p.channels[channel] && p.channels[channel].viable)
    .map((p) => ({ code: p.code, minutes: p.minutes, priceGbpInclVat: p.priceGbpInclVat, channel, providerProductId: p.channels[channel].providerProductId }));
  if (!offered.length) return off(products.length ? 'no_viable_product' : 'not_configured');
  return { available: true, reason: null, products: offered, expiresAtReset: true };
}

function sumCredits(credits) {
  const sum = (kinds) => credits.filter((c) => kinds.includes(c.kind)).reduce((s, c) => s + Number(c.applied_seconds || 0), 0);
  return { topUpSeconds: sum(['topup', 'topup_reversal']), adjustmentSeconds: sum(['admin_adjustment']) };
}

/**
 * @param {object} args
 * @param {object} args.household     req.household (server-resolved from the session)
 * @param {object|null} args.entitlement  req.entitlement
 * @param {object|null} [args.subscription] Stripe subscriptions row (source = stripe only)
 * @param {'web'|'ios'|'android'} [args.platform]
 * @param {object} [args.monitoring] Fortress monitoringAllowance already read this request
 * @param {object} args.deps  Fortress reads (database/financialSafety.js) + optional
 *                            listAllowanceCredits / countLiveMonitoringSessions (063)
 */
async function getCustomerAllowance({ household, entitlement, subscription = null, platform = 'web', deps, monitoring: precomputed = null, now = new Date(), env = process.env }) {
  const membership = resolveEntitlementState({ entitlement, subscription, now });
  const plan = resolvePlanForEntitlement(entitlement, env);
  // Source of truth: 056 monitored minutes (default), or — once the
  // £-budget Financial Fortress (fc_household_status) is merged and
  // ALLOWANCE_SOURCE=fortress — its budget status. A dashboard that already
  // read 056's monitoringAllowance this request passes it in.
  let monitoring;
  if (env.ALLOWANCE_SOURCE === 'fortress' && deps.getFortressHouseholdStatus) {
    const fortress = await Promise.resolve().then(() => deps.getFortressHouseholdStatus({ householdId: household.id, now })).catch(() => null);
    monitoring = fromFortressHouseholdStatus(fortress, { plan });
  } else {
    monitoring = precomputed || await getHouseholdAllowance({ household, entitlement, subscription, deps, now, env });
  }

  let credits = { topUpSeconds: 0, adjustmentSeconds: 0 };
  let inProgressMonitoredCalls = null;
  if (monitoring.state !== 'unavailable' && monitoring.source === 'fortress') {
    inProgressMonitoredCalls = monitoring.liveCalls;
  } else if (monitoring.state !== 'unavailable') {
    const [creditRows, live] = await Promise.all([
      deps.listAllowanceCredits && monitoring.periodStartsAt
        ? deps.listAllowanceCredits({ householdId: household.id, periodStart: monitoring.periodStartsAt }).catch(() => null)
        : [],
      deps.countLiveMonitoringSessions
        ? deps.countLiveMonitoringSessions({ householdId: household.id, now }).catch(() => null)
        : null,
    ]);
    if (Array.isArray(creditRows)) credits = sumCredits(creditRows);
    inProgressMonitoredCalls = live;
  }

  const includedMinutes = Math.floor(plan.allowanceSeconds / 60);
  const status = statusFor(monitoring, membership);
  const unknown = monitoring.state === 'unavailable';

  return {
    version: 1,
    status,
    tone: toneFor(status),
    monitoringActive: status === 'inactive' ? false : monitoring.monitoringActive,
    // Always true on the 056 source (the allowance never blocks calls).
    // On the Fortress source, false once budget and delivery reserve are
    // both used: new forwarded calls may then be refused.
    callsContinue: monitoring.callsContinue !== false,
    // Integration 2026-10-03: true when trusted callers still connect even
    // though other callers may not (trusted-only delivery reserve).
    trustedCallersContinue: monitoring.trustedCallersContinue === undefined ? monitoring.callsContinue !== false : monitoring.trustedCallersContinue !== false,
    source: monitoring.source === 'fortress' ? 'fortress' : 'monitoring_minutes',
    enforced: monitoring.enforced,
    membership: {
      state: membership.state,
      channel: membership.channel,
      planCode: plan.code,
      planName: plan.name,
      periodEndsAt: membership.periodEndsAt,
      renews: membership.renews,
      testPurchase: membership.testPurchase,
    },
    allowance: {
      includedMinutes,
      topUpMinutes: Math.floor(credits.topUpSeconds / 60),
      adjustmentMinutes: Math.trunc(credits.adjustmentSeconds / 60),
      totalMinutes: monitoring.allowanceMinutes,
      usedMinutes: monitoring.usedMinutes,
      remainingMinutes: monitoring.remainingMinutes,
      usedPercent: monitoring.usedPercent,
      remainingPercent: monitoring.remainingPercent,
      // Share of the allowance held by calls in progress (Fortress
      // reservations; already counted in usedPercent). null on the 056
      // source, where live usage is metered into "used" every ~10 s.
      reservedPercent: monitoring.reservedPercent === undefined ? null : monitoring.reservedPercent,
      // Live monitored calls right now. Their seconds so far are already in
      // usedMinutes (Fortress meters every ~10 s); they may use a little
      // more before they end (bounded by Fortress's grace period).
      inProgressMonitoredCalls: unknown ? null : inProgressMonitoredCalls,
      periodStartsAt: monitoring.periodStartsAt,
      resetsAt: monitoring.resetsAt,
    },
    warning: {
      // Highest warning point reached this period (claimed once per period
      // by Fortress) — the app shows its in-app notice for this level.
      level: unknown ? null : monitoring.lastWarningPoint,
      points: monitoring.warningPoints,
    },
    topUp: topUpOffer({ membership, monitoring, platform, now, env }),
  };
}

module.exports = { getCustomerAllowance, statusFor, PLATFORM_CHANNEL };
