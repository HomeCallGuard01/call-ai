// Operational exception queue (customer lifecycle automation, 2026-10-04).
//
// One list of every customer/number state that needs a human, built from
// the activation state machine (./activationState.js) and the canonical
// number-lifecycle anomalies (services/numberLifecycle/state.js — reused,
// never re-derived). Pure: callers load the rows (database/lifecycleSnapshot.js)
// and decide what to do; nothing here acts, contacts a customer or calls a
// provider.
//
// Each item says WHO owns it and whether a safe deterministic automation
// already exists or is merely possible once a policy decision is made, so the
// queue doubles as the "where does Andrew still have to intervene" inventory
// (docs/operations/CUSTOMER_LIFECYCLE_AUTOMATION.md §6).
//
// The queue is DERIVED (recomputed on read), not stored: an item disappears
// when its cause is fixed. Acknowledgement/assignment needs a table and is a
// documented next step, not invented here.
'use strict';

const { DAY_MS, HOUR_MS, parseTimestampMs } = require('../numberLifecycle/state');
const { STAGES, deriveActivationState, isDeletedHousehold } = require('./activationState');

// Time rules. DECISION-marked values are proposals for Andrew; they only
// change when an item is raised, never what the system does.
const THRESHOLDS = Object.freeze({
  // Same 24h clock as the admin onboarding monitor (services/adminOnboardingStatus.js).
  setupStalledMs: 24 * HOUR_MS,
  // DECISION: entitled, forwarding works, no confirmed delivery for a week.
  firstDeliveryLongMs: 7 * DAY_MS,
  // DECISION: Stripe past_due for this long ⇒ support follow-up.
  paymentIssueMs: 3 * DAY_MS,
});

const SEVERITY_ORDER = { critical: 0, action: 1, watch: 2 };

// Catalogue. owner: support (customer-facing), ops (numbers/money),
// engineering (a bug or data defect). automation:
//   'manual'                    — needs judgement every time;
//   'automatable_after_decision' — deterministic once a policy is approved;
//   'automated_elsewhere'       — a job exists; the item means it has not
//                                 (yet) done its work.
const EXCEPTIONS = Object.freeze({
  LIFECYCLE_STATE_AMBIGUOUS: { severity: 'critical', owner: 'engineering', automation: 'manual', action: 'Entitlement, provisioning or hold state is unreadable. Never release, never tell the customer they are protected until resolved.' },
  NUMBER_CONFLICT: { severity: 'critical', owner: 'ops', automation: 'manual', action: 'The household is entitled but its live number is in quarantine. Do NOT confirm deactivation; remove the quarantine row after checking the number still routes.' },
  HOUSEHOLD_ON_HOLD: { severity: 'action', owner: 'ops', automation: 'manual', action: 'Fortress financial hold: no HCG-funded call (trusted callers included) is authorised. Review the hold reason; only an admin can release it (POST /admin/api/fortress/households/:id/hold).' },
  NUMBER_PROVISIONING_FAILED: { severity: 'action', owner: 'ops', automation: 'manual', action: 'Paid customer without a number. Check the last provisioning error, then POST /admin/api/households/:id/retry-provisioning.' },
  SETUP_STALLED: { severity: 'action', owner: 'support', automation: 'automatable_after_decision', action: 'Paid customer not protected 24h after their number was ready. Contact them with the setup step they are missing (the setup_incomplete message, once approved, automates this).' },
  FIRST_DELIVERY_UNCONFIRMED_LONG: { severity: 'watch', owner: 'support', automation: 'manual', action: 'Forwarding and app look ready but no protected call has been confirmed delivered for a week. Ask the customer to test or check their divert.' },
  PROTECTION_LOST: { severity: 'action', owner: 'support', automation: 'automatable_after_decision', action: 'Delivery worked before but the app is now unreachable. Ask the customer to open the app (re-register).' },
  EVIDENCE_PREDATES_CURRENT_NUMBER: { severity: 'action', owner: 'support', automation: 'manual', action: 'The household has a new HCG number; its forwarding/delivery proof is for the old one. The customer must re-dial the forwarding code for the new number.' },
  PAYMENT_ISSUE: { severity: 'action', owner: 'support', automation: 'automatable_after_decision', action: 'Stripe subscription past_due/unpaid; access continues meanwhile. Stripe dunning (if enabled in the Dashboard) is the only customer message today.' },
  RETURNING_CUSTOMER_OLD_NUMBER_QUARANTINED: { severity: 'action', owner: 'ops', automation: 'automatable_after_decision', action: 'Entitled again with a new number while the old one is still quarantined (and billed). Decide: reinstate the old number or confirm its deactivation.' },
  QUARANTINE_WITHOUT_HOUSEHOLD: { severity: 'action', owner: 'ops', automation: 'manual', action: 'Quarantined number whose household row is gone (household_id NULL). No route can confirm it; it is billed until released by hand.' },
  STRIPE_EVENT_FAILED: { severity: 'action', owner: 'engineering', automation: 'manual', action: 'A Stripe subscription event failed to process. Check stripe_webhook_events.error and reprocess.' },
  STRIPE_EVENT_FOR_DELETED_HOUSEHOLD: { severity: 'watch', owner: 'engineering', automation: 'manual', action: 'A Stripe event for a deleted household FAILED before the F-03 fix (2026-10-04; new ones are recorded as ignored). Entitlement is already revoked; acknowledge.' },
  DELETED_HOUSEHOLD_SUBSCRIPTION_LIVE: { severity: 'action', owner: 'ops', automation: 'manual', action: 'Stripe reported a LIVE subscription (trialing/active/past_due) for a deleted account: the customer may still be paying with no service. Cancel it in Stripe; refund per decision D-B3.' },
  ACCOUNT_DELETED_NUMBER_RETAINED: { severity: 'critical', owner: 'ops', automation: 'manual', action: 'An anonymised household still holds a number. Should be impossible (029 refuses) — investigate.' },
});

