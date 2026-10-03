// Dry-run planner for moving customers' routing to another provider.
//
// Pure: takes a snapshot of households + routing_assignments rows and
// returns, per customer, what a migration would have to do and where it
// currently stands. It never reads a database, never calls a provider and
// never writes anything — scripts/provider-migration-dry-run.js feeds it a
// JSON file.
//
// Strategy (docs/architecture/CUSTOMER_IDENTITY_AND_CARRIER_ABSTRACTION.md):
//   preferred — port the existing HCG number to the target provider, so
//               the customer's forwarding keeps working untouched;
//   fallback  — assign a new routing number at the target provider; the
//               customer must update their forwarding to it.
// Either way the HCG account number, subscription, trusted contacts and
// allowance stay exactly where they are: on the household.

'use strict';

const { selectPrimaryAssignment, isTerminal } = require('./routingLifecycle');

const STRATEGIES = Object.freeze(['port_preferred', 'replace_only']);

function maskE164(e164) {
  if (!e164 || typeof e164 !== 'string') return null;
  if (e164.length <= 6) return '*'.repeat(e164.length);
  return `${e164.slice(0, 3)}${'*'.repeat(e164.length - 6)}${e164.slice(-3)}`;
}

function forwardingInstruction(deviceType) {
  if (deviceType === 'mobile') return 'customer_reenters_mobile_forwarding_codes_for_new_number';
  if (deviceType === 'landline') return 'landline_forwarding_must_be_changed_to_new_number';
  return 'customer_forwarding_must_be_updated_device_type_unknown';
}

function isAfter(a, b) {
  const ta = Date.parse(a || '');
  const tb = Date.parse(b || '');
  return Number.isFinite(ta) && Number.isFinite(tb) && ta > tb;
}

// The migration currently in flight from `source`: its newest live
// successor, else its newest failed port (so the planner can fall back to
// a replacement). Released/failed replacements are history, not in flight.
function findSuccessor(assignments, source) {
  const successors = assignments
    .filter(a => a.replaces_assignment_id === source.id)
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  return successors.find(a => !isTerminal(a.state))
    || successors.find(a => a.acquisition === 'ported_in' && a.state === 'failed')
    || null;
}

function planHousehold(household, assignments, options) {
  const { targetProvider, strategy, portability, targetCapabilities, showNumbers } = options;
  const notes = [];
  const shown = n => (showNumbers ? n || null : maskE164(n));

  const row = {
    householdId: household.id,
    accountNumber: household.account_number || null,
    customerStatus: household.status || null,
    currentProvider: null,
    currentNumber: null,
    targetProvider,
    plan: null,
    portState: 'not_applicable',
    replacementState: 'not_applicable',
    forwardingAction: 'none',
    verificationStatus: 'not_applicable',
    rollbackState: 'not_applicable',
    notes,
  };

  if (!row.accountNumber) notes.push('missing_account_number');
  if (household.status && household.status !== 'active') notes.push(`customer_status_${household.status}`);

  const activePrimaries = assignments.filter(a => a.state === 'active' && a.is_primary);
  if (activePrimaries.length > 1) notes.push('multiple_active_primaries');

  // Find where the household's line currently is. A finished migration's
  // source is released, so walk back from the primary to see whether it
  // was itself a port/replacement.
  const primary = selectPrimaryAssignment(assignments);
  if (!primary) {
    row.plan = 'no_active_routing';
    const pending = assignments.find(a => !isTerminal(a.state));
    if (pending) notes.push(`non_active_assignment_${pending.state}`);
    return row;
  }

  row.currentProvider = primary.provider_code;
  row.currentNumber = shown(primary.e164_number);

  const predecessor = primary.replaces_assignment_id
    ? assignments.find(a => a.id === primary.replaces_assignment_id)
    : null;

  // In-flight or finished migration started from the current primary.
  const successor = findSuccessor(assignments, primary);

  if (successor) {
    return describeInFlight(row, household, successor, shown);
  }

  // Cut over to a replacement, previous number still active (overlap).
  if (predecessor && !isTerminal(predecessor.state) && primary.acquisition === 'purchased') {
    return describeInFlight(row, household, primary, shown);
  }

  if (primary.provider_code === targetProvider) {
    if (predecessor && predecessor.provider_code !== targetProvider) {
      return describeCompletedOnTarget(row, household, primary, predecessor);
    }
    row.plan = 'already_on_target';
    return row;
  }

  const portable = portability[primary.e164_number] || 'unknown';
  const canPort = strategy === 'port_preferred' && targetCapabilities.portIn === true && portable === 'portable';

  if (canPort) {
    row.plan = 'port_number';
    row.portState = 'not_started';
    row.forwardingAction = 'none_number_unchanged';
    row.verificationStatus = 'not_started';
    row.rollbackState = 'not_started';
    return row;
  }

  if (strategy === 'port_preferred') {
    if (targetCapabilities.portIn !== true) notes.push('target_port_in_capability_unverified');
    if (portable === 'unknown') notes.push('number_portability_unknown');
    if (portable === 'not_portable') notes.push('number_not_portable');
  }

  row.plan = 'replace_number';
  row.replacementState = 'not_started';
  row.forwardingAction = forwardingInstruction(household.device_type);
  row.verificationStatus = 'not_started';
  row.rollbackState = 'not_started';
  return row;
}

