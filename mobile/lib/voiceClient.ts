// Minimum same-phone delivery client — registers this device with Twilio's
// Voice SDK so an approved call can ring on THIS handset directly, never
// via a PSTN dial-back into the customer's own number (which loops into
// their own active carrier forwarding — see
// docs/operations/HANDOVER_2026-08-15.md §12-13 for the full incident).
//
// Deliberately minimal for the same-phone proof-of-concept milestone:
// register for incoming calls and auto-accept them so two-way audio can
// be verified on a real device. No UI, no CallKit customisation yet —
// see the remaining TODO below for what "harden later" adds on top of
// this.
import { Voice, CallInvite, Call, AudioDevice } from "@twilio/voice-react-native-sdk";
import { Platform, AppState } from "react-native";
import { fetchVoiceToken } from "./api";

const voice = new Voice();

let activeCall: Call | null = null;
let registered = false;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

// Guards against two concurrent registration attempts — proven necessary
// 2026-08-23 on a real device: the (tabs) layout's session-gated effect
// and this file's own AppState "active" listener (below) both call
// registerForIncomingCalls() independently, and both only checked the
// `registered` boolean, which stays false until the WHOLE async flow
// completes. On a cold launch both fire within the same tick, both pass
// the `if (registered) return` check, and both proceed to call
// voice.register() — resulting in two live Voice SDK registrations for
// the same identity, which is what caused a single Twilio call to
// present two separate CallKit incoming-call screens (confirmed via
// physical-device testing: one Twilio call leg, two CallKit UIs,
// answering either failed). This promise makes a second overlapping call
// await the first attempt's outcome instead of starting its own.
let inFlightRegistration: Promise<void> | null = null;

// Defense in depth alongside the in-flight guard above: even if the SDK
// itself were ever asked to register twice in the future, a single
// underlying Twilio call should never be presented to CallKit more than
// once on this device. Tracks call SIDs already seen this session.
const seenCallSids = new Set<string>();

// Re-register well before the token actually expires, never at the exact
// edge — a call arriving in the gap between expiry and a completed
// refresh would simply never ring. 5 minutes of margin against a 1 hour
// TTL (services/voiceAccessToken.js's DEFAULT_TTL_SECONDS) is generous
// relative to how long a single register() round trip takes.
const REFRESH_MARGIN_SECONDS = 300;

function scheduleRefresh(ttlSeconds: number): void {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
  }

  const delayMs = Math.max(ttlSeconds - REFRESH_MARGIN_SECONDS, 30) * 1000;

  refreshTimer = setTimeout(() => {
    registered = false;
    registerForIncomingCalls().catch((err) => {
      console.error("VOICE TOKEN REFRESH FAILED:", err);
      // Retry sooner than a full cycle rather than silently going dark
      // for up to an hour on a transient failure (network blip, backend
      // briefly unavailable) — 60s matches this codebase's existing
      // "caller retries with a fresh credential" pattern
      // (middleware/requireAuthApi.js) rather than an unbounded loop.
      refreshTimer = setTimeout(() => {
        registered = false;
        registerForIncomingCalls().catch((retryErr) =>
          console.error("VOICE TOKEN REFRESH RETRY FAILED:", retryErr)
        );
      }, 60_000);
    });
  }, delayMs);
}

// Twilio's AudioSwitch (Android, com.twilio:audioswitch 1.2.2) defaults
// to Earpiece over Speakerphone when nothing is plugged in — confirmed
// directly against that library's source, defaultPreferredDeviceList is
// [BluetoothHeadset, WiredHeadset, Earpiece, Speakerphone]. The incoming
// -call ringtone (native MediaPlayerManager, USAGE_VOICE_COMMUNICATION)
// plays through whatever device AudioSwitch currently has selected, so
// on a bare phone it plays out of the earpiece: technically ringing,
// inaudible in normal use. Explicitly selecting Speaker here — once,
// right after register, well before any call can arrive — records it as
// AudioSwitch's userSelectedDevice, which persists across
// re-enumeration and is what VoiceService.incomingCall()'s
// audioSwitch.activate() applies when the ring actually starts. Failures
// are swallowed deliberately: this is a best-effort audibility
// improvement, never something that should block registration or break
// an otherwise-working call.
async function selectSpeakerForRinging(): Promise<void> {
  try {
    const { audioDevices } = await voice.getAudioDevices();
    const speaker = audioDevices.find((device) => device.type === AudioDevice.Type.Speaker);
    if (!speaker) {
      if (__DEV__) {
        console.warn(
          "VOICE DEBUG: no Speaker audio device found, available:",
          audioDevices.map((device) => device.type)
        );
      }
      return;
    }
    await speaker.select();
    if (__DEV__) {
      console.log("VOICE DEBUG: Speaker audio device selected for ringing");
    }
  } catch (err) {
    if (__DEV__) {
      console.warn("VOICE DEBUG: failed to select Speaker audio device:", err);
    }
  }
}

// TEMPORARY diagnostic beacon (2026-08-23 physical iOS Voice SDK
// verification pass) — reports registration progress to the backend
// since iOS redacts on-device console output by default and there is no
// other way to observe a release-mode build's progress remotely. Never
// blocks or throws; remove once CallKit reception is confirmed working.
function beacon(stage: string, detail?: string): void {
  try {
    const base = process.env.EXPO_PUBLIC_API_BASE_URL;
    if (!base) return;
    fetch(`${base}/debug/voice-beacon`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stage, detail, platform: Platform.OS }),
    }).catch(() => {});
  } catch {
    // never let diagnostics break the real registration flow
  }
}

