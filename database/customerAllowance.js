// customerAllowance.js — data access for migration 063 (allowance credits
// and warning delivery). Allowance changes go ONLY through the
// credit_allowance RPC (idempotent, audited, same lock as Fortress's
// monitoring admission). Every function THROWS on failure; the caller
// decides the fail-safe. The client is injectable so tests need no
// Supabase.
'use strict';

function resolveClient(client) {
  if (client) return client;
  const { supabaseAdmin } = require('../services/supabaseClients');
  if (!supabaseAdmin) throw new Error('SUPABASE_SERVICE_ROLE_KEY not configured');
  return supabaseAdmin;
}

const iso = (d) => new Date(d).toISOString();

async function creditAllowance(args, client) {
  const { data, error } = await resolveClient(client).rpc('credit_allowance', {
    p_household_id: args.householdId,
    p_period_start: iso(args.periodStart),
    p_period_end: iso(args.periodEnd),
    p_kind: args.kind,
    p_seconds: args.seconds,
    p_source: args.source,
    p_environment: args.environment,
    p_provider_transaction_id: args.transactionId,
    p_provider_event_id: args.eventId || null,
    p_product_code: args.productCode || null,
    p_amount_minor: Number.isInteger(args.amountMinor) ? args.amountMinor : null,
    p_currency: args.currency || null,
    p_actor: args.actor || null,
    p_reason: args.reason || null,
    p_allow_non_production: Boolean(args.allowNonProduction),
    // Integration 2026-10-03 (migration 068): the £ capacity credited to the
    // Financial Fortress budget in the same transaction. Ignored for reversals
    // (the SQL reverses exactly what the original credited).
    p_budget_gbp: Number.isFinite(args.budgetGbp) ? args.budgetGbp : 0,
  });
  if (error) throw new Error(`credit_allowance failed: ${error.message || error}`);
  return data;
}

async function findTopUpCredit({ source, transactionId }, client) {
  const { data, error } = await resolveClient(client)
    .from('allowance_credits')
    .select('id, household_id, period_start, period_end, product_code, applied_seconds')
    .eq('source', source)
    .eq('provider_transaction_id', transactionId)
    .eq('kind', 'topup')
    .maybeSingle();
  if (error) throw new Error(`findTopUpCredit failed: ${error.message || error}`);
  return data;
}

async function listAllowanceCredits({ householdId, periodStart }, client) {
  const { data, error } = await resolveClient(client)
    .from('allowance_credits')
    .select('kind, applied_seconds, created_at')
    .eq('household_id', householdId)
    .eq('period_start', iso(periodStart));
  if (error) throw new Error(`listAllowanceCredits failed: ${error.message || error}`);
  return data || [];
}

// Live monitored calls (056 monitoring_sessions not ended, heartbeat fresh).
async function countLiveMonitoringSessions({ householdId, now = new Date(), staleAfterSeconds = 90 }, client) {
  const since = new Date(new Date(now).getTime() - staleAfterSeconds * 1000).toISOString();
  const { count, error } = await resolveClient(client)
    .from('monitoring_sessions')
    .select('call_sid', { count: 'exact', head: true })
    .eq('household_id', householdId)
    .neq('status', 'ended')
    .gt('last_heartbeat_at', since);
  if (error) throw new Error(`countLiveMonitoringSessions failed: ${error.message || error}`);
  return count || 0;
}

async function enqueueNoticeDeliveries(rows, client) {
  if (!rows.length) return;
  const { error } = await resolveClient(client)
    .from('allowance_notice_deliveries')
    .upsert(rows.map((r) => ({ household_id: r.householdId, period_start: iso(r.periodStart), kind: r.kind, channel: r.channel })),
      { onConflict: 'household_id,period_start,kind,channel', ignoreDuplicates: true });
  if (error) throw new Error(`enqueueNoticeDeliveries failed: ${error.message || error}`);
}

async function claimNoticeBatch({ now = new Date(), limit = 25, leaseSeconds = 120 }, client) {
  const { data, error } = await resolveClient(client).rpc('claim_allowance_notice_batch', {
    p_now: iso(now), p_limit: limit, p_lease_seconds: leaseSeconds,
  });
  if (error) throw new Error(`claim_allowance_notice_batch failed: ${error.message || error}`);
  return data || [];
}

async function completeNoticeDelivery({ householdId, periodStart, kind, channel, status, nextAttemptAt = null, error: lastError = null }, client) {
  const patch = { status, lease_until: null, last_error: lastError ? String(lastError).slice(0, 500) : null };
  if (status === 'sent') patch.sent_at = new Date().toISOString();
  if (nextAttemptAt) patch.next_attempt_at = iso(nextAttemptAt);
  const { error } = await resolveClient(client)
    .from('allowance_notice_deliveries')
    .update(patch)
    .eq('household_id', householdId)
    .eq('period_start', iso(periodStart))
    .eq('kind', kind)
    .eq('channel', channel);
  if (error) throw new Error(`completeNoticeDelivery failed: ${error.message || error}`);
}

module.exports = {
  creditAllowance,
  findTopUpCredit,
  listAllowanceCredits,
  countLiveMonitoringSessions,
  enqueueNoticeDeliveries,
  claimNoticeBatch,
  completeNoticeDelivery,
};

// Higher tier (063 workstream): set plan_code on the household's ACTIVE
// entitlement row only. Fortress reads entitlements.plan_code (056) for the
// allowance; nothing else changes. Returns whether a row changed.
// Scoped to the entitlement SOURCE that sent the event, so a Stripe event
// can never change an Apple/complimentary row's plan, or vice versa.
async function setActiveEntitlementPlanCode({ householdId, planCode, source }, client) {
  if (!source) throw new Error('setActiveEntitlementPlanCode: source is required');
  const { data, error } = await resolveClient(client)
    .from('entitlements')
    .update({ plan_code: planCode })
    .eq('household_id', householdId)
    .eq('status', 'active')
    .eq('source', source)
    .neq('plan_code', planCode)
    .select('id');
  if (error) throw new Error(`setActiveEntitlementPlanCode failed: ${error.message || error}`);
  return (data || []).length > 0;
}

module.exports.setActiveEntitlementPlanCode = setActiveEntitlementPlanCode;

// Financial Fortress £-budget status (fc_household_status on
// security/financial-containment-p0 — PROVISIONAL, not merged). Only called
// when ALLOWANCE_SOURCE=fortress; until that RPC exists it simply errors and
// the read model reports 'unavailable'.
async function getFortressHouseholdStatus({ householdId, now = new Date() }, client) {
  const { data, error } = await resolveClient(client).rpc('fc_household_status', { p_household_id: householdId, p_now: iso(now) });
  if (error) throw new Error(`fc_household_status failed: ${error.message || error}`);
  return data;
}

module.exports.getFortressHouseholdStatus = getFortressHouseholdStatus;
