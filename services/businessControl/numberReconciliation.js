// Business control dashboard (2026-09-27) — Protection / number
// reconciliation. READ-ONLY reporting over the number lifecycle that
// other code owns:
//   - provisioning:        services/twilioProvisioning.js (016)
//   - grace-period release: twilio_number_pending_release_at (017) and
//                           services/twilioNumberReleaseRunner.js
//   - quarantine / confirm: twilio_number_quarantine (037) and the
//                           admin confirm-deactivation route
//   - entitlement guard:    migration 047 (fix/number-lifecycle-
//                           entitlement-guard, not yet merged)
// Nothing here schedules, cancels, quarantines or releases a number, and
// nothing here re-implements those rules — it compares the recorded
// state of each household against what that lifecycle says should be
// true and reports the differences.
//
// Provider release failures are NOT persisted anywhere today
// (releaseQuarantinedTwilioNumber only logs them), so they can only be
// INFERRED: a confirmed quarantine still unreleased well after the daily
// release job should have run. That anomaly is labelled as inferred.
'use strict';

const { isEntitlementCurrentlyActive, parseTimestampMs } = require('../adminOnboardingStatus');

const HOUR_MS = 60 * 60 * 1000;
// server.js runs both release jobs every 24h from process start, so a
// correctly-working job may legitimately lag a due date by up to 24h.
// Anything later than 48h is treated as overdue.
const RELEASE_JOB_GRACE_MS = 48 * HOUR_MS;
// Provisioning normally completes within seconds of an entitlement
// starting; an hour without a number is worth a look, not an alarm.
const PROVISIONING_WATCH_MS = 1 * HOUR_MS;

const SEVERITY = { ACTION: 'action', WATCH: 'watch' };

const ANOMALIES = {
  PAID_WITHOUT_NUMBER: { severity: SEVERITY.ACTION, label: 'Paying customer without an HCG number' },
  ENTITLED_WITHOUT_NUMBER: { severity: SEVERITY.ACTION, label: 'Entitled household without an HCG number' },
  ENTITLED_PENDING_RELEASE: { severity: SEVERITY.ACTION, label: 'Entitled (or about to be) household whose number is scheduled for release' },
  NUMBER_RETAINED_NO_ENTITLEMENT: { severity: SEVERITY.ACTION, label: 'No entitlement, number retained, no release scheduled' },
  RELEASE_OVERDUE: { severity: SEVERITY.ACTION, label: 'Number still held after its scheduled release' },
  QUARANTINE_AWAITING_CONFIRMATION: { severity: SEVERITY.ACTION, label: 'Quarantined number awaiting deactivation confirmation' },
  QUARANTINE_RELEASE_OVERDUE: { severity: SEVERITY.ACTION, label: 'Confirmed quarantine not released (possible provider release failure — inferred)' },
  PROVIDER_NUMBER_UNACCOUNTED: { severity: SEVERITY.ACTION, label: 'Number on the provider account not held by any household or open quarantine' },
  NUMBER_MISSING_AT_PROVIDER: { severity: SEVERITY.ACTION, label: 'Household number not found on the provider account' },
  PROVISIONING_IN_PROGRESS: { severity: SEVERITY.WATCH, label: 'Number provisioning in progress' },
  VOICE_SDK_NEVER_REGISTERED: { severity: SEVERITY.WATCH, label: 'App (Voice SDK) never registered' },
  DELIVERY_NEVER_CONFIRMED: { severity: SEVERITY.WATCH, label: 'Call delivery never confirmed' },
};

// An entitlement that has not started yet: status 'scheduled', or
// 'active' with a future starts_at. Same definition as migration 047's
// household_has_upcoming_entitlement (fix/number-lifecycle-entitlement-
// guard) and PR #47's reconciliation: a household about to become
// entitled legitimately keeps its number, and scheduling its release is
// exactly the incident 047 guards against.
function isUpcomingEntitlement(entitlement, now) {
  if (!entitlement) return false;
  if (entitlement.status === 'scheduled') return true;
  if (entitlement.status !== 'active') return false;
  const startsMs = parseTimestampMs(entitlement.starts_at);
  return startsMs !== null && startsMs > now.getTime();
}

