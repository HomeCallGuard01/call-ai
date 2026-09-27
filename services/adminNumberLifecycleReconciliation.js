// Admin number-lifecycle reconciliation (2026-09-27 launch-hardening,
// Priority 2) — pure derivation of a per-household view spanning
// subscription -> entitlement -> HCG number -> pending release/
// quarantine -> released, plus an overall OK/ACTION REQUIRED summary.
//
// Built specifically to surface the "loose ends" class of anomaly that
// let the real #8 incident (household 30f01a7a, 2026-09-23) go
// unnoticed until a customer complaint: nothing in this codebase, before
// tonight, gave an operator a single place to see "entitled but number
// pending release" or "no entitlement but number still assigned" across
// every household at once. This is READ-ONLY — a reporting/observability
// layer, exactly like services/adminOnboardingStatus.js and
// services/adminCustomerHealth.js, which it deliberately reuses rather
// than reimplements wherever they already compute the same fact.
//
// Never gates runtime behaviour. Never writes anything. Classification
// (account_classifications, migration 031) is read purely to keep
// internal/test/reviewer/admin accounts from contaminating the
// genuine-customer anomaly counts — exactly the same "business-reporting
// only, never a runtime gate" rule that table's own migration comment
//
// UNCLASSIFIED DEFAULT — deliberately the OPPOSITE of the "Total
// Customers" KPI rule elsewhere in this codebase, not a contradiction of
// it. Migration 031's own comment says an unclassified household must
// never be silently counted AS a genuine customer, specifically so this
// table can never inflate that vanity metric by itself. This file's job
// is the opposite kind of safety: migration 031 only ever seeded 5
// specific, already-known test/admin/reviewer accounts — every real
// paying customer is "unclassified" by default, today, as a simple fact
// of how that table has been used so far. Excluding "unclassified" from
// this dashboard's anomaly counting would therefore hide almost every
// genuine customer's anomaly, defeating the entire purpose of this
// feature. So here, unclassified counts AS genuine for anomaly
// visibility — fail toward showing a real problem, never toward hiding
// one — while still never counting toward the separate "Total Customers"
// KPI anywhere else in this codebase, which this file does not touch.
// establishes, unchanged here.

'use strict';

function parseTimestampMs(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isNaN(ms) ? null : ms;
  }
  if (typeof value !== 'string') return null;
  const hasZone = /(Z|[+-]\d{2}(:?\d{2})?)$/i.test(value.trim());
  const ms = Date.parse(hasZone ? value : value.trim().replace(' ', 'T') + 'Z');
  return Number.isNaN(ms) ? null : ms;
}

// Mirrors database/billing.js's getActiveEntitlement() query exactly —
// see that function's own comment for why this must never independently
// drift from the real runtime rule.
function isCurrentlyEntitled(entitlement, nowMs) {
  if (!entitlement || entitlement.status !== 'active') return false;
  const startsMs = parseTimestampMs(entitlement.starts_at);
  if (startsMs === null || startsMs > nowMs) return false;
  const endsMs = parseTimestampMs(entitlement.ends_at);
  return endsMs === null || endsMs > nowMs;
}

// Mirrors supabase/migrations/047_number_release_entitlement_guard.sql's
// household_has_upcoming_entitlement() exactly.
function isUpcomingEntitlement(entitlement, nowMs) {
  if (!entitlement) return false;
  const startsMs = parseTimestampMs(entitlement.starts_at);
  const endsMs = parseTimestampMs(entitlement.ends_at);
  if (endsMs !== null && endsMs <= nowMs) return false;
  if (entitlement.status === 'scheduled') return true;
  if (entitlement.status === 'active' && startsMs !== null && startsMs > nowMs) return true;
  return false;
}

