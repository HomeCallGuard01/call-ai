// Business control centre — the ONE place that defines HCG's business
// vocabulary. Every dashboard card, table and label uses these
// definitions, so "customer", "paid", "protected", "revenue" and "MRR"
// can never silently mean different things in different places.
// Pure; regression-tested in tests/business-definitions.test.mjs.
//
// Terms (also rendered in the dashboard's Definitions panel):
//   account / household      any registered household (neutral word).
//   genuine customer         household explicitly classified
//                            'genuine_customer'. Never inferred.
//   internal test / reviewer / admin / QA
//                            explicitly classified non-customer accounts.
//   unclassified             no classification yet — never counted as a
//                            customer or as revenue until classified.
//   deleted                  anonymised account (migration 029).
//   paid access              a current 'paid_subscription' entitlement.
//   complimentary access     a current complimentary/staff/partner/
//                            promotion/founding_offer entitlement.
//   trial access             a current 'free_trial' entitlement.
//   genuine paying customer  genuine customer WITH paid access.
//   payment history          any paid entitlement ever recorded, in any
//                            status (active, expired, revoked). Stripe
//                            test / Apple sandbox rows are indistinguishable
//                            here, so this is "a paid membership was
//                            recorded", not "money was received".
//   former paying            payment history, but no paid access now.
//   audience                 genuine | unclassified | test (internal_test,
//                            reviewer, admin, QA) | deleted — the one badge
//                            the dashboard shows on every account.
//   membership current       an entitlement active right now (same test
//                            as requireEntitlement).
//   membership upcoming      scheduled, or active with a future start
//                            (migration 047's definition).
//   cancelled                no current/upcoming membership, and the
//                            latest subscription is 'canceled' or the
//                            latest entitlement was 'revoked'.
//   expired                  no current/upcoming membership; had one that
//                            ended by date or was expired (not cancelled).
//   protected                current membership AND computeProtectionStatus
//                            ().fullyProtected — the customer-facing
//                            definition, unchanged.
//   entitled but not protected
//                            current membership, not (yet) protected.
//   revenue / MRR            money from GENUINE customers only, read from
//                            the payment provider (never entitlement count
//                            × list price). See stripeRevenue.js.
'use strict';

const { isEntitlementCurrentlyActive, parseTimestampMs } = require('../adminOnboardingStatus');
const { computeProtectionStatus } = require('../callRouting');
const lifecycle = require('../numberLifecycle/state');

const ANONYMISED_EMAIL_SUFFIX = '@deleted.homecallguard.internal';
const PAID_TYPES = new Set(['paid_subscription']);
const COMPLIMENTARY_TYPES = new Set(['complimentary', 'staff', 'partner', 'promotion', 'founding_offer']);
const TRIAL_TYPES = new Set(['free_trial']);
const NON_GENUINE_CLASSES = new Set(['internal_test', 'reviewer', 'admin', 'qa_automation']);

const GLOSSARY = [
  ['Account / household', 'Any registered household. Neutral: not necessarily a customer.'],
  ['Genuine customer', 'A household explicitly classified as a genuine customer. Never inferred.'],
  ['Internal test / reviewer / admin / QA', 'Explicitly classified non-customer accounts. Visible everywhere, never counted as customers or revenue.'],
  ['Unclassified', 'Not yet classified. Not counted as a customer or as revenue until classified.'],
  ['Paid access', 'A current paid subscription entitlement.'],
  ['Complimentary access', 'A current complimentary (or staff/partner/promotion) entitlement. No payment.'],
  ['Genuine paying customer', 'A genuine customer with paid access.'],
  ['Payment history', 'A paid membership was recorded at some point (any status). Stripe test or Apple sandbox purchases look the same here, so this is not proof money was received.'],
  ['Former paying', 'Payment history, but no paid access now (cancelled, expired or moved to complimentary).'],
  ['Cancelled', 'No current or upcoming membership, and the subscription was cancelled or access was revoked.'],
  ['Expired', 'No current or upcoming membership; the last one ended by date.'],
  ['Protected', 'Current membership and the customer-facing Protected test (delivery confirmed and app registered).'],
  ['Entitled but not protected', 'Current membership, but not (yet) Protected.'],
  ['Revenue / MRR', 'Money from genuine customers only, read from the payment provider. Never an entitlement count multiplied by the list price.'],
];