function anomaly(code, detail) {
  return { code, severity: ANOMALIES[code].severity, label: ANOMALIES[code].label, detail: detail || null };
}

const PAID_TYPES = new Set(['paid_subscription']);

// Pure — the lifecycle chain for one household, for the per-household
// view: subscription → entitlement → number → app → delivery → protected
// → cancellation → quarantine → released. Each stage: state + timestamp.
function buildLifecycleChain({ household, currentEntitlement, latestEntitlement, latestSubscription, quarantineRows }) {
  const openQuarantine = (quarantineRows || []).find((q) => !q.released_at) || null;
  const releasedQuarantine = (quarantineRows || []).filter((q) => q.released_at).sort((a, b) => (parseTimestampMs(b.released_at) || 0) - (parseTimestampMs(a.released_at) || 0))[0] || null;
  const protectedNow = !!(household.delivery_verified_at && household.voice_client_registered_at);
  return [
    { key: 'subscription', label: 'Subscription', state: latestSubscription ? latestSubscription.status : 'none', at: latestSubscription ? latestSubscription.updated_at : null },
    { key: 'entitlement', label: 'Entitlement', state: currentEntitlement ? 'active' : latestEntitlement ? latestEntitlement.status : 'none', at: (currentEntitlement || latestEntitlement || {}).starts_at || null },
    { key: 'number', label: 'HCG number', state: household.twilio_number ? 'assigned' : household.twilio_provisioning_status || 'none', at: household.twilio_provisioning_updated_at || null },
    { key: 'app', label: 'App registered', state: household.voice_client_registered_at ? 'yes' : 'no', at: household.voice_client_registered_at || null },
    { key: 'delivery', label: 'Delivery confirmed', state: household.delivery_verified_at ? 'yes' : 'no', at: household.delivery_verified_at || null },
    { key: 'protected', label: 'Protected', state: protectedNow ? 'yes' : 'no', at: null },
    { key: 'cancellation', label: 'Release scheduled', state: household.twilio_number_pending_release_at ? 'scheduled' : 'no', at: household.twilio_number_pending_release_at || null },
    { key: 'quarantine', label: 'Quarantine', state: openQuarantine ? (openQuarantine.deactivation_confirmed ? 'confirmed' : 'awaiting confirmation') : 'none', at: openQuarantine ? openQuarantine.quarantined_at : null },
    { key: 'released', label: 'Provider number released', state: releasedQuarantine ? 'released' : 'no', at: releasedQuarantine ? releasedQuarantine.released_at : null },
  ];
}