// Number-lifecycle anomalies already catalogued by state.js that the queue
// carries through unchanged. The two onboarding "watch" anomalies are
// replaced by the more precise activation exceptions above.
const NUMBER_ANOMALY_PASSTHROUGH = new Set([
  'PROVISIONING_FAILED', 'ENTITLED_WITHOUT_NUMBER', 'ENTITLED_PENDING_RELEASE', 'NUMBER_RETAINED_NO_ENTITLEMENT',
  'RELEASE_OVERDUE', 'QUARANTINE_AWAITING_CONFIRMATION', 'QUARANTINE_AWAITING_CONFIRMATION_LONG', 'QUARANTINE_RELEASE_STUCK',
  'QUARANTINED_NUMBER_OF_ENTITLED_HOUSEHOLD', 'RECORDED_RELEASE_FAILURE',
]);
const NUMBER_ANOMALY_OWNER = { AMBIGUOUS_STATE: 'engineering' };
const NUMBER_ANOMALY_AUTOMATION = {
  NUMBER_RETAINED_NO_ENTITLEMENT: 'automated_elsewhere', // the lifecycle sweep schedules it (OFF by default)
  RELEASE_OVERDUE: 'automated_elsewhere', // the daily release runner
  QUARANTINE_AWAITING_CONFIRMATION: 'automatable_after_decision',
  QUARANTINE_AWAITING_CONFIRMATION_LONG: 'automatable_after_decision',
};

function item(code, ctx, detail, since) {
  const def = EXCEPTIONS[code];
  return {
    code,
    severity: def.severity,
    owner: def.owner,
    automation: def.automation,
    recommendedAction: def.action,
    householdId: ctx.householdId || null,
    accountNumber: ctx.accountNumber || null,
    detail: detail || null,
    since: since || null,
    dedupeKey: `${code}:${ctx.householdId || ctx.key || 'global'}`,
  };
}

function setupClockStartMs(snapshot) {
  // max(current entitlement start, number assignment) — the onboarding
  // monitor's clock (services/adminOnboardingStatus.js), since no
  // setup-completed timestamp exists server-side.
  const ents = snapshot.entitlements || [];
  const nowCurrent = ents.filter((e) => e.status === 'active').map((e) => parseTimestampMs(e.starts_at)).filter((v) => v !== null);
  const startMs = nowCurrent.length ? Math.max(...nowCurrent) : null;
  const assignedMs = parseTimestampMs(snapshot.currentNumberAssignedAt) ?? parseTimestampMs(snapshot.household && snapshot.household.twilio_provisioning_updated_at);
  const candidates = [startMs, assignedMs].filter((v) => v !== null);
  return candidates.length ? Math.max(...candidates) : null;
}

/**
 * Exceptions for one household snapshot (the deriveActivationState input).
 * @returns {{ activation: object, items: object[] }}
 */
