// Active-call state for the in-app call screen (DT-1, 2026-10-05). Pure: no
// React Native or Twilio imports, so tests/mobile-active-call.test.mjs can
// load it directly in Node.
//
// Real-device finding DT-1 (iOS 1.0.2 Build 16, staging, 5 Oct): an incoming
// HCG call rang through CallKit and was answered on the banner; iOS then
// brought HCG to the foreground — which is what iOS does for a CallKit app
// answered on an UNLOCKED phone: the app is expected to show its own in-call
// screen. HCG had none (voiceClient never even kept the answered Call), so
// the customer lost the obvious way to hang up and ended it from the caller's
// phone. This model drives a simple full-screen call screen (End call, Mute,
// Speaker) shown while a call is active; ringing and answering stay with
// CallKit (iOS) / the SDK notification (Android), unchanged.
export type ActiveCallStatus = "idle" | "connecting" | "connected" | "reconnecting" | "ending";

export interface ActiveCallState {
  status: ActiveCallStatus;
  callSid: string | null;
  from: string | null;
  connectedAtMs: number | null;
  muted: boolean;
  speaker: boolean;
  /** Last control action that failed, shown as plain guidance. */
  error: "end_failed" | "mute_failed" | "speaker_failed" | null;
}

export type ActiveCallEvent =
  | { type: "accepted"; callSid: string | null; from: string | null }
  // H5 cold-start recovery (2026-10-10): a call the SDK already holds when
  // the app (re)starts or returns to the foreground — e.g. answered from the
  // notification while the app was killed, so the JS CallInvite.Accepted
  // event never fired in this process.
  | {
      type: "recovered";
      callSid: string | null;
      from: string | null;
      status: "connecting" | "connected" | "reconnecting";
      connectedAtMs: number | null;
      muted: boolean;
      speaker: boolean;
    }
  | { type: "connected"; atMs: number }
  | { type: "reconnecting" }
  | { type: "reconnected" }
  | { type: "end_requested" }
  | { type: "ended" }
  | { type: "muted"; muted: boolean }
  | { type: "speaker"; speaker: boolean }
  | { type: "control_failed"; control: "end" | "mute" | "speaker" };

export const IDLE_CALL: ActiveCallState = Object.freeze({
  status: "idle",
  callSid: null,
  from: null,
  connectedAtMs: null,
  muted: false,
  speaker: false,
  error: null,
}) as ActiveCallState;

export function reduceActiveCall(state: ActiveCallState, event: ActiveCallEvent): ActiveCallState {
  switch (event.type) {
    case "accepted":
      // A new answered call always starts clean (never inherits mute/speaker).
      return { ...IDLE_CALL, status: "connecting", callSid: event.callSid, from: event.from };
    case "recovered":
      // Never overwrite a call this process is already tracking (its own
      // events are more current than a snapshot).
      if (state.status !== "idle") return state;
      return {
        ...IDLE_CALL,
        status: event.status,
        callSid: event.callSid,
        from: event.from,
        connectedAtMs: event.status === "connecting" ? null : event.connectedAtMs,
        muted: event.muted === true,
        speaker: event.speaker === true,
      };
    case "connected":
      if (state.status === "idle") return state;
      return { ...state, status: "connected", connectedAtMs: state.connectedAtMs ?? event.atMs, error: null };
    case "reconnecting":
      return state.status === "idle" ? state : { ...state, status: "reconnecting" };
    case "reconnected":
      return state.status === "idle" ? state : { ...state, status: "connected" };
    case "end_requested":
      return state.status === "idle" ? state : { ...state, status: "ending", error: null };
    case "ended":
      return IDLE_CALL;
    case "muted":
      return state.status === "idle" ? state : { ...state, muted: event.muted, error: null };
    case "speaker":
      return state.status === "idle" ? state : { ...state, speaker: event.speaker, error: null };
    case "control_failed":
      if (state.status === "idle") return state;
      // A failed hang-up returns to the live call so the button stays usable.
      return {
        ...state,
        status: event.control === "end" ? (state.connectedAtMs !== null ? "connected" : "connecting") : state.status,
        error: event.control === "end" ? "end_failed" : event.control === "mute" ? "mute_failed" : "speaker_failed",
      };
    default:
      return state;
  }
}

