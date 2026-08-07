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
    result.code === '*21*01234567890#',
    `${deviceType}: produces the standard *21*<number># code`
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
    result.code === '*21*01234567890#',
    `landline/${provider}: standard code, no extra zero`
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
    result.code === '*21*001234567890#',
    'landline/virgin: includes the confirmed extra leading zero'
  );
  check(
    result.cancelCode === '##21#',
    'landline/virgin: cancellation code is the double-hash variant, not the standard #21#'
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
    result.code === '*21*01234567890#',
    'landline/sky: standard code format (no extra zero, unlike Virgin)'
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
