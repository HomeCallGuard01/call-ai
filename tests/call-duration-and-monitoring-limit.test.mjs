// Unit/integration tests for the V1 call-monitoring cost-protection
// safeguard: call-duration instrumentation, the per-call AI/live-
// monitoring safety limit (default 30 minutes), its mandatory customer
// notification, and rapid-abuse instrumentation.
//
// Explicitly V1-scoped: the monthly household-usage tiers, the
// household_monthly_usage table/RPC, and concurrent-call instrumentation
// from the original 2026-09-02 cost-protection audit are deferred to
// V1.1 and have no code in this repo to test — see
// supabase/migrations/034_call_duration_and_monitoring_limit.sql's own
// header for the full scope decision.
//
// Pure logic (monitoringLimit.js, rapidAbuseDetection.js) is exercised
// directly. mediaStreamHandler.js's monitoring-limit behaviour is
// exercised the same way tests/live-monitoring-media-stream-handler.test.mjs
// already does — real message-protocol objects, fake transcribe/sms
// clients, no real socket — with an injected `now` and small
// maxMonitoringDurationMs so the 30-minute limit can be tested without a
// real wait, and an explicit fake sendAlert so this file never depends
// on ambient Resend configuration.
//
// Run with: node tests/call-duration-and-monitoring-limit.test.mjs

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);

const {
  DEFAULT_MAX_MONITORING_DURATION_MINUTES,
  resolveMonitoringMaxDurationMs,
  hasReachedDurationThreshold,
  elapsedSeconds,
} = require('../services/liveMonitoring/monitoringLimit.js');

const {
  DEFAULT_DAILY_UNKNOWN_CALL_ALERT_THRESHOLD,
  DEFAULT_REPEAT_CALLER_WINDOW_MINUTES,
  DEFAULT_REPEAT_CALLER_COUNT_THRESHOLD,
  resolveDailyUnknownCallAlertThreshold,
  resolveRepeatCallerWindowMs,
  resolveRepeatCallerCountThreshold,
  countUnknownCallsToday,
  countRecentCallsFromSameCaller,
} = require('../services/rapidAbuseDetection.js');

const { createMediaStreamHandler } = require('../services/liveMonitoring/mediaStreamHandler.js');
const { MONITORING_LIMIT_ENDED_BODY } = require('../services/liveMonitoring/smsWarning.js');

let failures = 0;

function check(condition, message) {
  if (condition) {
    console.log(`✓ ${message}`);
  } else {
    console.error(`✗ ${message}`);
    failures++;
  }
}

// --- monitoringLimit.js: config resolution ---

check(DEFAULT_MAX_MONITORING_DURATION_MINUTES === 30, 'the default per-call monitoring safety limit is 30 minutes, matching the explicit V1 requirement');
check(resolveMonitoringMaxDurationMs({}) === 30 * 60 * 1000, 'with no env override, the limit resolves to 30 minutes in ms');
check(resolveMonitoringMaxDurationMs({ MONITORING_MAX_DURATION_MINUTES: '45' }) === 45 * 60 * 1000, 'MONITORING_MAX_DURATION_MINUTES overrides the default — configuration-driven, not hardcoded');
check(resolveMonitoringMaxDurationMs({ MONITORING_MAX_DURATION_MINUTES: '0' }) === 30 * 60 * 1000, 'a zero/invalid override falls back to the safe default rather than disabling the limit entirely');
check(resolveMonitoringMaxDurationMs({ MONITORING_MAX_DURATION_MINUTES: 'not-a-number' }) === 30 * 60 * 1000, 'a non-numeric override falls back to the safe default');

// --- monitoringLimit.js: hasReachedDurationThreshold / elapsedSeconds ---

{
  const now = new Date('2026-09-06T12:00:00.000Z');
  const thresholdMs = 30 * 60 * 1000;

  check(hasReachedDurationThreshold(null, now, thresholdMs) === false, 'a missing startedAt never reaches the threshold — fails toward continuing to monitor, never toward silently stopping');
  check(hasReachedDurationThreshold('not-a-date', now, thresholdMs) === false, 'a malformed startedAt never reaches the threshold, never throws');

  const justStarted = new Date(now.getTime() - 1000);
  check(hasReachedDurationThreshold(justStarted, now, thresholdMs) === false, 'a call started 1 second ago has not reached a 30-minute threshold');

  const exactlyAtLimit = new Date(now.getTime() - thresholdMs);
  check(hasReachedDurationThreshold(exactlyAtLimit, now, thresholdMs) === true, 'a call at exactly the threshold has reached it (inclusive boundary) — never lets one extra frame slip through');

  const justPast = new Date(now.getTime() - thresholdMs - 1000);
  check(hasReachedDurationThreshold(justPast, now, thresholdMs) === true, 'a call past the threshold has reached it');

  check(elapsedSeconds(justStarted, now) === 1, 'elapsedSeconds computes real wall-clock elapsed time');
  check(elapsedSeconds(null, now) === 0, 'elapsedSeconds never throws on a missing startedAt, returns 0');
}

