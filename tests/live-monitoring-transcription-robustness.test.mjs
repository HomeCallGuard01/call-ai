// Regression coverage for the 2026-08-16 transcription-robustness fixes,
// built directly from a real staging call's actual failure mode
// (CA4107acfc3b9146a7cb6c4129b69b0c83): a red-line phrase ("don't speak
// to your bank or your family") was split across a Whisper window
// boundary and the continuation was mistranscribed as "I can't speak to
// your bank" — a different sentence, not a garbled one.
//
// The fix is in transcription robustness (window overlap + Whisper
// prompt context — see audioWindow.js and transcribeChunk.js), NOT in
// loosening what counts as a red line. These tests prove the semantic
// distinction between "don't" (instruction) and "I can't" (statement)
// is still intact, using the SAME chunk-accumulation path
// (createCallMonitor.handleTranscribedChunk) the real monitor uses, not
// just direct regex string tests.
//
// Run with: node tests/live-monitoring-transcription-robustness.test.mjs

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createCallMonitor } = require('../services/liveMonitoring/riskMonitor.js');
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

function makeFakeSmsClient() {
  const calls = [];
  return { calls, messages: { create: async (p) => { calls.push(p); return { sid: 'SM_test' }; } } };
}

async function run() {
  // ============================================================
  // 1. Dangerous instruction split across adjacent chunks, correctly
  //    continued — the accumulation path heals the split when Whisper
  //    gets the continuation right.
  // ============================================================
  {
    const smsClient = makeFakeSmsClient();
    const monitor = createCallMonitor({ callSid: 'CA-split-correct', householdId: 'h1', smsClient, toNumber: '+447700900001', fromNumber: '+441615700779' });

    const first = await monitor.handleTranscribedChunk("Don't hang up, don't speak to your");
    check(first.criticalTriggeredThisCall === false, 'split (correct continuation), chunk 1: mid-word cut, no red line yet');

    const second = await monitor.handleTranscribedChunk('bank or your family about this.');
    check(second.criticalTriggeredThisCall === true, 'split (correct continuation), chunk 2: accumulation reconstructs the full sentence, RED LINE fires');
    check(
      second.criticalSignalIds.includes('isolation_from_bank') && second.criticalSignalIds.includes('isolation_from_family'),
      `split (correct continuation): correct signal IDs (got: ${second.criticalSignalIds.join(', ')})`
    );
  }

  // ============================================================
  // 2. The ACTUAL real-call failure mode: partial first chunk +
  //    semantically inverted continuation. Must NOT fire — this proves
  //    we have not papered over the bug by loosening detection.
  // ============================================================
  {
    const smsClient = makeFakeSmsClient();
    const monitor = createCallMonitor({ callSid: 'CA-split-inverted', householdId: 'h2', smsClient, toNumber: '+447700900002', fromNumber: '+441615700779' });

    const first = await monitor.handleTranscribedChunk("Don't hang up, don't speak to your");
    check(first.criticalTriggeredThisCall === false, 'split (inverted continuation), chunk 1: mid-word cut, no red line yet');

    // The exact mistranscription observed on the real call.
    const second = await monitor.handleTranscribedChunk('I can’t speak to your bank or your family about this, but I need you to.'.replace('’', "'"));
    check(
      second.criticalTriggeredThisCall === false,
      'split (inverted continuation): "I can\'t speak to..." does NOT trigger a red line — the real failure mode is correctly NOT papered over'
    );
  }

  // ============================================================
  // 3. Benign standalone near-miss: "I can't speak to my bank right
  //    now" with no prior "don't hang up" context at all.
  // ============================================================
  check(
    extractCriticalSignals("I can't speak to my bank right now, can you call back later?").hasCriticalSignal === false,
    'benign near-miss: "I can\'t speak to my bank right now" (a statement about the caller, not an instruction) triggers nothing'
  );
  check(
    extractCriticalSignals("Don't speak to your bank about this.").hasCriticalSignal === true,
    'sanity check: "Don\'t speak to your bank about this." (the real instruction) still triggers isolation_from_bank'
  );

  // ============================================================
  // 4. Gerund money-transfer forms — progressive risk, not a red line
  // ============================================================
  {
    const scored = scoreTranscript('I need you to start looking at transferring money.', null);
    check(
      scored.riskIndicators.some(r => r.id === 'payment_or_transfer_request'),
      'gerund: "transferring money" (the real call\'s exact phrasing) now triggers payment_or_transfer_request progressively'
    );
    check(
      !extractCriticalSignals('I need you to start looking at transferring money.').hasCriticalSignal,
      'gerund: "transferring money" alone (no account qualifier) is NOT a red line — stays progressive-only'
    );
  }
  {
    const scored = scoreTranscript('We are moving funds around at the moment.', null);
    check(
      scored.riskIndicators.some(r => r.id === 'payment_or_transfer_request'),
      'gerund: "moving funds" triggers payment_or_transfer_request progressively'
    );
  }
  check(
    scoreTranscript('Please send the funds today.', null).riskIndicators.some(r => r.id === 'payment_or_transfer_request'),
    'natural variation: "send the funds" triggers payment_or_transfer_request'
  );
  check(
    scoreTranscript('Can you move your savings for me?', null).riskIndicators.some(r => r.id === 'payment_or_transfer_request'),
    'natural variation: "move your savings" triggers payment_or_transfer_request'
  );

  // ============================================================
  // 5. Safe-account redirection with gerund paraphrases — now a red line
  // ============================================================
  check(
    extractCriticalSignals('We need you moving your money into a safe account now.').hasCriticalSignal === true,
    'gerund redirection: "moving your money into a safe account" is now a red line (financial_redirection)'
  );
  check(
    extractCriticalSignals("We're transferring your savings somewhere secure.").hasCriticalSignal === true,
    'gerund redirection: "transferring your savings somewhere secure" is now a red line (financial_redirection)'
  );

  // ============================================================
  // 6. Replay the real call's actual chunks 9-14 (verbatim Whisper
  //    output) through the accumulation path: critical detection must
  //    STILL correctly not fire (preserving the semantic distinction),
  //    but the progressive score must now cross the warning threshold
  //    once chunk 11's "transferring money" is reached.
  // ============================================================
  {
    const smsClient = makeFakeSmsClient();
    const monitor = createCallMonitor({ callSid: 'CA4107acfc3b9146a7cb6c4129b69b0c83-replay', householdId: 'h-real', smsClient, toNumber: '+447769939682', fromNumber: '+441302490922' });

    const chunks = [
      'you',
      'Thank you.',
      "Hello, I'm calling from your bank, I just want to speak to you about...",
      'want to speak to you about your account.',
      'Bye-bye.',
      'There is something unusual in your account and we need to solve it.',
      'account and we need to sort this out today, urgently.',
      'Thank you.',
      "Don't hang up, don't speak to your...",
      "I can't speak to your bank or your family about this, but I need you to.",
      'I need you to start looking at transferring money.',
      "That's just not going to work out.",
      'Okay, thanks. Bye.',
      'Thank you.',
    ];

    const results = [];
    for (const c of chunks) results.push(await monitor.handleTranscribedChunk(c));

    check(results.every(r => r.criticalTriggeredThisCall === false), 'real-call replay: critical detection correctly never fires on the actual (mistranscribed) wording — no semantics were loosened');

    check(results[10].riskScore === 65, `real-call replay: chunk 11 ("...transferring money.") now scores ${results[10].riskScore} (was 45 before this fix)`);
    check(results[10].riskScore >= THRESHOLDS.LIVE_MONITORING_WARN_MIN, 'real-call replay: chunk 11 now crosses the warning threshold');
    check(monitor.hasSentWarning() === true, 'real-call replay: the progressive SMS warning now fires (it did not on the real call)');
    check(smsClient.calls.length === 1, 'real-call replay: exactly one (progressive) SMS sent, not a red-line one');
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  } else {
    console.log('\nAll live-monitoring transcription-robustness checks passed.');
  }
}

run();
