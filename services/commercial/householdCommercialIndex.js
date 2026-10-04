// Household → canonical commercial status, for every business/admin surface
// (final UI integration 2026-10-04, Admin redesign requirement MI-1).
//
// ONE genuine-customer definition everywhere: services/commercial/
// commercialStatus.js classifyCommercialStatus. "Genuine paying" is proven
// production money only (Stripe live, store production). Account
// classification is ONLY an exclusion input (internal_test / reviewer /
// admin / QA / other_non_customer → never genuine); the manual
// 'genuine_customer' label no longer decides anything on its own.
'use strict';

const { classifyCommercialStatus, STATUS } = require('./commercialStatus');
const { currentEntitlementOf } = require('../lifecycle/exceptionQueue');

const ENTITLEMENT_BASE_COLUMNS = 'household_id, entitlement_type, status, source, starts_at, ends_at, updated_at';

function isMissingColumn(error) {
  return /42703|revenuecat_environment|store_will_renew|store_billing_issue_at|store_refunded_at|does not exist|Could not find/i.test(`${(error && error.code) || ''} ${(error && error.message) || ''}`);
}

/**
 * Entitlements WITH the store environment (migration 053). Before 053 is
 * applied the column does not exist: falls back to the base columns, and
 * store grants then classify as environment-unverified (never genuine).
 * @param {object} supabase
 * @param {string} [columns]
 * @param {Function} [select] — optional (cols) => query builder, for pagination wrappers
 */
// Apple store lifecycle state (migration 073, launch sprint 2026-10-05).
const STORE_STATE_COLUMNS = 'store_will_renew, store_billing_issue_at, store_refunded_at';

async function selectEntitlementsWithEnvironment(supabase, columns = ENTITLEMENT_BASE_COLUMNS, select = null) {
  const run = (cols) => (select ? select(cols) : supabase.from('entitlements').select(cols));
  // Newest schema first; each missing-column error steps down one migration
  // (073 → 053 → base) so admin keeps working before either is applied.
  const withStore = await run(`${columns}, revenuecat_environment, ${STORE_STATE_COLUMNS}`);
  if (!(withStore && withStore.error && isMissingColumn(withStore.error))) return withStore;
  const withEnv = await run(`${columns}, revenuecat_environment`);
  if (withEnv && withEnv.error && isMissingColumn(withEnv.error)) return run(columns);
  return withEnv;
}

/** Pure: commercial status of one household. */
function commercialStatusOf({ entitlements, classification = null }, now = new Date()) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  return classifyCommercialStatus({ currentEntitlement: currentEntitlementOf(entitlements || [], nowMs), classification });
}

/**
 * Pure: Map(household_id → commercial status) plus
 * Map(stripe_customer_id → household_id) for revenue attribution.
 */
function buildCommercialIndex({ households, entitlementsByHousehold, classificationMap }, now = new Date()) {
  const byHousehold = new Map();
  const householdByStripeCustomer = new Map();
  for (const h of households || []) {
    const c = commercialStatusOf({ entitlements: entitlementsByHousehold.get(h.id) || [], classification: classificationMap ? classificationMap.get(h.id) || null : null }, now);
    byHousehold.set(h.id, c);
    if (h.stripe_customer_id) householdByStripeCustomer.set(h.stripe_customer_id, h.id);
  }
  return { byHousehold, householdByStripeCustomer };
}

/** Short bucket for labels/attribution: genuine | test | store_test | unverified | complimentary | trial | none. */
function commercialBucket(c) {
  if (!c) return 'none';
  switch (c.status) {
    case STATUS.GENUINE_PAYING: return 'genuine';
    case STATUS.INTERNAL_OR_TEST: return 'test';
    case STATUS.STORE_SANDBOX: case STATUS.STRIPE_TEST: return 'store_test';
    case STATUS.STORE_ENVIRONMENT_UNVERIFIED: return 'unverified';
    case STATUS.COMPLIMENTARY: return 'complimentary';
    case STATUS.TRIAL: return 'trial';
    default: return 'none';
  }
}

/**
 * Loads households + entitlements (with store environment) and builds the
 * index. Returns null when unreadable (callers then count nobody as genuine —
 * never a fallback to a second definition).
 */
async function loadCommercialIndex(supabase, classificationMap, now = new Date()) {
  if (!supabase) return null;
  const [hRes, eRes] = await Promise.all([
    supabase.from('households').select('id, stripe_customer_id'),
    selectEntitlementsWithEnvironment(supabase),
  ]);
  if ((hRes && hRes.error) || (eRes && eRes.error)) return null;
  const entitlementsByHousehold = new Map();
  for (const e of eRes.data || []) {
    if (!entitlementsByHousehold.has(e.household_id)) entitlementsByHousehold.set(e.household_id, []);
    entitlementsByHousehold.get(e.household_id).push(e);
  }
  return buildCommercialIndex({ households: hRes.data || [], entitlementsByHousehold, classificationMap }, now);
}

module.exports = { loadCommercialIndex, ENTITLEMENT_BASE_COLUMNS, selectEntitlementsWithEnvironment, commercialStatusOf, buildCommercialIndex, commercialBucket };
