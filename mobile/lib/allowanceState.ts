// Allowance state for the Home screen (WS3, 2026-10-10). Pure and import-free
// so tests/mobile-allowance-state.test.mjs runs it under plain Node.
//
// WS2 (financial workstream) owns the server contract. This file is a
// TOLERANT reader of the contract WS3 assumed (docs/launch/2026-10-10-WS3-
// REPORT.md §"Assumed allowance contract"):
//
//   GET /api/v1/me/dashboard → allowanceState?: {
//     version?: 1,
//     state: "normal" | "screening_low" | "screening_paused" | "continuity_low" | "hard_ceiling",
//     percentUsed: number | null,          // 0–100 (values above 100 are clamped)
//     screeningActive: boolean | null,     // true only when unknown callers are being checked NOW
//     resetsAt?: string | null,            // ISO date the allowance resets
//     trustedCallersContinue?: boolean | null, // hard_ceiling: trusted callers still connect
//   }
//   (also accepted at customerAllowance.allowanceState)
//
// Rules this file guarantees (tests assert each one):
//   1. Missing / malformed payload → null → the Home screen behaves exactly
//      as before this change.
//   2. An unknown state string is never guessed. It is ignored UNLESS the
//      server says screeningActive === false, in which case the app shows
//      the generic "not being checked" wording (never "Protected").
//   3. "Protected" is suppressed for every state in which unknown callers
//      are not being checked (screening_paused, continuity_low,
//      hard_ceiling, or screeningActive === false).
//   4. Nothing here claims forwarding turns itself off. Returning the phone
//      to normal is always a customer action (Turn off call forwarding).
//   5. Google Play (Option C, consumption-only Android app): no purchase
//      button, link, price or QR — at most plain, non-tappable text. iOS:
//      no top-up wording at all (App Store anti-steering).
//
// DRAFT customer wording — needs Andrew's approval before release.

export type AllowanceStateKey = "normal" | "screening_low" | "screening_paused" | "continuity_low" | "hard_ceiling";

export interface AllowanceStateView {
  /** "unknown" = a state string this app version doesn't know (only kept when screeningActive === false). */
  state: AllowanceStateKey | "unknown";
  percentUsed: number | null;
  screeningActive: boolean | null;
  resetsAt: string | null;
  trustedCallersContinue: boolean | null;
}

const KNOWN_STATES: readonly string[] = ["normal", "screening_low", "screening_paused", "continuity_low", "hard_ceiling"];
const NOT_SCREENING_STATES: readonly string[] = ["screening_paused", "continuity_low", "hard_ceiling"];

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Reads allowanceState from a dashboard response (or the object itself). Null = show nothing new. */
export function parseAllowanceState(dashboard: unknown): AllowanceStateView | null {
  if (!isObject(dashboard)) return null;
  let raw: unknown = dashboard.allowanceState;
  if (!isObject(raw) && isObject(dashboard.customerAllowance)) raw = (dashboard.customerAllowance as Record<string, unknown>).allowanceState;
  return readAllowanceStateObject(raw);
}

/** Parses the allowanceState object itself. Null = show nothing new. */
export function readAllowanceStateObject(raw: unknown): AllowanceStateView | null {
  if (!isObject(raw)) return null;
  // A future, incompatible contract version is not guessed at.
  if (raw.version !== undefined && raw.version !== 1) return null;

  const screeningActive = typeof raw.screeningActive === "boolean" ? raw.screeningActive : null;
  const pct = typeof raw.percentUsed === "number" && Number.isFinite(raw.percentUsed) ? Math.max(0, Math.min(100, Math.round(raw.percentUsed))) : null;
  const resetsAt = typeof raw.resetsAt === "string" && raw.resetsAt ? raw.resetsAt : null;
  const trustedCallersContinue = typeof raw.trustedCallersContinue === "boolean" ? raw.trustedCallersContinue : null;

  let state: AllowanceStateView["state"];
  if (typeof raw.state === "string" && KNOWN_STATES.includes(raw.state)) {
    state = raw.state as AllowanceStateKey;
    // Contradiction (should be impossible): a "screening" state while the
    // server also says screening is off. Fail towards the truthful,
    // less reassuring reading.
    if ((state === "normal" || state === "screening_low") && screeningActive === false) state = "unknown";
  } else if (screeningActive === false) {
    state = "unknown";
  } else {
    return null;
  }
  return { state, percentUsed: pct, screeningActive, resetsAt, trustedCallersContinue };
}