// --- rapidAbuseDetection.js: config resolution ---

check(DEFAULT_DAILY_UNKNOWN_CALL_ALERT_THRESHOLD === 20, 'the daily Unknown-caller alert threshold is 20 — well above any legitimate household\'s normal daily volume, catching a burst well before the monthly 40/80 fair-use thresholds would notice it');
check(DEFAULT_REPEAT_CALLER_WINDOW_MINUTES === 10 && DEFAULT_REPEAT_CALLER_COUNT_THRESHOLD === 3, 'the repeat-caller check (3 calls in 10 minutes from the same number) targets an automated-dialer pattern a human caller would not normally produce');
check(resolveDailyUnknownCallAlertThreshold({ RAPID_ABUSE_DAILY_UNKNOWN_CALL_THRESHOLD: '5' }) === 5, 'the daily threshold is independently configurable via env, without a code change, matching monitoringLimit.js\'s own convention');
check(resolveRepeatCallerWindowMs({}) === 10 * 60 * 1000, 'the repeat-caller window defaults to 10 minutes in ms');
check(resolveRepeatCallerCountThreshold({}) === 3, 'the repeat-caller count threshold defaults to 3');

// --- rapidAbuseDetection.js: pure counting functions ---

{
  const callsToday = [
    { status: 'Unknown' }, { status: 'Unknown' }, { status: 'Known' }, { status: 'Unknown' },
  ];
  check(countUnknownCallsToday(callsToday) === 3, 'countUnknownCallsToday counts only Unknown-status calls, ignoring Known ones');
  check(countUnknownCallsToday([]) === 0, 'an empty list counts as 0, never throws');
  check(countUnknownCallsToday(null) === 0, 'a null/undefined list is treated as empty, never throws');
}

{
  const now = new Date('2026-09-06T12:00:00.000Z');
  const windowMs = 10 * 60 * 1000;
  const recentCalls = [
    { number: '+447700900001', created_at: new Date(now.getTime() - 60_000).toISOString() },
    { number: '+447700900001', created_at: new Date(now.getTime() - 5 * 60_000).toISOString() },
    { number: '+447700900001', created_at: new Date(now.getTime() - 20 * 60_000).toISOString() }, // outside window
    { number: '+447700900002', created_at: new Date(now.getTime() - 60_000).toISOString() }, // different caller
  ];
  check(countRecentCallsFromSameCaller(recentCalls, '+447700900001', now, windowMs) === 2, 'counts only calls from the same normalised caller number, within the window');
  check(countRecentCallsFromSameCaller(recentCalls, '447700900001', now, windowMs) === 2, 'compares via normaliseNumber, not raw string equality (e.g. missing leading +)');
  check(countRecentCallsFromSameCaller(recentCalls, null, now, windowMs) === 0, 'a missing caller number never throws and matches nothing');
  check(countRecentCallsFromSameCaller([], '+447700900001', now, windowMs) === 0, 'an empty recent-calls list is always 0');
}

// --- mediaStreamHandler.js: the per-call monitoring safety limit end-to-end ---

function makeFakeSmsClient() {
  const sent = [];
  return {
    sent,
    messages: {
      create: async (params) => {
        sent.push(params);
        return { sid: 'SM_test' };
      },
    },
  };
}

function makeFailingSmsClient() {
  return {
    sent: [],
    messages: {
      create: async () => {
        throw new Error('Twilio SMS send failed (simulated)');
      },
    },
  };
}

function makeCountingTranscribeClient(scriptedLine = 'ordinary conversation, nothing risky here') {
  const calls = [];
  return {
    calls,
    transcribe: async () => {
      calls.push(true);
      return scriptedLine;
    },
  };
}

function silentMediaFrame() {
  return Buffer.from([0xff]).toString('base64');
}

function feedFramesForOneWindow(handler, streamSid) {
  const promises = [];
  for (let i = 0; i < 200; i++) {
    promises.push(
      handler.handleMessage(JSON.stringify({ event: 'media', streamSid, media: { payload: silentMediaFrame() } }))
    );
  }
  return Promise.all(promises);
}

