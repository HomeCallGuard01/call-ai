// Phase-5 scenario coverage for the progressive monitoring integration
// (restoring progressive monitoring, 2026-08-11) that isn't already
// exercised by the ported live-monitoring-risk-monitor / -media-stream-
// handler test files:
//
//   - identity-only ("bank"/"HMRC"/"police", no risky ask) stays SAFE at
//     the rule-scoring layer (the GPT-prompt layer itself can't be unit
//     tested without a live API call — see server.js's /process handler
//     for the exact prompt wording, and the honest caveat in the report)
//   - urgency + a credential/money ask together escalates past the
//     LIVE_MONITORING_WARN_MIN threshold
//   - the new secrecy/coaching signal escalates alone, and further in
//     combination with a payment ask
//   - trusted contacts structurally never enter monitoring at all
//     (attachLiveMonitoring is only ever referenced from /process's
//     SAFE-connect branch, never from /voice's known-contact bypass)
//   - a persistence failure in recordOutcome after the call has already
//     ended never throws / never propagates
//
// Run with: node tests/live-monitoring-scenarios.test.mjs

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { scoreTranscript } = require('../services/liveMonitoring/scoring/scorer.js');
const { THRESHOLDS } = require('../services/liveMonitoring/scoring/thresholds.js');
const { createCallMonitor } = require('../services/liveMonitoring/riskMonitor.js');
const { createMediaStreamHandler } = require('../services/liveMonitoring/mediaStreamHandler.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
  return { calls, messages: { create: async (p) => { calls.push(p); return { sid: 'SM_test' }; } } };
}

