'use strict';

// Telephony abuse P0 (2026-10-03) — the ONE place a phone number is parsed,
// classified and checked against what HCG is allowed to do with it.
//
// Two separate questions, deliberately kept apart:
//   1. parsePhoneNumber(raw)   — what IS this number? (canonical E.164 +
//      numbering class). Pure, no I/O, never guesses: anything it cannot
//      parse unambiguously is `malformed`.
//   2. evaluateNumberForPurpose(purpose, raw, ctx) — may HCG use it for
//      THIS purpose? Each purpose has an explicit allowlist of classes;
//      everything else is refused with a reason code.
//
// Classification is by UK National Numbering Plan top-level ranges only
// (Ofcom's published plan: 01/02 geographic, 03 UK-wide, 05x, 070 personal,
// 07x mobile, 076 paging, 08x freephone/service, 09 premium). It is NOT a
// numbering database: sub-range allocation (which operator holds a block,
// Channel Islands mobile blocks inside 077–079, high-termination-rate mobile
// blocks used for IRSF) needs Ofcom's numbering data or a provider lookup
// (e.g. Twilio Lookup line type). Those are listed in
// docs/security/TELEPHONY_ABUSE_THREAT_MODEL.md as open dependencies, and
// can be added without code changes via ABUSE_DENY_E164_PREFIXES.

const MAX_RAW_LENGTH = 64;

