// Operational event scan + delivery (soft-launch integration 2026-10-04).
//
// NOT SCHEDULED ANYWHERE. Not called from any entitlement, call, webhook or
// provisioning path, so a failure here can never affect a customer. When
// enabled (after migration 072 + approval), run periodically:
//   1. runOpsEventScan    — detect + record events exactly once (idempotent);
//   2. deliverDueOpsEvents — send due deliveries; a retry updates the delivery
//      row only, never the event.
// Email sending needs BOTH OPS_NOTIFY_EMAIL_ENABLED=true and an injected
// sender adapter; there is no live-provider adapter in this integration.
'use strict';

const { detectOpsEvents } = require('./detector');
const { assertSafe, renderMessage, TYPES } = require('./events');
const { plannedDeliveries, recipientFor } = require('./routing');

const MAX_ATTEMPTS = 5;
const backoffMs = (attempts) => Math.min(6 * 3600e3, 60e3 * 2 ** Math.max(0, attempts - 1));

async function runOpsEventScan({ loadSnapshots, store, env = process.env, now = new Date(), log = console.error } = {}) {
  const summary = { households: 0, detected: 0, recorded: 0, alreadyRecorded: 0, errors: 0 };
  let snapshots;
  try {
    ({ snapshots } = await loadSnapshots());
  } catch (err) {
    log('OPS EVENT SCAN: snapshots unreadable:', err.message);
    return { ...summary, errors: 1, aborted: true };
  }
  for (const snap of snapshots || []) {
    summary.households += 1;
    try {
      const { events } = detectOpsEvents(snap, now);
      for (const e of events) {
        summary.detected += 1;
        // Launch sprint 2026-10-05: number each NEW genuine customer (1st, 2nd…)
        // so milestones (first 5, 10, 25, 50, 100) are visible. Counted from
        // the events already recorded; an already-recorded event is a no-op, so
        // a re-scan never renumbers. Best-effort: a count failure leaves it unset.
        if (e.event_type === TYPES.NEW_GENUINE_CUSTOMER && typeof store.countEvents === 'function') {
          const already = await store.countEvents(TYPES.NEW_GENUINE_CUSTOMER).catch(() => null);
          if (Number.isInteger(already)) e.payload = { ...e.payload, genuineCustomerOrdinal: already + 1 };
        }
        const r = await store.recordEvent(assertSafe(e), plannedDeliveries(e, env));
        if (r && r.inserted) summary.recorded += 1; else summary.alreadyRecorded += 1;
      }
    } catch (err) {
      summary.errors += 1;
      log('OPS EVENT SCAN: household skipped:', snap && snap.household && snap.household.id, err.message);
    }
  }
  return summary;
}

const disabledSender = { async send() { return { disabled: true }; } };

async function deliverDueOpsEvents({ store, sender = disabledSender, env = process.env, now = new Date(), log = console.error } = {}) {
  const summary = { claimed: 0, sent: 0, retried: 0, failed: 0, disabled: 0 };
  let due;
  try { due = await store.claimDue({ now }); } catch (err) { log('OPS DELIVERY: claim failed:', err.message); return { ...summary, error: err.message }; }
  for (const { delivery, event } of due || []) {
    summary.claimed += 1;
    const finish = (status, error = null, nextAttemptAt = null) => store.complete({ id: delivery.id, status, error, nextAttemptAt }).catch((e) => log('OPS DELIVERY: complete failed:', e.message));
    const to = recipientFor(delivery.channel, delivery.recipient_role, env);
    const channelOn = delivery.channel === 'email' ? env.OPS_NOTIFY_EMAIL_ENABLED === 'true' : env.OPS_NOTIFY_PUSH_ENABLED === 'true';
    if (!channelOn || !to || delivery.channel !== 'email') { summary.disabled += 1; await finish('disabled', !channelOn ? 'channel disabled' : !to ? 'no recipient configured for role' : 'no adapter for channel'); continue; }
    try {
      const msg = renderMessage(event);
      const r = await sender.send({ to, subject: msg.subject, text: msg.text, idempotencyKey: `${event.event_key}:${delivery.channel}:${delivery.recipient_role}` });
      if (r && r.disabled) { summary.disabled += 1; await finish('disabled', 'sender disabled'); continue; }
      summary.sent += 1; await finish('sent');
    } catch (err) {
      if (delivery.attempts >= MAX_ATTEMPTS) { summary.failed += 1; await finish('failed', String(err.message).slice(0, 300)); }
      else { summary.retried += 1; await finish('retry', String(err.message).slice(0, 300), new Date(new Date(now).getTime() + backoffMs(delivery.attempts)).toISOString()); }
    }
  }
  return summary;
}

module.exports = { runOpsEventScan, deliverDueOpsEvents, disabledSender, MAX_ATTEMPTS };