export async function registerForIncomingCalls(accessToken?: string): Promise<void> {
  console.log("VOICE DEBUG: registerForIncomingCalls called, registered=", registered);
  beacon("start");
  if (registered) {
    console.log("VOICE DEBUG: already registered, skipping");
    beacon("already-registered");
    return;
  }

  if (inFlightRegistration) {
    console.log("VOICE DEBUG: registration already in flight, awaiting it instead of starting another");
    beacon("awaiting-in-flight");
    return inFlightRegistration;
  }

  inFlightRegistration = performRegistration(accessToken).finally(() => {
    inFlightRegistration = null;
  });
  return inFlightRegistration;
}

async function performRegistration(accessToken?: string): Promise<void> {
  let ttlSeconds: number;
  try {
    if (Platform.OS === "ios") {
      // Delegates PushKit device-token handling and incoming-push wake-up
      // to the SDK itself, rather than requiring us to write a native
      // PushKit delegate module — the SDK is "tightly integrated with the
      // iOS CallKit framework" per Twilio's own getting-started-ios.md, and
      // this is the one call needed to opt into that integration from the
      // JS side.
      beacon("pushRegistry-start");
      await voice.initializePushRegistry();
      beacon("pushRegistry-done");
    }

    console.log("VOICE DEBUG: about to fetchVoiceToken");
    beacon("tokenFetch-start");
    const tokenResult = await fetchVoiceToken(accessToken);
    ttlSeconds = tokenResult.ttlSeconds;
    const { token } = tokenResult;
    beacon("tokenFetch-done");
    console.log("VOICE DEBUG: fetchVoiceToken resolved, about to voice.register");
    beacon("voiceRegister-start");
    await voice.register(token);
    beacon("voiceRegister-done");
    console.log("VOICE DEBUG: voice.register resolved");
  } catch (err) {
    beacon("error", err instanceof Error ? `${err.name}: ${err.message}` : String(err));
    throw err;
  }
  registered = true;
  if (Platform.OS === "android") {
    // Android-only: see selectSpeakerForRinging's own comment for why —
    // AudioSwitch's Earpiece-first default is an Android/AudioSwitch-
    // specific behaviour with no CallKit equivalent. On iOS, incoming-call
    // audio routing is owned entirely by CallKit; explicitly selecting a
    // device here would be untested and could affect the connected call's
    // routing too, not just the ring.
    await selectSpeakerForRinging();
  }
  scheduleRefresh(ttlSeconds);
}

// A backgrounded/suspended app's JS timers don't reliably fire on
// schedule (iOS especially suspends JS execution entirely) — re-checking
// on every foreground transition means a stale/near-expired token can't
// silently sit unrefreshed through a long background period. Cheap no-op
// when already registered and well within TTL (registerForIncomingCalls
// only does real work when `registered` is false).
AppState.addEventListener("change", (state) => {
  if (state === "active" && !registered) {
    registerForIncomingCalls().catch((err) => {
      console.error("VOICE REGISTRATION ON FOREGROUND FAILED:", err);
    });
  }
});

// Deliberately NOT auto-accepting (temporary, for the same-phone-ringing
// proof specifically — see docs/operations/HANDOVER_2026-08-15.md
// follow-up, 2026-08-16): auto-accept was proving two-way audio can
// connect, but skipped past the customer-visible part of the milestone
// entirely — a real approved call must audibly/visibly ring on the
// handset and wait for a real answer action, which auto-accept
// short-circuits before the native incoming-call notification/ringtone
// even has a chance to be perceived. Leaving the CallInvite unaccepted
// here lets the SDK's own native Android notification (created
// automatically by VoiceFirebaseMessagingService → VoiceService — see
// node_modules/@twilio/voice-react-native-sdk's NotificationUtility)
// show the real ring + Answer action; tapping Answer there accepts
// natively, no JS call needed. Revert to a real in-app UI later
// (original TODO) once this is proven, not to this auto-accept shortcut.
voice.on(Voice.Event.CallInvite, (callInvite: CallInvite) => {
  const callSid = callInvite.getCallSid();

  // Defense in depth (2026-08-23, see inFlightRegistration's own comment
  // for the actual root cause this was found alongside): one underlying
  // Twilio call must only ever be presented to CallKit once on this
  // device. If two invites for the same call SID ever arrive — from a
  // duplicate registration this guard didn't prevent, or a genuine
  // duplicate/retried VoIP push — reject the second instead of letting a
  // second incoming-call UI appear for a call the customer is already
  // being shown.
  if (seenCallSids.has(callSid)) {
    console.warn("VOICE DEBUG: duplicate CallInvite for already-seen callSid, rejecting", callSid);
    beacon("duplicate-call-invite-rejected", callSid);
    callInvite.reject().catch((err) => {
      console.error("VOICE DEBUG: failed to reject duplicate CallInvite", err);
    });
    return;
  }
  seenCallSids.add(callSid);

  console.log("Voice SDK: CallInvite received", callSid);
});

voice.on(Voice.Event.Registered, () => {
  console.log("Voice SDK: registered for incoming calls");
});

voice.on(Voice.Event.Unregistered, () => {
  console.log("Voice SDK: unregistered");
  registered = false;
});

voice.on(Voice.Event.Error, (error) => {
  console.error("VOICE SDK ERROR:", error);
});

export function getActiveCall(): Call | null {
  return activeCall;
}
