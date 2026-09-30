// Structured call-delivery telemetry (2026-09-30, release readiness P3):
// privacy allow-list, never-throwing recorder, DB gate, timeline + diagnosis.
//
// Run with: node tests/call-delivery-events.test.mjs

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ev = require('../services/callDeliveryEvents');
const { EVENTS } = ev;

let failures = 0;
function check(condition, message) {
  if (condition) console.log(`✓ ${message}`);
  else { failures++; console.error(`✗ ${message}`); }
}

const HH = '9cb62adb-0000-4000-8000-000000000001';
const PARENT = 'CA' + 'a'.repeat(32);
const CHILD = 'CA' + 'b'.repeat(32);

// --- privacy allow-list ---
{
  const d = ev.sanitizeDetail('caller_classified', { classification: 'unknown', from: '+447700900123', callerName: 'Jane', transcript: 'hello' });
  check(JSON.stringify(d) === '{"classification":"unknown"}', 'caller_classified keeps only the classification; number, name and transcript are dropped');
  check(Object.keys(ev.sanitizeDetail('caller_classified', { classification: '+447700900123' })).length === 0, 'a phone number in an allowed enum key is rejected');
  check(Object.keys(ev.sanitizeDetail('push_failed', { reason: '07700 900123' })).length === 0, 'a phone-number-like string in a free-token key is rejected');
  check(ev.sanitizeDetail('push_failed', { reason: 'fcm:NotRegistered' }).reason === 'fcm:NotRegistered', 'provider failure reason token is kept');
  check(Object.keys(ev.sanitizeDetail('push_failed', { reason: 'x'.repeat(41) })).length === 0, 'over-long tokens are rejected');
  check(Object.keys(ev.sanitizeDetail('routing_decision', { mode: 'pstn-dial' })).length === 0, 'unknown enum values are rejected');
  check(ev.sanitizeDetail('routing_decision', { registrationAgeHours: -1 }).registrationAgeHours === undefined, 'negative numbers are rejected');
  check(Object.keys(ev.sanitizeDetail('not_an_event', { a: 1 })).length === 0, 'unknown events keep no detail');
  check(ev.looksLikePhoneNumber('+44 7700 900123') && ev.looksLikePhoneNumber('07700900123') && !ev.looksLikePhoneNumber('fcm:NotRegistered'), 'phone-number detector');
  for (const [event, schema] of Object.entries(ev.DETAIL_SCHEMA)) {
    const banned = Object.keys(schema).filter(k => /^(from|to|number|phone(number)?|caller\w*|\w*name|transcript\w*|text|summary|content)$/i.test(k));
    check(banned.length === 0, `schema for ${event} has no key that could carry a number/name/content`);
  }
}

// --- row building ---
{
  const row = ev.buildDeliveryEvent({ event: EVENTS.PUSH_REQUESTED, householdId: HH, callSid: PARENT, detail: { timeoutSeconds: 20 }, now: new Date('2026-09-30T12:42:25Z') });
  check(row.household_id === HH && row.call_sid === PARENT && row.client_call_sid === null && row.source === 'server', 'valid row keeps household, parent SID, default source');
  check(row.occurred_at === '2026-09-30T12:42:25.000Z', 'occurred_at is ISO');
  const bad = ev.buildDeliveryEvent({ event: EVENTS.PUSH_REQUESTED, householdId: 'not-a-uuid', callSid: 'CA123' });
  check(bad.household_id === null && bad.call_sid === null, 'malformed household id / call SID are nulled, not stored');
  check(ev.buildDeliveryEvent({ event: 'made_up' }) === null, 'unknown event → no row');
  check(ev.buildDeliveryEvent({ event: EVENTS.PUSH_REQUESTED, source: 'browser' }) === null, 'unknown source → no row');
}

