// Daily number-lifecycle reconciliation sweep (2026-09-27, Step 2 of the
// provider-number lifecycle work, built on top of migration 047's
// entitlement guard).
//
// THIS FILE NEVER RELEASES, SCHEDULES, OR ALTERS ANYTHING ITSELF. It is
// a pure decision function: given the current state of every household,
// its entitlements, its quarantine rows, and which expiry warnings have
// already been sent, it computes a list of ACTIONS — plain data, not
// side effects. A separate runner (see numberLifecycleSweepRunner.js)
// executes each action through the exact same protected paths already
// established:
//   - "schedule_release" -> database/households.js's
//     markTwilioNumberPendingRelease -> the 047-guarded SQL function
//     mark_household_twilio_number_pending_release, which re-checks
//     household_blocks_number_release() itself under the row lock. This
//     file's own candidate check is advisory, not authoritative — the
//     047 guard is the ONLY thing that can actually decide a release is
//     safe, and it decides again, independently, at execution time.
//   - "expire_lapsed_entitlement" -> the new, narrow
//     expire_lapsed_entitlement() RPC (migration 050), which re-checks
//     the entitlement's own end date itself before transitioning it.
//   - "send_test_expiry_warning" -> the caller's own SMS/notification
//     path, then record_entitlement_expiry_warning_sent() (idempotent by
//     database constraint, not just this function's own bookkeeping).
//   - "alert_inconsistency" -> the existing sendCriticalAlert mechanism.
//
// This file never calls Twilio, never touches households.twilio_number
// directly, and never bypasses 047 to "clean up" a number it thinks is
// unused — see the module header's own repeated emphasis: ALL releases
// go through the protected lifecycle. A reconciliation query that merely
// *thinks* a number is unused is exactly the kind of shortcut that must
// never exist here.
//
// Fail-closed discipline: any household whose entitlement/provisioning
// state cannot be cleanly classified (missing required fields, an
// unrecognised status value) produces NO release-adjacent action for
// that household and an "ambiguous_state" alert instead — silence or a
// guess is never treated as "safe to release".

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

const KNOWN_ENTITLEMENT_STATUSES = new Set(['scheduled', 'active', 'expired', 'revoked']);

// Mirrors database/billing.js's getActiveEntitlement() exactly — see
// services/adminNumberLifecycleReconciliation.js's identical function
// for why this must never independently drift from the real runtime rule.
function isCurrentlyEntitled(entitlement, nowMs) {
  if (!entitlement || entitlement.status !== 'active') return false;
  const startsMs = parseTimestampMs(entitlement.starts_at);
  if (startsMs === null || startsMs > nowMs) return false;
  const endsMs = parseTimestampMs(entitlement.ends_at);
  return endsMs === null || endsMs > nowMs;
}

// Mirrors migration 047's household_has_upcoming_entitlement() exactly.
function isUpcomingEntitlement(entitlement, nowMs) {
  if (!entitlement) return false;
  const startsMs = parseTimestampMs(entitlement.starts_at);
  const endsMs = parseTimestampMs(entitlement.ends_at);
  if (endsMs !== null && endsMs <= nowMs) return false;
  if (entitlement.status === 'scheduled') return true;
  if (entitlement.status === 'active' && startsMs !== null && startsMs > nowMs) return true;
  return false;
}

// Mirrors migration 047's household_blocks_number_release() exactly —
// the ONE rule this whole file exists to respect, never override.
function blocksNumberRelease(entitlements, nowMs) {
  return entitlements.some(e => isCurrentlyEntitled(e, nowMs) || isUpcomingEntitlement(e, nowMs));
}

const TEST_CLASSIFICATIONS = new Set(['internal_test', 'reviewer', 'qa_automation']);
const PRE_EXPIRY_WARNING_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const QUARANTINE_STUCK_THRESHOLD_MS = 48 * 60 * 60 * 1000;

