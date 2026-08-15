// Regression coverage for the 2026-08-15 behavioural-language widening of
// urgency_or_threat and secrecy_or_coaching (services/liveMonitoring/
// scoring/signals.js), driven by a real staging call whose scripted
// urgency/secrecy lines went undetected — see the comments on those two
// patterns for the exact gap.
//
// Three groups:
//   1. Benign sentences that reuse the same ordinary words ("today",
//      "quickly", "bank", "account", "important", "delay") in isolation —
//      none of these may materially raise the risk score. This is the
//      behavioural principle the whole exercise is required to preserve.
//   2. Natural-language urgency phrasings that must now trigger
//      urgency_or_threat.
//   3. Secrecy/coaching phrasings, including the two gaps found on the
//      real call ("stay on the call", "don't contact your bank").
// Then a combined progressive scenario (identity -> urgency -> payment ->
// secrecy) proving the three signals together cross the existing
// LIVE_MONITORING_WARN_MIN (60) threshold, with no threshold or weight
// changes.
//
// Run with: node tests/live-monitoring-signal-regression.test.mjs

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { scoreTranscript } = require('../services/liveMonitoring/scoring/scorer.js');
const { THRESHOLDS } = require('../services/liveMonitoring/scoring/thresholds.js');
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
  return { calls, messages: { create: async (p) => { calls.push(p); return { sid: 'SM_test' }; } } };
}

async function run() {
  // --- 1. benign sentences must not materially escalate ---
  const benignCases = [
    'Your appointment is today.',
    'The bank closes early today.',
    "I'll call you back quickly.",
    "It's important that we have the correct address.",
    'There may be a delay with your delivery.',
  ];
  for (const text of benignCases) {
    const scored = scoreTranscript(text, null);
    check(
      scored.riskScore < THRESHOLDS.SAFE_MAX,
      `benign: "${text}" stays at or below SAFE_MAX (scored ${scored.riskScore})`
    );
    check(
      !scored.riskIndicators.some(r => r.id === 'urgency_or_threat'),
      `benign: "${text}" does not trigger urgency_or_threat`
    );
  }

  // --- 2. natural urgency phrasings must trigger urgency_or_threat ---
  const urgencyCases = [
    'You need to deal with this today.',
    'We need to sort this out quickly.',
    "You can't delay this.",
    'You need to act now.',
    'This needs dealing with immediately.',
    "If you don't do this today your account will be suspended.",
  ];
  for (const text of urgencyCases) {
    const scored = scoreTranscript(text, null);
    check(
      scored.riskIndicators.some(r => r.id === 'urgency_or_threat'),
      `urgency: "${text}" triggers urgency_or_threat`
    );
  }

  // --- 3. secrecy/coaching phrasings ---
  const secrecyCases = [
    'Stay on the call.',
    'Stay on the line.',
    "Don't hang up.",
    "Don't tell your family.",
    "Don't contact your bank.",
  ];
  for (const text of secrecyCases) {
    const scored = scoreTranscript(text, null);
    check(
      scored.riskIndicators.some(r => r.id === 'secrecy_or_coaching'),
      `secrecy: "${text}" triggers secrecy_or_coaching`
    );
  }

  // --- combined progressive scenario: identity -> urgency -> payment -> secrecy ---
  // Mirrors how riskMonitor actually accumulates real transcript chunks,
  // not just a single scoreTranscript() call, so this exercises the same
  // code path a real call goes through.
  {
    const smsClient = makeFakeSmsClient();
    const monitor = createCallMonitor({
      callSid: 'CA-progressive-regression',
      householdId: 'household-regression',
      smsClient,
      toNumber: '+447700900321',
      fromNumber: '+441615700779',
    });

    const identityResult = await monitor.handleTranscribedChunk("Hello, I'm calling from your bank.");
    check(identityResult.riskScore < THRESHOLDS.SAFE_MAX, `combined: bank identity alone stays low (scored ${identityResult.riskScore})`);

    const urgencyResult = await monitor.handleTranscribedChunk('We need to sort this out quickly.');
    check(
      urgencyResult.riskScore > identityResult.riskScore,
      `combined: natural urgency phrasing raises the score above the identity-only baseline (${identityResult.riskScore} -> ${urgencyResult.riskScore})`
    );

    const paymentResult = await monitor.handleTranscribedChunk('We need to move your money into a safe account.');
    check(
      paymentResult.riskScore > urgencyResult.riskScore,
      `combined: payment/transfer language raises the score further (${urgencyResult.riskScore} -> ${paymentResult.riskScore})`
    );

    const secrecyResult = await monitor.handleTranscribedChunk("Don't tell your family or your bank about this.");
    check(
      secrecyResult.riskScore >= THRESHOLDS.LIVE_MONITORING_WARN_MIN,
      `combined: adding secrecy/coaching crosses LIVE_MONITORING_WARN_MIN (${THRESHOLDS.LIVE_MONITORING_WARN_MIN}) without any threshold/weight change (final score ${secrecyResult.riskScore})`
    );
    check(monitor.hasSentWarning() === true, 'combined: the real monitor actually sends the warning once the threshold is crossed');
    check(smsClient.calls.length === 1, 'combined: exactly one SMS is sent for the whole progressive scenario');
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  } else {
    console.log('\nAll live-monitoring signal-regression checks passed.');
  }
}

run();
