function normaliseNumber(number) {
  return (number || "").replace(/\D/g, "").slice(-10);
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

  return `+44${national}`;
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

module.exports = { normaliseNumber, normaliseUkPhoneToE164, wouldCreateForwardingLoop };
