// Unit tests for services/activationInstructions.js — the server-side
// forwarding-code generator added so the raw Twilio number is never
// exposed through the general dashboard endpoints, and per-provider
// formatting/caveats (Virgin's extra zero, Sky/Virgin's preliminary 150
// call) live in exactly one place. Pure function, no network/DB
// involved.
//
// Run with: node tests/activation-instructions.test.mjs

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { toNationalDialingFormat, buildActivationInstructions } = require('../services/activationInstructions.js');

let failures = 0;

function check(condition, message) {
  if (condition) {
    console.log(`✓ ${message}`);
  } else {
    console.error(`✗ ${message}`);
    failures++;
  }
}

// --- toNationalDialingFormat ---

check(
  toNationalDialingFormat('+441234567890') === '01234567890',
  'converts a UK E.164 number to national dialling format (leading 0)'
);

// --- buildActivationInstructions: mobile (iPhone/Android) ---

for (const deviceType of ['iphone', 'android']) {
  const result = buildActivationInstructions({ twilioNumber: '+441234567890', deviceType });
  check(
    result.code === '**21*01234567890#',
    `${deviceType}: produces the standards-correct **21*<number># Registration code (2026-09-07 fix — the previous single-asterisk *21*<number># is not a valid 3GPP MMI Registration production and was rejected by a real Android device)`
  );
  check(
    result.cancelCode === '#21#',
    `${deviceType}: produces the standard #21# cancellation code`
  );
  check(
    result.requiresPreliminaryCall === false && result.preliminaryCallNumber === null,
    `${deviceType}: no preliminary call required`
  );
}

// --- buildActivationInstructions: landline, standard providers ---

for (const provider of ['bt', 'talktalk', 'plusnet', 'other']) {
  const result = buildActivationInstructions({ twilioNumber: '+441234567890', deviceType: 'landline', provider });
  check(
    result.code === '**21*01234567890#',
    `landline/${provider}: standards-correct **21*<number># Registration code, no extra zero`
  );
  check(
    result.requiresPreliminaryCall === false,
    `landline/${provider}: no preliminary call required`
  );
}

// --- buildActivationInstructions: landline, Virgin Media (extra zero + preliminary call) ---

{
  const result = buildActivationInstructions({ twilioNumber: '+441234567890', deviceType: 'landline', provider: 'virgin' });
  check(
    result.code === '**21*001234567890#',
    'landline/virgin: standards-correct **21*<number># Registration code, including the confirmed extra leading zero'
  );
  check(
    result.cancelCode === '##21#',
    'landline/virgin: cancellation code is the double-hash Erasure variant, not the standard #21# Deactivation — left unchanged by the 2026-09-07 fix: both are valid MMI procedures (unlike the old single-asterisk registration code), and no research documents a real reason to change it, so it is not touched merely for symmetry'
  );
  check(
    result.requiresPreliminaryCall === true && result.preliminaryCallNumber === '150',
    'landline/virgin: requires calling 150 first'
  );
  check(
    typeof result.preliminaryCallNote === 'string' && result.preliminaryCallNote.includes('150'),
    'landline/virgin: preliminary call note mentions 150'
  );
}

// --- buildActivationInstructions: landline, Sky (standard code + preliminary call + cost note) ---

{
  const result = buildActivationInstructions({ twilioNumber: '+441234567890', deviceType: 'landline', provider: 'sky' });
  check(
    result.code === '**21*01234567890#',
    'landline/sky: standards-correct **21*<number># Registration code (no extra zero, unlike Virgin)'
  );
  check(
    result.requiresPreliminaryCall === true && result.preliminaryCallNumber === '150',
    'landline/sky: requires calling 150 first'
  );
  check(
    typeof result.preliminaryCallNote === 'string' && result.preliminaryCallNote.includes('£2.50'),
    'landline/sky: preliminary call note mentions the real ~£2.50/month cost'
  );
}

// --- 2026-09-07 regression: Registration form must be double-asterisk ---
//
// Explicit, unmistakable regression test — not just an incidental string
// match against the assertions above — for the exact defect a real
// Android device surfaced: *21*<number># (single asterisk) is the GSM
// Activation form (use an already-registered number, no parameter) and
// is not valid MMI grammar for registering a NEW number. Android's own
// telephony stack rejected it as "invalid MMI code."

{
  const result = buildActivationInstructions({ twilioNumber: '+441234567890', deviceType: 'android' });
  check(result.code.startsWith('**21*'), 'the forwarding-registration code uses the double-asterisk Registration prefix (**), not the single-asterisk Activation prefix (*) — registering a new number requires Registration, per 3GPP TS 22.030');
  check(!result.code.startsWith('*21*'), 'the forwarding-registration code is never the old, standards-incorrect single-asterisk form that a real Android device rejected as an invalid MMI code');
}

// --- 2026-09-07: cancellation code is deliberately unchanged ---
//
// Unlike the registration code above, #21# (Deactivation) and ##21#
// (Erasure) are BOTH valid, standard MMI procedures for service code 21
// — this is not a single-vs-double-asterisk defect. No research
// (docs/mobile-app/APP_DECISION_003 or elsewhere) documents a real
// reason Virgin needs Erasure specifically rather than Deactivation, but
// "unresearched" is not "incorrect" — so this stays as it was, not
// changed merely for symmetry with the registration fix above.

check(
  buildActivationInstructions({ twilioNumber: '+441234567890', deviceType: 'android' }).cancelCode === '#21#',
  'the standard (non-Virgin) cancellation code remains the valid #21# Deactivation form — deliberately not touched by the 2026-09-07 registration-code fix'
);
check(
  buildActivationInstructions({ twilioNumber: '+441234567890', deviceType: 'landline', provider: 'virgin' }).cancelCode === '##21#',
  "Virgin's cancellation code remains the valid ##21# Erasure form — deliberately not touched by the 2026-09-07 registration-code fix, since it is not itself incorrect MMI syntax"
);

// --- validation ---

{
  let threw = false;
  try {
    buildActivationInstructions({ twilioNumber: '+441234567890', deviceType: 'toaster' });
  } catch {
    threw = true;
  }
  check(threw, 'an invalid deviceType throws rather than silently producing a bogus code');
}

{
  let threw = false;
  try {
    buildActivationInstructions({ twilioNumber: '+441234567890', deviceType: 'landline', provider: 'not-a-real-provider' });
  } catch {
    threw = true;
  }
  check(threw, 'an invalid landline provider throws rather than silently producing a bogus code');
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