function latestBy(rows, field) {
  let latest = null;
  for (const r of rows || []) {
    if (!latest || (parseTimestampMs(r[field]) || 0) > (parseTimestampMs(latest[field]) || 0)) latest = r;
  }
  return latest;
}

// Canonical (migration 047): services/numberLifecycle/state.js.
function isUpcomingEntitlement(entitlement, now) {
  return lifecycle.isUpcomingEntitlement(entitlement, now);
}

function accessOf(entitlement) {
  if (!entitlement) return 'none';
  if (PAID_TYPES.has(entitlement.entitlement_type)) return 'paid';
  if (COMPLIMENTARY_TYPES.has(entitlement.entitlement_type)) return 'complimentary';
  if (TRIAL_TYPES.has(entitlement.entitlement_type)) return 'trial';
  return 'complimentary';
}

// Pure — the complete business classification of one household.
function classifyHouseholdForBusiness({ household, entitlements, subscriptions, classification }, now) {
  const deleted = typeof household.email === 'string' && household.email.endsWith(ANONYMISED_EMAIL_SUFFIX);
  const accountClass = deleted
    ? 'deleted'
    : classification === 'genuine_customer'
      ? 'genuine'
      : NON_GENUINE_CLASSES.has(classification)
        ? classification
        : 'unclassified';

  const ents = entitlements || [];
  const current = ents.find((e) => isEntitlementCurrentlyActive(e, now)) || null;
  const upcoming = current ? null : ents.find((e) => isUpcomingEntitlement(e, now)) || null;
  const latestEntitlement = latestBy(ents, 'updated_at');
  const latestSubscription = latestBy(subscriptions, 'updated_at');

  let membership;
  if (current) membership = 'current';
  else if (upcoming) membership = 'upcoming';
  else if (ents.length === 0) membership = 'never';
  else if ((latestSubscription && latestSubscription.status === 'canceled') || (latestEntitlement && latestEntitlement.status === 'revoked')) membership = 'cancelled';
  else membership = 'expired';

  const access = accessOf(current);
  const paidEntitlements = ents.filter((e) => PAID_TYPES.has(e.entitlement_type));
  const everPaid = paidEntitlements.length > 0;
  const audience = accountClass === 'genuine' || accountClass === 'unclassified' || accountClass === 'deleted' ? accountClass : 'test';
  const technical = computeProtectionStatus(household, now);
  const protection = current ? (technical.fullyProtected ? 'protected' : 'entitled_not_protected') : 'not_entitled';

  // When a finished membership ended: ends_at if passed, else the row's
  // last change (the webhook's expire/revoke update).
  let endedAt = null;
  if (!current && !upcoming && latestEntitlement) {
    const endsMs = parseTimestampMs(latestEntitlement.ends_at);
    endedAt = endsMs !== null && endsMs <= now.getTime() ? latestEntitlement.ends_at : latestEntitlement.updated_at || null;
  }

  return {
    accountClass,
    isGenuine: accountClass === 'genuine',
    access,
    membership,
    isGenuinePayingCustomer: accountClass === 'genuine' && access === 'paid',
    audience,
    everPaid,
    formerPaying: everPaid && access !== 'paid',
    paidSources: [...new Set(paidEntitlements.map((e) => e.source || 'unknown'))],
    cancellingAtPeriodEnd: !!(current && latestSubscription && latestSubscription.cancel_at_period_end && latestSubscription.status !== 'canceled'),
    paymentIssue: !!(latestSubscription && (latestSubscription.status === 'past_due' || latestSubscription.status === 'unpaid')),
    protection,
    holdsNumber: !!household.twilio_number,
    membershipEndedAt: endedAt,
    currentEntitlement: current,
    upcomingEntitlement: upcoming,
    latestEntitlement,
    latestSubscription,
  };
}

module.exports = {
  GLOSSARY,
  ANONYMISED_EMAIL_SUFFIX,
  PAID_TYPES,
  COMPLIMENTARY_TYPES,
  NON_GENUINE_CLASSES,
  isUpcomingEntitlement,
  classifyHouseholdForBusiness,
};
