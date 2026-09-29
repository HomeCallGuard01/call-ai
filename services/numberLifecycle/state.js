// Number lifecycle — the ONE definition of entitlement-for-numbers,
// household number state and lifecycle anomalies (2026-09-29).
//
// Why: four engines calculated lifecycle problems and disagreed
// (docs/admin/RECONCILIATION_CONSOLIDATION_PLAN.md): the admin API (#47),
// the daily sweep (#49), the dashboard and Finance's number-cost report.
// The release AUTHORITY is migration 047's SQL
// (household_is_currently_entitled / household_has_upcoming_entitlement /
// household_blocks_number_release), re-checked under a row lock at
// execution time. Everything here mirrors that SQL exactly and is
// regression-tested against it (tests/number-lifecycle-state.test.mjs and
// the shared fixture tests/fixtures/number-lifecycle-parity.json, which
// the sweep and admin API can run once merged).
//
// Rules:
//   - Classification is never an input. A reviewer's number costs the same
//     as a customer's; views may split by class afterwards.
//   - Fail closed: an entitlement status outside the known set, or an
//     unreadable provisioning status, makes the household AMBIGUOUS. An
//     ambiguous household always blocks release and is always reported.
//   - Pure. Nothing here reads a database, calls a provider or acts.
//     Only the sweep turns anomalies into actions, through 047.
'use strict';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// One place for every time rule. Values marked DECISION were chosen
// where engines disagreed; see the consolidation plan.
const GRACE = Object.freeze({
  // Entitlement started < 1h ago and no number yet: provisioning is in
  // progress (watch), not a failure.
  provisioningWatchMs: 1 * HOUR_MS,
  // Release job cadence: server.js runs it 60s after boot, then every 24h.
  releaseJobIntervalMs: 24 * HOUR_MS,
  // DECISION: a due release still holding its number after one full job
  // interval is overdue. The sweep (#49) used 24h; the dashboard used
  // 48h. The backend value wins: the dashboard must never show "fine"
  // for something the sweep alerts on.
  releaseOverdueMs: 24 * HOUR_MS,
  // A CONFIRMED quarantine not released after this is stuck (provider
  // release failure, inferred until P0's 052 columns record it).
  // DECISION: measured from deactivation_confirmed_at when present (the
  // moment release became allowed), else quarantined_at (the sweep's
  // basis) — never later than the sweep would alert.
  quarantineReleaseStuckMs: 48 * HOUR_MS,
  // Unconfirmed quarantine escalation (approved 45/90-day policy).
  quarantineEscalateMs: 45 * DAY_MS,
  quarantineCriticalMs: 90 * DAY_MS,
});

const KNOWN_ENTITLEMENT_STATUSES = new Set(['scheduled', 'active', 'expired', 'revoked']);

function parseTimestampMs(value) {
  if (value === null || value === undefined || value === '') return null;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}

function toMs(now) {
  return typeof now === 'number' ? now : now.getTime();
}

// Mirrors household_is_currently_entitled(): status 'active',
// starts_at <= now, ends_at null or > now. A missing starts_at is never
// current (SQL: NULL <= now() is not true).
function isCurrentlyEntitled(entitlement, now) {
  if (!entitlement || entitlement.status !== 'active') return false;
  const nowMs = toMs(now);
  const startsMs = parseTimestampMs(entitlement.starts_at);
  if (startsMs === null || startsMs > nowMs) return false;
  const endsMs = parseTimestampMs(entitlement.ends_at);
  return endsMs === null || endsMs > nowMs;
}

// Mirrors household_has_upcoming_entitlement(): (status 'scheduled', or
// 'active' with starts_at > now) AND (ends_at null or > now).
function isUpcomingEntitlement(entitlement, now) {
  if (!entitlement) return false;
  const nowMs = toMs(now);
  const endsMs = parseTimestampMs(entitlement.ends_at);
  if (endsMs !== null && endsMs <= nowMs) return false;
  if (entitlement.status === 'scheduled') return true;
  if (entitlement.status !== 'active') return false;
  const startsMs = parseTimestampMs(entitlement.starts_at);
  return startsMs !== null && startsMs > nowMs;
}

// Mirrors household_blocks_number_release().
function blocksNumberRelease(entitlements, now) {
  return (entitlements || []).some((e) => isCurrentlyEntitled(e, now) || isUpcomingEntitlement(e, now));
}

function hasAmbiguousEntitlement(entitlements) {
  return (entitlements || []).some((e) => !KNOWN_ENTITLEMENT_STATUSES.has(e && e.status));
}