function householdExceptions(snapshot, now, thresholds = THRESHOLDS) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const h = snapshot.household || {};
  const ctx = { householdId: h.id, accountNumber: h.account_number };
  const activation = deriveActivationState(snapshot, now);
  const items = [];
  const clockMs = setupClockStartMs(snapshot);
  const age = clockMs === null ? null : nowMs - clockMs;
  const sinceIso = clockMs === null ? null : new Date(clockMs).toISOString();

  if (isDeletedHousehold(h)) {
    if (h.twilio_number) items.push(item('ACCOUNT_DELETED_NUMBER_RETAINED', ctx, h.twilio_number));
    for (const ev of snapshot.failedStripeEvents || []) {
      items.push({ ...item('STRIPE_EVENT_FOR_DELETED_HOUSEHOLD', ctx, `${ev.event_type} ${ev.stripe_event_id}`, ev.last_attempt_at || ev.received_at), dedupeKey: `STRIPE_EVENT_FOR_DELETED_HOUSEHOLD:${ev.stripe_event_id}` });
    }
    for (const ev of snapshot.liveSubscriptionEventsAfterDeletion || []) {
      items.push({ ...item('DELETED_HOUSEHOLD_SUBSCRIPTION_LIVE', ctx, `${ev.event_type} ${ev.stripe_event_id}`, ev.processed_at || ev.received_at), dedupeKey: `DELETED_HOUSEHOLD_SUBSCRIPTION_LIVE:${ev.stripe_event_id}` });
    }
  } else {
    for (const ev of snapshot.failedStripeEvents || []) {
      items.push({ ...item('STRIPE_EVENT_FAILED', ctx, `${ev.event_type} ${ev.stripe_event_id}: ${String(ev.error || '').slice(0, 160)}`, ev.last_attempt_at || ev.received_at), dedupeKey: `STRIPE_EVENT_FAILED:${ev.stripe_event_id}` });
    }
  }

  switch (activation.stage) {
    case STAGES.AMBIGUOUS:
      items.push(item('LIFECYCLE_STATE_AMBIGUOUS', ctx, activation.blockers.join(', ')));
      break;
    case STAGES.ON_HOLD:
      items.push(item('HOUSEHOLD_ON_HOLD', ctx, activation.evidence.holdSource ? `source: ${activation.evidence.holdSource}` : null, snapshot.financialHold && snapshot.financialHold.heldAt));
      break;
    case STAGES.NUMBER_FAILED:
      items.push(item('NUMBER_PROVISIONING_FAILED', ctx, h.twilio_provisioning_last_error ? String(h.twilio_provisioning_last_error).slice(0, 160) : null));
      break;
    // AWAITING_NUMBER: carried by state.js's canonical ENTITLED_WITHOUT_NUMBER
    // (after its own 1h provisioning window) — not re-derived here.
    case STAGES.NUMBER_CONFLICT:
      items.push(item('NUMBER_CONFLICT', ctx, h.twilio_number));
      break;
    case STAGES.AWAITING_FORWARDING:
    case STAGES.AWAITING_APP:
      if (age !== null && age > thresholds.setupStalledMs) items.push(item('SETUP_STALLED', ctx, `stage: ${activation.stage}`, sinceIso));
      break;
    case STAGES.AWAITING_FIRST_DELIVERY:
      if (age !== null && age > thresholds.firstDeliveryLongMs) items.push(item('FIRST_DELIVERY_UNCONFIRMED_LONG', ctx, null, sinceIso));
      break;
    case STAGES.RECONNECT_NEEDED:
      items.push(item('PROTECTION_LOST', ctx, activation.attention.includes('delivery_unreachable') ? 'delivery health UNREACHABLE' : 'app not registered'));
      break;
    default:
      break;
  }

  if (activation.attention.includes('evidence_predates_current_number') && activation.billingStanding !== 'none') {
    items.push(item('EVIDENCE_PREDATES_CURRENT_NUMBER', ctx, `number assigned ${snapshot.currentNumberAssignedAt}`));
  }
  if (activation.billingStanding === 'payment_issue') {
    const since = parseTimestampMs(snapshot.subscription && snapshot.subscription.updated_at);
    if (since === null || nowMs - since > thresholds.paymentIssueMs) items.push(item('PAYMENT_ISSUE', ctx, snapshot.subscription.status, since === null ? null : new Date(since).toISOString()));
  }
  const liveQuarantine = (snapshot.quarantineRows || []).filter((r) => !r.released_at);
  // Entitled household holding a NEW number while an OLD one is still
  // quarantined: the specific item replaces state.js's generic "quarantined
  // number of an entitled household — do not confirm" (which is about the
  // live number and would be the wrong advice here).
  const onlyOldNumbersQuarantined = !!h.twilio_number && liveQuarantine.length > 0 && liveQuarantine.every((r) => r.twilio_number !== h.twilio_number);
  if (activation.numberLifecycle.membership === 'current' && onlyOldNumbersQuarantined) {
    for (const q of liveQuarantine) {
      items.push({ ...item('RETURNING_CUSTOMER_OLD_NUMBER_QUARANTINED', ctx, q.twilio_number, q.quarantined_at), dedupeKey: `RETURNING_CUSTOMER_OLD_NUMBER_QUARANTINED:${q.id || q.twilio_number}` });
    }
  }

  for (const a of activation.numberLifecycle.anomalies) {
    if (a.code === 'AMBIGUOUS_STATE') continue; // already LIFECYCLE_STATE_AMBIGUOUS
    if (!NUMBER_ANOMALY_PASSTHROUGH.has(a.code)) continue;
    // Superseded by the more specific activation items above.
    if (a.code === 'PROVISIONING_FAILED' && activation.stage === STAGES.NUMBER_FAILED) continue;
    if (a.code === 'QUARANTINED_NUMBER_OF_ENTITLED_HOUSEHOLD' && (activation.stage === STAGES.NUMBER_CONFLICT || onlyOldNumbersQuarantined)) continue;
    items.push({
      code: a.code,
      severity: a.severity,
      owner: NUMBER_ANOMALY_OWNER[a.code] || 'ops',
      automation: NUMBER_ANOMALY_AUTOMATION[a.code] || 'manual',
      recommendedAction: a.label,
      householdId: ctx.householdId || null,
      accountNumber: ctx.accountNumber || null,
      detail: a.detail,
      since: null,
      dedupeKey: `${a.code}:${ctx.householdId}:${a.detail || ''}`,
    });
  }
  return { activation, items };
}

