// Unit test for the UK ringback-tone fix (2026-09-13) — a real physical
// test (giffgaff/Android, 2026-09-12) found the caller heard a
// "noticeably different/international-style ringback tone" while a real
// approved call was being delivered via <Dial><Client>. Confirmed cause:
// server.js's dialHouseholdOrFailClosed never set the <Dial> verb's
// ringTone attribute, so Twilio used its own un-customised default
// rather than a UK-styled tone.
//
// dialHouseholdOrFailClosed is a private function inside server.js (not
// exported, and server.js as a whole starts a real server rather than
// being importable) — there is no HTTP test tooling in this project (see
// tests/account-deletion-screen.test.mjs and others for the same
// established convention), so this is checked structurally against the
// real source, matching tests/live-monitoring-scenarios.test.mjs's own
// precedent for dialHouseholdOrFailClosed's call site.
//
// Run with: node tests/call-delivery-ringback.test.mjs

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverSource = readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

let failures = 0;

function check(condition, message) {
  if (condition) {
    console.log(`✓ ${message}`);
  } else {
    console.error(`✗ ${message}`);
    failures++;
  }
}

// --- the fix itself ---

check(
  serverSource.includes('twiml.dial({ action: "/call-delivery-failed", timeout: 20, ringTone: "uk" });'),
  'the client-only <Dial> now sets ringTone: "uk", overriding Twilio\'s un-customised default ringback tone'
);

// --- exactly one <Dial> call site exists, and it's the one that changed ---

const dialCallSites = serverSource.match(/twiml\.dial\(/g) || [];
check(
  dialCallSites.length === 1,
  `exactly one twiml.dial(...) call site exists in server.js (found ${dialCallSites.length}) — the ringTone fix did not need to be, and was not, duplicated anywhere else`
);

// --- routing/behaviour is otherwise completely unchanged ---

check(
  serverSource.includes('if (plan.mode === "client-only") {'),
  'the client-only branch itself is untouched — still gated on the exact same plan.mode check'
);

{
  const branchStart = serverSource.indexOf('if (plan.mode === "client-only") {');
  const branchEnd = serverSource.indexOf('\n  }', branchStart);
  const branch = serverSource.slice(branchStart, branchEnd);

  check(
    branch.includes('action: "/call-delivery-failed"'),
    'the existing action callback (/call-delivery-failed, for duration/outcome tracking) is unchanged'
  );
  check(
    branch.includes('timeout: 20'),
    'the existing 20-second ring timeout is unchanged'
  );
  check(
    branch.includes('dial.client(plan.clientIdentity);'),
    'the call is still dialled to the exact same Voice SDK client identity, unchanged'
  );
  check(
    branch.includes('return;'),
    'the branch still returns immediately after building the dial, unchanged control flow'
  );
}

// --- the invariant this whole function exists to enforce is untouched:
// no PSTN number is ever introduced by this change ---

check(
  !serverSource.includes('dial.number('),
  'no PSTN <Number> target exists anywhere in server.js — this cosmetic ringback change does not reintroduce or interact with the removed PSTN dual-dial path'
);

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
