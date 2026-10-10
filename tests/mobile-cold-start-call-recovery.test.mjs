// H5 cold-start call recovery (WS3, 2026-10-10).
//
// Launch-blocker risk H5 (docs/launch/2026-10-09-ANDROID-HANDSET-VERIFICATION-
// PLAN.md): the in-app call screen was fed only by the JS CallInvite.Accepted
// event. Answering from the notification while HCG is killed (Android) or
// before the JS bridge runs (iOS cold launch from a VoIP push) fires that
// event in no listener, so a connected call had no HCG screen and no in-app
// End/Mute/Speaker. The fix asks the SDK for the calls it already holds
// (Voice.getCalls()) on start and on every foreground. This pins the pure
// decision (lib/activeCallModel.ts) and the wiring (lib/voiceClient.ts).
//
// NOT device-proven: H5 in the handset plan is still the acceptance test.
//
// Run with: node tests/mobile-cold-start-call-recovery.test.mjs

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  reduceActiveCall, IDLE_CALL, shouldShowCallScreen, pickRecoverableCall, RECOVERY_RETRY_DELAYS_MS, statusLabel,
} from '../mobile/lib/activeCallModel.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mobile = path.join(__dirname, '..', 'mobile');
const read = (rel) => readFileSync(path.join(mobile, rel), 'utf8');

let failures = 0;
const check = (c, m) => { if (c) console.log(`✓ ${m}`); else { console.error(`✗ ${m}`); failures++; } };

const cand = (over = {}) => ({ state: 'connected', callSid: 'CA1', from: '+447700900123', connectedAtMs: 5000, muted: false, ...over });

// ── 1. What gets recovered ─────────────────────────────────────────────
{
  const pick = pickRecoverableCall(IDLE_CALL, [cand()]);
  check(pick && pick.index === 0 && pick.event.type === 'recovered' && pick.event.status === 'connected', 'a connected call the SDK holds is recovered');
  check(pick.event.callSid === 'CA1' && pick.event.from === '+447700900123' && pick.event.connectedAtMs === 5000, 'recovered call keeps SID, caller and the SDK connected timestamp');
  check(pickRecoverableCall(IDLE_CALL, [cand({ state: 'reconnecting' })]).event.status === 'reconnecting', 'reconnecting call recovered');
  const connecting = pickRecoverableCall(IDLE_CALL, [cand({ state: 'connecting', connectedAtMs: null })]);
  check(connecting.event.status === 'connecting' && connecting.event.connectedAtMs === null, 'a call still connecting (accept in progress) recovered as Connecting…');
  check(pickRecoverableCall(IDLE_CALL, [cand({ state: 'disconnected' })]) === null, 'a disconnected call is never recovered');
  check(pickRecoverableCall(IDLE_CALL, [cand({ state: 'ringing' })]) === null, '"ringing" (outgoing-call state; HCG places none) is never recovered');
  check(pickRecoverableCall(IDLE_CALL, [cand({ state: undefined })]) === null && pickRecoverableCall(IDLE_CALL, [cand({ state: 'weird' })]) === null, 'unknown/missing state → nothing recovered (fail safe: behaviour as before)');
  check(pickRecoverableCall(IDLE_CALL, []) === null && pickRecoverableCall(IDLE_CALL, null) === null && pickRecoverableCall(IDLE_CALL, undefined) === null, 'no calls / bad input → nothing');
  const two = pickRecoverableCall(IDLE_CALL, [cand({ state: 'connecting', callSid: 'CA_A' }), cand({ state: 'connected', callSid: 'CA_B' })]);
  check(two.index === 1 && two.event.callSid === 'CA_B', 'with several calls, the connected one wins over one still connecting');
  check(pickRecoverableCall(IDLE_CALL, [cand({ muted: true })]).event.muted === true && pickRecoverableCall(IDLE_CALL, [cand({ muted: null })]).event.muted === false, 'mute state taken from the SDK (unknown → not muted)');
  check(pickRecoverableCall(IDLE_CALL, [cand({ callSid: '' })]).event.callSid === null && pickRecoverableCall(IDLE_CALL, [cand({ connectedAtMs: NaN })]).event.connectedAtMs === null, 'bad SID / timestamp sanitised to null');
}

// ── 2. Never fights a call this process already tracks ───────────────────
{
  const live = reduceActiveCall(IDLE_CALL, { type: 'accepted', callSid: 'CA_LIVE', from: null });
  check(pickRecoverableCall(live, [cand()]) === null, 'already showing a call → recovery does nothing');
  const ev = pickRecoverableCall(IDLE_CALL, [cand()]).event;
  check(reduceActiveCall(live, ev) === live, 'a recovered snapshot never overwrites a live call (reducer guard)');
}

