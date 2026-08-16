// Unit tests for services/liveMonitoring/riskMonitor.js — genuine and
// scam scenarios, and the send-at-most-once SMS guarantee. Uses a fake
// Twilio SMS client only; never a real API call.
//
// Run with: node tests/live-monitoring-risk-monitor.test.mjs

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createCallMonitor } = require('../services/liveMonitoring/riskMonitor.js');

let failures = 0;

function check(condition, message) {
  if (condition) {
    console.log(`✓ ${message}`);
  } else {
    console.error(`✗ ${message}`);
    failures++;
  }
}

function makeFakeSmsClient() {
  const calls = [];
  return {
    calls,
    messages: {
      create: async (params) => {
        calls.push(params);
        return { sid: 'SM_test_123' };
      },
    },
  };
}

async function run() {
  // --- genuine call scenario: a real, benign conversation never crosses
  // the warning threshold, no SMS is ever sent ---
  {
    const smsClient = makeFakeSmsClient();
    const monitor = createCallMonitor({
      callSid: 'CA-genuine-1',
      householdId: 'household-1',
      smsClient,
      toNumber: '+447700900001',
      fromNumber: '+441615700779',
    });

    const genuineChunks = [
      'hi it is dave from next door',
      'just wondering if you still have my drill from last week',
      'no worries if not I can pop round later',
      'thanks so much talk soon bye',
    ];

    let lastResult;
    for (const chunk of genuineChunks) {
      lastResult = await monitor.handleTranscribedChunk(chunk);
    }

    check(monitor.hasSentWarning() === false, 'genuine scenario: no SMS warning is ever sent across a benign conversation');
    check(smsClient.calls.length === 0, 'genuine scenario: the fake SMS client received zero calls');
    check(lastResult.riskScore < 60, 'genuine scenario: final accumulated risk score stays below the warning threshold');
  }

  // --- scam call scenario: risk rises mid-call, exactly one SMS sent ---
  {
    const smsClient = makeFakeSmsClient();
    const monitor = createCallMonitor({
      callSid: 'CA-scam-1',
      householdId: 'household-2',
      smsClient,
      toNumber: '+447700900002',
      fromNumber: '+441615700779',
    });

    const scamChunks = [
      'hello this is calling from your bank security team',
      'we have detected unusual activity on your account',
      'this is urgent we need you to confirm your one time passcode now',
      'please read out the code you just received by text',
    ];

    const results = [];
    for (const chunk of scamChunks) {
      results.push(await monitor.handleTranscribedChunk(chunk));
    }

    check(monitor.hasSentWarning() === true, 'scam scenario: a warning is triggered once risk crosses the threshold');
    check(smsClient.calls.length === 1, 'scam scenario: exactly one SMS is sent, not one per chunk');
    check(
      smsClient.calls[0].to === '+447700900002' && smsClient.calls[0].from === '+441615700779',
      'scam scenario: the SMS is addressed to the household and sent from the protected number'
    );

    const crossingIndex = results.findIndex(r => r.warningSentThisCall);
    check(crossingIndex >= 0 && crossingIndex < scamChunks.length - 1, 'scam scenario: the warning fires mid-call, not only after the call ends');

    // Further chunks after the warning must not send a second SMS.
    await monitor.handleTranscribedChunk('one more risky sentence about payment and bitcoin');
    check(smsClient.calls.length === 1, 'scam scenario: a further high-risk chunk after the warning does not send a second SMS');
  }

  // --- send-at-most-once guarantee under a single already-high-risk chunk ---
  {
    const smsClient = makeFakeSmsClient();
    const monitor = createCallMonitor({
      callSid: 'CA-scam-2',
      householdId: 'household-3',
      smsClient,
      toNumber: '+447700900003',
      fromNumber: '+441615700779',
    });

    await monitor.handleTranscribedChunk('give me your password and remote access to your computer immediately');
    await monitor.handleTranscribedChunk('give me your password and remote access to your computer immediately');
    await monitor.handleTranscribedChunk('give me your password and remote access to your computer immediately');

    check(smsClient.calls.length === 1, 'high-severity content across multiple chunks still results in exactly one SMS for the whole call');
  }

  // --- SMS failure never throws and never blocks further monitoring ---
  {
    const failingSmsClient = {
      messages: {
        create: async () => {
          throw new Error('simulated Twilio outage');
        },
      },
    };
    const monitor = createCallMonitor({
      callSid: 'CA-sms-fail',
      householdId: 'household-4',
      smsClient: failingSmsClient,
      toNumber: '+447700900004',
      fromNumber: '+441615700779',
    });

    let threw = false;
    try {
      await monitor.handleTranscribedChunk('give me your password and one time passcode now');
    } catch (err) {
      threw = true;
    }

    check(threw === false, 'an SMS send failure is caught and never propagates as a thrown error');
    check(monitor.hasSentWarning() === true, 'the warning is still considered "triggered" even if delivery failed, so it is not retried repeatedly');
  }

  // --- a purely progressive (non-critical) high-risk chunk never
  // triggers termination — updated 2026-08-15 for the two-layer red-line
  // architecture: credential/remote-access phrasing is now ALSO a
  // critical signal (see live-monitoring-critical-signals.test.mjs and
  // live-monitoring-red-line-replay.test.mjs for that path), so this test
  // now deliberately uses wording that scores high progressively without
  // matching any critical pattern, to keep testing what it always tested:
  // a chunk with no red-line behaviour never signals call-control action. ---
  {
    const smsClient = makeFakeSmsClient();
    const monitor = createCallMonitor({
      callSid: 'CA-no-terminate',
      householdId: 'household-5',
      smsClient,
      toNumber: '+447700900005',
      fromNumber: '+441615700779',
    });

    const result = await monitor.handleTranscribedChunk('this is urgent, we need a bank transfer today');
    check(
      !('terminate' in result) && !('hangup' in result) && !('nextAction' in result),
      'the monitor result never includes any legacy call-control/termination field'
    );
    check(
      result.criticalTriggeredThisCall === false,
      'a chunk with no critical/red-line behaviour never triggers the termination path'
    );
  }

  // --- no valid household destination number: never sends, never throws,
  // never touches the call, still marks the warning as "handled" so it
  // isn't retried on every subsequent chunk ---
  {
    const smsClient = makeFakeSmsClient();
    const monitor = createCallMonitor({
      callSid: 'CA-no-destination',
      householdId: 'household-6',
      smsClient,
      toNumber: null,
      fromNumber: '+441615700779',
    });

    let threw = false;
    let result;
    try {
      result = await monitor.handleTranscribedChunk('give me your password and one time passcode now');
    } catch (err) {
      threw = true;
    }

    check(threw === false, 'a missing household destination number never throws');
    check(smsClient.calls.length === 0, 'a missing household destination number means no SMS is ever attempted');
    check(monitor.hasSentWarning() === true, 'the warning is still marked as handled so a missing number is not re-logged on every chunk');
    check(
      result && !('terminate' in result) && !('hangup' in result) && !('nextAction' in result),
      'a missing destination number still never signals any call-control action'
    );

    // A second high-risk chunk must not attempt to send either.
    await monitor.handleTranscribedChunk('please confirm the code you just received');
    check(smsClient.calls.length === 0, 'subsequent chunks after a missing-destination warning still never attempt to send');
  }

  // --- empty-string destination is treated the same as missing ---
  {
    const smsClient = makeFakeSmsClient();
    const monitor = createCallMonitor({
      callSid: 'CA-blank-destination',
      householdId: 'household-7',
      smsClient,
      toNumber: '   ',
      fromNumber: '+441615700779',
    });

    await monitor.handleTranscribedChunk('give me your password and one time passcode now');
    check(smsClient.calls.length === 0, 'a blank/whitespace-only destination number is treated as no valid number, not sent to Twilio');
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  } else {
    console.log('\nAll live-monitoring risk-monitor checks passed.');
  }
}

run();
