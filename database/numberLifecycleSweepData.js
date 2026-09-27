// Data-access wrappers for the 3 new RPCs migration 052 adds — kept in
// their own small file (not added to database/households.js) to avoid
// touching that already-critical, heavily-depended-on file for a
// Step 2-specific concern. Same conventions as every other file in
// database/: thin wrappers around supabaseAdmin.rpc, no decision logic
// (that lives in services/numberLifecycleSweep.js).

'use strict';

const { supabaseAdmin } = require('../services/supabaseClients');

async function expireLapsedEntitlement(entitlementId) {
  if (!supabaseAdmin) throw new Error('Supabase admin client not configured');
  const { data, error } = await supabaseAdmin.rpc('expire_lapsed_entitlement', {
    p_entitlement_id: entitlementId,
  });
  if (error) throw error;
  return data === true;
}

async function recordEntitlementExpiryWarningSent(entitlementId, householdId) {
  if (!supabaseAdmin) throw new Error('Supabase admin client not configured');
  const { data, error } = await supabaseAdmin.rpc('record_entitlement_expiry_warning_sent', {
    p_entitlement_id: entitlementId,
    p_household_id: householdId,
  });
  if (error) throw error;
  return data === true;
}

// error: pass null for a successful attempt, or the error message/text
// for a failed one. Never throws itself on a downstream failure being
// recorded — that's the whole point (recording a failure must not
// itself fail the caller's error-handling path) — but a genuine RPC
// call failure (e.g. the household doesn't exist) still propagates, so
// the runner can alert on a truly broken evidence-recording path too.
async function recordTwilioReleaseAttempt(householdId, error = null) {
  if (!supabaseAdmin) throw new Error('Supabase admin client not configured');
  const { error: rpcError } = await supabaseAdmin.rpc('record_twilio_release_attempt', {
    p_household_id: householdId,
    p_error: error,
  });
  if (rpcError) throw rpcError;
}

async function getWarnedEntitlementIds() {
  if (!supabaseAdmin) throw new Error('Supabase admin client not configured');
  const { data, error } = await supabaseAdmin.from('entitlement_expiry_warnings_sent').select('entitlement_id');
  if (error) throw error;
  return new Set((data || []).map(r => r.entitlement_id));
}

// --- Data loaders for the sweep's production entry point (Priority 4,
// 2026-09-27) — services/numberLifecycleSweepScheduler.js. Deliberately
// separate from the RPC wrappers above: these are plain reads (no
// SECURITY DEFINER function needed, matching the rest of this codebase's
// convention of only wrapping WRITES in RPCs), and load the exact input
// shapes computeLifecycleSweepActions documents (see
// services/numberLifecycleSweep.js's own JSDoc).

// Deliberately loads EVERY household, not just ones with a twilio_number
// — a household that was granted a complimentary/test entitlement that
// later lapsed WITHOUT ever having a number provisioned still needs its
// stale 'active' entitlement row transitioned to 'expired' by this sweep
// (the expire_lapsed_entitlement action has no hasNumber precondition —
// see numberLifecycleSweep.js). Matches the existing precedent in this
// same file's sibling (getHouseholdByTwilioNumber, database/households.js)
// of loading the full table rather than a narrowed subset.
async function getAllHouseholdsForSweep() {
  if (!supabaseAdmin) throw new Error('Supabase admin client not configured');
  const { data, error } = await supabaseAdmin
    .from('households')
    .select('id, twilio_number, twilio_provisioning_status, twilio_number_pending_release_at');
  if (error) throw error;
  return data || [];
}

// Deliberately loads every entitlement row regardless of status — NOT
// pre-filtered to 'active'/'scheduled' — because computeLifecycleSweepActions'
// own fail-closed ambiguous-status check (services/numberLifecycleSweep.js)
// depends on seeing a genuinely unrecognised status value to catch it; a
// query-side filter would silently hide exactly the rows that check
// exists to find.
async function getEntitlementsGroupedByHousehold() {
  if (!supabaseAdmin) throw new Error('Supabase admin client not configured');
  const { data, error } = await supabaseAdmin
    .from('entitlements')
    .select('id, household_id, status, starts_at, ends_at');
  if (error) throw error;
  const byHousehold = new Map();
  for (const row of data || []) {
    if (!row.household_id) continue;
    const list = byHousehold.get(row.household_id) || [];
    list.push(row);
    byHousehold.set(row.household_id, list);
  }
  return byHousehold;
}

async function getQuarantineRowsForSweep() {
  if (!supabaseAdmin) throw new Error('Supabase admin client not configured');
  const { data, error } = await supabaseAdmin
    .from('twilio_number_quarantine')
    .select('household_id, deactivation_confirmed, released_at, quarantined_at');
  if (error) throw error;
  return data || [];
}

// --- Durable run-evidence writes (migration 054, Priority 4) — plain
// grants, not RPCs (see that migration's own comment for why: this table
// enforces no business rule a plain grant can't already guarantee, and
// has no untrusted caller to guard against). ---

// Returns the new row's id so the caller can complete it later, even if
// the process crashes between the two calls — a started-but-never-
// completed row (completed_at IS NULL) is itself meaningful durable
// evidence, not a bug to hide.
async function recordLifecycleSweepRunStart(startedAt) {
  if (!supabaseAdmin) throw new Error('Supabase admin client not configured');
  const { data, error } = await supabaseAdmin
    .from('number_lifecycle_sweep_runs')
    .insert({ started_at: startedAt.toISOString() })
    .select('id')
    .single();
  if (error) throw error;
  return data.id;
}

async function recordLifecycleSweepRunCompletion(runId, { completedAt, householdsEvaluated, scheduled, expired, warned, alerted, errorCount, fatalError = null }) {
  if (!supabaseAdmin) throw new Error('Supabase admin client not configured');
  const { error } = await supabaseAdmin
    .from('number_lifecycle_sweep_runs')
    .update({
      completed_at: completedAt.toISOString(),
      households_evaluated: householdsEvaluated,
      scheduled_count: scheduled,
      expired_count: expired,
      warned_count: warned,
      alerted_count: alerted,
      error_count: errorCount,
      fatal_error: fatalError,
    })
    .eq('id', runId);
  if (error) throw error;
}

module.exports = {
  expireLapsedEntitlement,
  recordEntitlementExpiryWarningSent,
  recordTwilioReleaseAttempt,
  getWarnedEntitlementIds,
  getAllHouseholdsForSweep,
  getEntitlementsGroupedByHousehold,
  getQuarantineRowsForSweep,
  recordLifecycleSweepRunStart,
  recordLifecycleSweepRunCompletion,
};
