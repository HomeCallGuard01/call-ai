// Tests for services/deliveryHealthMonitor.js and the per-household
// alert dedupe added to services/alerting.js (2026-09-29, P0
// call-delivery resilience). In-memory Supabase/Twilio fakes; no
// network. Alerts are captured, never sent.
//
// Run with: node tests/delivery-health-monitor.test.mjs

import { createRequire } from 'node:module';
import { createFakeSupabase, createFakeTwilio } from './helpers/fakeSupabase.mjs';

const require = createRequire(import.meta.url);
const monitor = require('../services/deliveryHealthMonitor.js');
const alerting = require('../services/alerting.js');

let failures = 0;
function check(condition, message) {
  if (condition) console.log(`✓ ${message}`);
  else { failures++; console.error(`✗ ${message}`); }
}

const sid = c => 'CA' + c.repeat(32);
const HH = 'hh-1';
const quiet = () => {};

function callRow(c, minute, fields = {}) {
  return {
    call_sid: sid(c),
    household_id: HH,
    created_at: new Date(Date.UTC(2026, 8, 26, 14, minute)).toISOString(),
    dial_call_status: null,
    client_invite_received_at: null,
    client_outcome: null,
    dial_call_sid: null,
    push_failure: null,
    ...fields,
  };
}

function captureAlerts() {
  const sent = [];
  const alert = async (type, message, context, opts) => { sent.push({ type, message, context, opts }); return true; };
  return { sent, alert };
}

