// Replays the exact 26 transcription-window outputs captured from the
// real staging call CAe712e319c992aa41527a595495bfa1e7 (2026-08-14)
// through the new two-layer decision engine (progressive scoring +
// critical/red-line detection + bounded termination), using fake SMS and
// Twilio REST clients — no real API calls, no real call.
//
// On the real call, nothing intervened: peak progressive score reached
// 45, below LIVE_MONITORING_WARN_MIN (60), so no SMS and no termination
// ever happened. This test proves the new architecture would have
// intervened at chunk 17 — "Don't speak to your bank or your family." —
// via the critical/red-line layer, independent of that 45 score.
//
// The chunk texts below are verbatim Whisper output from the real call,
// including its transcription artifacts (repeated "Thank you for
// watching." hallucinations on near-silence, one window mistranscribed
// as Welsh) — this is deliberately the messy real data, not a clean
// synthetic script.
//
// Run with: node tests/live-monitoring-red-line-replay.test.mjs

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createCallMonitor } = require('../services/liveMonitoring/riskMonitor.js');
const { RED_LINE_WARNING_BODY, WARNING_BODY } = require('../services/liveMonitoring/smsWarning.js');

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

function makeFakeTwilioRestClient() {
  const updates = [];
  return {
    updates,
    calls: (sid) => ({
      update: async (params) => {
        updates.push({ sid, params });
        return { sid };
      },
    }),
  };
}

// Verbatim chunk texts from CAe712e319c992aa41527a595495bfa1e7.
const REAL_CALL_CHUNKS = [
  'Thank you for watching.',
  'Thank you for watching.',
  'Thank you for watching.',
  'Altyazı M.K.',
  'There is something unusual on your account and we need to sort it out.',
  'need to sort it out fairly quickly.',
  'Thank you.',
  'Thank you.',
  'Thank you for watching.',
  'you',
  'You need to deal with this.',
  "Mae angen i chi ddeal â hyn heddiw. Mae'n bwysig nad ydych chi'n gadael.", // Welsh mistranscription
  'delay.',
  'Thank you.',
  'Thanks. Bye-bye. Bye-bye. ',
  'or your family about this, we need to move your money.',
  "Don't speak to your bank or your family.", // <-- chunk 17, expected intervention point
  'you a more safe account now.',
  'Stay on the call.',
  'Thank you. ',
  'Thank you.',
  "See, I've got a warning.",
  'Is it saying anything?',
  "Is it saying anything? It's not speaking.",
  'God speak with you.',
  '',
];