// ── 3. Reducer: the screen shows with working state ─────────────────────
{
  const ev = { ...pickRecoverableCall(IDLE_CALL, [cand({ muted: true })]).event, speaker: true };
  const s = reduceActiveCall(IDLE_CALL, ev);
  check(shouldShowCallScreen(s) && s.status === 'connected', 'recovered connected call → call screen shown');
  check(s.muted === true && s.speaker === true && s.connectedAtMs === 5000, 'mute/speaker/timer reflect the real call');
  check(statusLabel(s, 47000) === '0:42', 'timer counts from the SDK connected time, not from app start');
  const ending = reduceActiveCall(s, { type: 'end_requested' });
  check(ending.status === 'ending' && reduceActiveCall(ending, { type: 'ended' }) === IDLE_CALL, 'End call works on a recovered call (ending → idle)');
  check(reduceActiveCall(s, { type: 'muted', muted: false }).muted === false, 'Mute toggles on a recovered call');
  const c = reduceActiveCall(IDLE_CALL, pickRecoverableCall(IDLE_CALL, [cand({ state: 'connecting', connectedAtMs: 1 })]).event);
  check(c.connectedAtMs === null && reduceActiveCall(c, { type: 'connected', atMs: 9000 }).connectedAtMs === 9000, 'connecting snapshot ignores a stale timestamp; the live Connected event starts the timer');
  const next = reduceActiveCall(reduceActiveCall(s, { type: 'ended' }), { type: 'accepted', callSid: 'CA2', from: null });
  check(!next.muted && !next.speaker, 'the next call never inherits a recovered call\'s mute/speaker');
}

// ── 4. Retry schedule ───────────────────────────────────────────────────
{
  check(RECOVERY_RETRY_DELAYS_MS[0] === 0 && RECOVERY_RETRY_DELAYS_MS.length >= 3 && RECOVERY_RETRY_DELAYS_MS.every((d, i, a) => i === 0 || d > a[i - 1]), 'checks immediately, then a few increasing retries (native accept may still be completing)');
  check(Math.max(...RECOVERY_RETRY_DELAYS_MS) <= 10000, 'retries stop within 10 s (no polling)');
}

// ── 5. Wiring (source) ─────────────────────────────────────────────────
{
  const vc = read('lib/voiceClient.ts');
  check(/await withTimeout\(voice\.getCalls\(\), RECOVERY_SDK_TIMEOUT_MS\)/.test(vc), 'recovery uses the SDK\'s own voice.getCalls(), bounded by a timeout');
  check(/\nscheduleCallRecovery\("start"\);/.test(vc), 'recovery scheduled at module load (every cold start; _layout imports voiceClient first)');
  const fg = vc.slice(vc.indexOf('AppState.addEventListener("change"'));
  check(/scheduleCallRecovery\("foreground"\)/.test(fg.slice(0, 300)), 'recovery repeated on every foreground');
  const rec = vc.slice(vc.indexOf('export function recoverActiveCall'), vc.indexOf('function scheduleCallRecovery'));
  check(/pickRecoverableCall\(activeCallState/.test(rec) && /attachCallListeners\(call\)/.test(rec), 'decision comes from the pure model; recovered call gets the same Disconnected/Reconnecting listeners');
  check(/if \(activeCall \|\| activeCallState\.status !== "idle"\) return/.test(rec), 're-checks after each await so a live CallInvite.Accepted always wins the race');
  check(!/\.accept\(|\.reject\(|\.connect\(/.test(rec), 'recovery never answers, rejects or places a call');
  check(/catch \(err\)[\s\S]{0,200}console\.warn\("VOICE DEBUG: active call recovery failed"/.test(rec), 'a recovery failure is swallowed (behaviour as before, next foreground retries)');
  check(/!seenCallSids\.has\(sid\) && !recoveredCallSids\.has\(sid\)/.test(rec), 'outcome telemetry only for invites this process never saw, once per SID');
  check(/if \(!\(await hasOngoingSdkCall\(\)\)\) \{\s*await selectSpeakerForRinging\(\);/.test(vc), 'ringing-time Speaker selection skipped while a call is live (a recovered call is never moved to the loudspeaker)');
  const accepted = vc.slice(vc.indexOf('callInvite.on(CallInvite.Event.Accepted, (acceptedCall: Call) => {'));
  check(/trackAcceptedCall\(acceptedCall, callSid\)/.test(accepted.slice(0, 600)), 'the live CallInvite.Accepted path is unchanged');
  check(/call\.on\(Call\.Event\.Disconnected, clear\)/.test(vc) && /call\.on\(Call\.Event\.ConnectFailure, clear\)/.test(vc), 'disconnect / connect failure still clear the screen');
  const sdkTypes = (() => { try { return read('node_modules/@twilio/voice-react-native-sdk/lib/typescript/Voice.d.ts'); } catch { return null; } })();
  if (sdkTypes) check(/getCalls\(\): Promise<ReadonlyMap<Uuid, Call>>/.test(sdkTypes), 'installed SDK exposes Voice.getCalls() with the expected signature');
  else console.log('  (SDK typings not installed in this checkout — signature check skipped)');
}

console.log(failures === 0 ? '\nH5 cold-start call recovery: all checks hold.' : `\n${failures} check(s) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
