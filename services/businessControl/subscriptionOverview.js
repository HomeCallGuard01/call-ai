// Business control dashboard (2026-09-27) — Customers & subscriptions
// area. Pure core (computeSubscriptionOverview) plus a thin read-only
// fetch. No writes, no Stripe API calls: everything here comes from HCG's
// own households / entitlements / subscriptions / account_classifications
// tables, which the Stripe and RevenueCat webhooks already maintain.
//
// Revenue-safety invariant, same as services/businessMetrics/
// customerClassificationOverview.js: only households explicitly
// classified 'genuine_customer' count as genuine. Reviewer / internal /
// admin / QA accounts are never genuine; UNCLASSIFIED households are
// reported separately ("needs classification") rather than silently
// counted either way, so a real new customer is visible without ever
// inflating genuine revenue figures.
'use strict';
const { hasGenuinePaymentHistory } = require('../commercial/commercialStatus');

const { isEntitlementCurrentlyActive, parseTimestampMs } = require('../adminOnboardingStatus');
const { classifyHousehold, UNCLASSIFIED } = require('../businessMetrics/accountClassification');
const { classifyHouseholdForBusiness } = require('./definitions');

const DAY_MS = 24 * 60 * 60 * 1000;
const ANONYMISED_EMAIL_SUFFIX = '@deleted.homecallguard.internal';

const PAID_TYPES = new Set(['paid_subscription']);
const COMPLIMENTARY_TYPES = new Set(['complimentary', 'staff', 'partner', 'promotion', 'founding_offer']);
const TRIAL_TYPES = new Set(['free_trial']);
const NON_GENUINE_CLASSIFICATIONS = ['internal_test', 'admin', 'reviewer', 'qa_automation', 'other_non_customer'];

// Stripe statuses where the customer is still being billed / in dunning.
const STRIPE_LIVE_STATUSES = new Set(['active', 'trialing', 'past_due', 'unpaid']);

function groupByHousehold(rows) {
  const map = new Map();
  for (const row of rows || []) {
    if (!map.has(row.household_id)) map.set(row.household_id, []);
    map.get(row.household_id).push(row);
  }
  return map;
}

function latestByUpdatedAt(rows) {
  let latest = null;
  for (const row of rows || []) {
    if (!latest || (parseTimestampMs(row.updated_at) || 0) > (parseTimestampMs(latest.updated_at) || 0)) latest = row;
  }
  return latest;
}

// When a (no longer active) entitlement stopped: ends_at if it had one
// that has passed, otherwise the moment its row last changed (the
// webhook's expire/revoke update).
function entitlementEndedAtMs(entitlement, nowMs) {
  const endsMs = parseTimestampMs(entitlement.ends_at);
  if (endsMs !== null && endsMs <= nowMs) return endsMs;
  if (entitlement.status === 'expired' || entitlement.status === 'revoked') return parseTimestampMs(entitlement.updated_at);
  return null;
}