// Pure — every anomaly for one household.
function detectHouseholdAnomalies({ household, entitlements, quarantineRows }, now) {
  const nowMs = now.getTime();
  const current = (entitlements || []).find((e) => isEntitlementCurrentlyActive(e, now)) || null;
  const upcoming = current ? null : (entitlements || []).find((e) => isUpcomingEntitlement(e, now)) || null;
  const hasNumber = !!household.twilio_number;
  const pendingReleaseMs = parseTimestampMs(household.twilio_number_pending_release_at);
  const found = [];

  if (current) {
    const startedMs = parseTimestampMs(current.starts_at);
    const sinceStart = startedMs === null ? Infinity : nowMs - startedMs;
    if (!hasNumber) {
      if (household.twilio_provisioning_status !== 'failed' && sinceStart < PROVISIONING_WATCH_MS) {
        found.push(anomaly('PROVISIONING_IN_PROGRESS'));
      } else if (PAID_TYPES.has(current.entitlement_type)) {
        found.push(anomaly('PAID_WITHOUT_NUMBER', household.twilio_provisioning_status === 'failed' ? 'Provisioning failed' : null));
      } else {
        found.push(anomaly('ENTITLED_WITHOUT_NUMBER', household.twilio_provisioning_status === 'failed' ? 'Provisioning failed' : null));
      }
    }
    if (pendingReleaseMs !== null) {
      found.push(anomaly('ENTITLED_PENDING_RELEASE', `Release scheduled for ${new Date(pendingReleaseMs).toISOString()}`));
    }
    if (hasNumber && !household.voice_client_registered_at) found.push(anomaly('VOICE_SDK_NEVER_REGISTERED'));
    if (hasNumber && !household.delivery_verified_at) found.push(anomaly('DELIVERY_NEVER_CONFIRMED'));
  } else if (upcoming) {
    // About to be entitled: keeping (or not yet having) a number is
    // expected; a scheduled release is not.
    if (pendingReleaseMs !== null) {
      found.push(anomaly('ENTITLED_PENDING_RELEASE', `Upcoming entitlement from ${upcoming.starts_at || 'a scheduled date'}; release scheduled for ${new Date(pendingReleaseMs).toISOString()}`));
    }
  } else if (hasNumber) {
    if (pendingReleaseMs === null) {
      found.push(anomaly('NUMBER_RETAINED_NO_ENTITLEMENT'));
    } else if (nowMs - pendingReleaseMs > RELEASE_JOB_GRACE_MS) {
      found.push(anomaly('RELEASE_OVERDUE', `Was due ${new Date(pendingReleaseMs).toISOString()}`));
    }
  }

  for (const q of quarantineRows || []) {
    if (q.released_at) continue;
    if (!q.deactivation_confirmed) {
      found.push(anomaly('QUARANTINE_AWAITING_CONFIRMATION', `Quarantined ${q.quarantined_at || 'at unknown time'} (${q.release_reason || 'reason not recorded'})`));
    } else {
      const confirmedMs = parseTimestampMs(q.deactivation_confirmed_at);
      if (confirmedMs !== null && nowMs - confirmedMs > RELEASE_JOB_GRACE_MS) {
        found.push(anomaly('QUARANTINE_RELEASE_OVERDUE', `Confirmed ${q.deactivation_confirmed_at}; release failures are only logged, check server logs`));
      }
    }
  }

  return { anomalies: found, currentEntitlement: current, upcomingEntitlement: upcoming };
}

function normaliseNumber(n) {
  return typeof n === 'string' ? n.replace(/[^0-9+]/g, '') : null;
}