const ANOMALY = {
  ACTIVE_NO_NUMBER: 'active_entitlement_no_number',
  CANCELLED_RETAINS_NUMBER: 'no_entitlement_retains_number',
  ENTITLED_PENDING_RELEASE: 'entitled_but_pending_release',
  PROVISIONING_FAILED: 'provisioning_failed',
  QUARANTINE_RELEASE_FAILED: 'quarantine_release_failed',
  // 2026-09-27, found during this session's own Priority 7 audit: PR #50
  // (fix/revenuecat-sandbox-environment-guard) deliberately grants an
  // entitlement for a RevenueCat SANDBOX purchase (TestFlight/App
  // Review/local dev) while skipping real Twilio provisioning — correct,
  // intended behaviour, but WITHOUT this distinct anomaly type, every
  // such purchase would have been indistinguishable from ACTIVE_NO_NUMBER
  // (a genuine provisioning failure) below, and — since a sandbox
  // purchaser is never auto-classified (account_classifications stays
  // 'unclassified' by that fix's own deliberate design) — would have
  // counted toward the genuine-customer anomaly total, exactly
  // reproducing the false-alarm-y signal that raised tonight's own
  // Priority 2 in the first place. Requires migration 053's
  // entitlements.revenuecat_environment column — see this file's own
  // dependency note near computeNumberLifecycleReconciliation.
  SANDBOX_TEST_PURCHASE_NO_NUMBER: 'sandbox_test_purchase_no_number',
};

const ANOMALY_LABELS = {
  [ANOMALY.ACTIVE_NO_NUMBER]: 'Subscription/entitlement active but no HCG number assigned',
  [ANOMALY.CANCELLED_RETAINS_NUMBER]: 'No current or upcoming entitlement, but a number is still assigned (and not scheduled for release)',
  [ANOMALY.ENTITLED_PENDING_RELEASE]: 'Currently or upcoming entitled, but a release is still pending (should have been auto-cancelled — migration 047)',
  [ANOMALY.PROVISIONING_FAILED]: 'Twilio provisioning is in a failed state',
  [ANOMALY.QUARANTINE_RELEASE_FAILED]: 'A quarantined number was never confirmed released at the provider',
  [ANOMALY.SANDBOX_TEST_PURCHASE_NO_NUMBER]: 'A confirmed RevenueCat SANDBOX-environment purchase (TestFlight/App Review/local dev) — no number provisioned, correctly, by design (P0 fix, 2026-09-27, PR #50). Informational only, never counted toward the anomaly total or the OK/ACTION REQUIRED verdict.',
};

// Never counted toward totalAnomalies/status below — these are expected,
// intended states, not something requiring operator action. Currently
// only the sandbox case; kept as its own named set (rather than an
// inline check) so a future addition to this list is a one-line change,
// not a re-derivation of this reasoning.
const INFORMATIONAL_ANOMALIES = new Set([ANOMALY.SANDBOX_TEST_PURCHASE_NO_NUMBER]);

/**
 * Pure — no database, no Express, `now` always injected (matches this
 * codebase's established convention).
 *
 * @param {Array<object>} households - each with: id, email,
 *   twilio_number, twilio_provisioning_status,
 *   twilio_provisioning_last_error, twilio_number_pending_release_at
 * @param {Map<string, object[]>} entitlementsByHousehold - household_id -> entitlement rows.
 *   Each row: status, starts_at, ends_at, and (2026-09-27, optional —
 *   requires migration 053) source, revenuecat_environment — used only
 *   to distinguish a known-sandbox no-number state from a genuine
 *   provisioning failure. A caller not yet selecting these two columns
 *   (i.e. querying a database without migration 053 applied) still works
 *   correctly — every sandbox purchase just falls through to the
 *   pre-existing ACTIVE_NO_NUMBER anomaly exactly as before this change,
 *   never a crash or missing-field error.
 * @param {Map<string, string>} classificationByHousehold - household_id -> classification string (or absent = unclassified)
 * @param {Array<object>} quarantineRows - rows from public.twilio_number_quarantine
 * @param {Date} now
 */