// The union anomaly catalogue (consolidation plan). severity: 'action'
// needs a decision/fix; 'watch' is expected-but-monitor; 'critical' can
// cause harm if acted on wrongly.
const ANOMALIES = Object.freeze({
  AMBIGUOUS_STATE: { severity: 'action', label: 'Lifecycle state cannot be determined (unknown entitlement or provisioning status) — never safe to release' },
  PROVISIONING_IN_PROGRESS: { severity: 'watch', label: 'Number provisioning in progress' },
  PROVISIONING_FAILED: { severity: 'action', label: 'Number provisioning failed' },
  ENTITLED_WITHOUT_NUMBER: { severity: 'action', label: 'Entitled household without an HCG number' },
  ENTITLED_PENDING_RELEASE: { severity: 'action', label: 'Entitled (or about to be) household whose number is scheduled for release' },
  NUMBER_RETAINED_NO_ENTITLEMENT: { severity: 'action', label: 'No entitlement, number retained, no release scheduled (outside the lifecycle)' },
  RELEASE_OVERDUE: { severity: 'action', label: 'Number still held after its scheduled release' },
  QUARANTINE_AWAITING_CONFIRMATION: { severity: 'watch', label: 'Quarantined number awaiting deactivation confirmation' },
  QUARANTINE_AWAITING_CONFIRMATION_LONG: { severity: 'action', label: 'Quarantined number awaiting confirmation for over 45 days' },
  QUARANTINE_RELEASE_STUCK: { severity: 'action', label: 'Confirmed quarantine not released (possible provider release failure)' },
  QUARANTINED_NUMBER_OF_ENTITLED_HOUSEHOLD: { severity: 'critical', label: 'Number quarantined while the household is entitled — do not confirm deactivation' },
  RECORDED_RELEASE_FAILURE: { severity: 'action', label: 'A provider release attempt failed (recorded)' },
  VOICE_SDK_NEVER_REGISTERED: { severity: 'watch', label: 'App (Voice SDK) never registered' },
  DELIVERY_NEVER_CONFIRMED: { severity: 'watch', label: 'Call delivery never confirmed' },
});

// The household-number state, one value per household.
const NUMBER_STATES = Object.freeze({
  AMBIGUOUS: 'ambiguous',
  ACTIVE: 'active', // current entitlement, holds a number
  UPCOMING: 'upcoming', // entitlement about to start; keeps/awaits its number
  AWAITING_NUMBER: 'awaiting_number', // entitled, no number
  GRACE_PERIOD: 'grace_period', // no entitlement; release scheduled in the future
  RELEASE_DUE: 'release_due', // release date passed, job has not run yet (within one interval)
  RELEASE_OVERDUE: 'release_overdue',
  OUTSIDE_LIFECYCLE: 'outside_lifecycle', // no entitlement, number, no release scheduled
  NO_NUMBER: 'no_number', // no entitlement, no number
});

function anomaly(code, detail) {
  return { code, severity: ANOMALIES[code].severity, label: ANOMALIES[code].label, detail: detail || null };
}

/**
 * The canonical lifecycle for one household. Pure.
 * @param {{ household: object, entitlements: object[], quarantineRows?: object[] }} input
 * @param {Date|number} now
 */
