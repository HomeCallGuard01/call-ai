// financialContainment.js — data access for the financial containment
// ledger (migration 067_financial_containment_authorization_ledger.sql,
// DRAFT; was supabase/provisional/ before integration 2026-10-03). Every write is a SECURITY DEFINER RPC; this
// module never writes a table directly. Every function THROWS on failure —
// services/containment/* decides the fail-closed behaviour. The client is
// injectable so tests never need Supabase.
'use strict';

function resolveClient(client) {
  if (client) return client;
  const { supabaseAdmin } = require('../services/supabaseClients');
  if (!supabaseAdmin) throw new Error('SUPABASE_SERVICE_ROLE_KEY not configured');
  return supabaseAdmin;
}

async function rpc(name, params, client) {
  const { data, error } = await resolveClient(client).rpc(name, params);
  if (error) throw new Error(`${name} failed: ${error.message || error}`);
  if (data === null || data === undefined) throw new Error(`${name} returned no data`);
  return data;
}

const iso = (d) => (d === null || d === undefined ? null : new Date(d).toISOString());

module.exports = {
  authorizeCall: ({ householdId, callSid, isKnown, wantsMonitoring, isEssential, periodStart, periodEnd, now, overrides }, client) =>
    rpc('fc_authorize_call', {
      p_household_id: householdId || null, p_call_sid: callSid, p_is_known: Boolean(isKnown),
      p_wants_monitoring: Boolean(wantsMonitoring), p_is_essential: Boolean(isEssential),
      p_period_start: iso(periodStart), p_period_end: iso(periodEnd), p_now: iso(now), p_overrides: overrides || null,
    }, client),
  settleCall: ({ callSid, durationSeconds = null, monitoredSeconds = null, source, now }, client) =>
    rpc('fc_settle_call', {
      p_call_sid: callSid, p_duration_seconds: durationSeconds, p_monitored_seconds: monitoredSeconds,
      p_source: source || null, p_now: iso(now),
    }, client),
  markMonitoringStarted: ({ callSid }, client) => rpc('fc_mark_monitoring_started', { p_call_sid: callSid }, client),
  renewLease: ({ callSid, now, overrides }, client) =>
    rpc('fc_renew_lease', { p_call_sid: callSid, p_now: iso(now), p_overrides: overrides || null }, client),
  dueLeases: ({ now, limit }, client) => rpc('fc_due_leases', { p_now: iso(now), p_limit: limit || 100 }, client),
  recordTermination: ({ callSid, confirmed, providerStatus, now }, client) =>
    rpc('fc_record_termination', { p_call_sid: callSid, p_confirmed: Boolean(confirmed), p_provider_status: providerStatus || null, p_now: iso(now) }, client),
  noteProviderCheck: ({ callSid, providerStatus, now }, client) =>
    rpc('fc_note_provider_check', { p_call_sid: callSid, p_provider_status: providerStatus || null, p_now: iso(now) }, client),
  adoptDegradedCall: ({ householdId, callSid, startedAt, timeLimitSeconds, periodStart, periodEnd, now }, client) =>
    rpc('fc_adopt_degraded_call', {
      p_household_id: householdId || null, p_call_sid: callSid, p_started_at: iso(startedAt),
      p_time_limit_seconds: timeLimitSeconds, p_period_start: iso(periodStart), p_period_end: iso(periodEnd), p_now: iso(now),
    }, client),
  authorizeSpend: ({ idempotencyKey, householdId, category, units, periodStart, periodEnd, now, overrides }, client) =>
    rpc('fc_authorize_spend', {
      p_idempotency_key: idempotencyKey, p_household_id: householdId || null, p_category: category, p_units: units,
      p_period_start: iso(periodStart), p_period_end: iso(periodEnd), p_now: iso(now), p_overrides: overrides || null,
    }, client),
  recordActual: ({ provider, providerRef, callSid, category, amountGbp, now }, client) =>
    rpc('fc_record_actual', {
      p_provider: provider, p_provider_ref: providerRef, p_call_sid: callSid || null, p_category: category || null,
      p_amount_gbp: amountGbp, p_now: iso(now),
    }, client),
  adminAdjust: ({ householdId, amountGbp, reason, actor, idempotencyKey, source, periodStart, periodEnd, now }, client) =>
    rpc('fc_admin_adjust', {
      p_household_id: householdId, p_amount_gbp: amountGbp, p_reason: reason, p_actor: actor, p_idempotency_key: idempotencyKey,
      p_source: source, p_period_start: iso(periodStart), p_period_end: iso(periodEnd), p_now: iso(now),
    }, client),
  setKillSwitch: ({ on, reason, actor }, client) => rpc('fc_set_kill_switch', { p_on: Boolean(on), p_reason: reason, p_actor: actor }, client),
  // Integration 2026-10-04: per-household financial hold (source admin|financial|fraud; only admin releases).
  setHouseholdHold: ({ householdId, hold, reason, actor, source }, client) =>
    rpc('fc_set_household_hold', { p_household_id: householdId, p_hold: Boolean(hold), p_reason: reason, p_actor: actor, p_source: source }, client),
  householdHold: async ({ householdId }, client) => {
    const { data, error } = await resolveClient(client).from('fc_household_holds').select('source, reason, held_at').eq('household_id', householdId).maybeSingle();
    if (error) throw new Error(`fc_household_holds read failed: ${error.message || error}`);
    return data || null;
  },
  resetBreaker: ({ reason, actor }, client) => rpc('fc_reset_breaker', { p_reason: reason, p_actor: actor }, client),
  refreshEntitledCount: ({ now }, client) => rpc('fc_refresh_entitled_count', { p_now: iso(now) }, client),
  householdStatus: ({ householdId, now }, client) => rpc('fc_household_status', { p_household_id: householdId, p_now: iso(now) }, client),
  globalStatus: ({ now }, client) => rpc('fc_global_status', { p_now: iso(now) }, client),
  checkInvariants: (client) => rpc('fc_check_invariants', {}, client),
  // WS2 2026-10-10 (migration 076, DRAFT): deterministic allowance state and its transition log.
  householdAllowanceState: ({ householdId, now }, client) =>
    rpc('fortress_household_allowance_state', { p_household_id: householdId, p_now: iso(now) }, client),
  recordAllowanceState: ({ householdId, now }, client) =>
    rpc('fortress_record_allowance_state', { p_household_id: householdId, p_now: iso(now) }, client),
};