async function run() {
  // --- monitoring continues normally below the limit; the limit stops
  // transcription/AI processing but the "call" (this handler's own
  // state) is never told to hang up anything — only closeConnection
  // (the WebSocket) is invoked, never any Twilio call-control API — and
  // the mandatory customer SMS fires exactly once, alongside exactly one
  // ops alert. ---
  {
    const transcribeClient = makeCountingTranscribeClient();
    const smsClient = makeFakeSmsClient();
    const recordedOutcomes = [];
    const alerts = [];
    let closeCallCount = 0;

    // Fixed clock, advanced manually between windows — makes the
    // 30-minute (here: 1-minute, for a fast test) limit deterministic
    // without a real wait.
    let currentTime = new Date('2026-09-06T12:00:00.000Z');

    const handler = createMediaStreamHandler({
      transcribeClient,
      smsClient,
      fromNumber: '+441615700779',
      maxMonitoringDurationMs: 60_000, // 1 minute, for a fast test
      now: () => currentTime,
      recordOutcome: async (outcome) => {
        recordedOutcomes.push(outcome);
      },
      sendAlert: async (type, message, context) => {
        alerts.push({ type, message, context });
        return true;
      },
    });

    await handler.handleMessage(JSON.stringify({
      event: 'start',
      start: { streamSid: 'MZ-limit-1', callSid: 'CA-limit-1', customParameters: { householdId: 'household-limit-1', toNumber: '+447700900001', protectedNumber: '+441615700779' } },
    }));

    // First window: well within the limit — monitoring continues
    // normally, exactly like existing HCG call protection today.
    await feedFramesForOneWindow(handler, 'MZ-limit-1');
    check(transcribeClient.calls.length === 1, 'below the limit, transcription proceeds normally — existing call protection is completely unaffected');
    check(smsClient.sent.length === 0, 'no customer notification is sent while still under the limit');

    // Advance the clock past the 1-minute limit, then feed one more frame.
    currentTime = new Date(currentTime.getTime() + 61_000);
    const closeConnection = () => { closeCallCount += 1; };

    await handler.handleMessage(
      JSON.stringify({ event: 'media', streamSid: 'MZ-limit-1', media: { payload: silentMediaFrame() } }),
      { closeConnection }
    );

    check(transcribeClient.calls.length === 1, 'no additional transcription call is made once the monitoring limit is reached — OpenAI/media processing stops for this call');
    check(closeCallCount === 1, 'the WebSocket connection is closed exactly once when the limit is reached — this is what stops Twilio sending/billing further Media Streams data');
    check(!handler._streamsForTesting.has('MZ-limit-1'), 'the stream state is cleaned up immediately once the limit is reached, not left dangling until a "stop" that will never arrive');

    check(recordedOutcomes.length === 1, 'the call outcome is recorded exactly once, at the moment the limit is reached (Twilio will never send its own "stop" for a connection we already closed)');
    check(recordedOutcomes[0].monitoringLimitReached === true, 'monitoring_limit_reached is persisted as true');
    check(recordedOutcomes[0].monitoredDurationSeconds === 61, 'the actual monitored duration is persisted, reflecting real elapsed time up to the limit, not a guess');

    check(
      alerts.filter(a => a.type === 'monitoring_limit_reached').length === 1,
      'reaching the limit fires the existing operational alert exactly once'
    );
    check(
      alerts.some(a => a.type === 'monitoring_limit_reached' && a.message.includes('call itself remains connected')),
      'the ops alert explicitly states the underlying call is unaffected, matching reality'
    );

    check(smsClient.sent.length === 1, 'the customer SMS fires exactly once');
    check(smsClient.sent[0].body === MONITORING_LIMIT_ENDED_BODY, 'the customer SMS uses the exact required non-alarming wording');
    check(smsClient.sent[0].to === '+447700900001', 'the customer SMS is sent to the household\'s own number, the same destination every other in-call warning SMS already uses');

    // Repeated/replayed events for the same now-finalized stream (e.g. a
    // redundant timer tick, or Twilio still delivering a couple of
    // already-queued "media" frames after our close()) must never
    // duplicate either notification.
    let threwAfterLimit = false;
    try {
      await handler.handleMessage(JSON.stringify({ event: 'media', streamSid: 'MZ-limit-1', media: { payload: silentMediaFrame() } }));
      await handler.handleMessage(JSON.stringify({ event: 'media', streamSid: 'MZ-limit-1', media: { payload: silentMediaFrame() } }));
      // Twilio's own "stop" can still arrive after we've already closed
      // our end — must also be a safe no-op, not a second finalize.
      await handler.handleMessage(JSON.stringify({ event: 'stop', streamSid: 'MZ-limit-1', stop: { callSid: 'CA-limit-1' } }));
    } catch {
      threwAfterLimit = true;
    }
    check(threwAfterLimit === false, 'stray events arriving after the limit was reached are silently ignored, never thrown');
    check(transcribeClient.calls.length === 1, 'a stray frame after the limit still never triggers another transcription call');
    check(smsClient.sent.length === 1, 'replayed/repeated events never duplicate the customer SMS — still exactly one');
    check(alerts.filter(a => a.type === 'monitoring_limit_reached').length === 1, 'replayed/repeated events never duplicate the ops alert — still exactly one');
    check(recordedOutcomes.length === 1, 'replayed/repeated events never duplicate the persisted outcome — still exactly one');
  }

  // --- a call that ends normally, well within the limit, is completely
  // unaffected — no early close, no monitoringLimitReached flag, no
  // customer notification ---
  {
    const transcribeClient = makeCountingTranscribeClient();
    const smsClient = makeFakeSmsClient();
    const recordedOutcomes = [];
    let closeCallCount = 0;

    const handler = createMediaStreamHandler({
      transcribeClient,
      smsClient,
      fromNumber: '+441615700779',
      maxMonitoringDurationMs: 30 * 60 * 1000,
      now: () => new Date('2026-09-06T12:00:00.000Z'),
      recordOutcome: async (outcome) => { recordedOutcomes.push(outcome); },
      sendAlert: async () => true,
    });

    await handler.handleMessage(JSON.stringify({
      event: 'start',
      start: { streamSid: 'MZ-normal-1', callSid: 'CA-normal-1', customParameters: { householdId: 'household-normal-1', toNumber: '+447700900001', protectedNumber: '+441615700779' } },
    }));

    await feedFramesForOneWindow(handler, 'MZ-normal-1');

    await handler.handleMessage(
      JSON.stringify({ event: 'stop', streamSid: 'MZ-normal-1', stop: { accountSid: 'AC1', callSid: 'CA-normal-1' } }),
      { closeConnection: () => { closeCallCount += 1; } }
    );

    check(closeCallCount === 0, 'a call ending normally (real Twilio "stop" event) never has this module\'s own closeConnection invoked — that path is exclusively for the limit-reached case');
    check(recordedOutcomes.length === 1 && recordedOutcomes[0].monitoringLimitReached === false, 'a normally-ending call is recorded with monitoringLimitReached: false');
    check(typeof recordedOutcomes[0].monitoredDurationSeconds === 'number', 'monitored duration is recorded for every call, not only ones that hit the limit');
    check(smsClient.sent.length === 0, 'a normally-ending call never sends the limit-reached customer notification');
  }

  // --- failure injection: SMS/DB/alert failures must never break the
  // underlying call (i.e. must never prevent closeConnection from being
  // called, and must never throw out of handleMessage) ---
  {
    const transcribeClient = makeCountingTranscribeClient();
    const smsClient = makeFailingSmsClient(); // simulates Twilio SMS API failure
    let closeCallCount = 0;
    let currentTime = new Date('2026-09-06T12:00:00.000Z');

    const handler = createMediaStreamHandler({
      transcribeClient,
      smsClient,
      fromNumber: '+441615700779',
      maxMonitoringDurationMs: 60_000,
      now: () => currentTime,
      recordOutcome: async () => {
        throw new Error('Supabase write failed (simulated)'); // simulates DB failure
      },
      sendAlert: async () => {
        throw new Error('Resend alert failed (simulated)'); // simulates ops-alert failure
      },
    });

    await handler.handleMessage(JSON.stringify({
      event: 'start',
      start: { streamSid: 'MZ-fail-1', callSid: 'CA-fail-1', customParameters: { householdId: 'household-fail-1', toNumber: '+447700900001', protectedNumber: '+441615700779' } },
    }));
    await feedFramesForOneWindow(handler, 'MZ-fail-1');

    currentTime = new Date(currentTime.getTime() + 61_000);

    let threw = false;
    try {
      await handler.handleMessage(
        JSON.stringify({ event: 'media', streamSid: 'MZ-fail-1', media: { payload: silentMediaFrame() } }),
        { closeConnection: () => { closeCallCount += 1; } }
      );
    } catch {
      threw = true;
    }

    check(threw === false, 'a simultaneous SMS failure, DB write failure, and ops-alert failure never throw out of handleMessage');
    check(closeCallCount === 1, 'the WebSocket is still closed even when every downstream notification/persistence call fails — the cost-cap itself never depends on any of them succeeding');
  }

  // --- closeConnection itself throwing must not prevent finalization ---
  {
    const transcribeClient = makeCountingTranscribeClient();
    const smsClient = makeFakeSmsClient();
    const recordedOutcomes = [];
    let currentTime = new Date('2026-09-06T12:00:00.000Z');

    const handler = createMediaStreamHandler({
      transcribeClient,
      smsClient,
      fromNumber: '+441615700779',
      maxMonitoringDurationMs: 60_000,
      now: () => currentTime,
      recordOutcome: async (outcome) => { recordedOutcomes.push(outcome); },
      sendAlert: async () => true,
    });

    await handler.handleMessage(JSON.stringify({
      event: 'start',
      start: { streamSid: 'MZ-close-fail-1', callSid: 'CA-close-fail-1', customParameters: { householdId: 'household-close-fail-1', toNumber: '+447700900001', protectedNumber: '+441615700779' } },
    }));
    await feedFramesForOneWindow(handler, 'MZ-close-fail-1');

    currentTime = new Date(currentTime.getTime() + 61_000);

    let threw = false;
    try {
      await handler.handleMessage(
        JSON.stringify({ event: 'media', streamSid: 'MZ-close-fail-1', media: { payload: silentMediaFrame() } }),
        { closeConnection: () => { throw new Error('socket already closed (simulated)'); } }
      );
    } catch {
      threw = true;
    }

    check(threw === false, 'a closeConnection failure is caught and logged, never propagated');
    check(recordedOutcomes.length === 1, 'the outcome is still recorded even when closing the socket itself fails');
    check(smsClient.sent.length === 1, 'the customer is still notified even when closing the socket itself fails');
  }
}

