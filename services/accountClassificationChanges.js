// Account classification changes from the admin dashboard (2026-09-29).
//
// Classification is a REPORTING label (genuine customer vs test/reviewer/
// other). Changing it must have no effect on entitlement, billing,
// subscriptions, call routing or telephony — so this module imports none
// of those, and its only write is one RPC (migration 055's
// set_account_classification), which writes the classification and its
// append-only audit event in one transaction.
//
// Fail closed: if migration 055 is not applied, changes are REFUSED
// (503) rather than written without an audit record.
'use strict';

// What an admin may choose. 'admin' and 'qa_automation' (migration 031)
// remain valid stored values and display as they are, but are not offered.
const ALLOWED_TARGETS = ['genuine_customer', 'internal_test', 'reviewer', 'other_non_customer'];
const LABELS = {
  genuine_customer: 'Genuine customer',
  internal_test: 'Internal test',
  reviewer: 'Reviewer',
  other_non_customer: 'Other non-customer',
  admin: 'Admin',
  qa_automation: 'QA automation',
  unclassified: 'Unclassified',
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Pure.
function validateClassificationChange({ householdId, classification, note, expectedPrevious }) {
  if (!UUID_RE.test(String(householdId || ''))) return { ok: false, status: 400, reason: 'invalid household id' };
  if (!ALLOWED_TARGETS.includes(classification)) return { ok: false, status: 400, reason: `classification must be one of ${ALLOWED_TARGETS.join(', ')}` };
  const trimmed = typeof note === 'string' ? note.trim() : '';
  if (trimmed.length < 3) return { ok: false, status: 400, reason: 'a reason (at least 3 characters) is required' };
  if (trimmed.length > 500) return { ok: false, status: 400, reason: 'reason is too long (500 characters max)' };
  if (typeof expectedPrevious !== 'string' || !expectedPrevious) return { ok: false, status: 400, reason: 'expectedPrevious is required (the classification you were looking at)' };
  if (expectedPrevious === classification) return { ok: false, status: 400, reason: `already ${classification}` };
  return { ok: true, note: trimmed };
}

function isMissingMigration(error) {
  const text = `${error && error.code} ${error && error.message}`;
  return /42883|42P01|PGRST202|PGRST205|Could not find the function|does not exist/i.test(text);
}

// Pure — RPC error → HTTP result.
function mapRpcError(error) {
  if (isMissingMigration(error)) {
    return { ok: false, status: 503, reason: 'Classification changes are disabled: migration 055 (classification history) is not applied, and no change is made without an audit record.' };
  }
  const message = String((error && error.message) || 'failed');
  if (/stale edit/.test(message)) return { ok: false, status: 409, reason: 'Someone changed this classification since you loaded it. Reload and try again.' };
  if (/already|reason|unknown classification|does not exist/.test(message)) return { ok: false, status: 400, reason: message.replace(/^.*set_account_classification: /, '') };
  return { ok: false, status: 500, reason: 'Classification change failed' };
}

function resolveSupabaseAdmin() {
  try { return require('./supabaseClients').supabaseAdmin; } catch (err) { return null; }
}

async function setAccountClassification(input, { supabaseAdmin = resolveSupabaseAdmin() } = {}) {
  const v = validateClassificationChange(input);
  if (!v.ok) return v;
  if (!supabaseAdmin) return { ok: false, status: 503, reason: 'database not configured' };
  const { data, error } = await supabaseAdmin.rpc('set_account_classification', {
    p_household_id: input.householdId,
    p_classification: input.classification,
    p_note: v.note,
    p_actor_user_id: UUID_RE.test(String(input.actorUserId || '')) ? input.actorUserId : null,
    p_actor_email: input.actorEmail || null,
    p_expected_previous: input.expectedPrevious === 'unclassified' ? null : input.expectedPrevious,
  });
  if (error) return mapRpcError(error);
  return { ok: true, status: 200, result: data };
}

async function getClassificationHistory(householdId, { supabaseAdmin = resolveSupabaseAdmin() } = {}) {
  if (!UUID_RE.test(String(householdId || ''))) return { available: false, status: 400, reason: 'invalid household id' };
  if (!supabaseAdmin) return { available: false, status: 503, reason: 'database not configured' };
  const [cur, hist] = await Promise.all([
    supabaseAdmin.from('account_classifications').select('classification, note, classified_by, updated_at').eq('household_id', householdId).maybeSingle(),
    supabaseAdmin.from('account_classification_events').select('previous_classification, new_classification, note, changed_by_email, source, created_at').eq('household_id', householdId).order('created_at', { ascending: false }).limit(50),
  ]);
  if (cur.error) return { available: false, status: 500, reason: cur.error.message };
  const current = cur.data ? cur.data.classification : 'unclassified';
  if (hist.error) {
    return { available: true, current, currentNote: cur.data ? cur.data.note : null, history: null, writable: false,
      reason: isMissingMigration(hist.error) ? 'History and changes need migration 055 (not applied).' : hist.error.message };
  }
  return { available: true, current, currentNote: cur.data ? cur.data.note : null, history: hist.data || [], writable: true };
}

module.exports = { ALLOWED_TARGETS, LABELS, validateClassificationChange, mapRpcError, setAccountClassification, getClassificationHistory };