/**
 * The whole queue.
 * @param {object} input
 * @param {object[]} input.snapshots              per-household snapshots
 * @param {object[]} [input.orphanQuarantineRows]  quarantine rows with household_id NULL, unreleased
 * @param {Date|number} now
 */
function buildExceptionQueue({ snapshots = [], orphanQuarantineRows = [] }, now, thresholds = THRESHOLDS) {
  const items = [];
  const stages = {};
  let protectedCount = 0;
  for (const s of snapshots) {
    const { activation, items: hItems } = householdExceptions(s, now, thresholds);
    stages[activation.stage] = (stages[activation.stage] || 0) + 1;
    if (activation.protected) protectedCount += 1;
    items.push(...hItems);
  }
  for (const q of orphanQuarantineRows) {
    if (q.released_at) continue;
    items.push({ ...item('QUARANTINE_WITHOUT_HOUSEHOLD', { key: q.id || q.twilio_number }, q.twilio_number, q.quarantined_at), dedupeKey: `QUARANTINE_WITHOUT_HOUSEHOLD:${q.id || q.twilio_number}` });
  }
  // Deterministic order: severity, then oldest first, then key.
  const seen = new Set();
  const deduped = items.filter((i) => (seen.has(i.dedupeKey) ? false : (seen.add(i.dedupeKey), true)));
  deduped.sort((a, b) => (SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
    || ((parseTimestampMs(a.since) ?? Infinity) - (parseTimestampMs(b.since) ?? Infinity))
    || a.dedupeKey.localeCompare(b.dedupeKey));
  const bySeverity = { critical: 0, action: 0, watch: 0 };
  const byOwner = {};
  for (const i of deduped) {
    bySeverity[i.severity] += 1;
    byOwner[i.owner] = (byOwner[i.owner] || 0) + 1;
  }
  return {
    generatedAt: new Date(now instanceof Date ? now.getTime() : Number(now)).toISOString(),
    summary: { households: snapshots.length, protected: protectedCount, stages, bySeverity, byOwner, total: deduped.length },
    items: deduped,
  };
}

module.exports = { THRESHOLDS, EXCEPTIONS, setupClockStartMs, householdExceptions, buildExceptionQueue };
