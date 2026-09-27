// Regression tests for the 2026-09-27 privacy fix: live-monitoring logs
// must never contain transcript (conversation) content or a customer's
// full mobile number, while scam detection, interventions and SMS
// delivery behave exactly as before.
//
// Run with: node tests/live-monitoring-log-privacy.test.mjs

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { describeTranscriptChunk, maskPhoneNumber, redactPhoneNumbers } = require('../services/liveMonitoring/logRedaction.js');
const { createCallMonitor } = require('../services/liveMonitoring/riskMonitor.js');
const { sendWarningSms, RED_LINE_WARNING_BODY } = require('../services/liveMonitoring/smsWarning.js');

let failures = 0;

function check(condition, message) {
  if (condition) {
    console.error(`✓ ${message}`);
  } else {
    console.error(`✗ ${message}`);
    failures++;
  }
}

// logEvent writes JSON lines with console.log; capture them. Test output
// itself goes to console.error so it is never mistaken for a log line.
async function captureLogs(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => { lines.push(args.join(' ')); };
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return lines;
}
const parse = lines => lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

const CUSTOMER_MOBILE = '+447700900123';
const CUSTOMER_MOBILE_DIGITS = '7700900123';
const SCAM_CHUNKS = [
  'hello this is your bank fraud department calling about your account',
  'please read me the one time passcode we just sent to your phone',
];

