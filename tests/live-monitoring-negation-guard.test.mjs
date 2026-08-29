// Dedicated regression suite for the 2026-08-29 negation-guard fix
// (services/liveMonitoring/scoring/negationGuard.js).
//
// Bug: credential_or_otp_request (and several other critical/progressive
// patterns) matched their trigger words regardless of context, including
// inside a protective/negated disclaimer such as "we will never ask for
// your PIN" — not just a live request for one. Because
// credential_or_otp_request is severity:'high' and standalone in
// criticalSignals.js, that sentence alone would float the progressive
// score to the high-severity floor AND trigger immediate call
// termination, on a call that was actively protecting the customer.
//
// This suite tests three layers directly against the exact phrases from
// the task:
//   1. negationGuard.hasUnnegatedMatch() in isolation.
//   2. extractSignals() (progressive layer, signals.js).
//   3. extractCriticalSignals() (red-line layer, criticalSignals.js).
//
// Run with: node tests/live-monitoring-negation-guard.test.mjs

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { hasUnnegatedMatch } = require('../services/liveMonitoring/scoring/negationGuard.js');
const { extractSignals } = require('../services/liveMonitoring/scoring/signals.js');
const { extractCriticalSignals } = require('../services/liveMonitoring/scoring/criticalSignals.js');
const { scoreTranscript } = require('../services/liveMonitoring/scoring/scorer.js');
const { THRESHOLDS } = require('../services/liveMonitoring/scoring/thresholds.js');

let failures = 0;

function check(condition, message) {
  if (condition) {
    console.log(`✓ ${message}`);
  } else {
    console.error(`✗ ${message}`);
    failures++;
  }
}

function hasRiskSignal(text, id) {
  return extractSignals(text).riskIndicators.some(r => r.id === id);
}

function hasCriticalSignal(text, id) {
  return extractCriticalSignals(text).criticalSignals.some(s => s.id === id);
}

// The user's exact test phrases.
const PROTECTIVE_CREDENTIAL_PHRASES = [
  'We will never ask for your PIN.',
  'Never give anyone your PIN.',
  'Do not tell me your security code.',
  'Your bank will never ask you for your one-time passcode.',
  "Don't share your password with anybody.",
];

const MALICIOUS_CREDENTIAL_PHRASES = [
  'Tell me your PIN.',
  'Read the security code to me.',
  'What is the one-time passcode we just sent?',
  'Give me your password.',
];

