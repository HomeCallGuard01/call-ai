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
// 2026-10-04 (MI-1b): genuine = the canonical commercial status (commercialIndex);
// classification only supplies the test/reviewer/admin exclusion buckets.
// Without an index nobody counts as genuine — never a second definition.
function computeGenuineCustomerBreakdown({ households, activeEntitlementHouseholdIds, activeStripeEntitlementHouseholdIds, commercialIndex = null }, classificationMap) {
  const byClassification = {
    genuine_customer: [],
    internal_test: [],
    admin: [],
    reviewer: [],
    qa_automation: [],
    other_non_customer: [],
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

  const commercialOf = (h) => (commercialIndex ? commercialIndex.byHousehold.get(h.id) : null);
  const genuine = (households || []).filter((h) => { const c = commercialOf(h); return !!(c && c.genuinePaying); });
  // Partition (2026-10-04): genuine (canonical) + explicit test/reviewer/admin/
  // QA/other labels + everything else ("unclassified" = not genuine paying and
  // not an explicit test account — e.g. a 'genuine_customer' label with no
  // proven production money).
  const genuineIds = new Set(genuine.map((h) => h.id));
  const testIds = new Set(['internal_test', 'admin', 'reviewer', 'qa_automation', 'other_non_customer'].flatMap((k) => byClassification[k].map((h) => h.id)));
  byClassification.unclassified = (households || []).filter((h) => !genuineIds.has(h.id) && !testIds.has(h.id));

  return {
    genuineCustomers: genuine.length,
    genuinePayingCustomers: genuine.length,
    // Stripe-only subset of genuinePayingCustomers above — the real,
    // confirmed-revenue MRR (services/businessMetrics/config.js's price)
    // is computed from this count, never from the Apple/RevenueCat
    // portion, which stays a separately-labeled estimate.
    genuineStripePayingCustomers: genuine.filter((h) => commercialOf(h).channel === 'web_stripe').length,
    activeProtectedGenuineCustomers: genuine.filter(isActiveProtected).length,
    internalTest: byClassification.internal_test.length,
    admin: byClassification.admin.length,
    reviewer: byClassification.reviewer.length,
    qaAutomation: byClassification.qa_automation.length,
    otherNonCustomer: byClassification.other_non_customer.length,
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
      commercialIndex: await require('../commercial/householdCommercialIndex').loadCommercialIndex(supabaseAdmin, classification.map),
    },
    classification.map
  );

  return { available: true, ...breakdown };
}

// Pure — annotates an already-fetched customer list (database/
// adminMetrics.js's getRecentCustomers shape) with each household's
// classification, and splits it into genuine vs. everything-else.
// Directly unit-testable with no database at all. Every row keeps its
// classification field regardless of which list it lands in, so the
// "diagnostics" view can show a badge per row rather than a second,
// separately-shaped table.
function classifyCustomerList(customers, classificationMap, commercialIndex = null) {
  const annotated = (customers || []).map((c) => {
    const commercial = commercialIndex ? commercialIndex.byHousehold.get(c.householdId) || null : null;
    return { ...c, classification: classifyHousehold(c.householdId, classificationMap), commercialStatus: commercial ? commercial.status : null, genuinePaying: !!(commercial && commercial.genuinePaying) };
  });
  return {
    all: annotated,
    // 2026-10-04 (MI-1): the canonical genuine-paying definition.
    genuine: annotated.filter((c) => c.genuinePaying),
  };
}

// Dashboard Cleanup (2026-09): the Customers tab's data source.
// database/adminMetrics.js's getRecentCustomers() itself is completely
// unchanged (still returns every household, unfiltered, most-recent
// first) — classification is applied here, as an annotation layer, so
// the underlying function keeps its existing, already-tested behaviour
// and the "genuine-first, diagnostics available" split lives in exactly
// one place. Never reclassifies anything: this only ever reads the
// existing account_classifications table via getClassificationMap().
async function getClassifiedCustomerList(limit = 20) {
  const supabaseAdmin = resolveSupabaseAdmin();
  if (!supabaseAdmin) {
    return { available: false, reason: 'SUPABASE_SERVICE_ROLE_KEY not configured' };
  }

  // Required here (not at module top) to avoid a require-cycle risk if
  // database/adminMetrics.js ever grows a reverse dependency — it
  // currently has none, but this keeps the two modules' coupling
  // one-directional and explicit at the call site.
  const { getRecentCustomers } = require('../../database/adminMetrics');

  const [customers, classification] = await Promise.all([getRecentCustomers(limit), getClassificationMap()]);

  if (!classification.available) return { available: false, reason: classification.reason };

  const commercialIndex = await require('../commercial/householdCommercialIndex').loadCommercialIndex(resolveSupabaseAdmin(), classification.map);
  const { all, genuine } = classifyCustomerList(customers, classification.map, commercialIndex);
  return { available: true, all, genuine };
}

module.exports = {
  computeGenuineCustomerBreakdown,
  getGenuineCustomerOverview,
  classifyCustomerList,
  getClassifiedCustomerList,
  KNOWN_CLASSIFICATIONS,
};
