// Legacy matching key: the last 10 digits. Kept ONLY for UK numbers (every
// stored UK contact row and HCG number compares exactly as before).
function legacyLast10(number) {
  return (number || "").replace(/\D/g, "").slice(-10);
}

// Integration 2026-10-03 (launch-gate PR-03 / C3): the matching key is now
// country-aware. A genuinely international number keeps its full E.164, so
// +1 770 090 0123 or +33 7 70 09 00 12 3 can never equal the UK key of
// 07700 900123 anywhere this helper is still used (inbound To routing,
// rapid-abuse alerts, contact de-duplication, the legacy /process match).
// The trusted-contact DECISION itself already uses full-E.164 matching
// (services/abuse/inboundCallGuard.js → numberPolicy.sameNumber). Anything
// that does not parse as international keeps the legacy UK key, so no
// existing UK row changes meaning.
function normaliseNumber(number) {
  const raw = typeof number === "string" ? number : String(number || "");
  if (/^\s*(\+|00)/.test(raw)) {
    const { parsePhoneNumber } = require("./abuse/numberPolicy");
    const parsed = parsePhoneNumber(raw);
    if (parsed.e164 && parsed.countryCode && parsed.countryCode !== "44") return parsed.e164;
  }
  return legacyLast10(raw);
}

// Distinct from normaliseNumber above: that one produces a bare 10-digit
// string used only for caller-ID *matching* (contacts.number), never
// dialled directly. This produces a real E.164 UK number
// (+44XXXXXXXXXX) suitable for Twilio's dial.number() — used for
// households.phone_number, the customer's own destination that trusted/
// screened-safe calls are actually forwarded to
// (services/callRouting.js). Accepts the common real-world input shapes
// (0-prefixed national, +44, 0044, with spaces/dashes/brackets) and
// rejects anything that doesn't reduce to exactly 10 significant digits
// after the country code/trunk prefix — returns null rather than a
// best-effort guess, so a malformed number is never silently stored and
// later handed to Twilio's dial().
function normaliseUkPhoneToE164(rawInput) {
  const digitsOnly = (rawInput || "").replace(/\D/g, "");

  let national;
  if (digitsOnly.startsWith("0044")) {
    national = digitsOnly.slice(4);
  } else if (digitsOnly.startsWith("44")) {
    national = digitsOnly.slice(2);
  } else if (digitsOnly.startsWith("0")) {
    national = digitsOnly.slice(1);
  } else {
    national = digitsOnly;
  }

  if (national.length !== 10) {
    return null;
  }

  // Integration 2026-10-03 (launch-gate PR-04 / C1, C2): this normaliser's
  // only purpose is a HOUSEHOLD destination, so it applies the same
  // destination policy as setHouseholdPhoneNumber (numberPolicy
  // HOUSEHOLD_PHONE: UK mobile or geographic only). Premium-rate (09),
  // revenue-share (084/087), personal (070), paging (076), Isle of Man
  // mobile and other non-allowed classes return null here too — defence in
  // depth; the write path re-checks.
  const e164 = `+44${national}`;
  const { evaluateNumberForPurpose, PURPOSES } = require("./abuse/numberPolicy");
  const verdict = evaluateNumberForPurpose(PURPOSES.HOUSEHOLD_PHONE, e164);
  if (!verdict.allowed) return null;
  return e164;
}

// A real iPhone E2E test (2026-08-08/09) found that setting the
// destination number to the same phone being forwarded creates an
// inescapable carrier-level loop: unconditional call forwarding
// redirects 100% of that number's incoming calls, including Home Call
// Guard's own attempt to dial it back for a trusted/safe call — so the
// customer's phone can never ring again once both match, regardless of
// who's calling. Compares via normaliseNumber (never raw string
// equality), so equivalent formats — 07715..., +447715..., spaces,
// brackets — are correctly recognised as the same number. Two empty/
// unset numbers are never treated as "the same" — nothing to block yet.
function wouldCreateForwardingLoop(protectedNumber, destinationNumber) {
  const a = normaliseNumber(protectedNumber);
  const b = normaliseNumber(destinationNumber);
  return !!a && !!b && a === b;
}

// Telephony abuse P0 (2026-10-03): trusted-contact STORAGE form. UK numbers
// keep the legacy 10-digit form (unchanged for every existing row and
// client); a genuinely international number is stored as full E.164.
// Before this, "+33 6 12 34 56 78" was stored as "3612345678", and the
// last-10-digit caller match meant ANY caller ending in those 10 digits
// (any country) was treated as trusted. /voice now matches on full E.164
// (services/abuse/inboundCallGuard.js), which reads a 10-digit row as UK.
function normaliseContactNumber(rawInput) {
  const { parsePhoneNumber } = require("./abuse/numberPolicy");
  const parsed = parsePhoneNumber(typeof rawInput === "string" ? rawInput : String(rawInput || ""));
  if (parsed.e164 && parsed.countryCode !== "44" && parsed.class === "international") return parsed.e164;
  return legacyLast10(rawInput);
}

function isValidContactNumber(stored) {
  return /^\d{10}$/.test(stored) || /^\+[1-9]\d{6,14}$/.test(stored);
}

module.exports = { normaliseNumber, normaliseUkPhoneToE164, wouldCreateForwardingLoop, normaliseContactNumber, isValidContactNumber };
