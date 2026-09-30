// billingPeriod.js — which allowance period "now" falls in. Pure; `now` is
// always injectable.
//
// The allowance resets when the customer's payment renews, whichever
// system takes the payment:
//   Stripe      subscriptions.current_period_end (Stripe's own period)
//   Apple/Google (RevenueCat) entitlements.ends_at — each renewal EXTENDS
//               ends_at on the same entitlement row to the new expiry
//               (database/billing.js upsertActiveEntitlementFromRevenueCat)
//   complimentary / admin grants: monthly anniversary of starts_at
// A provider period end is used when it is in the future and within ~one
// monthly period of now; the period is then [end − 1 month, end). Anything
// else (lapsed/grace-period expiry in the past, far-future comp grants, bad
// data) falls back to the monthly anniversary of starts_at, and failing
// that the calendar month — there is always a finite, well-defined period.
//
// Anniversaries on the 29th–31st clamp to the last day of shorter months.
'use strict';

const MAX_PROVIDER_PERIOD_DAYS = 32;

function daysInMonthUtc(year, monthIndex) {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

function anniversaryUtc(anchor, year, monthIndex) {
  const day = Math.min(anchor.getUTCDate(), daysInMonthUtc(year, monthIndex));
  return new Date(Date.UTC(year, monthIndex, day,
    anchor.getUTCHours(), anchor.getUTCMinutes(), anchor.getUTCSeconds(), anchor.getUTCMilliseconds()));
}

function addMonths(year, monthIndex, delta) {
  const total = year * 12 + monthIndex + delta;
  return { year: Math.floor(total / 12), monthIndex: ((total % 12) + 12) % 12 };
}

function validDate(value) {
  if (!value) return null;
  const d = typeof value === 'number' ? new Date(value < 1e12 ? value * 1000 : value) : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Monthly anniversary period of `anchorStart` containing `now`
 * (calendar month if there is no usable anchor).
 */
function resolveBillingPeriod(anchorStart, now = new Date()) {
  const anchor = validDate(anchorStart);
  if (!anchor || anchor > now) {
    return {
      periodStart: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
      periodEnd: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
      basis: 'calendar_month',
    };
  }
  let { year, monthIndex } = { year: now.getUTCFullYear(), monthIndex: now.getUTCMonth() };
  let start = anniversaryUtc(anchor, year, monthIndex);
  if (start > now) {
    ({ year, monthIndex } = addMonths(year, monthIndex, -1));
    start = anniversaryUtc(anchor, year, monthIndex);
  }
  const next = addMonths(year, monthIndex, 1);
  return { periodStart: start, periodEnd: anniversaryUtc(anchor, next.year, next.monthIndex), basis: 'anniversary' };
}

/**
 * @param {object} args
 * @param {object|null} args.entitlement  { starts_at, ends_at, source }
 * @param {object|null} [args.subscription] { current_period_end } (Stripe; seconds or ISO)
 * @param {Date} [args.now]
 */
function resolveEntitlementPeriod({ entitlement, subscription = null, now = new Date() }) {
  const providerEnd = validDate(subscription && subscription.current_period_end)
    || (entitlement && entitlement.source !== 'stripe' ? validDate(entitlement.ends_at) : null);
  if (providerEnd && providerEnd > now && providerEnd - now <= MAX_PROVIDER_PERIOD_DAYS * 86400000) {
    const prev = addMonths(providerEnd.getUTCFullYear(), providerEnd.getUTCMonth(), -1);
    const periodStart = anniversaryUtc(providerEnd, prev.year, prev.monthIndex);
    if (periodStart <= now) return { periodStart, periodEnd: providerEnd, basis: subscription ? 'stripe_period' : 'store_expiry' };
  }
  return resolveBillingPeriod(entitlement && entitlement.starts_at, now);
}

module.exports = { resolveBillingPeriod, resolveEntitlementPeriod };