// Invisible formatting characters that real contact pickers do insert (iOS
// wraps numbers in U+202A/U+202C) — stripped, but recorded as a flag.
const INVISIBLE_CHARS = /[­᠎​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;
// Separators a human may legitimately type. Anything else (letters, `#`,
// `*`, `,`, `;`, `x`/`ext`, `p`/`w` pause chars) makes the number malformed:
// those are dial-string tricks, not numbers.
const ALLOWED_SEPARATORS = /[\s\-.()/]/g;

const WITHHELD_VALUES = new Set([
  'anonymous', 'restricted', 'unavailable', 'unknown', 'private', 'withheld', 'blocked',
  '+266696687', '266696687', // Twilio's "anonymous" sentinel
]);

// Country codes that are not countries: satellite and international
// networks, global freephone/shared-cost/premium. Well known as IRSF
// destinations. (ITU-T E.164 assignments.)
const GLOBAL_SERVICE_CODES = ['800', '808', '870', '878', '881', '882', '883', '888', '979'];

// Crown Dependencies use +44 but are separate jurisdictions; UK carriers
// commonly bill them as international. Only the area codes that are
// unambiguous are listed here. Channel Islands MOBILE blocks sit inside
// 077–079 and need Ofcom data — see the module header.
const CROWN_DEPENDENCY_NSN_PREFIXES = ['1481', '1534', '1624', '7624'];

const CLASSES = Object.freeze({
  UK_GEOGRAPHIC: 'uk_geographic',
  UK_NON_GEOGRAPHIC_03: 'uk_non_geographic_03',
  UK_MOBILE: 'uk_mobile',
  UK_PERSONAL_NUMBERING: 'uk_personal_numbering', // 070 — classic fraud range
  UK_PAGING: 'uk_paging',                          // 076 (excl. 07624)
  UK_CORPORATE_OR_VOIP: 'uk_corporate_or_voip',    // 055 / 056
  UK_FREEPHONE: 'uk_freephone',                    // 080x, legacy 0500
  UK_SERVICE_REVENUE_SHARE: 'uk_service_revenue_share', // 084 / 087
  UK_PREMIUM_RATE: 'uk_premium_rate',              // 09
  UK_OTHER_SPECIAL: 'uk_other_special',            // 081/082/083/085/086/088/089
  UK_UNALLOCATED: 'uk_unallocated',                // 04 / 06 / anything else
  CROWN_DEPENDENCY: 'crown_dependency',
  INTERNATIONAL: 'international',
  GLOBAL_SERVICE: 'global_service_or_satellite',
  SHORT_CODE: 'short_code',
  EMERGENCY: 'emergency',
  WITHHELD: 'withheld',
  MALFORMED: 'malformed',
});

function result(fields) {
  return Object.freeze({ e164: null, class: CLASSES.MALFORMED, countryCode: null, flags: [], reason: null, ...fields });
}

function classifyUkNsn(nsn) {
  if (CROWN_DEPENDENCY_NSN_PREFIXES.some((p) => nsn.startsWith(p))) return CLASSES.CROWN_DEPENDENCY;
  const d1 = nsn[0];
  const d2 = nsn.slice(0, 2);
  if (d1 === '1' || d1 === '2') return CLASSES.UK_GEOGRAPHIC;
  if (d1 === '3') return CLASSES.UK_NON_GEOGRAPHIC_03;
  if (d1 === '9') return CLASSES.UK_PREMIUM_RATE;
  if (d2 === '70') return CLASSES.UK_PERSONAL_NUMBERING;
  if (d2 === '76') return CLASSES.UK_PAGING;
  if (d1 === '7') return CLASSES.UK_MOBILE; // 071–075, 077–079
  if (d2 === '55' || d2 === '56') return CLASSES.UK_CORPORATE_OR_VOIP;
  if (nsn.startsWith('500')) return CLASSES.UK_FREEPHONE;
  if (d2 === '80') return CLASSES.UK_FREEPHONE;
  if (d2 === '84' || d2 === '87') return CLASSES.UK_SERVICE_REVENUE_SHARE;
  if (d1 === '8') return CLASSES.UK_OTHER_SPECIAL;
  return CLASSES.UK_UNALLOCATED;
}

// UK national significant number lengths: 10 digits for nearly everything;
// a small set of 01 geographic areas still have 9-digit NSNs.
function ukNsnLengthOk(nsn, cls) {
  if (cls === CLASSES.UK_GEOGRAPHIC) return nsn.length === 10 || (nsn.length === 9 && nsn[0] === '1');
  return nsn.length === 10;
}

function isShortCodeDigits(digits) {
  return digits.length >= 3 && digits.length <= 6;
}

/**
 * Parse any user/provider-supplied phone number into canonical E.164 and a
 * numbering class. Never throws. Never "best-effort guesses".
 */
function parsePhoneNumber(raw) {
  if (Array.isArray(raw)) return result({ reason: 'parameter_pollution' });
  if (typeof raw !== 'string') return result({ reason: raw == null ? 'missing' : 'not_a_string' });
  if (raw.length > MAX_RAW_LENGTH) return result({ reason: 'too_long' });

  const flags = [];
  let s = raw.normalize('NFKC'); // fullwidth digits → ASCII, NBSP → space
  if (s !== raw) flags.push('unicode_normalised');
  const stripped = s.replace(INVISIBLE_CHARS, '');
  if (stripped !== s) flags.push('invisible_chars_removed');
  s = stripped.trim();

  if (!s) return result({ reason: 'missing', flags });
  if (WITHHELD_VALUES.has(s.toLowerCase())) return result({ class: CLASSES.WITHHELD, reason: null, flags });
  if (s.toLowerCase().startsWith('client:') || s.toLowerCase().startsWith('sip:')) {
    return result({ reason: 'not_a_pstn_number', flags });
  }

  // UK "+44 (0)…" convention: the bracketed trunk zero is dropped.
  s = s.replace(/^(\+\s*44|00\s*44)\s*\(\s*0\s*\)/, '$1');

  const plusCount = (s.match(/\+/g) || []).length;
  if (plusCount > 1 || (plusCount === 1 && !s.startsWith('+'))) return result({ reason: 'misplaced_plus', flags });
  const body = s.startsWith('+') ? s.slice(1) : s;
  const withoutSeparators = body.replace(ALLOWED_SEPARATORS, '');
  if (!/^[0-9]+$/.test(withoutSeparators)) {
    // Non-ASCII digits (Arabic-Indic etc. survive NFKC), letters, # * , ;
    return result({ reason: 'invalid_characters', flags });
  }
  const digits = withoutSeparators;

  let international; // digits incl. country code, no prefix
  if (s.startsWith('+')) {
    international = digits;
  } else if (digits.startsWith('00')) {
    international = digits.slice(2);
    flags.push('idd_00_prefix');
  } else if (digits.startsWith('0')) {
    if (digits === '0' || digits.length < 4) return result({ reason: 'too_short', flags });
    international = `44${digits.slice(1)}`;
    flags.push('uk_national_format');
  } else if (['999', '112', '911'].includes(digits)) {
    return result({ class: CLASSES.EMERGENCY, reason: null, flags });
  } else if (isShortCodeDigits(digits)) {
    return result({ class: CLASSES.SHORT_CODE, reason: null, flags });
  } else if (digits.length === 10 && /^[1-9]/.test(digits) && !digits.startsWith('44')) {
    // Legacy contacts storage (services/phone.js normaliseNumber keeps the
    // last 10 digits) and bare national numbers without the trunk zero.
    international = `44${digits}`;
    flags.push('assumed_uk_no_trunk_prefix');
  } else if (digits.startsWith('44') && digits.length >= 11 && digits.length <= 12) {
    international = digits;
    flags.push('missing_plus');
  } else {
    return result({ reason: 'ambiguous_without_country_code', flags });
  }

  if (international.startsWith('0')) return result({ reason: 'invalid_country_code', flags });
  if (international.length < 7 || international.length > 15) {
    return result({ reason: international.length > 15 ? 'too_long' : 'too_short', flags });
  }
  const e164 = `+${international}`;

  if (international.startsWith('44')) {
    const nsn = international.slice(2);
    if (nsn.startsWith('0')) return result({ reason: 'uk_trunk_zero_after_country_code', flags });
    if (nsn.length <= 6) {
      return result({ e164, class: ['999', '112'].includes(nsn) ? CLASSES.EMERGENCY : CLASSES.SHORT_CODE, countryCode: '44', flags });
    }
    const cls = classifyUkNsn(nsn);
    if (!ukNsnLengthOk(nsn, cls)) return result({ e164: null, reason: 'uk_wrong_length', countryCode: '44', flags });
    return result({ e164, class: cls, countryCode: '44', flags });
  }

  const svc = GLOBAL_SERVICE_CODES.find((cc) => international.startsWith(cc));
  if (svc) return result({ e164, class: CLASSES.GLOBAL_SERVICE, countryCode: svc, flags });
  return result({ e164, class: CLASSES.INTERNATIONAL, countryCode: international.slice(0, 3), flags });
}

// ── Purpose policy ───────────────────────────────────────────────────────
//
// PSTN_DIAL is empty on purpose: HCG's product has no PSTN delivery leg
// (households.self_protecting / services/callRouting.js — delivery is Voice
// SDK <Client> only). Any future PSTN dial must change this list in review,
// and twimlEgressGuard refuses <Number>/<Sip> regardless.
const PURPOSES = Object.freeze({
  // HCG-paid SMS warning to the customer's own phone.
  SMS_WARNING: { name: 'sms_warning', allow: [CLASSES.UK_MOBILE], loopCheck: true },
  // households.phone_number — the customer's own number (SMS destination).
  HOUSEHOLD_PHONE: { name: 'household_phone', allow: [CLASSES.UK_MOBILE, CLASSES.UK_GEOGRAPHIC], loopCheck: true },
  // Any HCG-originated PSTN call leg. None exist today.
  PSTN_DIAL: { name: 'pstn_dial', allow: [], loopCheck: true },
  // Numbers HCG buys from a provider for a household.
  PROVISIONED_NUMBER: { name: 'provisioned_number', allow: [CLASSES.UK_GEOGRAPHIC], loopCheck: false },
  // Trusted contacts are caller-ID MATCHERS only — never dialled, never
  // messaged. International is allowed (family abroad). HCG numbers are not.
  TRUSTED_CONTACT: {
    name: 'trusted_contact',
    allow: [CLASSES.UK_MOBILE, CLASSES.UK_GEOGRAPHIC, CLASSES.UK_NON_GEOGRAPHIC_03, CLASSES.UK_CORPORATE_OR_VOIP, CLASSES.CROWN_DEPENDENCY, CLASSES.INTERNATIONAL],
    loopCheck: true,
  },
});

function parseDenyPrefixes(env = process.env) {
  return String(env.ABUSE_DENY_E164_PREFIXES || '')
    .split(',')
    .map((p) => p.trim())
    .filter((p) => /^\+\d{2,14}$/.test(p));
}

/**
 * @param {object} purpose  one of PURPOSES
 * @param {string} raw
 * @param {object} [ctx]
 * @param {(e164: string) => boolean} [ctx.isHcgNumber]  synchronous membership test (pre-loaded set)
 * @param {string[]} [ctx.denyPrefixes]
 * @returns {{allowed: boolean, reason: string|null, number: object}}
 */
function evaluateNumberForPurpose(purpose, raw, ctx = {}) {
  const number = parsePhoneNumber(raw);
  const deny = (reason) => ({ allowed: false, reason, number });
  if (!purpose || !Array.isArray(purpose.allow)) return deny('unknown_purpose');
  if (number.class === CLASSES.MALFORMED) return deny(`malformed:${number.reason}`);
  if (!purpose.allow.includes(number.class)) return deny(`class_not_permitted:${number.class}`);
  const denyPrefixes = ctx.denyPrefixes || parseDenyPrefixes();
  if (number.e164 && denyPrefixes.some((p) => number.e164.startsWith(p))) return deny('operator_deny_prefix');
  if (purpose.loopCheck && number.e164 && typeof ctx.isHcgNumber === 'function' && ctx.isHcgNumber(number.e164)) {
    return deny('hcg_owned_number');
  }
  return { allowed: true, reason: null, number };
}

/** Canonical comparison key: E.164 when parseable, else null (never matches). */
function canonicalKey(raw) {
  const n = parsePhoneNumber(raw);
  return n.e164 || null;
}

/** Two numbers are the same subscriber line (format-insensitive, no last-N-digit collisions). */
function sameNumber(a, b) {
  const ka = canonicalKey(a);
  return !!ka && ka === canonicalKey(b);
}

/** Masked for logs/audit: keep class-revealing prefix + last 3. Never the full number. */
function maskE164(e164) {
  if (typeof e164 !== 'string' || e164.length < 8) return e164 ? '***' : null;
  return `${e164.slice(0, 5)}…${e164.slice(-3)}`;
}

module.exports = {
  CLASSES,
  PURPOSES,
  GLOBAL_SERVICE_CODES,
  CROWN_DEPENDENCY_NSN_PREFIXES,
  parsePhoneNumber,
  evaluateNumberForPurpose,
  canonicalKey,
  sameNumber,
  maskE164,
  parseDenyPrefixes,
};
