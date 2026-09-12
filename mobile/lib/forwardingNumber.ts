// Derives the plain, human-readable Home Call Guard forwarding number
// from the server-generated activation code, so the customer never has
// to parse a technical MMI string to find "the number" — a real,
// confirmed customer confusion (physical-device test, 2026-09-12): the
// actual HCG/Twilio number was only ever shown embedded inside a code
// like "**21*01389317533#", never as a value on its own, and the
// customer had no way to look it up again outside the one-time setup
// screen.
//
// KNOWN LIMITATION, DELIBERATE — reviewed 2026-09-12: this is an interim
// approach, not the preferred long-term one. Checked first (per review):
// neither GET /api/v1/activation/instructions nor GET /api/v1/me/dashboard
// currently returns an explicit bare number field — routes/mobileApi.js's
// own comment states this outright ("this route's response never
// includes a bare `twilioNumber` field"), confirmed by reading both
// routes' actual res.json(...) shapes directly, not assumed. Parsing is
// therefore the only option available without a backend change today —
// not implemented here because it wasn't judged necessary purely for
// this fix's own convenience.
//
// Proposed smallest backend addition for a future batch (not done here):
// add one explicit field — e.g. `forwardingNumber` — to both of those
// same two JSON responses, sourced directly from the already-known
// `twilioNumber`/`toNationalDialingFormat(twilioNumber)` value inside
// services/activationInstructions.js's buildActivationInstructions,
// which already computes it server-side for every device type. This
// touches only response-shaping code, not routing, provisioning, or the
// "Twilio number never sent to any client" boundary any more than the
// existing MMI code already crosses it (activation-instructions is
// already the one deliberate, narrow exception, per its own comment) —
// no behavioural change to call delivery, activation, or provisioning.
// Once that field exists, this module's extraction function becomes
// unnecessary and should be retired in favour of reading it directly.
//
// Until then: the pattern below is deliberately narrow and fails safe —
// it matches only the one confirmed, stable code shape this app
// currently produces, and returns null (hiding the number display
// entirely, never a wrong guess) for anything else, including any future
// provider-specific activation method (e.g. native-Settings-only, no
// embedded code at all) that the eventual provider-aware activation work
// may introduce. The number never silently shows wrong — it silently
// stops showing, which is the deliberately safe failure mode until the
// backend field above exists.
//
// Pure, dependency-free (no react-native/expo-router imports) so it's
// directly unit-testable — see tests/mobile-app.test.mjs.

// Matches the Registration-form code every device type produces
// (**21*<nationalNumber>#) — including Virgin landline's confirmed extra
// leading zero, which simply means one more digit here, not a different
// shape. Returns null for anything that doesn't match this exact,
// stable pattern rather than guessing — a landline's own cancel code or
// a future, differently-shaped code should never be silently
// mis-parsed as a phone number.
const FORWARDING_CODE_PATTERN = /^\*\*21\*(0\d+)#$/;

export function extractForwardingNumberFromCode(code: string): string | null {
  const match = FORWARDING_CODE_PATTERN.exec(code);
  return match ? match[1] : null;
}

// Matches upload.html's own formatUkPhoneForDisplay exactly (5+6 group
// split) for consistency between the web dashboard and this app — this
// is the standard convention for both UK mobile (07XXX XXXXXX) and most
// geographic numbers. Falls back to the raw digits for any length this
// simple heuristic doesn't fit (e.g. Virgin's extra digit producing 12
// characters) rather than producing a visibly wrong group split.
export function formatUkPhoneForDisplay(nationalNumber: string): string {
  if (nationalNumber.length === 11) {
    return `${nationalNumber.slice(0, 5)} ${nationalNumber.slice(5)}`;
  }
  return nationalNumber;
}