/** True when the app must NOT show "Protected" (unknown callers aren't being checked). */
export function suppressesProtected(view: AllowanceStateView | null | undefined): boolean {
  if (!view) return false;
  return view.screeningActive === false || NOT_SCREENING_STATES.includes(view.state) || view.state === "unknown";
}

export type AllowanceBannerTone = "notice" | "warning" | "critical";

export interface AllowanceBanner {
  tone: AllowanceBannerTone;
  title: string;
  body: string;
  /** Plain text only — never a link, button, price or QR (Play Option C). Null on iOS. */
  moreNote: string | null;
  /** Show the "Turn off call forwarding" action (opens the guided screen; the customer presses Call). */
  offerTurnOffForwarding: boolean;
  /** Plain explanation shown next to the action. */
  turnOffExplainer: string | null;
}

// Android (Option C): plain, non-tappable text. Deliberately NOT "Top-ups are
// arranged on our website": no web top-up exists today, so that would be
// untrue. Swap to that wording only once a web top-up is live (decision for
// Andrew). An email address in plain text is allowed communication; it is not
// rendered as a mailto link here.
export const ANDROID_MORE_NOTE = "If you need more before then, email support@homecallguard.co.uk.";

export const TURN_OFF_EXPLAINER =
  "If you'd rather your phone worked exactly as it did before Home Call Guard, you can turn off call forwarding. You'll need to press Call in your Phone app — we can't do it for you.";

export const TURN_OFF_FORWARDING_LABEL = "Turn off call forwarding";

export function formatResetDay(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: "Europe/London" });
}

export function describeAllowanceBanner(view: AllowanceStateView | null | undefined, platform: string): AllowanceBanner | null {
  if (!view) return null;
  const resets = formatResetDay(view.resetsAt);
  const until = resets ? ` until your allowance resets on ${resets}` : " until your allowance resets";
  const moreNote = platform === "android" ? ANDROID_MORE_NOTE : null;

  switch (view.state) {
    case "normal":
      return null;
    case "screening_low":
      return {
        tone: "notice",
        title: "Call checking is running low",
        body:
          view.percentUsed !== null
            ? `You've used ${view.percentUsed}% of this month's call checking. Unknown callers are still being checked.`
            : "You've used most of this month's call checking. Unknown callers are still being checked.",
        moreNote,
        offerTurnOffForwarding: false,
        turnOffExplainer: null,
      };
    case "screening_paused":
      return {
        tone: "warning",
        title: "Screening paused",
        body: `Screening paused — calls are still reaching you, but unknown callers are not being checked${until}.`,
        moreNote,
        offerTurnOffForwarding: true,
        turnOffExplainer: TURN_OFF_EXPLAINER,
      };
    case "continuity_low":
      return {
        tone: "critical",
        title: "Calls may soon stop coming through",
        body:
          "Unknown callers are not being checked, and calls forwarded to Home Call Guard may soon stop reaching you. To keep getting every call, turn off call forwarding so calls ring your phone directly.",
        moreNote,
        offerTurnOffForwarding: true,
        turnOffExplainer: TURN_OFF_EXPLAINER,
      };
    case "hard_ceiling":
      return {
        tone: "critical",
        title: "Calls may not be reaching you",
        body:
          view.trustedCallersContinue === true
            ? `Calls from people you trust still get through. Other calls forwarded to Home Call Guard may not reach you${until}. Turn off call forwarding so every call rings your phone directly.`
            : `Calls forwarded to Home Call Guard may not reach you${until}. Turn off call forwarding so calls ring your phone directly.`,
        moreNote,
        offerTurnOffForwarding: true,
        turnOffExplainer: TURN_OFF_EXPLAINER,
      };
    case "unknown":
    default:
      return {
        tone: "warning",
        title: "Unknown callers aren't being checked",
        body: "Calls from unknown numbers aren't being checked for scams right now. Pull down to refresh, or contact us if this continues.",
        moreNote: null,
        offerTurnOffForwarding: false,
        turnOffExplainer: null,
      };
  }
}

/** Hero wording when "Protected" is suppressed by the allowance state. */
export function allowanceHeroBody(view: AllowanceStateView): string {
  switch (view.state) {
    case "hard_ceiling":
      return view.trustedCallersContinue === true
        ? "This month's allowance is used up. People you trust still get through, but other forwarded calls may not reach you."
        : "This month's allowance is used up. Calls forwarded to Home Call Guard may not reach you.";
    case "continuity_low":
      return "Unknown callers aren't being checked, and forwarded calls may soon stop reaching you.";
    case "screening_paused":
      return "Screening paused — calls are still reaching you, but unknown callers are not being checked.";
    default:
      return "Calls from unknown numbers aren't being checked for scams right now.";
  }
}