// ── H5 cold-start recovery (2026-10-10) ───────────────────────────────────
// Launch-blocker risk H5 (2026-10-09-ANDROID-HANDSET-VERIFICATION-PLAN.md):
// the call screen was fed ONLY by the JS CallInvite.Accepted event. When the
// customer answers from the notification while HCG is killed (Android) or the
// JS bridge is not yet running (iOS cold launch from a VoIP push), that event
// fires in no JS listener, so an already-connected call had no HCG screen and
// no in-app way to hang up. voiceClient.ts asks the SDK for the calls it
// holds (Voice.getCalls(): "existing calls, ongoing and pending … will not
// return any call that has finished") on start and on every foreground, and
// this pure function decides whether one should be shown.
//
// SDK Call.State values (2.0.0-preview.2): connected | connecting |
// disconnected | reconnecting | ringing. "ringing" is an OUTGOING-call state
// (HCG places none) and "disconnected" is over, so neither is recovered.
export interface RecoveryCandidate {
  state: string | null | undefined;
  callSid: string | null | undefined;
  from: string | null | undefined;
  /** Call.getInitialConnectedTimestamp() in ms since epoch, if known. */
  connectedAtMs: number | null | undefined;
  muted: boolean | null | undefined;
}

const RECOVERABLE_STATES = ["connected", "reconnecting", "connecting"];

export function pickRecoverableCall(
  current: ActiveCallState,
  candidates: readonly RecoveryCandidate[] | null | undefined
): { index: number; event: Extract<ActiveCallEvent, { type: "recovered" }> } | null {
  // Already showing a call: the live listeners own it.
  if (current.status !== "idle") return null;
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  // Prefer a connected call, then reconnecting, then connecting.
  for (const wanted of RECOVERABLE_STATES) {
    const index = candidates.findIndex((c) => c && c.state === wanted);
    if (index === -1) continue;
    const c = candidates[index];
    const connectedAtMs = typeof c.connectedAtMs === "number" && Number.isFinite(c.connectedAtMs) ? c.connectedAtMs : null;
    return {
      index,
      event: {
        type: "recovered",
        callSid: typeof c.callSid === "string" && c.callSid ? c.callSid : null,
        from: typeof c.from === "string" ? c.from : null,
        status: wanted as "connecting" | "connected" | "reconnecting",
        connectedAtMs,
        muted: c.muted === true,
        speaker: false,
      },
    };
  }
  return null;
}

// When to look: immediately, then a few short retries, because on a cold
// start the native accept can still be completing when JS first runs.
export const RECOVERY_RETRY_DELAYS_MS: readonly number[] = Object.freeze([0, 1500, 4000, 8000]);

/** The call screen is shown for every non-idle state (including while ending). */
export function shouldShowCallScreen(state: ActiveCallState): boolean {
  return state.status !== "idle";
}

/** "0:42", "12:05", "1:02:09". */
export function formatCallDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** Caller line: a UK number in readable form, or a neutral label. Never a raw Twilio client identity. */
export function displayCaller(from: string | null | undefined): string {
  if (!from || /^client:/i.test(from)) return "Incoming call";
  const digits = from.replace(/[^\d+]/g, "");
  if (/^\+44\d{10}$/.test(digits)) {
    const national = "0" + digits.slice(3);
    return national.startsWith("07") ? `${national.slice(0, 5)} ${national.slice(5)}` : `${national.slice(0, 3)} ${national.slice(3, 7)} ${national.slice(7)}`;
  }
  return digits || "Incoming call";
}

export function statusLabel(state: ActiveCallState, nowMs: number): string {
  switch (state.status) {
    case "connecting":
      return "Connecting…";
    case "reconnecting":
      return "Reconnecting…";
    case "ending":
      return "Ending call…";
    case "connected":
      return state.connectedAtMs !== null ? formatCallDuration(nowMs - state.connectedAtMs) : "Connected";
    default:
      return "";
  }
}

export const CALL_SCREEN_COPY = Object.freeze({
  title: "Call in progress",
  end: "End call",
  mute: "Mute",
  unmute: "Unmute",
  speakerOn: "Speaker",
  speakerOff: "Speaker off",
  endFailed: "We couldn't end the call from here. Press the button on the side of your phone to hang up.",
  muteFailed: "We couldn't change mute just now. Please try again.",
  speakerFailed: "We couldn't switch the speaker just now. Please try again.",
});
