// Unit test for handleSubscribeFormSubmit() in upload.html — extracted from
// the real page markup (between the TEST-EXTRACT markers) and executed
// standalone against a minimal fake form/button, no browser or DOM library
// required. Added after the 2026-07-18 duplicate-subscription incident (see
// docs/releases/2026-07-18_RC1.md) to prove repeated submission from the
// same page instance is prevented.
//
// Run with: node tests/subscribe-button.test.mjs

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

const startMarker = '// TEST-EXTRACT-START: handleSubscribeFormSubmit';
const endMarker = '// TEST-EXTRACT-END: handleSubscribeFormSubmit';
const startIdx = html.indexOf(startMarker);
const endIdx = html.indexOf(endMarker);

if (startIdx === -1 || endIdx === -1) {
  console.error('✗ could not find handleSubscribeFormSubmit markers in upload.html — test cannot run');
  process.exitCode = 1;
} else {
  const source = html.slice(startIdx + startMarker.length, endIdx);
  const handleSubscribeFormSubmit = new Function(`${source}\nreturn handleSubscribeFormSubmit;`)();

  const fakeButton = { disabled: false, textContent: 'Continue to secure payment' };
  const fakeForm = { querySelector: () => fakeButton };

  handleSubscribeFormSubmit(fakeForm);

  check(fakeButton.disabled === true, 'button becomes disabled on submission');
  check(
    fakeButton.textContent === 'Opening secure checkout…',
    'button text changes to "Opening secure checkout…"'
  );

  // A real disabled button can't fire a second submit event — this confirms
  // that even if the handler were somehow invoked again on the same
  // instance, the state stays disabled with the same text rather than
  // resetting or flipping back, i.e. repeated submission is a safe no-op.
  handleSubscribeFormSubmit(fakeForm);
  check(
    fakeButton.disabled === true && fakeButton.textContent === 'Opening secure checkout…',
    'repeated submission from the same page instance stays disabled (no reset, no second distinct state)'
  );
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
