// Unit tests for services/liveMonitoring/scoring/criticalSignals.js — the
// Layer 1 red-line pattern set added 2026-08-15. Pure pattern-matching
// tests, no monitor/termination involved (see
// live-monitoring-call-termination.test.mjs and
// live-monitoring-red-line-replay.test.mjs for those).
//
// Run with: node tests/live-monitoring-critical-signals.test.mjs

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { extractCriticalSignals } = require('../services/liveMonitoring/scoring/criticalSignals.js');

let failures = 0;

function check(condition, message) {
  if (condition) {
    console.log(`✓ ${message}`);
  } else {
    console.error(`✗ ${message}`);
    failures++;
  }
}

function hasSignal(text, id) {
  return extractCriticalSignals(text).criticalSignals.some(s => s.id === id);
}

function run() {
  // --- standalone-sufficient categories: positive cases ---
  check(hasSignal("Don't tell your family about this.", 'isolation_from_family'), 'isolation_from_family: "Don\'t tell your family about this."');
  check(hasSignal("Don't speak to your family.", 'isolation_from_family'), 'isolation_from_family: "Don\'t speak to your family."');
  check(hasSignal("Don't speak to your bank or your family.", 'isolation_from_family'), 'isolation_from_family: fires within the real call\'s actual utterance');
  check(hasSignal("Don't speak to your bank or your family.", 'isolation_from_bank'), 'isolation_from_bank: fires within the real call\'s actual utterance');
  check(hasSignal("Don't contact your bank about this.", 'isolation_from_bank'), 'isolation_from_bank: "Don\'t contact your bank about this."');
  check(hasSignal('We need you to transfer your money into a safe account.', 'financial_redirection'), 'financial_redirection: "transfer your money into a safe account"');
  check(hasSignal('Please move the money to a different account right away.', 'financial_redirection'), 'financial_redirection: "move the money to a different account"');
  check(hasSignal('Can you read out the one time passcode you just received?', 'credential_or_otp_request'), 'credential_or_otp_request: OTP request');
  check(hasSignal('I need your PIN number please.', 'credential_or_otp_request'), 'credential_or_otp_request: PIN request');
  check(hasSignal('Please install TeamViewer so I can help you.', 'remote_access_request'), 'remote_access_request: TeamViewer');
  check(hasSignal('Can you give me access to your computer?', 'remote_access_request'), 'remote_access_request: "give me access to your computer"');

  // --- directed_verification_callback: the false-positive-critical one ---
  check(hasSignal("Call us back on this number to verify it's really your bank.", 'directed_verification_callback'), 'directed_verification_callback: caller-supplied number, framed as verification');
  check(hasSignal('You can verify by calling this number right now.', 'directed_verification_callback'), 'directed_verification_callback: "verify by calling this number"');
  check(
    !hasSignal('Hang up and call the number on the back of your bank card.', 'directed_verification_callback'),
    'directed_verification_callback: legitimate advice to call the number on the back of your card must NOT match'
  );
  check(
    !hasSignal('Look up the official number yourself and call them independently.', 'directed_verification_callback'),
    'directed_verification_callback: independently-sourced number advice must NOT match'
  );
  check(
    !hasSignal('You can call 159 to verify.', 'directed_verification_callback'),
    'directed_verification_callback: an official verification shortcode (159) must NOT match'
  );

  // --- identity alone must never be a critical signal ---
  {
    const result = extractCriticalSignals("I'm calling from your bank.");
    check(result.hasCriticalSignal === false, 'identity alone ("I\'m calling from your bank") never triggers any critical signal');
  }
  {
    const result = extractCriticalSignals('This is HMRC calling about your account.');
    check(result.hasCriticalSignal === false, 'identity alone ("This is HMRC") never triggers any critical signal');
  }
  {
    const result = extractCriticalSignals('Good afternoon, this is the police.');
    check(result.hasCriticalSignal === false, 'identity alone ("This is the police") never triggers any critical signal');
  }

  // --- compound-only category: prevents_independent_verification ---
  {
    const alone = extractCriticalSignals('Please stay on the call for a moment.');
    check(
      !alone.criticalSignals.some(s => s.id === 'prevents_independent_verification'),
      'prevents_independent_verification: "stay on the call" ALONE does not trigger a red line'
    );
    check(alone.hasCriticalSignal === false, '"stay on the call" alone produces no critical signal at all');
  }
  {
    const alone = extractCriticalSignals("Don't hang up, I'll just be a moment.");
    check(
      !alone.criticalSignals.some(s => s.id === 'prevents_independent_verification'),
      'prevents_independent_verification: "don\'t hang up" ALONE does not trigger a red line'
    );
  }
  {
    const combined = extractCriticalSignals("Don't hang up, we just need your PIN number.");
    check(
      combined.criticalSignals.some(s => s.id === 'prevents_independent_verification'),
      'prevents_independent_verification: "don\'t hang up" COMBINED with a credential ask does trigger'
    );
    check(
      combined.criticalSignals.some(s => s.id === 'credential_or_otp_request'),
      'the combining credential signal is also reported'
    );
  }
  {
    const combined = extractCriticalSignals("Stay on the line, don't tell your family about this call.");
    check(
      combined.criticalSignals.some(s => s.id === 'prevents_independent_verification'),
      'prevents_independent_verification: "stay on the line" COMBINED with an isolation directive does trigger'
    );
  }

  // --- benign sentences reusing the same ordinary words must not trigger ---
  check(extractCriticalSignals('Your appointment is today.').hasCriticalSignal === false, 'benign: "Your appointment is today." triggers nothing');
  check(extractCriticalSignals('There may be a delay with your delivery.').hasCriticalSignal === false, 'benign: "There may be a delay with your delivery." triggers nothing');
  check(extractCriticalSignals("I'll call you back quickly.").hasCriticalSignal === false, 'benign: "I\'ll call you back quickly." triggers nothing');

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  } else {
    console.log('\nAll live-monitoring critical-signals checks passed.');
  }
}

run();
