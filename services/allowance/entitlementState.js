// entitlementState.js — ONE canonical answer to "what is this household's
// membership state?" for every customer surface (customer allowance
// workstream, 2026-10-03). Pure; `now` injectable.
//
// Inputs are only rows the payment webhooks themselves wrote (entitlements
// via process_stripe_webhook_event / the RevenueCat webhook / admin
// grants; subscriptions via the Stripe webhook) — never client data.
//
// This does NOT decide access. getActiveEntitlement (database/billing.js)
// and Financial Fortress (056 admission/monitoring gate) remain the
// authorities; this only describes the state honestly. Where it would
// disagree with access (e.g. an Apple row past ends_at that no EXPIRATION
// has flipped yet) it reports the truthful state ('expired').
//
// state:
//   active          paid and renewing
//   trial           entitlement_type free_trial (nothing issues one today)
//   complimentary   admin / invite / staff / partner grant
//   cancelling      paid, auto-renew off: active until periodEndsAt
//   payment_issue   paid, renewal payment failing (Stripe past_due); access
//                   continues while the provider retries
//   expired         was entitled, no longer is
//   none            never entitled / no row
//
// Known gaps (documented in the handover): RevenueCat CANCELLATION and
// BILLING_ISSUE are acknowledged without being stored, so an Apple
// subscriber shows 'active' until EXPIRATION — never 'cancelling' or
// 'payment_issue'. That needs a webhook change, not a read-model guess.
'use strict';

const COMPLIMENTARY_TYPES = new Set(['complimentary', 'partner', 'staff']);
const STRIPE_LAPSED = new Set(['unpaid', 'canceled', 'incomplete_expired']);

function toDate(value) {
  if (value === null || value === undefined || value === '') return null;
  const d = typeof value === 'number' ? new Date(value < 1e12 ? value * 1000 : value) : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function channelFor(entitlement) {
  const source = entitlement && entitlement.source;
  if (source === 'stripe') return 'stripe';
  if (source === 'apple_revenuecat' || source === 'apple') return 'apple';
  if (source === 'google_revenuecat' || source === 'google') return 'google';
  if (entitlement && COMPLIMENTARY_TYPES.has(entitlement.entitlement_type)) return 'complimentary';
  return source ? 'other' : null;
}

/**
 * @param {object} args
 * @param {object|null} args.entitlement  entitlements row (active one, or most recent)
 * @param {object|null} [args.subscription] Stripe subscriptions row (only when source = stripe)
 * @param {Date} [args.now]
 */
function resolveEntitlementState({ entitlement, subscription = null, now = new Date() }) {
  if (!entitlement) {
    return { state: 'none', channel: null, planCode: null, periodEndsAt: null, renews: false, testPurchase: false };
  }
  const channel = channelFor(entitlement);
  const planCode = entitlement.plan_code || 'standard';
  const testPurchase = entitlement.revenuecat_environment === 'sandbox';
  const endsAt = toDate(entitlement.ends_at);
  const base = { channel, planCode, testPurchase };

  const rowExpired = entitlement.status === 'expired' || entitlement.status === 'revoked' || (endsAt && endsAt <= now);
  if (rowExpired) return { ...base, state: 'expired', periodEndsAt: endsAt ? endsAt.toISOString() : null, renews: false };
  if (entitlement.status === 'scheduled') return { ...base, state: 'none', periodEndsAt: null, renews: false };

  if (entitlement.entitlement_type === 'free_trial') {
    return { ...base, state: 'trial', periodEndsAt: endsAt ? endsAt.toISOString() : null, renews: false };
  }
  if (channel === 'complimentary') {
    return { ...base, state: 'complimentary', periodEndsAt: endsAt ? endsAt.toISOString() : null, renews: false };
  }

  if (channel === 'stripe' && subscription) {
    const periodEnd = toDate(subscription.current_period_end);
    const periodEndsAt = periodEnd ? periodEnd.toISOString() : null;
    if (STRIPE_LAPSED.has(subscription.status)) return { ...base, state: 'expired', periodEndsAt, renews: false };
    if (subscription.status === 'past_due') return { ...base, state: 'payment_issue', periodEndsAt, renews: true };
    if (subscription.cancel_at_period_end) return { ...base, state: 'cancelling', periodEndsAt, renews: false };
    return { ...base, state: 'active', periodEndsAt, renews: true };
  }

  return { ...base, state: 'active', periodEndsAt: endsAt ? endsAt.toISOString() : null, renews: channel === 'apple' || channel === 'google' || channel === 'stripe' };
}

module.exports = { resolveEntitlementState, channelFor, COMPLIMENTARY_TYPES };