function run() {
  console.log('--- Layer 0: negationGuard.hasUnnegatedMatch() directly ---');
  const credentialRegex = /\b(one[\s-]?time (passcode|code|password)|otp|pin\s*(number)?|cvv|security code|verification code|\w+[\s-]?digit code|passwords?|passcode|card number|sort code)\b/i;

  for (const phrase of PROTECTIVE_CREDENTIAL_PHRASES) {
    check(hasUnnegatedMatch(phrase, credentialRegex) === false, `negation guard suppresses protective phrase: "${phrase}"`);
  }
  for (const phrase of MALICIOUS_CREDENTIAL_PHRASES) {
    check(hasUnnegatedMatch(phrase, credentialRegex) === true, `negation guard still detects malicious phrase: "${phrase}"`);
  }

  check(
    hasUnnegatedMatch('We will never ask for your PIN. Now, tell me your PIN.', credentialRegex) === true,
    'mixed sentence: a genuine request later in the same transcript is still detected even after an earlier protective disclaimer'
  );

  console.log('\n--- Layer 1: extractSignals() (progressive scoring) ---');
  for (const phrase of PROTECTIVE_CREDENTIAL_PHRASES) {
    check(!hasRiskSignal(phrase, 'credential_or_otp_request'), `progressive layer does not flag protective phrase: "${phrase}"`);
  }
  for (const phrase of MALICIOUS_CREDENTIAL_PHRASES) {
    check(hasRiskSignal(phrase, 'credential_or_otp_request'), `progressive layer still flags malicious phrase: "${phrase}"`);
  }

  console.log('\n--- Layer 2: extractCriticalSignals() (red-line/termination) ---');
  for (const phrase of PROTECTIVE_CREDENTIAL_PHRASES) {
    check(!hasCriticalSignal(phrase, 'credential_or_otp_request'), `critical layer does not flag protective phrase: "${phrase}"`);
  }
  for (const phrase of MALICIOUS_CREDENTIAL_PHRASES) {
    check(hasCriticalSignal(phrase, 'credential_or_otp_request'), `critical layer still flags malicious phrase: "${phrase}"`);
  }

  console.log('\n--- Layer 3: full scoreTranscript() — protective phrase must not hit the high-severity floor ---');
  for (const phrase of PROTECTIVE_CREDENTIAL_PHRASES) {
    const scored = scoreTranscript(phrase, null);
    check(scored.riskScore < THRESHOLDS.HIGH_SEVERITY_SCORE_FLOOR, `"${phrase}" does not float the score to the high-severity floor (got ${scored.riskScore})`);
  }
  for (const phrase of MALICIOUS_CREDENTIAL_PHRASES) {
    const scored = scoreTranscript(phrase, null);
    check(scored.riskScore >= THRESHOLDS.HIGH_SEVERITY_SCORE_FLOOR, `"${phrase}" still floats the score to the high-severity floor (got ${scored.riskScore})`);
  }

  console.log('\n--- Other negation-aware patterns: user-specified example ---');
  // "we will never ask you to transfer money" must not itself be
  // interpreted as an instruction to transfer money.
  const transferDisclaimer = 'We will never ask you to transfer money to another account.';
  const transferInstruction = 'Please transfer your money to a safe account now.';
  check(!hasRiskSignal(transferDisclaimer, 'payment_or_transfer_request'), 'progressive layer does not flag "we will never ask you to transfer money..." disclaimer');
  check(!hasCriticalSignal(transferDisclaimer, 'financial_redirection'), 'critical layer does not flag "we will never ask you to transfer money..." disclaimer');
  check(hasRiskSignal(transferInstruction, 'payment_or_transfer_request'), 'progressive layer still flags a genuine transfer instruction');
  check(hasCriticalSignal(transferInstruction, 'financial_redirection'), 'critical layer still flags a genuine transfer-to-safe-account instruction');

  console.log('\n--- Other negation-aware patterns: spot checks across remaining guarded patterns ---');
  const negationSpotChecks = [
    {
      id: 'remote_access_request',
      protective: 'We will never ask you to install TeamViewer.',
      malicious: 'Please install TeamViewer so I can have remote access to your computer.',
    },
    {
      id: 'gift_card_payment_request',
      protective: 'We will never ask you to buy a gift card to pay us.',
      malicious: 'Please buy a gift card and read me the codes.',
    },
    {
      id: 'cryptocurrency_payment_request',
      protective: 'We will never ask you to pay using bitcoin.',
      malicious: 'Please pay using bitcoin right away.',
    },
    {
      id: 'cash_withdrawal_instruction',
      protective: 'We will never ask you to withdraw cash from your account.',
      malicious: 'Please withdraw some cash from your account.',
    },
  ];
  for (const { id, protective, malicious } of negationSpotChecks) {
    check(!hasRiskSignal(protective, id), `progressive layer does not flag protective disclaimer for ${id}: "${protective}"`);
    check(hasRiskSignal(malicious, id), `progressive layer still flags malicious phrase for ${id}: "${malicious}"`);
  }

  const criticalOnlySpotChecks = [
    {
      id: 'physical_collection_request',
      protective: 'We will never send a courier to collect your card.',
      malicious: 'A courier will come round to collect your card this afternoon.',
    },
    {
      id: 'directed_verification_callback',
      protective: "We will never ask you to call us back on this number.",
      malicious: 'Please call us back on this number to verify.',
    },
  ];
  for (const { id, protective, malicious } of criticalOnlySpotChecks) {
    check(!hasCriticalSignal(protective, id), `critical layer does not flag protective disclaimer for ${id}: "${protective}"`);
    check(hasCriticalSignal(malicious, id), `critical layer still flags malicious phrase for ${id}: "${malicious}"`);
  }

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
  process.exitCode = failures === 0 ? 0 : 1;
}

run();
