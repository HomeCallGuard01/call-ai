'use strict';

// UK caller / called number canonicalisation for inbound telephony
// (WS6 Magrathea → Twilio BYOC, 2026-10-11).
//
// WHY. Twilio-hosted numbers deliver `From` / `To` as E.164 (+44…). A
// Magrathea DDI routed to a Twilio BYOC trunk may not: Magrathea presents the
// caller in NATIONAL form (07…), the Request-URI user without a plus
// (443300884327), and how Twilio renders BYOC `To`/`From` in the webhook is
// undocumented (provider questions T14 / M9). A SIP URI
// (sip:+443300884327@hcg.sip.ie1.twilio.com) contains a digit in the HOST,
// so the legacy last-10-digit key would silently mis-key it.
//
// This module is a thin, PURE layer over services/abuse/numberPolicy.js
// parsePhoneNumber (the one number parser): it only unwraps sip:/sips:/tel:
// URIs and URI parameters first, then delegates. It never guesses: anything
// parsePhoneNumber cannot parse unambiguously stays non-canonical (null).
//
// Accepted UK forms → +44 E.164:
//   +447700900123  +44 7700 900123  +44 (0)7700 900123
//   07700900123    00447700900123   447700900123 (missing plus, 11–12 digits)
//   sip:+447700900123@host  sip:07700900123@host;user=phone  tel:+447700900123
// Withheld: anonymous / restricted / unavailable / private / withheld /
//   blocked / unknown / Twilio's +266696687 sentinel / sip:anonymous@host.
// International E.164 (+1…, +33…) stays exactly that — never collapsed onto a
// UK number sharing its last 10 digits.

const { parsePhoneNumber, CLASSES } = require('../abuse/numberPolicy');

const URI_SCHEME = /^\s*(sips?|tel):/i;
const MAX_URI_LENGTH = 256;

/**
 * Unwraps the user part of a sip:/sips:/tel: URI (and strips ;params / ?headers).
 * Returns the input unchanged when it is not a URI. Never throws.
 */
function unwrapTelephonyUri(raw) {
  if (typeof raw !== 'string') return raw;
  if (!URI_SCHEME.test(raw) || raw.length > MAX_URI_LENGTH) return raw;
  let s = raw.trim().replace(URI_SCHEME, '');
  // display-name / angle brackets are not expected in Twilio params; refuse them.
  if (/[<>"]/.test(s)) return raw;
  s = s.split('@')[0];          // user part only (the host may contain digits)
  s = s.split(';')[0];          // ;user=phone, ;rn=…, ;npdi
  s = s.split('?')[0];          // ?headers
  try { s = decodeURIComponent(s); } catch { return raw; }
  return s;
}

/**
 * @returns {{ e164: string|null, class: string, withheld: boolean, uk: boolean, form: string, raw: any }}
 *   form: 'e164' | 'uk_national' | 'idd_00' | 'missing_plus' | 'uri' | 'withheld' | 'other' | 'unparseable'
 */
function canonicaliseNumber(raw) {
  const isUri = typeof raw === 'string' && URI_SCHEME.test(raw);
  const inner = unwrapTelephonyUri(raw);
  const parsed = parsePhoneNumber(inner);
  const withheld = parsed.class === CLASSES.WITHHELD;
  let form = 'other';
  if (withheld) form = 'withheld';
  else if (!parsed.e164) form = 'unparseable';
  else if (isUri) form = 'uri';
  else if (parsed.flags.includes('uk_national_format')) form = 'uk_national';
  else if (parsed.flags.includes('idd_00_prefix')) form = 'idd_00';
  else if (parsed.flags.includes('missing_plus')) form = 'missing_plus';
  else if (typeof inner === 'string' && inner.trim().startsWith('+')) form = 'e164';
  return {
    e164: parsed.e164 || null,
    class: parsed.class,
    withheld,
    uk: parsed.countryCode === '44',
    form,
    raw,
  };
}

/** Canonical E.164 for any accepted form, or null (withheld / malformed / ambiguous). */
function toE164(raw) {
  return canonicaliseNumber(raw).e164;
}

/** Same subscriber line? Format-insensitive; null keys never match. */
function sameLine(a, b) {
  const ka = toE164(a);
  return !!ka && ka === toE164(b);
}

// Inbound webhook params that name a number. `Called`/`Caller` mirror `To`/`From`.
const INBOUND_NUMBER_FIELDS = Object.freeze(['From', 'Caller', 'To', 'Called', 'ForwardedFrom']);

/**
 * The value an inbound webhook number field should carry, or null for "leave
 * as is". Only non-canonical forms are rewritten, so a Twilio-hosted call
 * (already E.164) is never changed. `client:` identities are never touched
 * (the Voice SDK origin check must still see them).
 */
function canonicalInboundValue(raw) {
  if (typeof raw !== 'string' || raw === '') return null;
  if (/^\s*client:/i.test(raw)) return null;
  const c = canonicaliseNumber(raw);
  // A plain withheld value (anonymous, +266696687…) is left exactly as sent;
  // only a withheld SIP URI (sip:anonymous@host) becomes 'anonymous'.
  if (c.withheld) return URI_SCHEME.test(raw) ? 'anonymous' : null;
  if (!c.e164) return null;
  if (c.e164 === raw) return null;
  // A URI is unwrapped whatever the country; a bare non-E.164 form is only
  // rewritten when it is unambiguously UK (national 0…, 0044…, 44… without plus).
  if (c.form === 'uri' || c.uk) return c.e164;
  return null;
}

/**
 * Pure: returns { params, changes } where params is a NEW object with the
 * number fields canonicalised and changes lists { field, form } (never the
 * number itself, so it is safe to log).
 */
function canonicaliseInboundParams(params) {
  const src = params && typeof params === 'object' ? params : {};
  const out = { ...src };
  const changes = [];
  for (const field of INBOUND_NUMBER_FIELDS) {
    const next = canonicalInboundValue(src[field]);
    if (next !== null && next !== src[field]) {
      changes.push({ field, form: canonicaliseNumber(src[field]).form });
      out[field] = next;
    }
  }
  return { params: out, changes };
}

module.exports = {
  INBOUND_NUMBER_FIELDS,
  unwrapTelephonyUri,
  canonicaliseNumber,
  toE164,
  sameLine,
  canonicalInboundValue,
  canonicaliseInboundParams,
};
