// Read-only loader for the customer lifecycle view and the operational
// exception queue (customer lifecycle automation, 2026-10-04). Builds the
// per-household snapshots services/lifecycle/activationState.js expects.
//
// Reads only; never writes. Every optional source tolerates a database
// where its migration is not applied yet:
//   - fc_household_holds (067)     absent ⇒ financialHold undefined ("not
//                                  deployed", reported as hold_not_checked);
//                                  present but unreadable ⇒ { unreadable } ⇒
//                                  the household is AMBIGUOUS (fail closed);
//   - routing_assignments (062)    absent ⇒ assignment time unknown (stale
//                                  evidence cannot be detected, and says so).
// Required sources (households, entitlements, quarantine) failing ⇒ the
// whole load fails; a partial queue would look like "nothing wrong".
'use strict';

const { selectAll } = require('../services/businessControl/selectAll');

function isMissingRelation(error) {
  const text = `${(error && error.code) || ''} ${(error && error.message) || ''}`;
  return /42P01|PGRST205|PGRST204|42703|does not exist|Could not find the table/i.test(text);
}

function groupBy(rows, key) {
  const out = new Map();
  for (const r of rows || []) {
    const k = r[key];
    if (k === null || k === undefined) continue;
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(r);
  }
  return out;
}

async function optional(build) {
  const res = await selectAll(build);
  if (!res.error) return { rows: res.data, state: 'ok', truncated: res.truncated };
  return { rows: [], state: isMissingRelation(res.error) ? 'absent' : 'unreadable', truncated: false };
}

async function required(build, label) {
  const res = await selectAll(build);
  if (res.error) throw new Error(`lifecycle snapshot: ${label} unreadable: ${res.error.message}`);
  return { rows: res.data, truncated: res.truncated };
}

/**
 * @param {{ supabase, householdId?: string }} opts  one household, or all
 * @returns {Promise<{ snapshots, orphanQuarantineRows, sources, truncated }>}
 */
async function loadLifecycleSnapshots({ supabase, householdId = null }) {
  if (!supabase) throw new Error('lifecycle snapshot: database not configured');
  const scoped = (q, col = 'household_id') => (householdId ? q.eq(col, householdId) : q);

  const [households, entitlements, quarantine] = await Promise.all([
    required(() => scoped(supabase.from('households').select('*'), 'id').order('id', { ascending: true }), 'households'),
    // 2026-10-04: + revenuecat_environment (053) for commercial classification;
    // falls back to the base columns until 053 is applied (store grants are then
    // environment-unverified, never genuine paying).
    (async () => {
      const cols = 'id, household_id, entitlement_type, status, starts_at, ends_at, source, external_reference';
      const res = await selectAll(() => scoped(supabase.from('entitlements').select(`${cols}, revenuecat_environment`)).order('id', { ascending: true }));
      if (res.error && isMissingRelation(res.error)) return required(() => scoped(supabase.from('entitlements').select(cols)).order('id', { ascending: true }), 'entitlements');
      if (res.error) throw new Error(`lifecycle snapshot: entitlements unreadable: ${res.error.message}`);
      return { rows: res.data, truncated: res.truncated };
    })(),
    required(() => {
      const q = supabase.from('twilio_number_quarantine').select('*').is('released_at', null);
      return (householdId ? q.eq('household_id', householdId) : q).order('id', { ascending: true });
    }, 'twilio_number_quarantine'),
  ]);
  const [subscriptions, holds, assignments, failedEvents] = await Promise.all([
    optional(() => scoped(supabase.from('subscriptions').select('household_id, stripe_subscription_id, status, current_period_end, cancel_at_period_end, updated_at, created_at')).order('id', { ascending: true })),
    optional(() => scoped(supabase.from('fc_household_holds').select('household_id, source, reason, held_at')).order('household_id', { ascending: true })),
    optional(() => scoped(supabase.from('routing_assignments').select('household_id, e164_number, state, is_primary, state_changed_at').eq('state', 'active').eq('is_primary', true)).order('id', { ascending: true })),
    optional(() => scoped(supabase.from('stripe_webhook_events').select('stripe_event_id, event_type, household_id, error, received_at, last_attempt_at').eq('status', 'failed')).order('stripe_event_id', { ascending: true })),
  ]);
  // F-03 fix (2026-10-04): events for a deleted household are now recorded as
  // 'ignored'; the ones whose subscription was still LIVE need a human.
  const classifications = await optional(() => scoped(supabase.from('account_classifications').select('household_id, classification')).order('household_id', { ascending: true }));
  const classBy = new Map(classifications.rows.map((c) => [c.household_id, c.classification]));
  const liveForDeleted = await optional(() => scoped(supabase.from('stripe_webhook_events').select('stripe_event_id, event_type, household_id, error, received_at, processed_at').eq('status', 'ignored').eq('error', 'ignored:deleted_household_subscription_live')).order('stripe_event_id', { ascending: true }));

  const entsBy = groupBy(entitlements.rows, 'household_id');
  const quarBy = groupBy(quarantine.rows, 'household_id');
  const subsBy = groupBy(subscriptions.rows, 'household_id');
  const holdBy = groupBy(holds.rows, 'household_id');
  const assignBy = groupBy(assignments.rows, 'household_id');
  const eventsBy = groupBy(failedEvents.rows, 'household_id');
  const liveDeletedBy = groupBy(liveForDeleted.rows, 'household_id');

  const snapshots = households.rows.map((household) => {
    const subs = (subsBy.get(household.id) || []).slice()
      .sort((a, b) => String(b.updated_at || b.created_at || '').localeCompare(String(a.updated_at || a.created_at || '')));
    const hold = (holdBy.get(household.id) || [])[0];
    const assignment = (assignBy.get(household.id) || []).find((a) => a.e164_number === household.twilio_number);
    let financialHold;
    if (holds.state === 'unreadable') financialHold = { unreadable: true };
    else if (holds.state === 'ok') financialHold = hold ? { held: true, source: hold.source, reason: hold.reason, heldAt: hold.held_at } : null;
    return {
      household,
      entitlements: entsBy.get(household.id) || [],
      subscription: subs[0] || null,
      quarantineRows: quarBy.get(household.id) || [],
      financialHold,
      currentNumberAssignedAt: assignment ? assignment.state_changed_at : null,
      failedStripeEvents: eventsBy.get(household.id) || [],
      liveSubscriptionEventsAfterDeletion: liveDeletedBy.get(household.id) || [],
      classification: classBy.get(household.id) || null,
      deliveryHealth: null,
    };
  });

  return {
    snapshots,
    orphanQuarantineRows: householdId ? [] : quarantine.rows.filter((q) => !q.household_id),
    sources: { subscriptions: subscriptions.state, financialHolds: holds.state, routingAssignments: assignments.state, stripeWebhookEvents: failedEvents.state, liveSubscriptionAfterDeletion: liveForDeleted.state, deliveryHealth: householdId ? 'per_household' : 'not_loaded_in_bulk' },
    truncated: [households, entitlements, quarantine, subscriptions, holds, assignments, failedEvents, liveForDeleted].some((r) => r.truncated),
  };
}

module.exports = { loadLifecycleSnapshots, isMissingRelation };
