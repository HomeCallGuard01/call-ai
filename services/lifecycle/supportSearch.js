// Support search query classification (customer lifecycle automation,
// 2026-10-04). Pure. Used by database/adminMetrics.js searchCustomers.
//
// What it fixes (doc §9):
//   - a support agent types a phone number the way a customer reads it
//     ("07700 900123"), but households.phone_number / twilio_number are
//     stored E.164 ("+447700900123"), so the old substring search missed it;
//   - the raw query was interpolated into a PostgREST `.or()` filter, where
//     a comma, parenthesis or quote changes the filter's meaning. Every value
//     that reaches a filter string now passes through filterSafe().
// Customer NAME search is not possible: no name is stored for a household
// (only trusted-contact names). The classifier reports that instead of
// silently searching something else.
'use strict';

const { parseAccountNumber } = require('../customerIdentity/accountNumber');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Characters with meaning inside a PostgREST logic-tree filter value, plus
// the ilike wildcards. Removed, not escaped: none can appear in an email
// local part we need to find, a phone number or an account number.
function filterSafe(value) {
  return String(value || '').replace(/[,()"'\\%*:]/g, '').trim();
}

// UK-first: 07…/7…(10 digits)/447…/00447…/+447… → +44XXXXXXXXXX. Any other
// "+<country>" number keeps its digits. Returns null when it is not a whole
// phone number (partial digit searches keep the substring path).
function phoneToE164(raw) {
  const s = String(raw || '').trim();
  if (!/^[+(\d][\d\s().-]*$/.test(s)) return null;
  const digits = s.replace(/\D/g, '');
  if (s.startsWith('+') && !digits.startsWith('44')) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  let national;
  if (digits.startsWith('0044')) national = digits.slice(4);
  else if (digits.startsWith('44')) national = digits.slice(2);
  else if (digits.startsWith('0')) national = digits.slice(1);
  else national = digits;
  return national.length === 10 ? `+44${national}` : null;
}

/**
 * @returns {{ kind: 'empty'|'uuid'|'account_number'|'phone'|'email'|'text', value: string, e164?: string, digits?: string, note?: string }}
 */
function classifySupportQuery(query) {
  const trimmed = String(query || '').trim();
  if (!trimmed) return { kind: 'empty', value: '' };
  if (UUID_RE.test(trimmed)) return { kind: 'uuid', value: trimmed.toLowerCase() };
  const acct = parseAccountNumber(trimmed);
  // Requires the HCG prefix as well as a valid check digit, so a bare digit
  // string (a partial phone number) keeps its substring path.
  if (acct.valid && /^hcg/i.test(trimmed)) return { kind: 'account_number', value: acct.canonical };
  const e164 = phoneToE164(trimmed);
  if (e164) return { kind: 'phone', value: trimmed, e164, digits: e164.replace(/\D/g, '') };
  if (trimmed.includes('@')) return { kind: 'email', value: filterSafe(trimmed) };
  const safe = filterSafe(trimmed);
  const note = /^[a-z][a-z\s'-]+$/i.test(trimmed) && !/\d/.test(trimmed)
    ? 'Households have no stored name; searching email/phone text only. Trusted-contact names are not searched.'
    : undefined;
  return { kind: 'text', value: safe, ...(note ? { note } : {}) };
}

module.exports = { classifySupportQuery, filterSafe, phoneToE164 };
