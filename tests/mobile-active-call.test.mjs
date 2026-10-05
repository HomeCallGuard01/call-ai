// DT-1 in-app call screen (real-device finding 2026-10-05, iOS 1.0.2 Build 16).
// Observed: Motorola → …1883 → iPhone rang via CallKit and was answered on the
// banner (callservicesd answerRequest 19:13:28 / 19:17:09); iOS then brought HCG
// to the foreground (HangTracer "App transitioned to foreground" 19:13:28.9),
// which had no in-call controls — the customer could not find a way to hang up
// and ended the call from the Motorola. This pins the fix.
//
// Run with: node tests/mobile-active-call.test.mjs

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  reduceActiveCall, IDLE_CALL, shouldShowCallScreen, formatCallDuration, displayCaller, statusLabel, CALL_SCREEN_COPY,
} from '../mobile/lib/activeCallModel.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mobile = path.join(__dirname, '..', 'mobile');
const read = (rel) => readFileSync(path.join(mobile, rel), 'utf8');

let failures = 0;
const check = (c, m) => { if (c) console.log(`✓ ${m}`); else { console.error(`✗ ${m}`); failures++; } };
const run = (events, from = IDLE_CALL) => events.reduce(reduceActiveCall, from);

// ── 1. Lifecycle ─────────────────────────────────────────────────────────
{
  check(!shouldShowCallScreen(IDLE_CALL), 'no call → no call screen');
  const accepted = run([{ type: 'accepted', callSid: 'CA1', from: '+447733413030' }]);
  check(accepted.status === 'connecting' && shouldShowCallScreen(accepted), 'answered → call screen shows immediately ("Connecting…")');
  const connected = run([{ type: 'connected', atMs: 1000 }], accepted);
  check(connected.status === 'connected' && connected.connectedAtMs === 1000, 'media connected → timer starts');
  check(run([{ type: 'connected', atMs: 9000 }], connected).connectedAtMs === 1000, 'a repeated Connected never resets the timer');
  check(run([{ type: 'reconnecting' }], connected).status === 'reconnecting' && run([{ type: 'reconnecting' }, { type: 'reconnected' }], connected).status === 'connected', 'reconnecting / reconnected keep the screen up');
  const ending = run([{ type: 'end_requested' }], connected);
  check(ending.status === 'ending' && shouldShowCallScreen(ending), 'End call pressed → "Ending call…" until the SDK confirms');
  check(run([{ type: 'ended' }], ending) === IDLE_CALL && !shouldShowCallScreen(run([{ type: 'ended' }], ending)), 'disconnected (either side) → screen gone');
  const failedEnd = run([{ type: 'control_failed', control: 'end' }], ending);
  check(failedEnd.status === 'connected' && failedEnd.error === 'end_failed', 'a failed hang-up returns to the live call with guidance (button usable again)');
  check(CALL_SCREEN_COPY.endFailed.includes('side of your phone'), 'failure guidance names the hardware fallback in plain words');
  const muted = run([{ type: 'muted', muted: true }, { type: 'speaker', speaker: true }], connected);
  check(muted.muted && muted.speaker, 'mute and speaker reflected');
  const next = run([{ type: 'ended' }, { type: 'accepted', callSid: 'CA2', from: null }], muted);
  check(!next.muted && !next.speaker && next.callSid === 'CA2', 'a new call never inherits the previous call\'s mute/speaker');
  check(run([{ type: 'connected', atMs: 1 }, { type: 'muted', muted: true }, { type: 'end_requested' }]) === IDLE_CALL, 'events with no answered call are ignored (no phantom screen)');
}

// ── 2. Display ──────────────────────────────────────────────────────────
{
  check(displayCaller('+447733413030') === '07733 413030' && displayCaller('+442046521883') === '020 4652 1883', 'UK numbers shown in familiar form');
  check(displayCaller('client:household-x') === 'Incoming call' && displayCaller(null) === 'Incoming call', 'never shows a raw client identity');
  check(formatCallDuration(42000) === '0:42' && formatCallDuration(725000) === '12:05' && formatCallDuration(3729000) === '1:02:09', 'timer format');
  const c = run([{ type: 'accepted', callSid: 'x', from: null }, { type: 'connected', atMs: 0 }]);
  check(statusLabel(c, 41000) === '0:41' && statusLabel(run([{ type: 'accepted', callSid: 'x', from: null }]), 0) === 'Connecting…', 'status line');
  check(CALL_SCREEN_COPY.end === 'End call' && CALL_SCREEN_COPY.title === 'Call in progress', 'plain words: "Call in progress", "End call"');
}

// ── 3. Wiring (source) ──────────────────────────────────────────────────
{
  const vc = read('lib/voiceClient.ts');
  const accepted = vc.slice(vc.indexOf('callInvite.on(CallInvite.Event.Accepted, (acceptedCall: Call) => {'));
  check(/trackAcceptedCall\(acceptedCall, callSid\)/.test(accepted.slice(0, 600)), 'voiceClient keeps the answered call (it was never stored before DT-1)');
  check(/activeCall = call;/.test(vc) && /call\.on\(Call\.Event\.Disconnected, clear\)/.test(vc) && /call\.on\(Call\.Event\.ConnectFailure, clear\)/.test(vc), 'the call is cleared on disconnect or connect failure');
  check(/await call\.disconnect\(\)/.test(vc), 'End call uses Call.disconnect() (iOS: CallKit CXEndCallAction via the SDK)');
  check(/await call\.mute\(muted\)/.test(vc) && /device\.select\(\)/.test(vc), 'Mute and Speaker use the SDK APIs');
  check(!/callInvite\.accept\(/.test(vc), 'the app never answers on the customer\'s behalf (ringing/answering stay with CallKit / the notification)');
  const selectRinging = vc.slice(vc.indexOf('async function selectSpeakerForRinging'), vc.indexOf('async function selectSpeakerForRinging') + 80);
  check(selectRinging.length > 10, 'ringing-time audio routing code still present (unchanged)');

  const layout = read('app/_layout.tsx');
  check(/import \{ ActiveCallScreen \} from "\.\.\/components\/ActiveCallScreen";/.test(layout) && /<ActiveCallScreen \/>/.test(layout), 'call screen mounted once at the app root (covers every route)');
  const screen = read('components/ActiveCallScreen.tsx');
  check(/presentationStyle="fullScreen"/.test(screen) && /visible=\{visible\}/.test(screen), 'full-screen modal, shown only while a call is active');
  check(/accessibilityLabel=\{CALL_SCREEN_COPY\.end\}/.test(screen) && /endActiveCall\(\)/.test(screen), 'one big labelled End call button wired to endActiveCall');
  check(!/Dynamic Island|side button/i.test(screen), 'the screen does not rely on the customer discovering Dynamic Island / side-button workarounds');
  const web = read('lib/voiceClient.web.ts');
  check(/export function subscribeActiveCall/.test(web) && /export async function endActiveCall/.test(web), 'web stub exports the same API (screenshot tooling keeps working)');
}

console.log(failures === 0 ? '\nIn-app call screen (DT-1): all checks hold.' : `\n${failures} check(s) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
