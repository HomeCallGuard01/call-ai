// Regression test for the "Get Protected Now" button bug (upload.html).
//
// Background: the button's click handler used to call setStatus("protected")
// directly, which unconditionally shows "You're protected — Calls to your
// phone are being checked for you" with no check of phone number,
// provisioning, or activation state. Every other transition into this card
// (loadDashboard's own normal flow) calls setStatus("protected") first, then
// immediately corrects it via renderProtectionStatus(data) using the real
// /dashboard-data response — the fix makes this button do the same, instead
// of bypassing that real, backend-driven check.
//
// Structural check against the real source, matching this codebase's
// existing convention for behavior that isn't a pure, extractable function
// (see tests/business-metrics.test.mjs, tests/reset-password-token-hash.test.mjs)
// — there's no DOM/browser test tooling in this project.
//
// Run with: node tests/get-protected-now-button.test.mjs

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

const anchor = 'document.getElementById("continueToSetupButton")';
const anchorIdx = html.indexOf(anchor);
const listenerStart = html.indexOf('addEventListener("click"', anchorIdx);
const handlerBodyEnd = html.indexOf('});', listenerStart);

if (anchorIdx === -1 || listenerStart === -1 || handlerBodyEnd === -1) {
  console.error('✗ could not locate the continueToSetupButton click handler in upload.html — test cannot run');
  failures++;
} else {
  // Starts from the addEventListener call itself, not the button lookup
  // above it — the fix's own explanatory comment text (between the two)
  // mentions setStatus("protected") by name to explain what NOT to do,
  // which would otherwise make this check trip over its own documentation.
  const handlerBlock = html.slice(listenerStart, handlerBodyEnd + 3);

  check(
    handlerBlock.includes('loadDashboard()'),
    'clicking "Get Protected Now" calls loadDashboard() — the same real, backend-driven path every other transition into this card uses'
  );

  check(
    !handlerBlock.includes('setStatus("protected")'),
    'clicking "Get Protected Now" never calls setStatus("protected") directly — it cannot force the protected state on its own, only loadDashboard()\'s own internal, already-gated call can'
  );

  check(
    !/setStatus\(\s*["'`]/.test(handlerBlock),
    'the click handler sets no dashboard state itself at all — it only ever refreshes and re-evaluates real backend data'
  );
}

// Sanity: loadDashboard() itself still contains the real, unmodified gate
// this fix now relies on — confirms the fix isn't routing to a hollowed-out
// or since-changed function.
const loadDashboardStart = html.indexOf('async function loadDashboard()');
const loadDashboardEnd = html.indexOf('\n  }', html.indexOf('renderProtectionStatus(data)', loadDashboardStart));

if (loadDashboardStart === -1 || loadDashboardEnd === -1) {
  console.error('✗ could not locate loadDashboard() in upload.html — sanity check cannot run');
  failures++;
} else {
  const loadDashboardBody = html.slice(loadDashboardStart, loadDashboardEnd);
  check(
    loadDashboardBody.includes('setStatus("protected")') && loadDashboardBody.includes('renderProtectionStatus(data)'),
    'loadDashboard() still calls setStatus("protected") then renderProtectionStatus(data) on the real response — the actual gate the button now relies on is unchanged'
  );
}

console.log(failures === 0 ? '\nAll get-protected-now-button checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
