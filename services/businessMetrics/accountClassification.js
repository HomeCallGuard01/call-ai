// accountClassification.js — explicit genuine-customer/internal/admin/
// reviewer/QA classification for the business dashboard (2026-09,
// Business Dashboard V2). Backed by the new public.account_classifications
// table (migration 031) — a household with no row is UNCLASSIFIED, never
// silently treated as a genuine customer. This is deliberate: neither
// households nor user_roles can reliably distinguish these today (no
// field for it), and inferring from email shape is unsafe — confirmed
// directly this session, an internal test account (ad_74uk@yahoo.co.uk)
// used an address indistinguishable in pattern from a genuine customer's.
'use strict';

const KNOWN_CLASSIFICATIONS = ['genuine_customer', 'internal_test', 'admin', 'reviewer', 'qa_automation'];
const UNCLASSIFIED = 'unclassified';

// Lazily resolved — same reasoning as every other file in this
// directory: services/supabaseClients.js's plain client throws
// synchronously if SUPABASE_URL is unset, which would otherwise crash a
// test/context that hasn't loaded it.
function resolveSupabaseAdmin() {
  try {
    return require('../supabaseClients').supabaseAdmin;
  } catch (err) {
    console.error('BUSINESS METRICS: failed to load Supabase client:', err.message);
    return null;
  }
}

async function getClassificationMap() {
  const supabaseAdmin = resolveSupabaseAdmin();
  if (!supabaseAdmin) {
    return { available: false, reason: 'SUPABASE_SERVICE_ROLE_KEY not configured', map: new Map() };
  }

  const { data, error } = await supabaseAdmin.from('account_classifications').select('household_id, classification');

  if (error) {
    return { available: false, reason: error.message, map: new Map() };
  }

  return { available: true, map: new Map((data || []).map((r) => [r.household_id, r.classification])) };
}

// Pure — a household with no entry in the map is UNCLASSIFIED. Never
// defaults to genuine_customer.
function classifyHousehold(householdId, classificationMap) {
  return (classificationMap && classificationMap.get(householdId)) || UNCLASSIFIED;
}

module.exports = {
  KNOWN_CLASSIFICATIONS,
  UNCLASSIFIED,
  getClassificationMap,
  classifyHousehold,
};
