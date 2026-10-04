// Customer-facing membership status — ONE derivation shared by GET
// /dashboard-data (server.js) and GET /api/v1/me/dashboard
// (routes/mobileApi.js). Launch sprint 2026-10-05 (migration 073).
//
// Stripe and everything that is not Apple-billed: EXACTLY the previous inline
// logic (trial → past_due = payment_issue → cancel_at_period_end = cancelled),
// with nextBillingDate / accessUntil from the Stripe subscription.
//
// Apple (entitlements.source = 'apple_revenuecat'): the Stripe subscriptions
// table never describes an Apple purchase, so the state comes from the
// entitlement row's store columns (migration 073):
//   billing problem reported, not yet recovered → 'payment_issue'
//   refunded or auto-renew off                  → 'cancelled', accessUntil = ends_at
//   otherwise                                   → 'active'
// The store stays authoritative for dates and prices: no nextBillingDate is
// invented for Apple. Columns absent (073 not applied) → 'active', exactly as
// before. Nothing here decides access or protection: display only.
'use strict';

function deriveMembershipStatus({ entitlement, subscription }) {
  const ent = entitlement || {};
  if (ent.entitlement_type === 'free_trial') {
    return { status: 'trial', nextBillingDate: stripeNextBilling(subscription), accessUntil: stripeAccessUntil(subscription) };
  }

  if (ent.source === 'apple_revenuecat') {
    if (ent.store_billing_issue_at) return { status: 'payment_issue', nextBillingDate: null, accessUntil: ent.ends_at || null };
    if (ent.store_refunded_at || ent.store_will_renew === false) return { status: 'cancelled', nextBillingDate: null, accessUntil: ent.ends_at || null };
    return { status: 'active', nextBillingDate: null, accessUntil: null };
  }

  let status = 'active';
  if (subscription && subscription.status === 'past_due') {
    // Still an active entitlement (past_due qualifies — see
    // process_stripe_webhook_event in migration 013): protection continues
    // while Stripe retries payment; a status to surface, not a reason to
    // withdraw access.
    status = 'payment_issue';
  } else if (subscription && subscription.cancel_at_period_end) {
    status = 'cancelled';
  }
  return { status, nextBillingDate: stripeNextBilling(subscription), accessUntil: stripeAccessUntil(subscription) };
}

function stripeNextBilling(subscription) {
  return subscription && !subscription.cancel_at_period_end ? subscription.current_period_end : null;
}

function stripeAccessUntil(subscription) {
  return subscription ? subscription.current_period_end : null;
}

module.exports = { deriveMembershipStatus };