await run();

// --- Structural: confirm the deferred V1.1 scope genuinely has no code
// here yet, and that rapid-abuse detection is alert-only (never blocks
// or deprovisions anything). ---

const mediaStreamHandlerSource = readFileSync(new URL('../services/liveMonitoring/mediaStreamHandler.js', import.meta.url), 'utf8');
check(
  !mediaStreamHandlerSource.includes('householdUsage') && !mediaStreamHandlerSource.includes('accumulateHouseholdMonitoredSeconds'),
  'mediaStreamHandler.js has no household-monthly-usage wiring — that V1.1 scope is genuinely deferred, not partially present'
);

const serverSource = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
check(
  !serverSource.includes('household_monthly_usage') && !serverSource.includes('accumulate_household_monitored_seconds'),
  'server.js has no household-monthly-usage wiring'
);
check(
  serverSource.includes('require("./services/rapidAbuseDetection")') &&
    serverSource.includes('countUnknownCallsToday(callsToday)') &&
    serverSource.includes('resolveDailyUnknownCallAlertThreshold()'),
  'server.js wires up rapid-abuse detection in the Unknown-caller path'
);
check(
  !/rapidAbuse[\s\S]{0,400}(deprovision|disable|block|reject|hangup|twiml\.hangup)/i.test(serverSource),
  'rapid-abuse detection never blocks, deprovisions, or hangs up a call anywhere near its own wiring — alert-only, exactly as required for V1'
);

