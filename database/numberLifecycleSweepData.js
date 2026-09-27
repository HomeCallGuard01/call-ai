// Data-access wrappers for the 3 new RPCs migration 050 adds — kept in
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

module.exports = {
  expireLapsedEntitlement,
  recordEntitlementExpiryWarningSent,
  recordTwilioReleaseAttempt,
  getWarnedEntitlementIds,
};