async function run() {
  const smsClient = makeFakeSmsClient();
  const twilioRestClient = makeFakeTwilioRestClient();

  const monitor = createCallMonitor({
    callSid: 'CAe712e319c992aa41527a595495bfa1e7-replay',
    householdId: 'household-replay',
    smsClient,
    toNumber: '+447769939682', // the real call's actual destination number
    fromNumber: '+441302490922', // the real call's actual staging Twilio number
    twilioRestClient,
    redLineRedirectUrl: 'https://ferret-augmented-distrust.ngrok-free.dev/red-line-terminate',
  });

  const results = [];
  for (const chunkText of REAL_CALL_CHUNKS) {
    results.push(await monitor.handleTranscribedChunk(chunkText));
  }

  // --- checkpoint 1: bank identity is not part of this transcript at all
  // (it went through the separate Twilio-ASR + GPT initial screening, not
  // the media stream), so chunks 1-15 (everything before the Stage 4
  // line) must show zero risk and no critical trigger — "allowed". ---
  for (let i = 0; i < 15; i++) {
    check(results[i].riskScore === 0, `chunk ${i + 1}: progressive score stays 0 ("${REAL_CALL_CHUNKS[i]}")`);
    check(results[i].criticalTriggeredThisCall === false, `chunk ${i + 1}: no critical signal yet`);
  }

  // --- checkpoint 2: natural urgency phrasing (chunks 5/6/11) is present
  // in the transcript but stays at riskScore 0 here — matches the real
  // call exactly, since these windows don't co-occur with a completed
  // financial/secrecy phrase yet. (The urgency-pattern widening from the
  // previous change is a separate, already-tested improvement — this
  // replay is about the red-line layer specifically.) ---
  check(results[5].riskScore === 0, 'chunk 6 ("need to sort it out fairly quickly."): still 0, matches the real call exactly');

  // --- checkpoint 3: money movement (chunk 16) escalates progressive risk ---
  check(results[15].riskScore === 20, 'chunk 16 ("...we need to move your money."): progressive risk escalates to 20 — "escalating risk"');
  check(results[15].criticalTriggeredThisCall === false, 'chunk 16: not yet a red line on its own');

  // --- checkpoint 4: chunk 17 is the red line ---
  const chunk17 = results[16];
  check(chunk17.criticalTriggeredThisCall === true, 'chunk 17 ("Don\'t speak to your bank or your family."): RED LINE triggered');
  check(chunk17.riskScore === 45, 'chunk 17: progressive score at the moment of intervention is 45 (same as the real call)');
  check(
    chunk17.criticalSignalIds.includes('isolation_from_bank') && chunk17.criticalSignalIds.includes('isolation_from_family'),
    `chunk 17: critical signal IDs are isolation_from_bank + isolation_from_family (got: ${chunk17.criticalSignalIds.join(', ')})`
  );

  // --- SMS action: the RED-LINE message, not the softer progressive one, sent exactly once ---
  check(smsClient.calls.length === 1, 'exactly one SMS was sent for the whole call');
  check(smsClient.calls[0].body === RED_LINE_WARNING_BODY, 'the SMS sent is the RED-LINE warning body, not the softer progressive WARNING_BODY');
  check(smsClient.calls[0].body !== WARNING_BODY, 'sanity check: the two SMS bodies are genuinely different');
  check(smsClient.calls[0].to === '+447769939682', 'the SMS was sent to the real call\'s actual destination number');

  // --- termination action: exactly one REST call, the graceful redirect, succeeds first try ---
  check(twilioRestClient.updates.length === 1, 'exactly one Twilio REST termination call was made — no duplicate/retry needed since the first attempt succeeded');
  check(twilioRestClient.updates[0].sid === 'CAe712e319c992aa41527a595495bfa1e7-replay', 'the termination call targets the correct CallSid');
  check(twilioRestClient.updates[0].params.url === 'https://ferret-augmented-distrust.ngrok-free.dev/red-line-terminate', 'the termination call redirects to the red-line TwiML endpoint');

  // --- persisted evidence (getSummary(), what database/calls.js would write) ---
  const summary = monitor.getSummary();
  check(summary.terminatedBySystem === true, 'persisted evidence: terminatedBySystem is true');
  check(summary.criticalSignalIds.join(', ') === 'isolation_from_bank, isolation_from_family' || summary.criticalSignalIds.slice().sort().join(',') === 'isolation_from_bank,isolation_from_family', `persisted evidence: termination_reason would be "${summary.criticalSignalIds.join(', ')}"`);
  check(summary.warningSent === true, 'persisted evidence: warning_sent is true');
  check(summary.peakRiskScore >= 45, `persisted evidence: peak progressive risk_score is ${summary.peakRiskScore} (>= 45, same as the real call)`);

  // --- checkpoint 5: idempotency — chunks 18-26 (after intervention) never trigger a second termination or SMS ---
  for (let i = 17; i < REAL_CALL_CHUNKS.length; i++) {
    check(results[i].criticalTriggeredThisCall === true, `chunk ${i + 1}: critical still marked triggered (idempotent), no re-evaluation`);
  }
  check(twilioRestClient.updates.length === 1, 'after all 26 chunks: still exactly one termination call — no duplicates from later chunks');
  check(smsClient.calls.length === 1, 'after all 26 chunks: still exactly one SMS — no duplicates from later chunks');

  console.log('\n--- Replay summary ---');
  console.log(`Intervention chunk: 17 of 26`);
  console.log(`Score at intervention: ${chunk17.riskScore}`);
  console.log(`Critical signal IDs: ${chunk17.criticalSignalIds.join(', ')}`);
  console.log(`SMS sent to: ${smsClient.calls[0].to} (red-line body)`);
  console.log(`Termination: ${twilioRestClient.updates.length} REST call, redirect to ${twilioRestClient.updates[0].params.url}`);
  console.log(`Persisted evidence: terminatedBySystem=${summary.terminatedBySystem}, terminationReason="${summary.criticalSignalIds.join(', ')}", warningSent=${summary.warningSent}, peakRiskScore=${summary.peakRiskScore}`);

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  } else {
    console.log('\nAll live-monitoring red-line-replay checks passed.');
  }
}

run();
