// acquisitionOverview.js — Acquisition/Website section for Business
// Dashboard V2 (2026-09). Reads public.acquisition_events (migration
// 032) plus the existing account_classifications table so
// checkout/conversion counts can be split into genuine-customer vs.
// internal/admin/reviewer/qa, the same way
// customerClassificationOverview.js already does for the customer
// headline KPIs.
//
// Explicit, permanent limitation carried through every function here:
// landing_visit/registration_submitted/registration_completed never
// have a household_id (no household exists yet at those points in a
// cookie-free design — see migration 032's own header), so they can
// only ever be reported as raw, unclassified totals. Only
// checkout_started and paid_conversion — which occur after a real,
// authenticated household exists — can be split by genuine-customer
// classification.
//
// Review correction (2026-09): the returned shape keeps two funnels
// completely separate — rawFunnel (every stage, every household,
// unclassified traffic included) and classifiedGenuineCustomerFunnel
// (only the two stages where classification is actually possible,
// counting only households explicitly classified genuine_customer).
// An unclassified household is NEVER folded into the genuine count —
// classifyHousehold's own default is 'unclassified', and
// splitByGenuineCustomer below only ever counts an exact
// 'genuine_customer' match as genuine, so this can never silently
// imply that a new, not-yet-classified account is a real customer.
'use strict';

const { classifyHousehold, getClassificationMap } = require('./accountClassification');

function resolveSupabaseAdmin() {
  try {
    return require('../supabaseClients').supabaseAdmin;
  } catch (err) {
    console.error('BUSINESS METRICS: failed to load Supabase client:', err.message);
    return null;
  }
}

function startOfTodayIso() {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

function startOfMonthIso() {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

// Pure — counts raw rows by event_type. Never distinguishes genuine
// customers from internal/test/admin/reviewer/qa — see this file's own
// header for why that's only possible for checkout_started/paid_conversion.
function countByEventType(rows, eventType) {
  return (rows || []).filter((r) => r.event_type === eventType).length;
}

// Pure — splits a set of rows (already filtered to one event_type) into
// genuine-customer vs. everything-else counts, using the same
// classification map customerClassificationOverview.js uses. Rows with
// no household_id at all (shouldn't occur for the two event types this
// is ever called on, but handled defensively) count as unclassifiable,
// never genuine.
function splitByGenuineCustomer(rows, classificationMap) {
  let genuine = 0;
  let other = 0;
  for (const row of rows || []) {
    if (row.household_id && classifyHousehold(row.household_id, classificationMap) === 'genuine_customer') {
      genuine += 1;
    } else {
      other += 1;
    }
  }
  return { genuine, total: genuine + other };
}

// Pure — top N UTM sources by row count, across whichever rows are
// passed in. Rows with no utm_source at all are grouped under
// "(not tagged)" so the total always accounts for every row, rather
// than silently dropping untagged traffic from the breakdown.
function topUtmSources(rows, limit = 10) {
  const counts = new Map();
  for (const row of rows || []) {
    const key = row.utm_source || '(not tagged)';
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([source, count]) => ({ source, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

// Pure — the full computed shape for one time window's worth of raw
// event rows, given the classification map. Directly unit-testable
// with no database at all. Two funnels, always kept separate — see
// this file's own header.
function computeAcquisitionSnapshot(rows, classificationMap) {
  const checkoutRows = (rows || []).filter((r) => r.event_type === 'checkout_started');
  const paidConversionRows = (rows || []).filter((r) => r.event_type === 'paid_conversion');

  const checkoutSplit = splitByGenuineCustomer(checkoutRows, classificationMap);
  const paidConversionSplit = splitByGenuineCustomer(paidConversionRows, classificationMap);

  const genuineConversionRate =
    checkoutSplit.genuine > 0 ? Math.round((paidConversionSplit.genuine / checkoutSplit.genuine) * 1000) / 10 : null;

  return {
    // Raw / all-traffic funnel — every event, every household,
    // unclassified and internal/test/admin/reviewer/qa traffic all
    // included. Never presented as, or confused with, real customer
    // acquisition.
    rawFunnel: {
      landingVisits: countByEventType(rows, 'landing_visit'),
      registrationsSubmitted: countByEventType(rows, 'registration_submitted'),
      registrationsCompleted: countByEventType(rows, 'registration_completed'),
      checkoutsStarted: checkoutSplit.total,
      paidConversions: paidConversionSplit.total,
    },
    // Classified genuine-customer funnel — ONLY the two stages where a
    // household (and therefore a classification) exists yet. An
    // unclassified household is never counted here.
    classifiedGenuineCustomerFunnel: {
      checkoutsStarted: checkoutSplit.genuine,
      paidConversions: paidConversionSplit.genuine,
    },
    genuineConversionRatePercent: genuineConversionRate,
    topUtmSources: topUtmSources(rows, 10),
  };
}

async function getAcquisitionOverview() {
  const supabaseAdmin = resolveSupabaseAdmin();
  if (!supabaseAdmin) {
    return { available: false, reason: 'SUPABASE_SERVICE_ROLE_KEY not configured' };
  }

  const [{ data: todayRows, error: todayError }, { data: mtdRows, error: mtdError }, classification] = await Promise.all([
    supabaseAdmin.from('acquisition_events').select('event_type, household_id, utm_source').gte('created_at', startOfTodayIso()),
    supabaseAdmin.from('acquisition_events').select('event_type, household_id, utm_source').gte('created_at', startOfMonthIso()),
    getClassificationMap(),
  ]);

  if (todayError) return { available: false, reason: todayError.message };
  if (mtdError) return { available: false, reason: mtdError.message };
  if (!classification.available) return { available: false, reason: classification.reason };

  return {
    available: true,
    today: computeAcquisitionSnapshot(todayRows || [], classification.map),
    monthToDate: computeAcquisitionSnapshot(mtdRows || [], classification.map),
  };
}

module.exports = {
  countByEventType,
  splitByGenuineCustomer,
  topUtmSources,
  computeAcquisitionSnapshot,
  getAcquisitionOverview,
};
