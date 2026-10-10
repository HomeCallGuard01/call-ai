// Opening the native Phone app pre-filled with a code is the one thing
// every mobile platform allows an app to do without extra permissions —
// but neither iOS nor Android will place the call itself. Confirmed
// researching both platforms before this was built: tel: links (what
// Linking.openURL uses under the hood, RN's Linking.openURL('tel:...')
// on iOS, an ACTION_VIEW tel: intent on Android — the same intent shape
// as ACTION_DIAL, not ACTION_CALL) always hand off to the Phone/Dialer
// app pre-filled and require the customer to press the call button
// themselves. There is no entitlement, permission, or native module that
// lets a normal app place a call without that tap on either platform —
// ACTION_CALL (Android) would remove that tap, but requires the
// dangerous CALL_PHONE runtime permission and heavy Play Store
// justification for a use-case (activation) that happens once, which
// isn't worth it just to remove a single unavoidable tap.
//
// This is only ever safe to use for a device whose OWN line is being
// forwarded — iphone/android, never landline. See activate.tsx: a
// landline's forwarding code must be dialled from the physical landline
// handset, a different device entirely from the phone this app runs on.
// Opening this device's own dialer for a landline code wouldn't fail
// safely — it would silently attempt to forward THIS device's own
// mobile line instead, a real, harmful side effect the customer didn't
// ask for. canAutoOpenDialer exists so that mistake can't happen by
// accident at a call site.
export function canAutoOpenDialer(deviceType: string): boolean {
  return deviceType === "iphone" || deviceType === "android";
}

// '#' must be percent-encoded — left literal, some URL-parsing layers
// (both native and web) treat a bare '#' as a fragment separator and
// silently drop everything after it, which would submit an incomplete,
// invalid MMI code (e.g. "*21*07700900000" with no terminating '#' at
// all). '*' has no such special meaning in a URI and is safe to leave
// as-is — matches the pattern Apple's own documented tel: examples for
// feature/field-test codes use (e.g. *3001#12345#*, %23-encoded only at
// each '#').
// iOS (2026-09-30): Apple documents that the Phone app does not dial tel:
// links containing * or #. Whether iOS then shows the code pre-filled is
// unverified on a device, so the iOS screens always add this manual fallback
// under the dial button (the code and Copy code are already on screen).
export const IOS_MANUAL_DIAL_HINT =
  "If your iPhone doesn't start the call, tap Copy code, open the Phone app's Keypad, paste the code and press Call.";

export function buildDialerUrl(code: string): string {
  return `tel:${code.replace(/#/g, "%23")}`;
}

// ── "Turn off call forwarding" (WS3, 2026-10-10) ──────────────────────────
// The honest "return to normal mobile" path when screening is paused or the
// allowance ceiling is reached. Nothing about it is automatic: HCG cannot
// switch a customer's carrier forwarding off. On Android the app opens the
// Phone app (tel: with '#' encoded as %23 — the dialer shows the code and
// waits; ACTION_VIEW on tel: behaves as ACTION_DIAL, see the header above)
// and the customer presses Call. iOS does not reliably pre-fill MMI codes
// (IOS_MANUAL_DIAL_HINT above), so iPhone gets the code to dial by hand plus
// the Settings path. The cancel code itself always comes from the server
// (services/activationInstructions.js) — this only decides how to present it.

// 3GPP TS 22.030 / 22.082 standard MMI: "##" = erase, service code 21 =
// call forwarding unconditional. NOT confirmed for any specific UK network
// by HCG (the backend deliberately ships no code for EE, Lebara, Talkmobile
// and others), so it is only ever offered on Android, labelled as the
// standard code, with the Settings path and support as the fallback.
// Offering it at all is decision WS3-D2 for Andrew (flip to false to show
// only the Settings path for networks without a confirmed code).
export const STANDARD_FORWARDING_OFF_CODE = "##21#";
export const OFFER_STANDARD_FORWARDING_OFF_CODE = true;

export const STANDARD_CODE_CAVEAT =
  "We haven't confirmed a code for your network yet. ##21# is the standard code for switching off \"always forward\". If your phone doesn't show a message saying call forwarding is off, use your phone's call forwarding settings instead, or contact support and we'll help.";

export const ANDROID_FORWARDING_SETTINGS_PATH =
  "Or use your phone's settings: open the Phone app, tap the three dots (More), then Settings, then Calls or Supplementary services, then Call forwarding, and turn off \"Always forward\". The exact names vary by phone.";

export const AFTER_TURN_OFF_NOTE =
  "Once forwarding is off, calls ring your phone directly, the way they did before Home Call Guard, and unknown callers are not checked. To use Home Call Guard again later, turn call forwarding back on from Account.";

export type TurnOffMode = "carrier_code" | "standard_code" | "settings" | "support";

export interface TurnOffPlan {
  mode: TurnOffMode;
  /** The code to show (and dial, when openDialer). Null when there is none to show. */
  code: string | null;
  /** Android, mobile device only: offer "Open Phone app" (pre-filled; the customer presses Call). */
  openDialer: boolean;
  /** Shown under a standard (unconfirmed) code. */
  caveat: string | null;
}

export function planTurnOffForwarding(input: {
  deviceType: string | null | undefined;
  platform: string;
  cancelCode: string | null | undefined;
  cancelCodeMethod: string | null | undefined;
}): TurnOffPlan {
  const deviceType = input.deviceType ?? "";
  const code = typeof input.cancelCode === "string" && input.cancelCode.trim() ? input.cancelCode.trim() : null;
  const isMobile = canAutoOpenDialer(deviceType);
  // Opening THIS phone's dialer is only safe for this phone's own line
  // (never a landline — see canAutoOpenDialer) and only pre-fills on Android.
  const dialable = isMobile && input.platform === "android";

  if (code) return { mode: "carrier_code", code, openDialer: dialable, caveat: null };
  if (input.cancelCodeMethod === "native_settings") return { mode: "settings", code: null, openDialer: false, caveat: null };
  if (!isMobile) return { mode: "support", code: null, openDialer: false, caveat: null };
  if (dialable && OFFER_STANDARD_FORWARDING_OFF_CODE) {
    return { mode: "standard_code", code: STANDARD_FORWARDING_OFF_CODE, openDialer: true, caveat: STANDARD_CODE_CAVEAT };
  }
  // iPhone without a confirmed code: Settings > Phone > Call Forwarding works
  // without any code; never a guessed code on iOS.
  return { mode: "settings", code: null, openDialer: false, caveat: null };
}
