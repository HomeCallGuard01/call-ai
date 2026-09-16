// Regression coverage for the "From this phone" contact-picker's feature
// detection — added 2026-08-08 after a real customer-facing investigation
// found the guard itself was correctly deployed, but that nothing anywhere
// (test suite or manual review) actually asserted this behaviour, meaning
// a future accidental regression (e.g. the earlier-found ID/variable
// desync pattern seen elsewhere in this file's history) would go
// completely uncaught until a real iPhone customer hit it again.
//
// Covers both halves explicitly required by this fix:
//   - unsupported browsers (iOS Safari — no navigator.contacts) must
//     never be shown the picker option
//   - supported browsers (Android Chrome — navigator.contacts exists)
//     must still see it
//
// Two layers, matching this repo's established TEST-EXTRACT convention:
//   1. The real decision logic (shouldShowPhoneContactPicker), pure,
//      extracted directly from upload.html and exercised with both
//      inputs.
//   2. A static check of the real page markup confirming the wrapping
//      element still starts `hidden` by default — the second half of
//      the guard (a broken JS guard is harmless if the element still
//      defaults to hidden; a missing default-hidden attribute is harmful
//      even with correct JS, since a slow/failed script load would
//      briefly or permanently reveal it). Both halves must hold.
//
// Run with: node tests/contact-picker-feature-detection.test.mjs

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(__dirname, '..', 'upload.html'), 'utf8');

let failures = 0;

function check(condition, message) {
  if (condition) {
    console.log(`✓ ${message}`);
  } else {
    console.error(`✗ ${message}`);
    failures++;
  }
}

function extractBetween(source, name) {
  const startMarker = `// TEST-EXTRACT-START: ${name}`;
  const endMarker = `// TEST-EXTRACT-END: ${name}`;
  const startIdx = source.indexOf(startMarker);
  const endIdx = source.indexOf(endMarker);
  if (startIdx === -1 || endIdx === -1) {
    return null;
  }
  return source.slice(startIdx + startMarker.length, endIdx);
}

const source = extractBetween(html, 'shouldShowPhoneContactPicker');

if (source === null) {
  console.error('✗ could not find the shouldShowPhoneContactPicker TEST-EXTRACT markers in upload.html — test cannot run');
  process.exit(1);
}

const { shouldShowPhoneContactPicker } = new Function(`${source}\nreturn { shouldShowPhoneContactPicker };`)();

// --- unsupported browsers must never see it ---

check(
  shouldShowPhoneContactPicker(false) === false,
  'iPhone Safari / any browser without navigator.contacts (hasContactsApi: false): the picker must never be shown'
);

check(
  shouldShowPhoneContactPicker(undefined) === false,
  'a missing/undefined feature-detection result is treated as unsupported, never assumed supported'
);

check(
  shouldShowPhoneContactPicker(null) === false,
  'a null feature-detection result is treated as unsupported, never assumed supported'
);

// --- supported browsers must still see it ---

check(
  shouldShowPhoneContactPicker(true) === true,
  'Android Chrome / any browser with navigator.contacts (hasContactsApi: true): the picker must still be shown — the fix for iPhone must never suppress it everywhere'
);

// --- the second half of the guard: real markup must default to hidden ---

const wrappingElementMatch = html.match(/<div class="upload-option" id="pickPhoneContactsOption"([^>]*)>/);

check(
  wrappingElementMatch !== null,
  'the real page markup still contains the pickPhoneContactsOption wrapping element'
);

check(
  !!wrappingElementMatch && /\bhidden\b/.test(wrappingElementMatch[1]),
  'pickPhoneContactsOption starts hidden in the HTML itself — so even a failed/slow script load never reveals it by default'
);

// --- only the one sanctioned code path ever clears .hidden on it ---

const hiddenClearSites = [...html.matchAll(/pickPhoneContactsOptionEl\.hidden\s*=\s*false/g)];

check(
  hiddenClearSites.length === 1,
  `exactly one code path ever reveals the picker option (found ${hiddenClearSites.length}) — a second, ungated reveal would silently defeat this whole guard`
);

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