/**
 * Pure, directly unit-testable — `now` always injected, matching this
 * codebase's established convention. No database, no Twilio, no side
 * effects — returns a plain array of action objects.
 *
 * @param {Array<object>} households - id, twilio_number,
 *   twilio_provisioning_status, twilio_number_pending_release_at
 * @param {Map<string, object[]>} entitlementsByHousehold - household_id -> entitlement rows (each: id, status, starts_at, ends_at)
 * @param {Map<string, string>} classificationByHousehold - household_id -> classification
 * @param {Array<object>} quarantineRows - household_id, deactivation_confirmed, released_at, quarantined_at
 * @param {Set<string>} warnedEntitlementIds - entitlement ids already recorded as warned (entitlement_expiry_warnings_sent)
 * @param {Date} now
 * @returns {Array<object>} actions, each `{ type, ...details }`
 */
function computeLifecycleSweepActions(households, entitlementsByHousehold, classificationByHousehold, quarantineRows, warnedEntitlementIds, now) {
  const nowMs = now.getTime();
  const actions = [];

  const quarantineByHousehold = new Map();
  for (const q of quarantineRows || []) {
    if (!q.household_id) continue;
    const list = quarantineByHousehold.get(q.household_id) || [];
    list.push(q);
    quarantineByHousehold.set(q.household_id, list);
  }

  for (const h of households || []) {
    if (!h || !h.id) continue;

    const entitlementsRaw = (entitlementsByHousehold && entitlementsByHousehold.get(h.id)) || [];

    // Fail-closed: any entitlement row with an unrecognised status, or a
    // household record missing the fields this function needs, makes
    // this household's state AMBIGUOUS — no release-adjacent action is
    // ever proposed for it, only an alert. Guessing "probably fine" is
    // never an option here.
    const hasAmbiguousEntitlement = entitlementsRaw.some(e => !KNOWN_ENTITLEMENT_STATUSES.has(e.status));
    if (hasAmbiguousEntitlement) {
      actions.push({
        type: 'alert_inconsistency',
        householdId: h.id,
        reason: 'ambiguous_entitlement_status',
        detail: `household ${h.id} has an entitlement with an unrecognised status`,
      });
      continue;
    }
    if (typeof h.twilio_provisioning_status !== 'string') {
      actions.push({
        type: 'alert_inconsistency',
        householdId: h.id,
        reason: 'ambiguous_provisioning_state',
        detail: `household ${h.id} has no readable twilio_provisioning_status`,
      });
      continue;
    }

    const blocks = blocksNumberRelease(entitlementsRaw, nowMs);
    const hasNumber = !!h.twilio_number;
    const pendingReleaseAt = h.twilio_number_pending_release_at || null;
    const pendingReleaseMs = parseTimestampMs(pendingReleaseAt);

    // --- date-expired entitlements: propose transitioning status, one
    // action per lapsed row, regardless of what else is true for this
    // household. Purely a hygiene/observability transition — the
    // release decision below is based on dates directly (isCurrentlyEntitled/
    // isUpcomingEntitlement already ignore a stale 'active' status once
    // ends_at has passed), so this never gates or delays a release; it
    // only keeps the entitlements table's own status column honest. ---
    for (const e of entitlementsRaw) {
      if (e.status === 'active') {
        const endsMs = parseTimestampMs(e.ends_at);
        if (endsMs !== null && endsMs <= nowMs) {
          actions.push({ type: 'expire_lapsed_entitlement', householdId: h.id, entitlementId: e.id });
        }
      }
    }

    // --- CRITICAL INVARIANT: a release is only ever proposed when
    // `blocks` is false — this is the one thing that must never be
    // wrong. The actual execution re-checks this independently anyway
    // (047's own guard, at the SQL layer, under the row lock) — this is
    // defence in depth, not the only check. ---
    if (!blocks && hasNumber && pendingReleaseAt === null) {
      actions.push({
        type: 'schedule_release',
        householdId: h.id,
        reason: 'no_current_or_upcoming_entitlement',
      });
    }

    // --- inconsistency: a release is pending despite current/upcoming
    // entitlement. 047's trigger should make this impossible — if it's
    // ever observed, something bypassed the trigger (e.g. a hand-written
    // SQL update, or a future code path that doesn't go through the
    // entitlements table's normal insert/update path). Always alert,
    // never silently self-heal here — self-healing already happens
    // inside release_household_twilio_number's own guard at the moment
    // a release is actually attempted; this sweep's job is to make the
    // anomaly VISIBLE before that moment, not to hide it by quietly
    // fixing it first. ---
    if (blocks && pendingReleaseAt !== null) {
      actions.push({
        type: 'alert_inconsistency',
        householdId: h.id,
        reason: 'pending_release_despite_entitlement',
        detail: `household ${h.id} has a pending release scheduled for ${pendingReleaseAt} despite a current/upcoming entitlement — the 047 trigger should have cancelled this`,
      });
    }

    // --- provisioning failed ---
    if (h.twilio_provisioning_status === 'failed') {
      actions.push({
        type: 'alert_inconsistency',
        householdId: h.id,
        reason: 'provisioning_failed',
        detail: `household ${h.id} has twilio_provisioning_status = 'failed'`,
      });
    }

    // --- stuck release: pending_release_at is in the past (grace period
    // has elapsed) but the number is still present — either the daily
    // release-check runner hasn't run yet (normal, transient) or it's
    // repeatedly failing (worth surfacing once it's been overdue a
    // while, not on the very first day). ---
    if (pendingReleaseMs !== null && pendingReleaseMs <= nowMs && hasNumber) {
      const overdueMs = nowMs - pendingReleaseMs;
      if (overdueMs > 24 * 60 * 60 * 1000) {
        actions.push({
          type: 'alert_inconsistency',
          householdId: h.id,
          reason: 'release_overdue',
          detail: `household ${h.id}'s grace period ended ${Math.round(overdueMs / (60 * 60 * 1000))}h ago but the number is still assigned`,
        });
      }
    }

    // --- 14-day pre-expiry warning for test/reviewer/internal accounts ---
    const classification = (classificationByHousehold && classificationByHousehold.get(h.id)) || null;
    if (classification && TEST_CLASSIFICATIONS.has(classification)) {
      for (const e of entitlementsRaw) {
        if (e.status !== 'active') continue;
        const endsMs = parseTimestampMs(e.ends_at);
        if (endsMs === null) continue; // open-ended — never expires, nothing to warn about
        const msUntilExpiry = endsMs - nowMs;
        if (msUntilExpiry > 0 && msUntilExpiry <= PRE_EXPIRY_WARNING_WINDOW_MS) {
          if (!warnedEntitlementIds || !warnedEntitlementIds.has(e.id)) {
            actions.push({
              type: 'send_test_expiry_warning',
              householdId: h.id,
              entitlementId: e.id,
              classification,
              expiresAt: e.ends_at,
            });
          }
        }
      }
    }

    // --- quarantine: confirmed for deactivation, never released, stuck
    // beyond a reasonable threshold ---
    const quarantineForHousehold = quarantineByHousehold.get(h.id) || [];
    for (const q of quarantineForHousehold) {
      if (q.deactivation_confirmed && !q.released_at) {
        const quarantinedMs = parseTimestampMs(q.quarantined_at);
        if (quarantinedMs !== null && nowMs - quarantinedMs > QUARANTINE_STUCK_THRESHOLD_MS) {
          actions.push({
            type: 'alert_inconsistency',
            householdId: h.id,
            reason: 'quarantine_release_stuck',
            detail: `household ${h.id} has a quarantined number confirmed for deactivation over 48h ago, never released at the provider`,
          });
        }
      }
    }
  }

  return actions;
}

module.exports = {
  computeLifecycleSweepActions,
  isCurrentlyEntitled,
  isUpcomingEntitlement,
  blocksNumberRelease,
  TEST_CLASSIFICATIONS,
  PRE_EXPIRY_WARNING_WINDOW_MS,
  QUARANTINE_STUCK_THRESHOLD_MS,
};