async function run() {
  // --- helpers ---
  {
    const d = describeTranscriptChunk('please read me the passcode');
    check(d.chunkChars === 27 && d.chunkWords === 5 && d.emptyTranscript === false, 'describeTranscriptChunk: counts characters and words');
    check(Object.keys(d).sort().join(',') === 'chunkChars,chunkWords,emptyTranscript', 'describeTranscriptChunk: returns only non-content fields');
    const e = describeTranscriptChunk(null);
    check(e.chunkChars === 0 && e.chunkWords === 0 && e.emptyTranscript === true, 'describeTranscriptChunk: null (failed transcription) is an empty transcript');
    check(describeTranscriptChunk('   ').emptyTranscript === true, 'describeTranscriptChunk: whitespace-only is an empty transcript');

    check(maskPhoneNumber(CUSTOMER_MOBILE) === '***123', 'maskPhoneNumber keeps only the last 3 digits');
    check(maskPhoneNumber('07700 900123') === '***123', 'maskPhoneNumber handles national format with spaces');
    check(maskPhoneNumber('12') === '***' && maskPhoneNumber(null) === null && maskPhoneNumber(undefined) === null, 'maskPhoneNumber: short or missing values never leak');

    const redacted = redactPhoneNumbers(`The 'To' number ${CUSTOMER_MOBILE} is not a valid phone number. Error 21211`);
    check(!redacted.includes(CUSTOMER_MOBILE_DIGITS) && redacted.includes('***123'), 'redactPhoneNumbers masks a number quoted in a provider error');
    check(redacted.includes('21211'), 'redactPhoneNumbers leaves short codes (e.g. 5-digit provider error codes) intact');
    check(redactPhoneNumbers('07700 900 123 rang') === '***123 rang', 'redactPhoneNumbers handles spaced national numbers');
  }

  // --- end to end: a scam call through the real risk monitor ---
  const smsSent = [];
  let monitor;
  const results = [];
  const lines = await captureLogs(async () => {
    monitor = createCallMonitor({
      callSid: 'CA_privacy_test',
      householdId: 'hh-privacy',
      smsClient: { messages: { create: async m => { smsSent.push(m); return { sid: 'SM1' }; } } },
      toNumber: CUSTOMER_MOBILE,
      fromNumber: '+441000000001',
    });
    for (const [i, chunk] of SCAM_CHUNKS.entries()) {
      results.push(await monitor.handleTranscribedChunk(chunk, { sequence: i }));
    }
    results.push(await monitor.handleTranscribedChunk(null, { sequence: SCAM_CHUNKS.length })); // failed transcription
  });
  const events = parse(lines);
  const all = lines.join('\n');

  const chunkEvents = events.filter(e => e.event === 'transcript_chunk');
  check(chunkEvents.length === 3, `one transcript_chunk event per chunk (got ${chunkEvents.length})`);
  check(chunkEvents.every(e => !('chunkText' in e)), 'transcript_chunk events have no chunkText field');
  check(chunkEvents.every(e => typeof e.chunkChars === 'number' && typeof e.chunkWords === 'number' && typeof e.emptyTranscript === 'boolean'), 'transcript_chunk events carry chunkChars/chunkWords/emptyTranscript');
  check(chunkEvents.every(e => e.callSid === 'CA_privacy_test' && e.householdId === 'hh-privacy' && typeof e.riskScore === 'number' && typeof e.confidence === 'number'), 'transcript_chunk events keep callSid, householdId, riskScore, confidence');
  check(chunkEvents[2].emptyTranscript === true, 'a failed transcription is logged as an empty transcript');

  const distinctiveWords = ['passcode', 'fraud department', 'one time', 'read me'];
  check(distinctiveWords.every(w => !all.toLowerCase().includes(w)), 'no transcript content appears in ANY log line emitted during the call');
  check(!all.includes(CUSTOMER_MOBILE_DIGITS), "the customer's full mobile number appears in no log line");

  // Behaviour unchanged: detection and intervention still happen.
  check(results[1].criticalTriggeredThisCall === true && results[1].criticalSignalIds.includes('credential_or_otp_request'), 'detection unchanged: OTP request still triggers the critical signal');
  check(smsSent.length === 1 && smsSent[0].to === CUSTOMER_MOBILE && smsSent[0].body === RED_LINE_WARNING_BODY, 'intervention unchanged: exactly one red-line SMS, sent to the FULL (unmasked) customer number');
  const sentEvent = events.find(e => e.event === 'sms_warning_sent');
  check(sentEvent && sentEvent.to === '***123', 'sms_warning_sent logs the masked number');

  // --- SMS failure whose provider error quotes the number ---
  const failLines = await captureLogs(async () => {
    const failingMonitor = createCallMonitor({
      callSid: 'CA_fail',
      householdId: 'hh-fail',
      smsClient: { messages: { create: async () => { throw new Error(`The 'To' number ${CUSTOMER_MOBILE} is not a valid phone number.`); } } },
      toNumber: CUSTOMER_MOBILE,
      fromNumber: '+441000000001',
    });
    await failingMonitor.handleTranscribedChunk(SCAM_CHUNKS[1], { sequence: 0 });
  });
  const failEvents = parse(failLines);
  const failed = failEvents.find(e => e.event === 'sms_warning_failed');
  const notDelivered = failEvents.find(e => e.event === 'sms_warning_not_delivered');
  check(failed && failed.to === '***123' && failed.error.includes('***123'), 'sms_warning_failed masks the number in both the "to" field and the provider error');
  check(notDelivered && !notDelivered.error.includes(CUSTOMER_MOBILE_DIGITS), 'sms_warning_not_delivered masks a number quoted in the error');
  check(!failLines.join('\n').includes(CUSTOMER_MOBILE_DIGITS), "no failure-path log line contains the customer's full number");

  // sendWarningSms return value is unchanged (callers' behaviour unaffected).
  const direct = await captureLogs(async () => {
    const r = await sendWarningSms({ client: { messages: { create: async () => { throw new Error('boom 07700900123'); } } }, to: CUSTOMER_MOBILE, from: '+441', callSid: 'CA_x' });
    check(r.sent === false && r.error === 'boom 07700900123', 'sendWarningSms still returns the original error text (redaction is applied only where it is logged)');
  });
  check(!direct.join('\n').includes('7700900123'), 'sendWarningSms logs no full number on failure');

  console.error('');
  if (failures > 0) {
    console.error(`${failures} check(s) failed.`);
    process.exit(1);
  }
  console.error('All checks passed.');
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
