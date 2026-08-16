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
import { Voice, CallInvite, Call } from "@twilio/voice-react-native-sdk";
import { Platform, AppState } from "react-native";
import { fetchVoiceToken } from "./api";

const voice = new Voice();

let activeCall: Call | null = null;
let registered = false;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

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

export async function registerForIncomingCalls(): Promise<void> {
  console.log("VOICE DEBUG: registerForIncomingCalls called, registered=", registered);
  if (registered) {
    console.log("VOICE DEBUG: already registered, skipping");
    return;
  }

  if (Platform.OS === "ios") {
    // Delegates PushKit device-token handling and incoming-push wake-up
    // to the SDK itself, rather than requiring us to write a native
    // PushKit delegate module — the SDK is "tightly integrated with the
    // iOS CallKit framework" per Twilio's own getting-started-ios.md, and
    // this is the one call needed to opt into that integration from the
    // JS side.
    await voice.initializePushRegistry();
  }

  console.log("VOICE DEBUG: about to fetchVoiceToken");
  const { token, ttlSeconds } = await fetchVoiceToken();
  console.log("VOICE DEBUG: fetchVoiceToken resolved, about to voice.register");
  await voice.register(token);
  console.log("VOICE DEBUG: voice.register resolved");
  registered = true;
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
  console.log("Voice SDK: CallInvite received", callInvite.getCallSid());
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
