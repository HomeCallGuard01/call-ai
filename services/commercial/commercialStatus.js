// Commercial status — the ONE definition of "is this a genuine paying
// customer?" (soft-launch integration 2026-10-04, after the 28 Sep 2026
// investigation: an Apple RevenueCat grant whose environment HCG never
// recorded was displayed as "Paying" and bought a real Twilio number).
//
// Used by: the admin customer-health labels and counts, the lifecycle
// exception queue, the number-purchase provenance guard and the operational
// event framework (services/opsEvents). Pure: no database, clock or network.
//
// Rules (fail closed — anything not PROVEN production money is not "genuine"):
//   - an internal/test/admin/reviewer/QA classification is never genuine,
//     whatever entitlement it holds;
//   - Stripe paid entitlement → genuine. A Stripe TEST-mode event cannot
//     reach production: the production webhook verifies with the LIVE
//     endpoint secret, so test-mode events fail signature verification;
//     where the event payload is available its livemode is also checked
//     (stripeLivemode=false ⇒ stripe_test);
//   - Apple/Google via RevenueCat: genuine ONLY when revenuecat_environment
//     is exactly 'production' (migration 053). 'sandbox' covers Apple
//     sandbox, TestFlight and App Review purchases, which RevenueCat does
//     not distinguish from one another; NULL (rows granted before 053) is
//     UNVERIFIED and never counted as paying;
//   - complimentary / trial are their own classes.
'use strict';

const TEST_CLASSIFICATIONS = new Set(['internal_test', 'admin', 'reviewer', 'qa_automation', 'other_non_customer']);
const STORE_SOURCES = new Set(['apple_revenuecat', 'google_revenuecat', 'revenuecat']);
const PAID_TYPES = new Set(['paid_subscription']);
const TRIAL_TYPES = new Set(['free_trial']);

const STATUS = Object.freeze({
  GENUINE_PAYING: 'genuine_paying',
  STORE_SANDBOX: 'store_sandbox', // Apple sandbox / TestFlight / App Review; Google test purchase
  STORE_ENVIRONMENT_UNVERIFIED: 'store_environment_unverified',
  STRIPE_TEST: 'stripe_test',
  COMPLIMENTARY: 'complimentary',
  TRIAL: 'trial',
  INTERNAL_OR_TEST: 'internal_or_test',
  NONE: 'none',
});

const LABELS = Object.freeze({
  genuine_paying: 'Paying',
  store_sandbox: 'Store sandbox / TestFlight / review — not paying',
  store_environment_unverified: 'Store purchase — environment unverified (not counted as paying)',
  stripe_test: 'Stripe test mode — not paying',
  complimentary: 'Complimentary',
  trial: 'Trial',
  internal_or_test: 'Internal / test / reviewer — not revenue',
  none: 'No membership',
});

function storeChannel(source) {
  if (source === 'google_revenuecat') return 'google';
  return 'apple';
}

/** Provenance of ONE entitlement row. */
function entitlementProvenance(ent, { stripeLivemode } = {}) {
  if (!ent) return { kind: 'none', channel: null };
  const type = ent.entitlement_type;
  if (TRIAL_TYPES.has(type)) return { kind: 'trial', channel: ent.source || null };
  if (!PAID_TYPES.has(type)) return { kind: 'complimentary', channel: ent.source || null };
  if (ent.source === 'stripe') return { kind: stripeLivemode === false || ent.stripe_livemode === false ? 'stripe_test' : 'stripe_live', channel: 'web_stripe' };
  if (STORE_SOURCES.has(ent.source)) {
    const env = ent.revenuecat_environment;
    const channel = storeChannel(ent.source);
    if (env === 'production') return { kind: 'store_production', channel };
    if (env === 'sandbox') return { kind: 'store_sandbox', channel };
    return { kind: 'store_unverified', channel };
  }
  // A paid type from an unknown source is never assumed to be money.
  return { kind: 'store_unverified', channel: ent.source || null };
}

/**
 * @param {{ currentEntitlement: object|null, classification?: string|null, stripeLivemode?: boolean }} input
 * @returns {{ status, label, genuinePaying: boolean, channel: string|null, testClassification: string|null }}
 */
function classifyCommercialStatus({ currentEntitlement, classification = null, stripeLivemode } = {}) {
  const testClassification = TEST_CLASSIFICATIONS.has(classification) ? classification : null;
  const p = entitlementProvenance(currentEntitlement, { stripeLivemode });
  let status;
  if (p.kind === 'none') status = STATUS.NONE;
  else if (testClassification) status = STATUS.INTERNAL_OR_TEST;
  else if (p.kind === 'stripe_live' || p.kind === 'store_production') status = STATUS.GENUINE_PAYING;
  else if (p.kind === 'store_sandbox') status = STATUS.STORE_SANDBOX;
  else if (p.kind === 'store_unverified') status = STATUS.STORE_ENVIRONMENT_UNVERIFIED;
  else if (p.kind === 'stripe_test') status = STATUS.STRIPE_TEST;
  else if (p.kind === 'trial') status = STATUS.TRIAL;
  else status = STATUS.COMPLIMENTARY;
  return { status, label: LABELS[status], genuinePaying: status === STATUS.GENUINE_PAYING, channel: p.channel, testClassification };
}

/**
 * May HCG buy a real telephone number for a household holding these ACTIVE
 * entitlements? Non-production store activity must never cause paid
 * production resources.
 *   - any active Stripe-paid, complimentary or trial entitlement → yes
 *     (unchanged: those are HCG-decided or real-money memberships);
 *   - store production → yes;
 *   - store sandbox only → NO, never overridable;
 *   - store environment unverified only → NO unless an admin explicitly
 *     overrides after checking RevenueCat (adminOverride === 'admin');
 *   - no active entitlement → NO.
 */
function decideNumberPurchaseByProvenance(activeEntitlements, { adminOverride = null } = {}) {
  const rows = (activeEntitlements || []).filter((e) => e && e.status === 'active');
  if (!rows.length) return { allowed: false, reason: 'no_active_entitlement' };
  const kinds = rows.map((e) => entitlementProvenance(e).kind);
  if (kinds.some((k) => ['stripe_live', 'store_production', 'complimentary', 'trial'].includes(k))) return { allowed: true, reason: null };
  if (kinds.every((k) => k === 'store_sandbox' || k === 'stripe_test')) return { allowed: false, reason: 'non_production_store_or_test_entitlement' };
  if (adminOverride === 'admin') return { allowed: true, reason: 'admin_override_store_environment_unverified' };
  return { allowed: false, reason: 'store_environment_unverified' };
}

/**
 * Did this household ever pay PRODUCTION money (for churn, cancellations,
 * payment history)? A paid entitlement whose provenance was Stripe live or a
 * store PRODUCTION grant, on an account that is not internal/test/reviewer.
 * (2026-10-04, MI-1: one genuine definition — "genuine now" is
 * classifyCommercialStatus; this is its history counterpart.)
 */
function hasGenuinePaymentHistory(entitlements, classification = null) {
  if (TEST_CLASSIFICATIONS.has(classification)) return false;
  return (entitlements || []).some((e) => e && PAID_TYPES.has(e.entitlement_type) && ['stripe_live', 'store_production'].includes(entitlementProvenance(e).kind));
}

module.exports = { hasGenuinePaymentHistory, STATUS, LABELS, TEST_CLASSIFICATIONS, entitlementProvenance, classifyCommercialStatus, decideNumberPurchaseByProvenance };
