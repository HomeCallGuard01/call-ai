// Minimum same-phone delivery client — registers this device with Twilio's
// Voice SDK so an approved call can ring on THIS handset directly, never
// via a PSTN dial-back into the customer's own number (which loops into
// their own active carrier forwarding — see
// docs/operations/HANDOVER_2026-08-15.md §12-13 for the full incident).
//
// Deliberately minimal for the same-phone proof-of-concept milestone:
// register for incoming calls and auto-accept them so two-way audio can
// be verified on a real device. No UI, no CallKit customisation, no
// re-registration/refresh handling yet — see the TODOs below for what
// "harden later" adds on top of this.
import { Voice, CallInvite, Call } from "@twilio/voice-react-native-sdk";
import { Platform } from "react-native";
import { fetchVoiceToken } from "./api";

const voice = new Voice();

let activeCall: Call | null = null;
let registered = false;

// TODO (harden later): re-fetch and re-register before ttlSeconds
// elapses, rather than only once at app start — see
// lib/api.ts's fetchVoiceToken comment.
export async function registerForIncomingCalls(): Promise<void> {
  if (registered) {
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

  const { token } = await fetchVoiceToken();
  await voice.register(token);
  registered = true;
}

// TODO (harden later): a real UI screen instead of auto-accept — the
// milestone-1 proof only needs to prove two-way audio actually connects
// on a real device; a customer-facing accept/reject UI belongs to the
// CallKit-driven native call screen (iOS) / notification (Android), not
// to this module, and comes after the fundamental path is proven.
voice.on(Voice.Event.CallInvite, async (callInvite: CallInvite) => {
  try {
    activeCall = await callInvite.accept();
  } catch (err) {
    console.error("VOICE CALL INVITE ACCEPT FAILED:", err);
  }
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