function describeInFlight(row, household, successor, shown) {
  const isPort = successor.acquisition === 'ported_in';
  row.notes.push(`target_number_${shown(successor.e164_number) || 'not_yet_assigned'}`);

  if (isPort) {
    row.plan = 'port_number';
    row.forwardingAction = 'none_number_unchanged';
    if (successor.state === 'failed') {
      row.portState = 'port_failed';
      row.verificationStatus = 'not_applicable';
      row.rollbackState = 'not_needed_source_still_active';
      row.plan = 'replace_number_after_port_failure';
      row.replacementState = 'not_started';
      row.forwardingAction = forwardingInstruction(household.device_type);
    } else {
      row.portState = successor.state; // requested | port_pending
      row.verificationStatus = 'awaiting_port_completion';
      row.rollbackState = 'available_cancel_port_source_still_active';
    }
    return row;
  }

  row.plan = 'replace_number';
  row.forwardingAction = forwardingInstruction(household.device_type);
  row.replacementState = successor.state;

  if (successor.state === 'failed') {
    row.verificationStatus = 'not_applicable';
    row.rollbackState = 'not_needed_source_still_active';
  } else if (successor.state === 'active') {
    const verified = isAfter(household.activation_verified_at, successor.state_changed_at || successor.created_at);
    row.verificationStatus = verified ? 'verified_on_new_number' : 'awaiting_forwarding_verification';
    row.rollbackState = 'available_previous_number_still_active';
    if (!successor.is_primary) row.notes.push('next_make_new_number_primary_after_verification');
    else if (verified) row.notes.push('next_release_previous_number_via_quarantine');
  } else if (['releasing', 'quarantined'].includes(successor.state)) {
    row.verificationStatus = 'not_applicable';
    row.rollbackState = 'rolled_back';
  } else {
    row.verificationStatus = 'awaiting_forwarding_verification';
    row.rollbackState = 'available_previous_number_still_active';
  }
  return row;
}

function describeCompletedOnTarget(row, household, primary, predecessor) {
  const isPort = primary.acquisition === 'ported_in';
  row.plan = isPort ? 'port_completed' : 'replacement_completed';
  row.portState = isPort ? 'completed' : 'not_applicable';
  row.replacementState = isPort ? 'not_applicable' : 'completed';
  row.forwardingAction = isPort ? 'none_number_unchanged' : 'done';
  row.verificationStatus = isAfter(household.activation_verified_at, primary.state_changed_at || primary.created_at)
    ? 'verified_on_new_number'
    : 'awaiting_forwarding_verification';
  row.rollbackState = isTerminal(predecessor.state) ? 'window_closed_previous_number_released' : 'available_previous_number_still_active';
  return row;
}

function planProviderMigration(snapshot, options = {}) {
  const targetProvider = options.targetProvider;
  if (!targetProvider || typeof targetProvider !== 'string') throw new Error('targetProvider is required');
  const strategy = options.strategy || 'port_preferred';
  if (!STRATEGIES.includes(strategy)) throw new Error(`strategy must be one of ${STRATEGIES.join(', ')}`);

  const resolved = {
    targetProvider,
    strategy,
    portability: options.portability || {},
    targetCapabilities: options.targetCapabilities || { portIn: null },
    showNumbers: options.showNumbers === true,
  };

  const households = (snapshot && snapshot.households) || [];
  const assignments = (snapshot && snapshot.assignments) || [];
  const byHousehold = new Map();
  for (const a of assignments) {
    if (!a.household_id) continue;
    if (!byHousehold.has(a.household_id)) byHousehold.set(a.household_id, []);
    byHousehold.get(a.household_id).push(a);
  }

  const rows = households
    .map(h => planHousehold(h, byHousehold.get(h.id) || [], resolved))
    .sort((a, b) => String(a.accountNumber || '').localeCompare(String(b.accountNumber || '')));

  // Same live number held by two households would be a data fault that
  // makes any migration unsafe — surfaced, never silently planned around.
  const holders = new Map();
  for (const a of assignments) {
    if (!a.e164_number || isTerminal(a.state) || !a.household_id) continue;
    const set = holders.get(a.e164_number) || new Set();
    set.add(a.household_id);
    holders.set(a.e164_number, set);
  }
  const conflicts = [...holders.values()].filter(s => s.size > 1).length;

  const count = key => rows.reduce((acc, r) => ({ ...acc, [r[key]]: (acc[r[key]] || 0) + 1 }), {});
  return {
    dryRun: true,
    targetProvider,
    strategy,
    rows,
    summary: {
      customers: rows.length,
      byPlan: count('plan'),
      byForwardingAction: count('forwardingAction'),
      customersNeedingForwardingChange: rows.filter(r => !['none', 'none_number_unchanged', 'done'].includes(r.forwardingAction)).length,
      numbersHeldByMultipleHouseholds: conflicts,
    },
  };
}

module.exports = { planProviderMigration, maskE164, STRATEGIES };