const migrationSource = readFileSync(new URL('../supabase/migrations/034_call_duration_and_monitoring_limit.sql', import.meta.url), 'utf8');
check(
  migrationSource.includes('add column if not exists duration_seconds integer') &&
    migrationSource.includes('add column if not exists monitored_duration_seconds integer') &&
    migrationSource.includes('add column if not exists monitoring_limit_reached boolean not null default false'),
  'migration 034 adds exactly the three call-level fields required for V1 — no more'
);
check(
  !migrationSource.toLowerCase().includes('create table if not exists public.household_monthly_usage') &&
    !migrationSource.toLowerCase().includes('create or replace function public.accumulate_household_monitored_seconds'),
  'migration 034 does not introduce the deferred household monthly-usage table/RPC (only mentions its name in the header comment explaining the deferral)'
);
check(
  !migrationSource.toLowerCase().includes('alter table public.households') && !migrationSource.toLowerCase().includes('alter table public.entitlements'),
  'migration 034 touches only the calls table — no existing household/entitlement table altered'
);

const callsDbSource = readFileSync(new URL('../database/calls.js', import.meta.url), 'utf8');
check(
  callsDbSource.includes('monitored_duration_seconds: monitoredDurationSeconds') && callsDbSource.includes('monitoring_limit_reached: monitoringLimitReached'),
  'database/calls.js persists both new fields on every recordMonitoringOutcome call'
);
check(
  callsDbSource.includes('async function recordCallDuration'),
  'database/calls.js exposes recordCallDuration for routes/mobileApi.js\'s own use of the calls table'
);

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
