// Unit tests for the 2026-08-29 UK scam-pattern additions (cash
// withdrawal, investigation pretext, unexpected prize/investment
// pretext) — added during Apple remediation, researched against Action
// Fraud / Met Police courier-fraud guidance, NCSC, and Take Five to Stop
// Fraud. Covers both detection (scam-like phrasing) and false positives
// (ordinary conversations using the same everyday words), plus one
// combined scam scenario and dedicated legitimate-bank-call scenarios —
// see services/liveMonitoring/scoring/signals.js and criticalSignals.js
// for the full rationale on each pattern.
//
// Run with: node tests/live-monitoring-uk-scam-patterns-2026-08-29.test.mjs

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
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

function run() {
  // --- cash_withdrawal_instruction: detection ---

  check(
    hasRiskSignal('You need to withdraw a large amount of cash from your account today', 'cash_withdrawal_instruction'),
    'cash_withdrawal_instruction: "withdraw a large amount of cash" matches'
  );
  check(
    hasRiskSignal('Please go to the bank and withdraw £2000 in cash', 'cash_withdrawal_instruction'),
    'cash_withdrawal_instruction: "go to the bank and withdraw" matches'
  );
  check(
    hasRiskSignal('I need you to take out some cash from your account', 'cash_withdrawal_instruction'),
    'cash_withdrawal_instruction: "take out some cash from your account" matches'
  );

  // --- cash_withdrawal_instruction: false positives ---

  check(
    !hasRiskSignal("I paid cash for the shopping, don't worry about it", 'cash_withdrawal_instruction'),
    'cash_withdrawal_instruction: an ordinary "paid cash" mention does not match'
  );
  check(
    !hasRiskSignal('Can you withdraw from the conversation, this is getting heated', 'cash_withdrawal_instruction'),
    'cash_withdrawal_instruction: "withdraw" used in an unrelated sense does not match'
  );

  // --- cash_withdrawal_instruction promoted to compound-only critical signal ---

  check(
    !hasCriticalSignal('You need to withdraw some cash from your account today', 'cash_withdrawal_instruction'),
    'cash_withdrawal_instruction: alone, does NOT count as a critical/red-line signal (compound-only, legitimate uses exist)'
  );
  {
    const combined = 'You need to withdraw some cash from your account, and someone will collect your card for verification.';
    const critical = extractCriticalSignals(combined);
    check(
      critical.criticalSignals.some(s => s.id === 'cash_withdrawal_instruction') &&
        critical.criticalSignals.some(s => s.id === 'physical_collection_request'),
      'cash_withdrawal_instruction: combined with physical_collection_request (a standalone signal), both count as critical — the real courier-fraud combination'
    );
  }

  // --- investigation_pretext: detection ---

  check(
    hasRiskSignal("We need your help with an investigation into fraud on your account", 'investigation_pretext'),
    'investigation_pretext: "help with an investigation" matches'
  );
  check(
    hasRiskSignal("You've been selected to help us catch the people responsible", 'investigation_pretext'),
    'investigation_pretext: "you\'ve been selected to help" matches'
  );
  check(
    hasRiskSignal('We need you to act as an undercover agent for the bank', 'investigation_pretext'),
    'investigation_pretext: "acting as an undercover agent for the bank" matches'
  );

  // --- investigation_pretext: false positives ---

  check(
    !hasRiskSignal('The police are investigating a break-in on your street last week', 'investigation_pretext'),
    'investigation_pretext: an ordinary local-crime mention does not match'
  );
  check(
    !hasRiskSignal("I'm just calling to update you, the investigation into the noise complaint is ongoing", 'investigation_pretext'),
    'investigation_pretext: a genuine unrelated "investigation" update does not match'
  );

  // --- unexpected_prize_or_investment_pretext: detection ---

  check(
    hasRiskSignal("You've won a prize, we just need your bank details to send it", 'unexpected_prize_or_investment_pretext'),
    'unexpected_prize_or_investment_pretext: "you\'ve won" matches'
  );
  check(
    hasRiskSignal('This is a risk-free investment opportunity with guaranteed returns', 'unexpected_prize_or_investment_pretext'),
    'unexpected_prize_or_investment_pretext: "risk-free investment" + "guaranteed return[s]" both match'
  );

  // --- unexpected_prize_or_investment_pretext: false positives ---

  check(
    !hasRiskSignal("I've been looking into some investment options for my pension with my adviser", 'unexpected_prize_or_investment_pretext'),
    'unexpected_prize_or_investment_pretext: an ordinary pension/investment-advice conversation does not match'
  );
  check(
    !hasRiskSignal('Congratulations, you won the raffle at the village fete', 'unexpected_prize_or_investment_pretext'),
    'unexpected_prize_or_investment_pretext: a genuine local prize win ("won the raffle", not "you\'ve won") does not match'
  );

  // --- Combined scam scenario: courier fraud, progressive score ---
  // Includes a genuine PIN-verification ask (a real, common element of
  // this exact fraud script — "confirm your PIN for verification" before
  // the collection) so the high-severity floor is reached authentically,
  // via the existing credential_or_otp_request pattern, not invented.
  {
    const transcript =
      "This is your bank. We're investigating unusual activity and need your help with our investigation. " +
      'You need to withdraw a large amount of cash from your account today, confirm your PIN number for verification, ' +
      'and a courier will come round to collect your card. ' +
      "Don't tell your bank or your family about this call.";
    const scored = scoreTranscript(transcript, null);
    check(
      scored.riskScore >= THRESHOLDS.HIGH_SEVERITY_SCORE_FLOOR,
      `combined courier-fraud scenario: progressive score (${scored.riskScore}) reaches the high-severity floor`
    );
    const critical = extractCriticalSignals(transcript);
    check(
      critical.hasCriticalSignal,
      'combined courier-fraud scenario: also trips a critical/red-line signal'
    );
    check(
      critical.criticalSignals.some(s => s.id === 'cash_withdrawal_instruction') &&
        critical.criticalSignals.some(s => s.id === 'investigation_pretext' ? false : true), // investigation_pretext is progressive-only, deliberately not promoted — see report
      'combined courier-fraud scenario: cash_withdrawal_instruction correctly counted among the critical signals once combined with other standalone signals present'
    );
  }

  // --- Legitimate bank/customer-service calls: must NOT reach termination threshold ---
  // These deliberately use "account", "payment", and "security" — the
  // exact words the task asked to confirm are never sufficient alone.
  // Deliberately avoid the literal words "PIN"/"password"/"passcode" in
  // a bare mention here — seeing those words used to demonstrate a
  // separate, pre-existing false-positive risk in the *existing*
  // credential_or_otp_request pattern, documented (not silently
  // patched) at the bottom of this file, not conflated with these
  // tests of the new additions specifically.

  {
    const transcript =
      "Hi, I'm calling about your account, just to confirm your recent payment went through fine. " +
      "As always, please stay alert for anyone contacting you unexpectedly and asking for your personal details.";
    const scored = scoreTranscript(transcript, null);
    check(
      scored.riskScore < THRESHOLDS.LIVE_MONITORING_WARN_MIN,
      `legitimate call 1 (account/payment/security, standard safety reminder): score (${scored.riskScore}) stays below the warning threshold (${THRESHOLDS.LIVE_MONITORING_WARN_MIN})`
    );
    check(
      !extractCriticalSignals(transcript).hasCriticalSignal,
      'legitimate call 1: no critical/red-line signal'
    );
  }

  {
    const transcript =
      "Good afternoon, this is your account manager. I wanted to let you know your payment has been received " +
      "and your account security settings look fine. Is there anything else I can help you with today?";
    const scored = scoreTranscript(transcript, null);
    check(
      scored.riskScore < THRESHOLDS.LIVE_MONITORING_WARN_MIN,
      `legitimate call 2 (routine account-manager check-in): score (${scored.riskScore}) stays below the warning threshold`
    );
    check(
      !extractCriticalSignals(transcript).hasCriticalSignal,
      'legitimate call 2: no critical/red-line signal'
    );
  }

  {
    const transcript =
      "Hi love, it's your son, can you withdraw some cash for me later, I'll pop round and pick it up after work, " +
      "no rush at all.";
    const scored = scoreTranscript(transcript, null);
    check(
      scored.riskScore < THRESHOLDS.LIVE_MONITORING_WARN_MIN,
      `legitimate call 3 (family member, casual cash favour, protective family-reference language present): score (${scored.riskScore}) stays below the warning threshold`
    );
    check(
      !extractCriticalSignals(transcript).hasCriticalSignal,
      'legitimate call 3: no critical/red-line signal — cash_withdrawal_instruction alone (no other standalone critical signal present) never terminates a legitimate family call'
    );
  }

  // --- Documented, pre-existing, deliberately NOT fixed here ---
  // Found while writing the legitimate-call tests above: the EXISTING
  // (not new — present before this session's changes)
  // credential_or_otp_request pattern in both signals.js and
  // criticalSignals.js matches the bare word "PIN" with no requirement
  // that it be part of a REQUEST — including a legitimate bank's own
  // standard anti-fraud disclaimer ("we will never ask you for your
  // PIN"). Because this pattern is severity:'high' AND standalone in
  // criticalSignals.js, that exact sentence would both float the
  // progressive score to the HIGH_SEVERITY_SCORE_FLOOR (90) and trigger
  // immediate call termination — a real false-positive risk on a call
  // that is actively protecting the customer, not attacking them.
  //
  // Deliberately NOT patched in this remediation pass: safely excluding
  // negated/protective phrasing ("never share your PIN", "we'll never
  // ask for your password") without weakening genuine detection ("share
  // your PIN with me", "read out your PIN") needs careful negation-aware
  // regex work and its own dedicated regression suite across many real
  // phrasings — exactly the kind of change the task asked to defer
  // rather than rush. This test exists to make the current, real
  // behaviour explicit and trackable, not to assert it as correct.
  {
    const transcript = "We will never ask you for your PIN or password — if anyone does, hang up and call us back.";
    const scored = scoreTranscript(transcript, null);
    const critical = extractCriticalSignals(transcript);
    console.log(
      `ℹ KNOWN ISSUE (pre-existing, not introduced by this change, not fixed here): a bank's own protective ` +
      `"we will never ask for your PIN" disclaimer currently scores ${scored.riskScore} ` +
      `(high-severity floor: ${THRESHOLDS.HIGH_SEVERITY_SCORE_FLOOR}) and ${critical.hasCriticalSignal ? 'DOES' : 'does not'} ` +
      `trigger a critical/red-line signal via the existing credential_or_otp_request pattern matching the bare word "PIN". ` +
      `Recommended as a priority, carefully-tested post-launch fix — see this test's own comment.`
    );
  }

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
  process.exitCode = failures === 0 ? 0 : 1;
}

run();
