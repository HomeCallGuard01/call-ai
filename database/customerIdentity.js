// Read/write access to the customer-identity and routing-assignment model
// (supabase/migrations/062_customer_identity_and_routing_assignments.sql).
// Service-role only; every write goes through the migration's RPCs so the
// lifecycle, audit trail and number-ownership guards always apply.
//
// Nothing in the live call path uses this module yet: inbound routing
// still resolves households from households.twilio_number
// (getHouseholdByTwilioNumber). Switching that read path is a separate,
// flagged step — see docs/architecture/CUSTOMER_IDENTITY_AND_CARRIER_ABSTRACTION.md.
//
// Authorisation reminder: an account number identifies, it never
// authorises. These helpers are for admin/support tooling behind
// requireAdmin, and for server-side jobs — never for resolving "who is
// this caller" from a client-supplied value.

'use strict';

const { supabaseAdmin } = require('../services/supabaseClients');
const { parseAccountNumber } = require('../services/customerIdentity/accountNumber');

const ROUTING_COLUMNS =
  'id, household_id, protection_service, provider_code, e164_number, state, is_primary, ' +
  'acquisition, replaces_assignment_id, state_changed_at, created_at';

function client(deps) {
  const db = (deps && deps.supabase) || supabaseAdmin;
  if (!db) throw new Error('Supabase admin client not configured');
  return db;
}

async function getHouseholdByAccountNumber(input, deps) {
  const parsed = parseAccountNumber(input);
  if (!parsed.valid) return null;
  const { data, error } = await client(deps)
    .from('households')
    .select('*')
    .eq('account_number', parsed.canonical)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function getRoutingAssignments(householdId, deps) {
  const { data, error } = await client(deps)
    .from('routing_assignments')
    .select(ROUTING_COLUMNS)
    .eq('household_id', householdId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

async function getRoutingEvents(householdId, deps, { limit = 100 } = {}) {
  const { data, error } = await client(deps)
    .from('routing_assignment_events')
    .select('id, assignment_id, event_type, from_state, to_state, is_primary, actor, reason, occurred_at')
    .eq('household_id', householdId)
    .order('id', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

// Future inbound-routing read path (not wired): the household whose
// ACTIVE assignment answers this number.
async function getHouseholdIdByActiveNumber(e164, deps) {
  const { data, error } = await client(deps)
    .from('routing_assignments')
    .select('household_id')
    .eq('e164_number', e164)
    .eq('state', 'active')
    .maybeSingle();
  if (error) throw error;
  return data ? data.household_id : null;
}

async function rpc(name, params, deps) {
  const { data, error } = await client(deps).rpc(name, params);
  if (error) throw error;
  return data;
}

function createRoutingAssignment(params, deps) {
  return rpc('routing_assignment_create', {
    p_household_id: params.householdId,
    p_provider_code: params.providerCode,
    p_state: params.state,
    p_acquisition: params.acquisition,
    p_actor: params.actor,
    p_reason: params.reason || null,
    p_e164_number: params.e164 || null,
    p_provider_resource_id: params.providerResourceId || null,
    p_replaces_assignment_id: params.replacesAssignmentId || null,
    p_protection_service: params.protectionService || 'primary',
  }, deps);
}

function transitionRoutingAssignment(params, deps) {
  return rpc('routing_assignment_transition', {
    p_assignment_id: params.assignmentId,
    p_expected_state: params.expectedState,
    p_to_state: params.toState,
    p_actor: params.actor,
    p_reason: params.reason || null,
    p_e164_number: params.e164 || null,
    p_provider_resource_id: params.providerResourceId || null,
    p_last_error: params.lastError || null,
  }, deps);
}

function makeRoutingAssignmentPrimary({ assignmentId, actor, reason }, deps) {
  return rpc('routing_assignment_make_primary', {
    p_assignment_id: assignmentId, p_actor: actor, p_reason: reason || null,
  }, deps);
}

function completePort({ assignmentId, actor, reason, providerResourceId }, deps) {
  return rpc('routing_assignment_complete_port', {
    p_assignment_id: assignmentId, p_actor: actor, p_reason: reason || null,
    p_provider_resource_id: providerResourceId || null,
  }, deps);
}

function rollbackReplacement({ assignmentId, actor, reason }, deps) {
  return rpc('routing_assignment_rollback_replacement', {
    p_new_assignment_id: assignmentId, p_actor: actor, p_reason: reason || null,
  }, deps);
}

module.exports = {
  getHouseholdByAccountNumber,
  getRoutingAssignments,
  getRoutingEvents,
  getHouseholdIdByActiveNumber,
  createRoutingAssignment,
  transitionRoutingAssignment,
  makeRoutingAssignmentPrimary,
  completePort,
  rollbackReplacement,
};
