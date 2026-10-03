// Thin wrapper around the financial ledger tables (migration 051:
// public.financial_entries and public.telephony_call_legs), following the
// database/*.js convention. Service-role only. The admin client is
// injectable (deps.admin) so tests never need a real Supabase, and is
// resolved lazily so requiring this module never needs SUPABASE_URL.
//
// Writes are plain upserts on the tables' natural keys; the rules about
// WHETHER to write (never downgrade provenance, never turn "not observed"
// into £0…) live in services/ledger/ledgerWriter.js.
'use strict';

function resolveAdmin(deps) {
  if (deps && deps.admin) return deps.admin;
  const { supabaseAdmin } = require('../services/supabaseClients');
  if (!supabaseAdmin) throw new Error('Supabase admin client not configured');
  return supabaseAdmin;
}

async function getLeg(provider, providerCallId, deps = {}) {
  const { data, error } = await resolveAdmin(deps)
    .from('telephony_call_legs')
    .select('*')
    .eq('provider', provider)
    .eq('provider_call_id', providerCallId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function upsertLeg(leg, deps = {}) {
  const { data, error } = await resolveAdmin(deps)
    .from('telephony_call_legs')
    .upsert({ ...leg, updated_at: new Date().toISOString() }, { onConflict: 'provider,provider_call_id' })
    .select('id')
    .single();
  if (error) throw error;
  return data;
}

async function getEntry(sourceSystem, entryKey, deps = {}) {
  const { data, error } = await resolveAdmin(deps)
    .from('financial_entries')
    .select('*')
    .eq('source_system', sourceSystem)
    .eq('entry_key', entryKey)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function upsertEntry(entry, deps = {}) {
  const { data, error } = await resolveAdmin(deps)
    .from('financial_entries')
    .upsert({ ...entry, updated_at: new Date().toISOString() }, { onConflict: 'source_system,entry_key' })
    .select('id')
    .single();
  if (error) throw error;
  return data;
}

// Legs/entries still waiting on a provider outcome, oldest first — the
// reconciliation worker's queue.
async function listLegsAwaitingReconciliation({ provider, olderThan, limit = 100 }, deps = {}) {
  const { data, error } = await resolveAdmin(deps)
    .from('telephony_call_legs')
    .select('id, provider, provider_call_id, provider_parent_call_id, call_id, household_id, household_match, attempts')
    .eq('provider', provider)
    .in('reconciliation_status', ['pending', 'provisional', 'error'])
    .lt('updated_at', olderThan)
    .order('updated_at', { ascending: true })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

async function listEntriesPendingObservation({ sourceSystem, limit = 100 }, deps = {}) {
  const { data, error } = await resolveAdmin(deps)
    .from('financial_entries')
    .select('id, source_system, entry_key, native_reference, telephony_leg_id')
    .eq('source_system', sourceSystem)
    .in('charge_observation', ['pending', 'unavailable'])
    .order('updated_at', { ascending: true })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

async function recordLegAttemptFailure(legId, message, deps = {}) {
  const admin = resolveAdmin(deps);
  const { data: current, error: readError } = await admin.from('telephony_call_legs').select('attempts').eq('id', legId).maybeSingle();
  if (readError) throw readError;
  const { error } = await admin
    .from('telephony_call_legs')
    .update({ attempts: ((current && current.attempts) || 0) + 1, last_error: String(message).slice(0, 500), updated_at: new Date().toISOString() })
    .eq('id', legId);
  if (error) throw error;
}

// After repeated failures the provider outcome is recorded as unavailable
// (never as a zero); a later successful fetch can still update it.
async function markLegUnavailable(legId, deps = {}) {
  const { error } = await resolveAdmin(deps)
    .from('telephony_call_legs')
    .update({ reconciliation_status: 'unavailable', updated_at: new Date().toISOString() })
    .eq('id', legId);
  if (error) throw error;
}

// Everything services/finance/spendMonitor.js needs, read-only: ledger cost
// entries and legs since `since`, the HCG calls they link to (for trusted
// vs unknown), the entitled-household count and the newest ledger write.
// Paged, so a busy month is never silently truncated.
async function loadSpendMonitorData({ since, pageSize = 1000 }, deps = {}) {
  const admin = resolveAdmin(deps);
  const page = async (build) => {
    const rows = [];
    for (let from = 0; ; from += pageSize) {
      const { data, error } = await build().range(from, from + pageSize - 1);
      if (error) throw error;
      rows.push(...(data || []));
      if (!data || data.length < pageSize) return rows;
    }
  };
  const [entries, legs, calls, entitlements, newest] = await Promise.all([
    page(() => admin.from('financial_entries')
      .select('household_id, call_id, category, entry_class, provenance, charge_observation, native_amount, native_currency, occurred_at, period_start, evidence')
      .in('entry_class', ['cost', 'fee'])
      .or(`occurred_at.gte.${since},period_start.gte.${since}`)
      .order('id')),
    page(() => admin.from('telephony_call_legs')
      .select('call_id, household_id, leg_type, provider_duration_seconds, billed_quantity, billed_unit, started_at, ended_at')
      .gte('started_at', since)
      .order('id')),
    page(() => admin.from('calls')
      .select('id, household_id, status, monitored_duration_seconds')
      .gte('created_at', since)
      .order('id')),
    page(() => admin.from('entitlements').select('household_id').eq('status', 'active').order('household_id')),
    admin.from('financial_entries').select('updated_at').order('updated_at', { ascending: false }).limit(1),
  ]);
  if (newest.error) throw newest.error;
  // Real-time safety counters (migration 056), for the estimate-vs-ledger
  // check. Optional: absent before 056 is applied (null = not compared).
  let realtimeDailyGbp = null;
  const hours = await admin.from('platform_usage_hours')
    .select('hour_start, monitoring_cost_gbp, telephony_cost_gbp, sms_cost_gbp')
    .gte('hour_start', since);
  if (!hours.error) {
    realtimeDailyGbp = {};
    for (const h of hours.data || []) {
      const day = new Date(h.hour_start).toISOString().slice(0, 10);
      realtimeDailyGbp[day] = (realtimeDailyGbp[day] || 0) + Number(h.monitoring_cost_gbp) + Number(h.telephony_cost_gbp) + Number(h.sms_cost_gbp);
    }
  }
  return {
    realtimeDailyGbp,
    entries,
    legs,
    calls,
    entitledHouseholds: new Set(entitlements.map((e) => e.household_id)).size,
    lastIngestedAt: newest.data && newest.data[0] ? newest.data[0].updated_at : null,
  };
}

module.exports = {
  loadSpendMonitorData,
  markLegUnavailable,
  getLeg,
  upsertLeg,
  getEntry,
  upsertEntry,
  listLegsAwaitingReconciliation,
  listEntriesPendingObservation,
  recordLegAttemptFailure,
};