function deriveHouseholdLifecycle({ household, entitlements, quarantineRows }, now) {
  const nowMs = toMs(now);
  const ents = entitlements || [];
  const hasNumber = !!(household && household.twilio_number);
  const pendingMs = parseTimestampMs(household && household.twilio_number_pending_release_at);
  const provisioning = household ? household.twilio_provisioning_status : undefined;
  const found = [];

  const ambiguous = hasAmbiguousEntitlement(ents) || (provisioning !== undefined && provisioning !== null && typeof provisioning !== 'string');
  const current = ents.find((e) => isCurrentlyEntitled(e, nowMs)) || null;
  const upcoming = current ? null : ents.find((e) => isUpcomingEntitlement(e, nowMs)) || null;
  // Fail closed: ambiguity blocks release even when no rule says so.
  const blocksRelease = ambiguous || !!(current || upcoming);
  const membership = ambiguous ? 'ambiguous' : current ? 'current' : upcoming ? 'upcoming' : 'none';

  let numberState;
  if (ambiguous) {
    numberState = NUMBER_STATES.AMBIGUOUS;
    found.push(anomaly('AMBIGUOUS_STATE'));
  } else if (current) {
    numberState = hasNumber ? NUMBER_STATES.ACTIVE : NUMBER_STATES.AWAITING_NUMBER;
  } else if (upcoming) {
    numberState = NUMBER_STATES.UPCOMING;
  } else if (!hasNumber) {
    numberState = NUMBER_STATES.NO_NUMBER;
  } else if (pendingMs === null) {
    numberState = NUMBER_STATES.OUTSIDE_LIFECYCLE;
  } else if (pendingMs > nowMs) {
    numberState = NUMBER_STATES.GRACE_PERIOD;
  } else if (nowMs - pendingMs > GRACE.releaseOverdueMs) {
    numberState = NUMBER_STATES.RELEASE_OVERDUE;
  } else {
    numberState = NUMBER_STATES.RELEASE_DUE;
  }

  if (!ambiguous) {
    if (current && !hasNumber) {
      const startedMs = parseTimestampMs(current.starts_at);
      if (provisioning === 'failed') found.push(anomaly('PROVISIONING_FAILED'));
      else if (startedMs !== null && nowMs - startedMs < GRACE.provisioningWatchMs) found.push(anomaly('PROVISIONING_IN_PROGRESS'));
      else found.push(anomaly('ENTITLED_WITHOUT_NUMBER'));
    }
    if ((current || upcoming) && pendingMs !== null) {
      found.push(anomaly('ENTITLED_PENDING_RELEASE', `Release scheduled for ${new Date(pendingMs).toISOString()}`));
    }
    if (numberState === NUMBER_STATES.OUTSIDE_LIFECYCLE) found.push(anomaly('NUMBER_RETAINED_NO_ENTITLEMENT'));
    if (numberState === NUMBER_STATES.RELEASE_OVERDUE) found.push(anomaly('RELEASE_OVERDUE', `Was due ${new Date(pendingMs).toISOString()}`));
    if (current && hasNumber && !household.voice_client_registered_at) found.push(anomaly('VOICE_SDK_NEVER_REGISTERED'));
    if (current && hasNumber && !household.delivery_verified_at) found.push(anomaly('DELIVERY_NEVER_CONFIRMED'));
  }
  if (household && household.twilio_release_last_error) {
    found.push(anomaly('RECORDED_RELEASE_FAILURE', String(household.twilio_release_last_error).slice(0, 200)));
  }

  for (const q of quarantineRows || []) {
    if (q.released_at) continue;
    if (current || upcoming || ambiguous) {
      found.push(anomaly('QUARANTINED_NUMBER_OF_ENTITLED_HOUSEHOLD', `Quarantined ${q.quarantined_at || 'at unknown time'}; the household is ${current ? 'currently' : upcoming ? 'about to be' : 'possibly'} entitled`));
    }
    const quarantinedMs = parseTimestampMs(q.quarantined_at);
    if (!q.deactivation_confirmed) {
      const age = quarantinedMs === null ? null : nowMs - quarantinedMs;
      if (age !== null && age > GRACE.quarantineEscalateMs) found.push(anomaly('QUARANTINE_AWAITING_CONFIRMATION_LONG', `Quarantined ${q.quarantined_at}${age > GRACE.quarantineCriticalMs ? ' (over 90 days)' : ''}`));
      else found.push(anomaly('QUARANTINE_AWAITING_CONFIRMATION', `Quarantined ${q.quarantined_at || 'at unknown time'} (${q.release_reason || 'reason not recorded'})`));
    } else {
      const basisMs = parseTimestampMs(q.deactivation_confirmed_at) ?? quarantinedMs;
      if (basisMs !== null && nowMs - basisMs > GRACE.quarantineReleaseStuckMs) {
        found.push(anomaly('QUARANTINE_RELEASE_STUCK', `Confirmed ${q.deactivation_confirmed_at || '(time not recorded; quarantined ' + q.quarantined_at + ')'}`));
      }
    }
  }

  return {
    membership,
    currentEntitlement: current,
    upcomingEntitlement: upcoming,
    blocksRelease,
    // Would the backend (047) allow this number to be released right now?
    // Only a number whose scheduled release date has passed and whose
    // household does not block release. Informational: the SQL decides.
    releaseEligibleNow: !blocksRelease && hasNumber && pendingMs !== null && pendingMs <= nowMs,
    numberState,
    anomalies: found,
  };
}

module.exports = {
  GRACE,
  HOUR_MS,
  DAY_MS,
  KNOWN_ENTITLEMENT_STATUSES,
  ANOMALIES,
  NUMBER_STATES,
  parseTimestampMs,
  isCurrentlyEntitled,
  isUpcomingEntitlement,
  blocksNumberRelease,
  hasAmbiguousEntitlement,
  deriveHouseholdLifecycle,
};
