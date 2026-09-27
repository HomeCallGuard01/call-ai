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

module.exports = {
  markLegUnavailable,
  getLeg,
  upsertLeg,
  getEntry,
  upsertEntry,
  listLegsAwaitingReconciliation,
  listEntriesPendingObservation,
  recordLegAttemptFailure,
};