// --- recorder: always logs, DB only when enabled, never throws ---
{
  const lines = [];
  const inserts = [];
  const supabase = { from: t => ({ insert: async row => { inserts.push([t, row]); return { error: null }; } }) };
  await ev.recordDeliveryEvent({ event: EVENTS.INBOUND_RECEIVED, householdId: HH, callSid: PARENT }, { supabase, env: {}, log: l => lines.push(l) });
  check(lines.length === 1 && lines[0].startsWith('HCG_CALL_DELIVERY {'), 'one grep-able log line per event');
  check(inserts.length === 0, 'no DB write unless CALL_DELIVERY_EVENTS_DB=on (safe to deploy before migration 060)');
  await ev.recordDeliveryEvent({ event: EVENTS.INBOUND_RECEIVED, householdId: HH, callSid: PARENT }, { supabase, env: { CALL_DELIVERY_EVENTS_DB: 'on' }, log: () => {} });
  check(inserts.length === 1 && inserts[0][0] === 'call_delivery_events', 'DB write to call_delivery_events when enabled');
  const throwing = { from: () => { throw new Error('boom'); } };
  let threw = false;
  const origErr = console.error; console.error = () => {};
  try { await ev.recordDeliveryEvent({ event: EVENTS.INBOUND_RECEIVED }, { supabase: throwing, env: { CALL_DELIVERY_EVENTS_DB: 'on' }, log: () => {} }); }
  catch { threw = true; } finally { console.error = origErr; }
  check(!threw, 'recorder never throws even if the database client throws');
  const erroring = { from: () => ({ insert: async () => ({ error: { message: 'relation does not exist' } }) }) };
  console.error = () => {};
  const r = await ev.recordDeliveryEvent({ event: EVENTS.INBOUND_RECEIVED }, { supabase: erroring, env: { CALL_DELIVERY_EVENTS_DB: 'on' }, log: () => {} });
  console.error = origErr;
  check(r && r.event === 'inbound_received', 'missing table (migration not applied) fails open');
  const logged = [];
  await ev.recordDeliveryEvent({ event: EVENTS.CALLER_CLASSIFIED, householdId: HH, detail: { classification: 'unknown', from: '+447700900123' } }, { log: l => logged.push(l) });
  check(!logged[0].includes('7700900123'), 'the log line never contains a caller number');
}

// --- timeline + diagnosis ---
const at = s => `2026-09-30T12:42:${String(s).padStart(2, '0')}.000Z`;
const e = (event, s, extra = {}) => ({ event, occurred_at: at(s), source: 'server', household_id: HH, call_sid: PARENT, client_call_sid: null, detail: {}, ...extra });
const serverPrefix = [
  e('inbound_received', 0), e('household_identified', 0),
  e('caller_classified', 0, { detail: { classification: 'unknown' } }),
  e('routing_decision', 0, { detail: { mode: 'client-only' } }), e('push_requested', 0),
];
const appEvent = (event, s) => ({ event, occurred_at: at(s), source: 'app', household_id: HH, call_sid: null, client_call_sid: CHILD, detail: {} });
const dialOutcome = (status, s) => e('dial_outcome', s, { client_call_sid: CHILD, detail: { dialCallStatus: status } });

function diagnosis(events) {
  const t = ev.buildDeliveryTimeline(events);
  return t.calls[0] && t.calls[0].diagnosis;
}

{
  const t = ev.buildDeliveryTimeline([...serverPrefix, appEvent('app_invite_received', 2), appEvent('app_answered', 6), appEvent('app_media_connected', 7), dialOutcome('completed', 40)]);
  check(t.calls.length === 1, 'app events (child SID) join the parent call via dial_outcome\'s SID pair');
  check(t.calls[0].diagnosis.verdict === 'delivered', 'answered + connected → delivered');
  check(t.calls[0].stages[0].event === 'inbound_received', 'stages ordered by time then pipeline order');
}
check(diagnosis([...serverPrefix, dialOutcome('no-answer', 21)]).stage === 'device',
  'THE 30 SEP CASE: push requested, no-answer, app never reported → stopped at the device (push/app), not "customer didn\'t answer"');