// Pure. `now` is a Date. Returns every count plus the definition used,
// so the UI can show exactly what each number means.
function computeSubscriptionOverview({ households, entitlements, subscriptions, classificationMap }, now) {
  const nowMs = now.getTime();
  const entitlementsByHousehold = groupByHousehold(entitlements);
  const subscriptionsByHousehold = groupByHousehold(subscriptions);

  const counts = {
    households: 0,
    deletedAccounts: 0,
    genuinePayingCustomers: 0,
    activePaidSubscriptions: { total: 0, genuine: 0, bySource: {} },
    cancellingAtPeriodEnd: { total: 0, genuine: 0 },
    paymentIssue: { total: 0, genuine: 0 },
    cancelledSubscriptions: { total: 0, genuine: 0 },
    complimentary: 0,
    trial: 0,
    nonGenuineAccounts: { internal_test: 0, admin: 0, reviewer: 0, qa_automation: 0, other_non_customer: 0 },
    nonGenuineWithActiveAccess: 0,
    unclassifiedWithActiveAccess: 0,
    newGenuinePayingLast7d: 0,
    newGenuinePayingLast30d: 0,
    // Business definitions (definitions.js), counted per account:
    membership: { current: 0, upcoming: 0, cancelled: 0, expired: 0, never: 0 },
    protection: { protected: 0, entitled_not_protected: 0 },
    // Payment history (definitions.js): a paid membership recorded in
    // any status. Genuine former payers are what "0 genuine paying now"
    // must never hide.
    paymentHistory: { genuineEverPaid: 0, genuineFormerPaying: 0, unclassifiedEverPaid: 0, nonGenuineEverPaid: 0 },
  };
  const needsClassification = [];

  // Churn inputs (genuine paid only).
  const windowStartMs = nowMs - 30 * DAY_MS;
  let paidActiveAtWindowStart = 0;
  let paidEndedInWindow = 0;

  for (const h of households || []) {
    const deleted = typeof h.email === 'string' && h.email.endsWith(ANONYMISED_EMAIL_SUFFIX);
    const classification = classifyHousehold(h.id, classificationMap);
    const ents = entitlementsByHousehold.get(h.id) || [];
    // 2026-10-04 (MI-1b): ONE genuine definition (services/commercial/
    // commercialStatus.js). `genuine` = genuine PAYMENT HISTORY (production
    // money ever, not a test/reviewer account) for history, cancellations
    // and churn; "paying now" uses biz.isGenuinePayingCustomer below.
    const genuine = hasGenuinePaymentHistory(ents, classificationMap && classificationMap.get(h.id));
    const current = ents.find((e) => isEntitlementCurrentlyActive(e, now)) || null;
    const latestSub = latestByUpdatedAt(subscriptionsByHousehold.get(h.id));

    if (deleted) counts.deletedAccounts += 1;
    else counts.households += 1;

    // Same vocabulary as every other card (definitions.js).
    const biz = classifyHouseholdForBusiness({ household: h, entitlements: ents, subscriptions: subscriptionsByHousehold.get(h.id) || [], classification: classificationMap && classificationMap.get(h.id) }, now);
    if (!deleted) {
      counts.membership[biz.membership] += 1;
      if (biz.protection !== 'not_entitled') counts.protection[biz.protection] += 1;
    }

    if (!deleted && NON_GENUINE_CLASSIFICATIONS.includes(classification)) counts.nonGenuineAccounts[classification] += 1;

    if (!deleted && biz.everPaid) {
      if (genuine) {
        counts.paymentHistory.genuineEverPaid += 1;
        if (biz.formerPaying) counts.paymentHistory.genuineFormerPaying += 1;
      } else if (NON_GENUINE_CLASSIFICATIONS.includes(classification)) {
        counts.paymentHistory.nonGenuineEverPaid += 1;
      } else {
        // MI-1: paid recorded, production money not proven (store sandbox /
        // environment unverified / Stripe test) and not a known test account.
        counts.paymentHistory.unclassifiedEverPaid += 1;
      }
    }
    // Unclassified accounts that must be classified: anyone with access
    // now, and anyone who ever paid (a former payer has no access, but is
    // exactly the account a buyer — or Andrew — will ask about).
    if (!deleted && classification === UNCLASSIFIED && (current || biz.everPaid)) {
      needsClassification.push({
        householdId: h.id,
        email: h.email,
        entitlementType: current ? current.entitlement_type : null,
        reason: biz.everPaid ? (biz.access === 'paid' ? 'paying now' : 'paid before (former paying · ' + biz.membership + ')') : 'has access',
      });
    }

    if (current) {
      const type = current.entitlement_type;
      if (PAID_TYPES.has(type)) {
        counts.activePaidSubscriptions.total += 1;
        const src = current.source || 'unknown';
        counts.activePaidSubscriptions.bySource[src] = (counts.activePaidSubscriptions.bySource[src] || 0) + 1;
        if (biz.isGenuinePayingCustomer) {
          counts.activePaidSubscriptions.genuine += 1;
          counts.genuinePayingCustomers += 1;
        }
      } else if (COMPLIMENTARY_TYPES.has(type)) {
        counts.complimentary += 1;
      } else if (TRIAL_TYPES.has(type)) {
        counts.trial += 1;
      }
      if (NON_GENUINE_CLASSIFICATIONS.includes(classification)) counts.nonGenuineWithActiveAccess += 1;
      if (classification === UNCLASSIFIED && !deleted) counts.unclassifiedWithActiveAccess += 1;
    }

    if (latestSub) {
      if (latestSub.status === 'canceled') {
        counts.cancelledSubscriptions.total += 1;
        if (genuine) counts.cancelledSubscriptions.genuine += 1;
      } else if (STRIPE_LIVE_STATUSES.has(latestSub.status)) {
        if (latestSub.cancel_at_period_end) {
          counts.cancellingAtPeriodEnd.total += 1;
          if (genuine) counts.cancellingAtPeriodEnd.genuine += 1;
        }
        if (latestSub.status === 'past_due' || latestSub.status === 'unpaid') {
          counts.paymentIssue.total += 1;
          if (genuine) counts.paymentIssue.genuine += 1;
        }
      }
    }

    if (genuine) {
      const paid = ents.filter((e) => PAID_TYPES.has(e.entitlement_type));
      const firstPaidMs = paid.map((e) => parseTimestampMs(e.starts_at)).filter((v) => v !== null).sort((a, b) => a - b)[0];
      if (firstPaidMs !== undefined && current && PAID_TYPES.has(current.entitlement_type) && biz.isGenuinePayingCustomer) {
        if (nowMs - firstPaidMs <= 7 * DAY_MS) counts.newGenuinePayingLast7d += 1;
        if (nowMs - firstPaidMs <= 30 * DAY_MS) counts.newGenuinePayingLast30d += 1;
      }
      // Paid at the start of the window: a paid entitlement that had
      // started by then and had not yet ended by then.
      const activeAtStart = paid.some((e) => {
        const s = parseTimestampMs(e.starts_at);
        const ended = entitlementEndedAtMs(e, nowMs);
        return s !== null && s <= windowStartMs && (ended === null || ended > windowStartMs);
      });
      if (activeAtStart) {
        paidActiveAtWindowStart += 1;
        const stillPaid = current && PAID_TYPES.has(current.entitlement_type);
        if (!stillPaid) paidEndedInWindow += 1;
      }
    }
  }

  const churn = paidActiveAtWindowStart > 0
    ? {
        available: true,
        rate: Math.round((paidEndedInWindow / paidActiveAtWindowStart) * 1000) / 10,
        lost: paidEndedInWindow,
        base: paidActiveAtWindowStart,
        definition: 'Genuine customers paying 30 days ago who no longer have a paid entitlement ÷ genuine customers paying 30 days ago.',
      }
    : {
        available: false,
        reason: 'No genuine customer was paying 30 days ago, so a churn rate would be meaningless.',
      };

  return { counts, churn, needsClassification };
}

