// financialSafety.js — data access for migration 056 (monitored-minute
// entitlement + call admission + safety counters). Every counter WRITE goes
// through a SECURITY DEFINER RPC (idempotent per CallSid, duplicate-safe);
// this module only reads tables directly, plus the insert-only audit log.
// Every function THROWS on failure — the caller decides the fail-safe
// behaviour (services/usage/*), never this layer. The client is injectable
// so tests never need Supabase.
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
  return data;
}

const iso = (d) => new Date(d).toISOString();

function admitCall({ householdId, callSid, callerKey, isKnown, isLoop, periodStart, periodEnd, now, limits }, client) {
  return rpc('admit_call', {
    p_household_id: householdId, p_call_sid: callSid, p_caller_key: callerKey || null,
    p_is_known: Boolean(isKnown), p_is_loop: Boolean(isLoop),
    p_period_start: iso(periodStart), p_period_end: iso(periodEnd), p_now: iso(now), p_limits: limits,
  }, client);
}

function endCall({ callSid, endedAt, source }, client) {
  return rpc('end_call', { p_call_sid: callSid, p_ended_at: iso(endedAt), p_source: source || null }, client);
}

function beginMonitoringSession({ householdId, callSid, periodStart, periodEnd, now, allowanceSeconds, enforceAllowance, limits }, client) {
  return rpc('begin_monitoring_session', {
    p_household_id: householdId, p_call_sid: callSid, p_period_start: iso(periodStart), p_period_end: iso(periodEnd),
    p_now: iso(now), p_allowance_seconds: allowanceSeconds, p_enforce_allowance: Boolean(enforceAllowance), p_limits: limits,
  }, client);
}

function attachMonitoringStream({ callSid, streamSid }, client) {
  return rpc('attach_monitoring_stream', { p_call_sid: callSid, p_stream_sid: streamSid }, client);
}

function recordMonitoringProgress({ callSid, streamSid, totalSeconds, costPerSecondGbp, now, final, endReason }, client) {
  return rpc('record_monitoring_progress', {
    p_call_sid: callSid, p_stream_sid: streamSid, p_total_seconds: totalSeconds, p_cost_per_second_gbp: costPerSecondGbp,
    p_now: iso(now), p_final: Boolean(final), p_end_reason: endReason || null,
  }, client);
}

function claimUsageNotification({ householdId, periodStart, kind }, client) {
  return rpc('claim_usage_notification', { p_household_id: householdId, p_period_start: iso(periodStart), p_kind: kind }, client);
}

function claimSmsSend({ householdId, periodStart, periodEnd, now, costGbp, limits }, client) {
  return rpc('claim_sms_send', {
    p_household_id: householdId, p_period_start: iso(periodStart), p_period_end: iso(periodEnd),
    p_now: iso(now), p_cost_gbp: costGbp, p_limits: limits,
  }, client);
}

async function getUsagePeriod({ householdId, periodStart }, client) {
  const { data, error } = await resolveClient(client)
    .from('household_usage_periods')
    .select('household_id, period_start, period_end, monitored_seconds, bonus_monitored_seconds, monitoring_cost_gbp, telephony_minutes, telephony_cost_gbp, sms_count, sms_cost_gbp')
    .eq('household_id', householdId)
    .eq('period_start', iso(periodStart))
    .maybeSingle();
  if (error) throw new Error(`getUsagePeriod failed: ${error.message || error}`);
  return data;
}

async function getHouseholdDayUsage({ householdId, day }, client) {
  const { data, error } = await resolveClient(client)
    .from('household_usage_days')
    .select('monitored_seconds, monitoring_cost_gbp, telephony_minutes, telephony_cost_gbp, sms_count, sms_cost_gbp')
    .eq('household_id', householdId)
    .eq('day', day)
    .maybeSingle();
  if (error) throw new Error(`getHouseholdDayUsage failed: ${error.message || error}`);
  return data;
}

async function getClaimedNotifications({ householdId, periodStart }, client) {
  const { data, error } = await resolveClient(client)
    .from('usage_notifications')
    .select('kind, claimed_at')
    .eq('household_id', householdId)
    .eq('period_start', iso(periodStart));
  if (error) throw new Error(`getClaimedNotifications failed: ${error.message || error}`);
  return data || [];
}

async function getSafetyState(client) {
  const { data, error } = await resolveClient(client)
    .from('financial_safety_state')
    .select('monitoring_suspended, telephony_suspended, reason, updated_at')
    .eq('id', 1)
    .maybeSingle();
  if (error) throw new Error(`getSafetyState failed: ${error.message || error}`);
  return data;
}

async function listPlatformHoursSince(since, client) {
  const { data, error } = await resolveClient(client)
    .from('platform_usage_hours')
    .select('*')
    .gte('hour_start', iso(since))
    .order('hour_start', { ascending: true });
  if (error) throw new Error(`listPlatformHoursSince failed: ${error.message || error}`);
  return data || [];
}

async function countActiveEntitledHouseholds(client) {
  const { data, error } = await resolveClient(client).from('entitlements').select('household_id').eq('status', 'active');
  if (error) throw new Error(`countActiveEntitledHouseholds failed: ${error.message || error}`);
  return new Set((data || []).map((r) => r.household_id)).size;
}

async function recordSafetyEvent(event, client) {
  const { error } = await resolveClient(client).from('financial_safety_events').insert({
    household_id: event.householdId || null,
    call_sid: event.callSid || null,
    stream_sid: event.streamSid || null,
    level: event.level,
    rule: event.rule,
    action: event.action,
    usage_seconds_before: Number.isFinite(event.usageSecondsBefore) ? event.usageSecondsBefore : null,
    estimated_cost_before_gbp: Number.isFinite(event.estimatedCostBeforeGbp) ? event.estimatedCostBeforeGbp : null,
    notification: event.notification || null,
    details: event.details || null,
  });
  if (error) throw new Error(`recordSafetyEvent failed: ${error.message || error}`);
}

module.exports = {
  admitCall,
  endCall,
  beginMonitoringSession,
  attachMonitoringStream,
  recordMonitoringProgress,
  claimUsageNotification,
  claimSmsSend,
  getUsagePeriod,
  getHouseholdDayUsage,
  getClaimedNotifications,
  getSafetyState,
  listPlatformHoursSince,
  countActiveEntitledHouseholds,
  recordSafetyEvent,
};
