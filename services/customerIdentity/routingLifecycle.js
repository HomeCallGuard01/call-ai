// Routing-assignment lifecycle — the JS mirror of the state machine
// enforced in the database by routing_assignment_transition_allowed and
// routing_assignments_guard (migration 062). Parity between the two is
// tested in tests/customer-identity.pglite.test.mjs, so this table cannot
// drift from the database's.
//
// Pure functions only: nothing here reads or writes the database or
// talks to a provider.

'use strict';

const STATES = Object.freeze([
  'requested',
  'provisioning',
  'active',
  'port_pending',
  'replacement_pending',
  'releasing',
  'released',
  'failed',
  'quarantined',
]);

const TERMINAL_STATES = Object.freeze(['released', 'failed']);

// States in which HCG still holds the number for that household (it can
// not be given to anyone else).
const HELD_STATES = Object.freeze(STATES.filter(s => !TERMINAL_STATES.includes(s) && s !== 'requested'));

const TRANSITIONS = Object.freeze({
  requested: ['provisioning', 'port_pending', 'failed'],
  provisioning: ['active', 'replacement_pending', 'failed'],
  port_pending: ['active', 'failed'],
  replacement_pending: ['active', 'releasing', 'failed'],
  active: ['releasing', 'quarantined'],
  quarantined: ['active', 'releasing', 'released'],
  releasing: ['active', 'quarantined', 'released'],
  released: [],
  failed: [],
});

// active -> released happens only when a port completes (the number now
// lives at another provider); every other release goes through
// releasing/quarantined first.
function canTransition(from, to, { viaPortCompletion = false } = {}) {
  if (from === 'active' && to === 'released') return viaPortCompletion === true;
  return (TRANSITIONS[from] || []).includes(to);
}

function isTerminal(state) {
  return TERMINAL_STATES.includes(state);
}

// The one assignment that should answer calls for a household's protected
// line: the active primary, else the newest active one (legacy rows
// created before primaries existed). null when nothing is active.
function selectPrimaryAssignment(assignments, { protectionService = 'primary' } = {}) {
  const active = (assignments || []).filter(
    a => a.state === 'active' && (a.protection_service || 'primary') === protectionService
  );
  return active.find(a => a.is_primary) || newestFirst(active)[0] || null;
}

// Which household an inbound call to `e164` belongs to, from assignment
// rows alone. Only an active assignment routes; a number that is
// releasing, quarantined or released is not anyone's anymore for routing
// purposes, even though its history is kept.
function resolveInboundHouseholdId(assignments, e164) {
  if (!e164) return null;
  const match = (assignments || []).find(a => a.state === 'active' && a.e164_number === e164);
  return match ? match.household_id : null;
}

function newestFirst(rows) {
  return [...rows].sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
}

// Customer/admin-safe history: no provider resource ids or metadata.
function summariseRoutingHistory(assignments) {
  return newestFirst(assignments || []).map(a => ({
    provider: a.provider_code,
    number: a.e164_number || null,
    state: a.state,
    primary: !!a.is_primary,
    acquisition: a.acquisition,
    since: a.state_changed_at || a.created_at || null,
  }));
}

module.exports = {
  STATES,
  TERMINAL_STATES,
  HELD_STATES,
  TRANSITIONS,
  canTransition,
  isTerminal,
  selectPrimaryAssignment,
  resolveInboundHouseholdId,
  summariseRoutingHistory,
};
