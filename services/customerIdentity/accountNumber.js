// HCG account numbers — the customer's permanent, human-readable identity.
//
// Format: "HCG-" + 7-digit serial (zero padded) + 1 Luhn check digit,
// e.g. HCG-00010017 (serial 1001, check digit 7). The serial comes from a
// database sequence (supabase/migrations/062_customer_identity_and_routing_assignments.sql);
// this module never creates one. It only formats, validates and parses, so
// support and admin tools can catch a mistyped number before looking it up.
//
// An account number is NOT a credential. It is printed on emails and read
// out on the phone; knowing one must never authorise anything. Every
// customer-facing route keeps resolving the household from the signed-in
// session, never from an account number the client sends.

'use strict';

const PREFIX = 'HCG-';
const SERIAL_MIN_DIGITS = 7;

function luhnCheckDigit(serial) {
  if (!Number.isSafeInteger(serial) || serial < 1) {
    throw new Error('account serial must be a positive integer');
  }
  const digits = String(serial);
  let sum = 0;
  let double = true;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return (10 - (sum % 10)) % 10;
}

function formatAccountNumber(serial) {
  return `${PREFIX}${String(serial).padStart(SERIAL_MIN_DIGITS, '0')}${luhnCheckDigit(serial)}`;
}

// Accepts what a person might type or say: any case, optional "HCG"
// prefix, spaces/dashes/dots between digit groups. Returns the canonical
// form only when the check digit matches; never throws.
function parseAccountNumber(input) {
  if (typeof input !== 'string') return { valid: false, reason: 'not_a_string' };
  const compact = input.trim().toUpperCase().replace(/[\s.\-_]/g, '');
  const match = /^(?:HCG)?([0-9]{8,})$/.exec(compact);
  if (!match) return { valid: false, reason: 'bad_format' };

  const digits = match[1];
  const serial = Number(digits.slice(0, -1));
  const check = Number(digits.slice(-1));
  if (!Number.isSafeInteger(serial) || serial < 1) return { valid: false, reason: 'bad_serial' };
  if (luhnCheckDigit(serial) !== check) return { valid: false, reason: 'check_digit_mismatch' };

  const canonical = formatAccountNumber(serial);
  // Rejects non-canonical zero padding, e.g. "HCG-000010017" for serial 1001.
  if (canonical !== `${PREFIX}${digits}`) return { valid: false, reason: 'bad_format' };
  return { valid: true, canonical, serial };
}

function isValidAccountNumber(input) {
  return parseAccountNumber(input).valid;
}

module.exports = {
  formatAccountNumber,
  parseAccountNumber,
  isValidAccountNumber,
  luhnCheckDigit,
};