function computeNumberLifecycleReconciliation(households, entitlementsByHousehold, classificationByHousehold, quarantineRows, now) {
  const nowMs = now.getTime();
  const quarantineByHousehold = new Map();
  for (const q of quarantineRows || []) {
    if (!q.household_id) continue;
    const list = quarantineByHousehold.get(q.household_id) || [];
    list.push(q);
    quarantineByHousehold.set(q.household_id, list);
  }

  const rows = [];
  for (const h of households || []) {
    const entitlements = (entitlementsByHousehold && entitlementsByHousehold.get(h.id)) || [];
    const current = entitlements.find(e => isCurrentlyEntitled(e, nowMs)) || null;
    const upcoming = entitlements.find(e => isUpcomingEntitlement(e, nowMs)) || null;
    const hasNumber = !!h.twilio_number;
    const pendingReleaseAt = h.twilio_number_pending_release_at || null;
    const classification = (classificationByHousehold && classificationByHousehold.get(h.id)) || 'unclassified';
    const quarantine = quarantineByHousehold.get(h.id) || [];
    const unreleasedQuarantine = quarantine.find(q => q.deactivation_confirmed && !q.released_at) || null;

    // Confirmed sandbox-origin: the relevant (current or upcoming)
    // entitlement itself carries source='apple_revenuecat' and
    // revenuecat_environment='sandbox' — stronger, more specific
    // evidence than account_classification alone (a sandbox purchaser is
    // never auto-classified, by PR #50's own deliberate design). Both
    // fields undefined (pre-migration-053 caller) safely falls through
    // to the pre-existing behaviour below.
    const relevantEntitlement = current || upcoming;
    const isSandboxOrigin = !!relevantEntitlement && relevantEntitlement.source === 'apple_revenuecat' && relevantEntitlement.revenuecat_environment === 'sandbox';

    const anomalies = [];
    if ((current || upcoming) && !hasNumber) {
      anomalies.push(isSandboxOrigin ? ANOMALY.SANDBOX_TEST_PURCHASE_NO_NUMBER : ANOMALY.ACTIVE_NO_NUMBER);
    }
    if (!current && !upcoming && hasNumber && !pendingReleaseAt) anomalies.push(ANOMALY.CANCELLED_RETAINS_NUMBER);
    if ((current || upcoming) && pendingReleaseAt) anomalies.push(ANOMALY.ENTITLED_PENDING_RELEASE);
    if (h.twilio_provisioning_status === 'failed') anomalies.push(ANOMALY.PROVISIONING_FAILED);
    if (unreleasedQuarantine) anomalies.push(ANOMALY.QUARANTINE_RELEASE_FAILED);

    rows.push({
      householdId: h.id,
      classification,
      isGenuineCustomer: classification === 'genuine_customer' || classification === 'unclassified',
      hasCurrentEntitlement: !!current,
      hasUpcomingEntitlement: !!upcoming,
      hasNumber,
      numberPendingReleaseAt: pendingReleaseAt,
      provisioningStatus: h.twilio_provisioning_status || null,
      provisioningLastError: h.twilio_provisioning_last_error || null,
      quarantine: unreleasedQuarantine
        ? { releaseReason: unreleasedQuarantine.release_reason, quarantinedAt: unreleasedQuarantine.quarantined_at, deactivationConfirmed: true, releasedAt: null }
        : null,
      anomalies,
      anomalyLabels: anomalies.map(a => ANOMALY_LABELS[a]),
    });
  }

  // Summary counts only the genuine-customer/unclassified population by
  // default — test/internal/reviewer/admin/qa_automation accounts are
  // shown in the full row list (so an operator can still see them) but
  // never contribute to the headline OK/ACTION REQUIRED verdict or the
  // primary anomaly counts, per the explicit "don't contaminate
  // genuine-customer metrics" requirement.
  const genuineRows = rows.filter(r => r.isGenuineCustomer);
  const anomalyCounts = {};
  for (const key of Object.values(ANOMALY)) anomalyCounts[key] = 0;
  let totalAnomalies = 0;
  for (const row of genuineRows) {
    for (const a of row.anomalies) {
      anomalyCounts[a] = (anomalyCounts[a] || 0) + 1;
      // INFORMATIONAL_ANOMALIES (currently just the confirmed-sandbox
      // no-number state) are visible in anomalyCounts/the row list, but
      // deliberately never inflate totalAnomalies or flip status to
      // ACTION_REQUIRED — they are a known, intended state, not
      // something an operator needs to act on.
      if (!INFORMATIONAL_ANOMALIES.has(a)) totalAnomalies++;
    }
  }

  const classificationCounts = {};
  for (const row of rows) {
    classificationCounts[row.classification] = (classificationCounts[row.classification] || 0) + 1;
  }

  return {
    status: totalAnomalies === 0 ? 'OK' : 'ACTION_REQUIRED',
    totalHouseholds: rows.length,
    genuineCustomerHouseholds: genuineRows.length,
    totalAnomalies,
    anomalyCounts,
    classificationCounts,
    households: rows,
  };
}

module.exports = {
  computeNumberLifecycleReconciliation,
  isCurrentlyEntitled,
  isUpcomingEntitlement,
  ANOMALY,
  ANOMALY_LABELS,
  INFORMATIONAL_ANOMALIES,
};