async function run() {
  // --- identity-only claims stay SAFE at the rule-scoring layer ---
  {
    const bankOnly = scoreTranscript('hello this is calling from your bank, how are you today', null);
    check(bankOnly.riskScore <= THRESHOLDS.SAFE_MAX, 'identity-only "bank" claim with no ask stays at or below SAFE_MAX');

    const hmrcOnly = scoreTranscript('this is hmrc, I just wanted to check a couple of details with you', null);
    check(hmrcOnly.riskScore < THRESHOLDS.LIVE_MONITORING_WARN_MIN, 'identity-only "HMRC" claim with no ask stays well below the warning threshold');

    const policeOnly = scoreTranscript('this is the police, we are following up on an incident in your area', null);
    check(policeOnly.riskScore < THRESHOLDS.LIVE_MONITORING_WARN_MIN, 'identity-only "police" claim with no ask stays well below the warning threshold');
  }

  // --- urgency + credential/money ask together escalates past the warning threshold ---
  {
    const scored = scoreTranscript(
      'this is urgent, your account will be suspended unless you confirm your one time passcode and make a payment today',
      null
    );
    check(scored.riskScore >= THRESHOLDS.LIVE_MONITORING_WARN_MIN, 'urgency combined with a credential ask and a payment ask crosses the warning threshold');
    check(
      scored.riskIndicators.some(r => r.id === 'urgency_or_threat') &&
      scored.riskIndicators.some(r => r.id === 'credential_or_otp_request') &&
      scored.riskIndicators.some(r => r.id === 'payment_or_transfer_request'),
      'all three contributing signals (urgency, credential request, payment request) are individually identified'
    );
  }

  // --- secrecy/coaching signal escalates alone ---
  {
    const secrecyAlone = scoreTranscript("don't tell anyone about this call, keep this between us", null);
    check(
      secrecyAlone.riskIndicators.some(r => r.id === 'secrecy_or_coaching'),
      'a secrecy/coaching instruction alone is identified as a risk signal'
    );
    check(secrecyAlone.riskScore > 0, 'a secrecy/coaching instruction alone raises the risk score above zero');
  }

  // --- secrecy/coaching combined with a payment ask escalates further, past the warning threshold ---
  {
    const secrecyPlusPayment = scoreTranscript(
      "don't tell your bank, this is urgent, transfer your money to the safe account right now",
      null
    );
    check(secrecyPlusPayment.riskScore >= THRESHOLDS.LIVE_MONITORING_WARN_MIN, 'secrecy/coaching combined with a payment ask crosses the warning threshold');
  }

  // --- confirm the secrecy signal fires the SMS warning end-to-end through the monitor ---
  {
    const smsClient = makeFakeSmsClient();
    const monitor = createCallMonitor({
      callSid: 'CA-secrecy-1',
      householdId: 'household-secrecy',
      smsClient,
      toNumber: '+447700900099',
      fromNumber: '+441615700779',
    });

    await monitor.handleTranscribedChunk("don't tell your bank, this is urgent, transfer your money to the safe account right now");
    check(monitor.hasSentWarning() === true, 'secrecy combined with a money-move instruction triggers the SMS warning through the real monitor');
  }

  // --- trusted callers structurally never enter monitoring: attachLiveMonitoring
  // is only ever wired into /process's SAFE-connect branch, never into
  // /voice's known-contact bypass branch ---
  {
    const serverSrc = readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

    const voiceRouteMatch = serverSrc.match(/app\.post\("\/voice",[\s\S]*?\n\}\);/);
    const processRouteMatch = serverSrc.match(/app\.post\("\/process",[\s\S]*?\n\}\);/);

    check(Boolean(voiceRouteMatch), 'sanity check: the /voice route handler is found in server.js');
    check(Boolean(processRouteMatch), 'sanity check: the /process route handler is found in server.js');

    if (voiceRouteMatch) {
      check(
        !voiceRouteMatch[0].includes('attachLiveMonitoring'),
        '/voice (the known-contact bypass route) never calls attachLiveMonitoring — trusted callers are never streamed or transcribed'
      );
    }
    if (processRouteMatch) {
      check(
        processRouteMatch[0].includes('attachLiveMonitoring'),
        '/process (the unknown-caller screening route) does call attachLiveMonitoring on its SAFE-connect path'
      );
    }

    const invocationSites = (serverSrc.match(/[^\w]attachLiveMonitoring\(twiml/g) || []).length;
    // Exactly 1: the single call site in /process (the function's own
    // definition line uses the same "attachLiveMonitoring(twiml" text but
    // is excluded by requiring a non-word character — i.e. not "function "
    // — immediately before it).
    const definitionSites = (serverSrc.match(/function attachLiveMonitoring\(twiml/g) || []).length;
    check(definitionSites === 1, 'attachLiveMonitoring has exactly one function definition in server.js');
    check(invocationSites === definitionSites + 1, 'attachLiveMonitoring is invoked exactly once in server.js (in /process) beyond its own definition');
  }

  // --- a persistence failure in recordOutcome, after the call has already
  // ended, never throws and never propagates ---
  {
    const smsClient = makeFakeSmsClient();
    const transcribeClient = { transcribe: async () => 'hello just checking in' };
    const failingRecordOutcome = async () => {
      throw new Error('simulated database outage');
    };

    const handler = createMediaStreamHandler({
      transcribeClient,
      smsClient,
      fromNumber: '+441615700779',
      recordOutcome: failingRecordOutcome,
    });

    await handler.handleMessage(JSON.stringify({
      event: 'start',
      start: {
        streamSid: 'MZ-persist-fail',
        callSid: 'CA-persist-fail',
        customParameters: { householdId: 'household-x', toNumber: '+447700900009', protectedNumber: '+441615700779' },
      },
    }));

    let threw = false;
    try {
      await handler.handleMessage(JSON.stringify({ event: 'stop', streamSid: 'MZ-persist-fail', stop: { callSid: 'CA-persist-fail' } }));
    } catch (err) {
      threw = true;
    }

    check(threw === false, 'a recordOutcome persistence failure on "stop" is caught and never thrown — the call has already ended by this point and cannot be affected');
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  } else {
    console.log('\nAll live-monitoring scenario checks passed.');
  }
}

run();