// Pure — the whole reconciliation report. Quarantine rows with no
// household (deleted accounts) are still reconciled, as number-level rows.
// `providerNumbers` (optional): the numbers actually on the provider
// account (read-only list). null = inventory not available, in which case
// the provider-side checks are skipped and reported as such.
function computeNumberReconciliation({ households, entitlements, subscriptions, quarantineRows, providerNumbers = null, classificationMap = null }, now) {
  const { buildLifecycleTimeline } = require('./lifecycleTimeline');
  const providerSet = Array.isArray(providerNumbers) ? new Set(providerNumbers.map(normaliseNumber).filter(Boolean)) : null;
  const allSubsByHousehold = new Map();
  for (const sRow of subscriptions || []) {
    if (!allSubsByHousehold.has(sRow.household_id)) allSubsByHousehold.set(sRow.household_id, []);
    allSubsByHousehold.get(sRow.household_id).push(sRow);
  }
  const entByHousehold = new Map();
  for (const e of entitlements || []) {
    if (!entByHousehold.has(e.household_id)) entByHousehold.set(e.household_id, []);
    entByHousehold.get(e.household_id).push(e);
  }
  const subByHousehold = new Map();
  for (const s of subscriptions || []) {
    const cur = subByHousehold.get(s.household_id);
    if (!cur || (parseTimestampMs(s.updated_at) || 0) > (parseTimestampMs(cur.updated_at) || 0)) subByHousehold.set(s.household_id, s);
  }
  const quarantineByHousehold = new Map();
  const orphanQuarantine = [];
  const householdIds = new Set((households || []).map((h) => h.id));
  for (const q of quarantineRows || []) {
    if (q.household_id && householdIds.has(q.household_id)) {
      if (!quarantineByHousehold.has(q.household_id)) quarantineByHousehold.set(q.household_id, []);
      quarantineByHousehold.get(q.household_id).push(q);
    } else {
      orphanQuarantine.push(q);
    }
  }

  const rows = [];
  const counts = {};
  for (const code of Object.keys(ANOMALIES)) counts[code] = 0;

  for (const h of households || []) {
    const ents = entByHousehold.get(h.id) || [];
    const qRows = quarantineByHousehold.get(h.id) || [];
    const { anomalies, currentEntitlement, upcomingEntitlement } = detectHouseholdAnomalies({ household: h, entitlements: ents, quarantineRows: qRows }, now);
    const relevant = currentEntitlement || upcomingEntitlement || h.twilio_number || h.twilio_number_pending_release_at || qRows.length > 0;
    if (!relevant) continue;
    for (const a of anomalies) counts[a.code] += 1;
    let latestEntitlement = null;
    for (const e of ents) if (!latestEntitlement || (parseTimestampMs(e.updated_at) || 0) > (parseTimestampMs(latestEntitlement.updated_at) || 0)) latestEntitlement = e;
    rows.push({
      householdId: h.id,
      email: h.email,
      hcgNumber: h.twilio_number || null,
      status: anomalies.some((a) => a.severity === SEVERITY.ACTION) ? 'action_required' : anomalies.length ? 'watch' : 'ok',
      anomalies,
      chain: buildLifecycleChain({ household: h, currentEntitlement, latestEntitlement, latestSubscription: subByHousehold.get(h.id) || null, quarantineRows: qRows }),
      timeline: buildLifecycleTimeline({
        household: h,
        entitlements: ents,
        subscriptions: allSubsByHousehold.get(h.id) || [],
        classification: classificationMap ? classificationMap.get(h.id) : undefined,
        quarantineRows: qRows,
        onProvider: providerSet ? (h.twilio_number ? providerSet.has(normaliseNumber(h.twilio_number)) : (qRows[0] && qRows[0].twilio_number ? providerSet.has(normaliseNumber(qRows[0].twilio_number)) : false)) : null,
      }, now),
    });
  }

  for (const q of orphanQuarantine) {
    const { anomalies } = detectHouseholdAnomalies({ household: { id: null }, entitlements: [], quarantineRows: [q] }, now);
    for (const a of anomalies) counts[a.code] += 1;
    rows.push({
      householdId: q.household_id || null,
      email: null,
      hcgNumber: q.twilio_number || null,
      status: anomalies.some((a) => a.severity === SEVERITY.ACTION) ? 'action_required' : 'ok',
      anomalies,
      chain: [],
      numberOnly: true,
    });
  }

  // Provider inventory, both directions.
  let providerInventory = { available: false, reason: 'Provider number list not available' };
  if (Array.isArray(providerNumbers)) {
    const onProvider = new Set(providerNumbers.map(normaliseNumber).filter(Boolean));
    const heldByHcg = new Set();
    for (const h of households || []) if (h.twilio_number) heldByHcg.add(normaliseNumber(h.twilio_number));
    for (const q of quarantineRows || []) if (!q.released_at && q.twilio_number) heldByHcg.add(normaliseNumber(q.twilio_number));

    for (const num of onProvider) {
      if (heldByHcg.has(num)) continue;
      const a = anomaly('PROVIDER_NUMBER_UNACCOUNTED', 'Not linked to any production household or open quarantine — it may belong to staging/testing. Verify before releasing; nothing is released from this view.');
      counts.PROVIDER_NUMBER_UNACCOUNTED += 1;
      rows.push({ householdId: null, email: null, hcgNumber: num, status: 'action_required', anomalies: [a], chain: [], numberOnly: true, providerOnly: true });
    }
    for (const row of rows) {
      if (!row.hcgNumber || row.numberOnly) continue;
      if (!onProvider.has(normaliseNumber(row.hcgNumber))) {
        row.anomalies.push(anomaly('NUMBER_MISSING_AT_PROVIDER', 'The customer may be forwarding calls to a number HCG no longer holds'));
        counts.NUMBER_MISSING_AT_PROVIDER += 1;
        row.status = 'action_required';
      }
    }
    providerInventory = { available: true, providerCount: onProvider.size, heldByHcgCount: heldByHcg.size };
  }

  const actionCount = rows.filter((r) => r.status === 'action_required').length;
  const watchCount = rows.filter((r) => r.status === 'watch').length;
  const order = { action_required: 0, watch: 1, ok: 2 };
  rows.sort((a, b) => order[a.status] - order[b.status]);

  return {
    overall: actionCount > 0 ? 'ACTION_REQUIRED' : watchCount > 0 ? 'WATCH' : 'OK',
    actionCount,
    watchCount,
    okCount: rows.filter((r) => r.status === 'ok').length,
    anomalyCounts: counts,
    anomalyDefinitions: ANOMALIES,
    providerInventory,
    rows,
    notes: [
      'Read-only: this view never schedules, quarantines or releases a number.',
      'Provider release failures are not recorded by the release job (logs only); an overdue confirmed quarantine is shown as an inferred failure.',
      'Release jobs run every 24h from server start; items up to 48h past due are not flagged.',
    ],
  };
}

