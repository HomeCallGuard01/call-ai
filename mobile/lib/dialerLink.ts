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
export function buildDialerUrl(code: string): string {
  return `tel:${code.replace(/#/g, "%23")}`;
}