check(diagnosis([...serverPrefix, { ...appEvent('push_failed', 3), source: 'poller' }, dialOutcome('no-answer', 21)]).stage === 'push', 'push failure → push stage');
check(diagnosis([...serverPrefix, appEvent('app_invite_received', 2), dialOutcome('no-answer', 21)]).verdict === 'rang_unanswered', 'invite received then no-answer → rang unanswered');
check(diagnosis([...serverPrefix, appEvent('app_invite_received', 2), appEvent('app_declined', 5), dialOutcome('busy', 5)]).verdict === 'customer_declined', 'declined');
check(diagnosis([...serverPrefix, dialOutcome('canceled', 9)]).verdict === 'caller_hung_up', 'caller hung up while ringing');
check(diagnosis([...serverPrefix, appEvent('app_invite_received', 2), appEvent('app_answered', 6), dialOutcome('failed', 30)]).stage === 'media', 'answered but never connected → media stage');
check(diagnosis([e('inbound_received', 0), e('household_identified', 0), e('routing_decision', 0, { detail: { mode: 'self-protecting-unreachable' } })]).stage === 'routing', 'no registered app → routing stage');
check(diagnosis([e('inbound_received', 0), e('household_not_found', 0)]).stage === 'household', 'number not linked to a household');
{
  const blockedCallLevel = [...serverPrefix, { ...appEvent('app_presentation_blocked', 2) }, dialOutcome('no-answer', 21)];
  check(diagnosis(blockedCallLevel).stage === 'presentation', 'SDK permission block on the call → presentation stage');
}
{
  const t = ev.buildDeliveryTimeline([
    { event: 'device_readiness', occurred_at: at(1), source: 'app', household_id: HH, detail: { platform: 'android', microphone: 'denied', notifications: 'granted' } },
    ...serverPrefix,
  ]);
  check(t.deviceReadiness.length === 1 && t.calls.length === 1, 'device readiness is listed separately, not as a call');
  const s = ev.summariseDeviceReadiness([
    { event: 'device_readiness', occurred_at: at(1), detail: { platform: 'android', microphone: 'denied', notifications: 'granted' } },
    { event: 'app_presentation_blocked', occurred_at: at(5), detail: {} },
  ]);
  check(s.microphone === 'denied' && s.presentationBlockedAt === at(5) && s.reportedAt === at(1), 'readiness summary: latest report + latest block');
  check(ev.summariseDeviceReadiness([]) === null, 'no readiness evidence → null (health unchanged)');
}