function resolveSupabaseAdmin() {
  try {
    return require('../supabaseClients').supabaseAdmin;
  } catch (err) {
    return null;
  }
}

// Read-only list of numbers on the Twilio account (same call the
// existing Business tab snapshot makes). Only the E.164 number is used.
// When the provider-neutral numbers seam (architecture/voice-provider-
// portability) is merged, this should read through it instead.
async function listProviderNumbers() {
  let client = null;
  try {
    client = require('../twilioClient').twilioRestClient;
  } catch (err) {
    client = null;
  }
  if (!client) return null;
  try {
    const numbers = await client.incomingPhoneNumbers.list({ limit: 1000 });
    return numbers.map((n) => n.phoneNumber);
  } catch (err) {
    console.error('RECONCILIATION: provider number list failed:', err.message);
    return null;
  }
}

async function getNumberReconciliation(now = new Date(), { providerNumbersLoader = listProviderNumbers } = {}) {
  const supabaseAdmin = resolveSupabaseAdmin();
  if (!supabaseAdmin) return { available: false, reason: 'SUPABASE_SERVICE_ROLE_KEY not configured' };

  const [hRes, eRes, sRes, qRes, providerNumbers] = await Promise.all([
    supabaseAdmin
      .from('households')
      .select('id, email, twilio_number, twilio_provisioning_status, twilio_provisioning_updated_at, twilio_number_pending_release_at, activation_verified_at, voice_client_registered_at, delivery_verified_at'),
    supabaseAdmin.from('entitlements').select('household_id, entitlement_type, status, source, starts_at, ends_at, updated_at'),
    supabaseAdmin.from('subscriptions').select('household_id, status, cancel_at_period_end, updated_at'),
    supabaseAdmin
      .from('twilio_number_quarantine')
      .select('id, household_id, twilio_number, release_reason, deactivation_confirmed, deactivation_confirmed_at, deactivation_confirmed_method, quarantined_at, released_at'),
    providerNumbersLoader(),
  ]);
  const { getClassificationMap } = require('../businessMetrics/accountClassification');
  const classification = await getClassificationMap();
  for (const r of [hRes, eRes, sRes, qRes]) if (r.error) return { available: false, reason: r.error.message };

  return {
    available: true,
    generatedAt: now.toISOString(),
    ...computeNumberReconciliation(
      { households: hRes.data || [], entitlements: eRes.data || [], subscriptions: sRes.data || [], quarantineRows: qRes.data || [], providerNumbers, classificationMap: classification.available ? classification.map : null },
      now
    ),
  };
}

module.exports = {
  ANOMALIES,
  SEVERITY,
  RELEASE_JOB_GRACE_MS,
  buildLifecycleChain,
  isUpcomingEntitlement,
  detectHouseholdAnomalies,
  computeNumberReconciliation,
  getNumberReconciliation,
};