async function main() {
  // --- evaluateAfterDeliveryOutcome: alert once per degradation step ---
  {
    const t = {
      households: [{ id: HH, voice_client_registered_at: '2026-09-20T00:00:00Z' }],
      calls: [callRow('1', 0, { dial_call_status: 'completed' })],
    };
    const supabase = createFakeSupabase(t);
    const { sent, alert } = captureAlerts();
    const logs = [];
    const log = line => logs.push(line);

    t.calls.push(callRow('2', 10, { dial_call_status: 'failed' }));
    const r1 = await monitor.evaluateAfterDeliveryOutcome({ supabase, callSid: sid('2'), dialCallSid: sid('b'), alert, log });
    check(r1.degraded && r1.after.state === 'SUSPECT', 'first hard failure after a success → degraded to SUSPECT');
    check(sent.length === 1 && sent[0].type === 'household_delivery_needs_attention', 'one needs-attention alert sent');
    check(sent[0].opts && sent[0].opts.dedupeKey === HH, 'alert is deduplicated per household, not globally');
    check(sent[0].context.event === monitor.EVENTS.REPEATED_APP_DELIVERY_FAILURE, 'alert carries the stable event name');
    check(logs.some(l => l.startsWith('HCG_DELIVERY_EVENT ') && JSON.parse(l.slice(19)).event === 'REPEATED_APP_DELIVERY_FAILURE'), 'structured, JSON-parseable event line logged');
    check(t.calls[1].dial_call_sid === sid('b'), 'DialCallSid stored on the parent row');

    t.calls.push(callRow('3', 20, { dial_call_status: 'failed' }));
    const r2 = await monitor.evaluateAfterDeliveryOutcome({ supabase, callSid: sid('3'), dialCallSid: sid('c'), alert, log });
    check(r2.after.state === 'UNREACHABLE' && sent.length === 2 && sent[1].type === 'household_not_receiving_calls', 'second hard failure → UNREACHABLE alert');
    check(sent[1].context.event === monitor.EVENTS.HOUSEHOLD_MAY_NOT_BE_RECEIVING_CALLS, 'UNREACHABLE uses HOUSEHOLD_MAY_NOT_BE_RECEIVING_CALLS');

    t.calls.push(callRow('4', 30, { dial_call_status: 'failed' }));
    await monitor.evaluateAfterDeliveryOutcome({ supabase, callSid: sid('4'), dialCallSid: sid('d'), alert, log });
    check(sent.length === 2, 'further failures while already UNREACHABLE send no more alerts');

    t.calls.push(callRow('5', 40, { dial_call_status: 'completed' }));
    const r4 = await monitor.evaluateAfterDeliveryOutcome({ supabase, callSid: sid('5'), dialCallSid: sid('e'), alert, log });
    check(r4.after.state === 'HEALTHY' && sent.length === 2, 'a delivered call recovers to HEALTHY without alerting');

    t.calls.push(callRow('6', 50, { dial_call_status: 'no-answer', client_outcome: 'rejected' }));
    await monitor.evaluateAfterDeliveryOutcome({ supabase, callSid: sid('6'), dialCallSid: sid('f'), alert, log });
    check(sent.length === 2, 'customer declining a call never alerts');
  }

  // --- fail-open ---
  {
    const broken = { from() { throw new Error('db down'); } };
    const logs = [];
    const r = await monitor.evaluateAfterDeliveryOutcome({ supabase: broken, callSid: sid('1'), alert: async () => {}, log: l => logs.push(l) });
    check(r === null && logs.some(l => l.includes('DELIVERY HEALTH EVALUATION FAILED')), 'a database failure is logged and swallowed (never affects the call)');
    check((await monitor.evaluateAfterDeliveryOutcome({ supabase: null, callSid: sid('1') })) === null, 'no Supabase client → no-op');
  }

  // --- push-failure ingestion (Twilio 52103) ---
  {
    const PARENT = sid('7');
    const CHILD = sid('8');
    const t = {
      households: [{ id: HH, voice_client_registered_at: '2026-09-20T00:00:00Z' }],
      calls: [
        callRow('1', 0, { dial_call_status: 'completed' }),
        callRow('7', 10, { dial_call_status: 'no-answer' }), // action callback ran, but pre-fix no dial_call_sid
      ],
    };
    const supabase = createFakeSupabase(t);
    const alertText = `bindingType=fcm&primaryCorrelationId=${CHILD}&description=FCM+failure='NotRegistered'&isPassthrough=true`;
    const twilioClient = createFakeTwilio({
      parents: { [CHILD]: PARENT },
      alerts: [
        { alertText, dateCreated: '2026-09-26T14:10:02Z' },
        { alertText: 'Msg=Got+HTTP+500&ErrorCode=11200', dateCreated: '2026-09-26T14:11:00Z' },
      ],
    });
    const { sent, alert } = captureAlerts();
    const logs = [];
    const summary = await monitor.ingestPushFailureAlerts({ supabase, twilioClient, since: new Date('2026-09-26T13:00:00Z'), alert, log: l => logs.push(l) });
    check(summary.alertsRead === 2 && summary.pushFailures === 1 && summary.recorded === 1, 'only push-failure alerts are ingested; webhook errors are ignored');
    check(t.calls[1].push_failure === 'fcm:NotRegistered' && t.calls[1].dial_call_sid === CHILD, 'push failure attached via Twilio child→parent lookup when dial_call_sid was missing');
    const types = sent.map(s => s.type);
    check(types.includes('voice_client_stale_registration'), 'dead token → stale-registration alert');
    check(types.includes('household_not_receiving_calls'), 'and the household health degrades to UNREACHABLE with its own alert');
    check(sent.every(s => s.opts && s.opts.dedupeKey === HH), 'all ingestion alerts are per-household');
    check(logs.some(l => l.includes('"event":"STALE_REGISTRATION"')) && logs.some(l => l.includes('"event":"VOICE_CLIENT_PUSH_FAILED"')), 'push-failed and stale-registration events logged');

    const before = sent.length;
    const again = await monitor.ingestPushFailureAlerts({ supabase, twilioClient, since: new Date('2026-09-26T13:00:00Z'), alert, log: quiet });
    check(again.recorded === 0 && again.unmatched === 1 && sent.length === before, 're-polling the same alert window is idempotent: no rewrite, no repeat alert');
  }

  // --- unmatched alert (call not in this DB, e.g. another environment) ---
  {
    const supabase = createFakeSupabase({ households: [], calls: [] });
    const twilioClient = createFakeTwilio({ alerts: [{ alertText: `bindingType=fcm&primaryCorrelationId=${sid('9')}&description=FCM+failure='NotRegistered'` }] });
    const { sent, alert } = captureAlerts();
    const summary = await monitor.ingestPushFailureAlerts({ supabase, twilioClient, since: new Date(), alert, log: quiet });
    check(summary.unmatched === 1 && sent.length === 0, 'a push failure for a call this database does not own is skipped silently (shared Twilio account with staging)');
  }

  // --- poller is OFF by default ---
  {
    let scheduled = 0;
    const setIntervalFn = () => { scheduled++; return { unref() {} }; };
    check(monitor.startPushFailurePolling({ env: {}, setIntervalFn }) === null && scheduled === 0, 'poller does not start unless DELIVERY_PUSH_FAILURE_POLLING=on');
    check(monitor.startPushFailurePolling({ env: { DELIVERY_PUSH_FAILURE_POLLING: 'true' }, setIntervalFn }) === null, "only the exact value 'on' enables it");
    const handle = monitor.startPushFailurePolling({
      env: { DELIVERY_PUSH_FAILURE_POLLING: 'on' },
      setIntervalFn,
      supabase: createFakeSupabase({ calls: [], households: [] }),
      twilioClient: createFakeTwilio(),
      log: quiet,
    });
    check(handle && scheduled === 1, 'poller schedules exactly one interval when enabled');
    await handle.tick();
    check(true, 'a poll tick with no alerts completes without error');
    check(monitor.DEFAULT_POLL_INTERVAL_MS === 5 * 60 * 1000, 'poll interval is 5 minutes (documented rationale)');
  }

  // --- alerting.js: per-key dedupe is opt-in ---
  {
    alerting._resetForTests();
    const posts = [];
    const post = async p => { posts.push(p.subject); return true; };
    await alerting.sendCriticalAlert('household_not_receiving_calls', 'm', {}, { post, dedupeKey: 'hh-A' });
    await alerting.sendCriticalAlert('household_not_receiving_calls', 'm', {}, { post, dedupeKey: 'hh-B' });
    await alerting.sendCriticalAlert('household_not_receiving_calls', 'm', {}, { post, dedupeKey: 'hh-A' });
    check(posts.length === 2, 'per-household dedupe: two households both alert; a repeat for the same household is suppressed');
    alerting._resetForTests();
    posts.length = 0;
    await alerting.sendCriticalAlert('approved_call_delivery_failed', 'm', { householdId: 'x' }, { post });
    await alerting.sendCriticalAlert('approved_call_delivery_failed', 'm', { householdId: 'y' }, { post });
    check(posts.length === 1, 'callers without dedupeKey keep the original per-type rate limit (behaviour unchanged)');
    alerting._resetForTests();
  }

  if (failures) {
    console.error(`\n✗ ${failures} delivery-health-monitor checks FAILED`);
    process.exit(1);
  }
  console.log('\n✓ All delivery-health-monitor checks passed');
}

main().catch(err => { console.error(err); process.exit(1); });