// --- wiring (source) ---
const server = readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const voiceHandler = server.slice(server.indexOf('app.post("/voice"'), server.indexOf('// PROCESS UNKNOWN CALL'));
check(/deliveryEvent\(\{[^}]*INBOUND_RECEIVED/.test(voiceHandler), '/voice records inbound_received');
check(voiceHandler.includes('CALLER_CLASSIFIED') && voiceHandler.includes('classifyCallerPresentation(caller)'), '/voice records the caller classification (never the number)');
check(!/await\s+deliveryEvent|await\s+recordDeliveryEvent/.test(server), 'server.js never awaits telemetry on a request path');
check(/dialHouseholdOrFailClosed\(twiml, household\);\s*recordRoutingTelemetry\(household, \{\s*callSid: req\.body\.CallSid,\s*monitoring: shouldStartPaidMonitoring\(household, activeEntitlement\)/.test(voiceHandler), 'unknown-caller path records routing telemetry right after the (unchanged) dial call');
check(/dialHouseholdOrFailClosed\(twiml, household\);\s*recordRoutingTelemetry\(household, \{ callSid: req\.body\.CallSid, monitoring: false, signed: telemetrySigned \}\)/.test(voiceHandler), 'known-contact path records routing telemetry (monitoring false)');
// Denial-of-wallet: /voice and /call-delivery-failed don't enforce Twilio
// signatures, so unsigned requests must never write telemetry rows.
check(/function deliveryEvent\(args, \{ persist = true \} = \{\}\) \{\s*recordDeliveryEvent\(args, \{ supabase: persist \? supabaseAdmin : null \}\)/.test(server), 'deliveryEvent persists only when asked (log-only otherwise)');
check(/const telemetrySigned = requestSignedByTwilio\(req\);/.test(voiceHandler), '/voice computes Twilio signature validity for telemetry');
check((voiceHandler.match(/telemetryPersist\);/g) || []).length === 3, 'every /voice telemetry event is gated on the signature');
check(/if \(signed\) recordEndpointHealthTelemetry\(household, callSid\);/.test(server), 'endpoint-health DB reads only for signed requests');
const failedCb = server.slice(server.indexOf('app.post("/call-delivery-failed"'), server.indexOf('app.post("/call-delivery-failed"') + 4000);
check(/if \(!persist\.persist\) \{[\s\S]*?return;\s*\}\s*const hh = await getHouseholdByTwilioNumber/.test(failedCb), 'unsigned Dial callbacks: no household lookup, no DB write');
{
  const rt = server.slice(server.indexOf('function recordRoutingTelemetry'), server.indexOf('function recordEndpointHealthTelemetry'));
  check((rt.match(/, persist\);/g) || []).length === 4, 'all routing telemetry events carry the signature gate');
}
const dialFn = server.match(/function dialHouseholdOrFailClosed\(twiml, household\) \{[\s\S]*?\n\}\n/);
check(Boolean(dialFn) && !/deliveryEvent|recordRoutingTelemetry|DELIVERY_EVENTS/.test(dialFn[0]), 'dialHouseholdOrFailClosed itself contains no telemetry (routing code untouched)');
check(Boolean(dialFn) && dialFn[0].includes('const dial = twiml.dial({ action: "/call-delivery-failed", timeout: 20, ringTone: "uk" });'), 'Dial TwiML unchanged (action, 20 s timeout, UK ringtone)');
const telemetryFn = server.slice(server.indexOf('function recordRoutingTelemetry'), server.indexOf('function dialHouseholdOrFailClosed'));
check(!/twiml|res\.|\.dial\(/.test(telemetryFn), 'recordRoutingTelemetry never touches TwiML or the response');
check(/try \{[\s\S]*\} catch \(err\)/.test(telemetryFn), 'recordRoutingTelemetry cannot throw into /voice');
const deliveredCb = server.slice(server.indexOf('app.post("/call-delivery-failed"'), server.indexOf('// Voicemail fallback PROTOTYPE completion'));
check(deliveredCb.includes('DIAL_OUTCOME') && deliveredCb.includes('clientCallSid: req.body.DialCallSid'), 'Dial action callback records dial_outcome with the child SID (joins app events)');
check(server.includes('app.use(adminDeliveryTimelineRoutes);'), 'admin timeline router mounted');
const adminRoute = readFileSync(path.join(__dirname, '..', 'routes', 'adminDeliveryTimeline.js'), 'utf8');
check(/router\.get\("\/admin\/api\/households\/:id\/call-delivery-timeline", requireAuth, requireAdmin,/.test(adminRoute), 'timeline route requires admin auth');
const mobileApi = readFileSync(path.join(__dirname, '..', 'routes', 'mobileApi.js'), 'utf8');
check(/router\.post\("\/api\/v1\/voice\/device-readiness", requireAuthApi,/.test(mobileApi), 'device-readiness route is authenticated (not a /debug beacon)');
check(/if \(outcome !== "connected"\) \{\s*await recordClientCallOutcome/.test(mobileApi), '"connected" never overwrites client_outcome (health logic unchanged)');
const monitor = readFileSync(path.join(__dirname, '..', 'services', 'deliveryHealthMonitor.js'), 'utf8');
check(monitor.includes('event: DELIVERY_EVENTS.PUSH_FAILED') && monitor.includes('source: "poller"'), 'push-failure poller records push_failed');

const migration = readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '060_call_delivery_events.sql'), 'utf8');
for (const name of Object.values(EVENTS)) {
  check(migration.includes(`'${name}'`), `migration 060 event check allows ${name}`);
}
const ddl = migration.split('\n').filter(l => !l.trim().startsWith('--')).join('\n');
check(!/\b(from_number|caller_number|caller|transcript|summary|phone_number)\b/i.test(ddl), 'migration 060 DDL has no column for caller numbers or content');

if (failures > 0) { console.error(`\n${failures} check(s) failed.`); process.exit(1); }
console.log('\nAll checks passed.');
