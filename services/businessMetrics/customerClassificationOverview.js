// customerClassificationOverview.js — the genuine-customer headline KPIs
// for Business Dashboard V2 (2026-09). Computed alongside, never
// replacing, the existing raw/operational counts in
// database/adminMetrics.js's computeBusinessOverview — both are shown,
// per the explicit brief: "Keep the existing operational/raw account
// counts available below the genuine-customer headline figures."
//
// An UNCLASSIFIED household is counted separately and NEVER folded into
// genuineCustomers — the one invariant this whole file exists to
// guarantee.
'use strict';

const { classifyHousehold, UNCLASSIFIED, KNOWN_CLASSIFICATIONS, getClassificationMap } = require('./accountClassification');

function resolveSupabaseAdmin() {
  try {
    return require('../supabaseClients').supabaseAdmin;
  } catch (err) {
    console.error('BUSINESS METRICS: failed to load Supabase client:', err.message);
    return null;
  }
}

// Pure — takes the already-fetched household rows, the set of
// household_ids with a currently-active entitlement, and the
// classification map, and produces the full classification breakdown.
// Directly unit-testable with no database at all.
function computeGenuineCustomerBreakdown({ households, activeEntitlementHouseholdIds, activeStripeEntitlementHouseholdIds }, classificationMap) {
  const byClassification = {
    genuine_customer: [],
    internal_test: [],
    admin: [],
    reviewer: [],
    qa_automation: [],
    unclassified: [],
  };

  for (const h of households || []) {
    const c = classifyHousehold(h.id, classificationMap);
    // Defensive: an unrecognised classification value (shouldn't happen —
    // the table has a CHECK constraint — but this module never assumes
    // the database is the only thing that can go wrong) falls into
    // unclassified rather than being silently dropped or miscounted.
    const bucket = byClassification[c] ? c : UNCLASSIFIED;
    byClassification[bucket].push(h);
  }

  const activeEntSet = new Set(activeEntitlementHouseholdIds || []);
  const activeStripeEntSet = new Set(activeStripeEntitlementHouseholdIds || []);
  const isActiveProtected = (h) => h.twilio_provisioning_status === 'active' && !!h.twilio_number;

  const genuine = byClassification.genuine_customer;

  return {
    genuineCustomers: genuine.length,
    genuinePayingCustomers: genuine.filter((h) => activeEntSet.has(h.id)).length,
    // Stripe-only subset of genuinePayingCustomers above — the real,
    // confirmed-revenue MRR (services/businessMetrics/config.js's price)
    // is computed from this count, never from the Apple/RevenueCat
    // portion, which stays a separately-labeled estimate.
    genuineStripePayingCustomers: genuine.filter((h) => activeStripeEntSet.has(h.id)).length,
    activeProtectedGenuineCustomers: genuine.filter(isActiveProtected).length,
    internalTest: byClassification.internal_test.length,
    admin: byClassification.admin.length,
    reviewer: byClassification.reviewer.length,
    qaAutomation: byClassification.qa_automation.length,
    unclassified: byClassification.unclassified.length,
    // Emails surfaced for admin visibility only — this is already
    // admin-only data (routes/adminBusiness.js, requireAuth+requireAdmin),
    // same as database/adminMetrics.js's existing getRecentCustomers.
    unclassifiedAccounts: byClassification.unclassified.map((h) => ({ householdId: h.id, email: h.email })),
  };
}

async function getGenuineCustomerOverview() {
  const supabaseAdmin = resolveSupabaseAdmin();
  if (!supabaseAdmin) {
    return { available: false, reason: 'SUPABASE_SERVICE_ROLE_KEY not configured' };
  }

  const [{ data: households, error: hErr }, { data: activeEnts, error: eErr }, classification] = await Promise.all([
    supabaseAdmin.from('households').select('id, email, twilio_provisioning_status, twilio_number'),
    supabaseAdmin.from('entitlements').select('household_id, source').eq('status', 'active'),
    getClassificationMap(),
  ]);

  if (hErr) return { available: false, reason: hErr.message };
  if (eErr) return { available: false, reason: eErr.message };
  if (!classification.available) return { available: false, reason: classification.reason };

  const breakdown = computeGenuineCustomerBreakdown(
    {
      households: households || [],
      activeEntitlementHouseholdIds: (activeEnts || []).map((e) => e.household_id),
      activeStripeEntitlementHouseholdIds: (activeEnts || []).filter((e) => e.source === 'stripe').map((e) => e.household_id),
    },
    classification.map
  );

  return { available: true, ...breakdown };
}

module.exports = { computeGenuineCustomerBreakdown, getGenuineCustomerOverview, KNOWN_CLASSIFICATIONS };