function resolveSupabaseAdmin() {
  try {
    return require('../supabaseClients').supabaseAdmin;
  } catch (err) {
    return null;
  }
}

async function getSubscriptionOverview(now = new Date()) {
  const supabaseAdmin = resolveSupabaseAdmin();
  if (!supabaseAdmin) return { available: false, reason: 'SUPABASE_SERVICE_ROLE_KEY not configured' };
  const { getClassificationMap } = require('../businessMetrics/accountClassification');

  const [hRes, eRes, sRes, classification] = await Promise.all([
    supabaseAdmin.from('households').select('id, email, created_at, twilio_number, activation_verified_at, voice_client_registered_at, delivery_verified_at'),
    require('../commercial/householdCommercialIndex').selectEntitlementsWithEnvironment(supabaseAdmin) /* 2026-10-04 MI-1: + store environment (053), tolerant */,
    supabaseAdmin.from('subscriptions').select('household_id, status, cancel_at_period_end, updated_at'),
    getClassificationMap(),
  ]);
  if (hRes.error) return { available: false, reason: hRes.error.message };
  if (eRes.error) return { available: false, reason: eRes.error.message };
  if (sRes.error) return { available: false, reason: sRes.error.message };
  if (!classification.available) return { available: false, reason: classification.reason };

  return {
    available: true,
    generatedAt: now.toISOString(),
    ...computeSubscriptionOverview(
      { households: hRes.data || [], entitlements: eRes.data || [], subscriptions: sRes.data || [], classificationMap: classification.map },
      now
    ),
  };
}

module.exports = { computeSubscriptionOverview, getSubscriptionOverview, entitlementEndedAtMs };
