// Structural proof that server.js's /voice handler correctly wires the
// 2026-09-26 subscription-enforcement cost-protection safeguard
// (services/callRouting.js's shouldStartPaidMonitoring) — matching this
// codebase's established convention for testing server.js internals
// (source-string assertions; server.js is never required directly in
// tests, since doing so would start the real app.listen()). See
// tests/voice-client-reachability-integration.test.mjs for the same
// idiom this file follows.
//
// shouldStartPaidMonitoring's own decision logic (null household, null
// entitlement, every combination) is exhaustively unit-tested in
// tests/call-routing.test.mjs — this file only proves the integration
// point: /voice actually resolves an active entitlement and gates BOTH
// the "monitored and protected" announcement and attachLiveMonitoring
// behind it, while dialHouseholdOrFailClosed remains completely
// unconditional (a lapsed/cancelled household's calls must still connect
// — this fix removes paid monitoring, never call delivery).
//
// Run with: node tests/subscription-enforcement-voice-gate.test.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let failures = 0;

function check(condition, message) {
  if (condition) {
    console.log(`✓ ${message}`);
  } else {
    console.error(`✗ ${message}`);
    failures++;
  }
}

const serverSrc = readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

check(
  serverSrc.includes('shouldStartPaidMonitoring,') && /require\("\.\/services\/callRouting"\)/.test(serverSrc),
  'server.js imports shouldStartPaidMonitoring from services/callRouting'
);

// Isolate the /voice route handler body for every remaining assertion, so
// a coincidental match elsewhere in the file (e.g. in /process, the
// deliberately-dead pre-call-screening route) can never produce a false
// pass.
const voiceRouteMatch = serverSrc.match(/app\.post\("\/voice", async \(req, res\) => \{[\s\S]*?\n\}\);\n/);
check(Boolean(voiceRouteMatch), 'sanity check: the /voice route handler body is found in server.js');
const voiceBody = voiceRouteMatch ? voiceRouteMatch[0] : '';

check(
  /const activeEntitlement = household \? await getActiveEntitlement\(household\.id\) : null;/.test(voiceBody),
  '/voice resolves the household\'s currently-active entitlement (via the same getActiveEntitlement every other entitlement check in this codebase uses) before deciding whether to monitor — null household correctly short-circuits to null, never calling getActiveEntitlement(undefined)'
);

check(
  /if \(shouldStartPaidMonitoring\(household, activeEntitlement\)\) \{/.test(voiceBody),
  '/voice gates on shouldStartPaidMonitoring(household, activeEntitlement) — not a re-implemented inline check'
);

// --- both the announcement AND attachLiveMonitoring must be inside the
// gated branch — the announcement must never claim "monitored and
// protected" when monitoring is not actually about to happen ---
const gatedBranchMatch = voiceBody.match(/if \(shouldStartPaidMonitoring\(household, activeEntitlement\)\) \{([\s\S]*?)\} else if \(household\) \{/);
check(Boolean(gatedBranchMatch), 'sanity check: the shouldStartPaidMonitoring branch body is found');
const gatedBranch = gatedBranchMatch ? gatedBranchMatch[1] : '';

check(
  gatedBranch.includes('This number is monitored and protected by Home Call Guard.'),
  'the "monitored and protected" announcement is inside the entitlement-gated branch — never spoken to a caller when no monitoring will actually happen'
);
check(
  /attachLiveMonitoring\(twiml, \{ household, twilioNumber: req\.body\.To \}\)/.test(gatedBranch),
  'attachLiveMonitoring (the actual Media Stream / paid transcription trigger) is inside the same gated branch as the announcement — both or neither, never one without the other'
);

// --- the unentitled branch must exist, must not alert as a fault, and
// must not itself attach monitoring or speak the announcement ---
const unentitledBranchMatch = voiceBody.match(/\} else if \(household\) \{([\s\S]*?)\}\n\n  dialHouseholdOrFailClosed/);
check(Boolean(unentitledBranchMatch), 'sanity check: the "no active entitlement" branch body is found');
const unentitledBranch = unentitledBranchMatch ? unentitledBranchMatch[1] : '';

check(
  // Checked for an actual call (opening paren), not a bare substring — this
  // branch's own explanatory comment legitimately contains the prose "no
  // sendCriticalAlert", which must not itself be mistaken for a real call.
  unentitledBranch.includes('console.error(') && !unentitledBranch.includes('sendCriticalAlert('),
  'the no-active-entitlement branch logs (for visibility) but does NOT call sendCriticalAlert — this is expected, steady-state behaviour for a lapsed/cancelled household, not an incident'
);
check(
  !unentitledBranch.includes('attachLiveMonitoring') && !unentitledBranch.includes('monitored and protected'),
  'the no-active-entitlement branch never attaches monitoring and never speaks the "monitored and protected" line — the false-claim risk this fix specifically closes'
);

// --- the single most important invariant: dialHouseholdOrFailClosed must
// remain completely unconditional — a lapsed/cancelled household's calls
// must still connect exactly as before. Only ONE call to it in the whole
// /voice unknown-caller tail, outside both branches. ---
const dialCallCount = (voiceBody.match(/dialHouseholdOrFailClosed\(twiml, household\)/g) || []).length;
check(
  dialCallCount === 2, // once for the known-contact branch (unaffected by this change), once for the unknown-caller tail
  `dialHouseholdOrFailClosed is called exactly twice in /voice (known-contact branch + the unconditional unknown-caller tail) — found ${dialCallCount}. This fix must never add a THIRD, conditional call site that could skip call delivery for an unentitled household.`
);

// The unconditional tail call must be OUTSIDE both the gated and
// unentitled branches — i.e. it must appear after the closing brace of
// the else-if block, not nested inside either branch's own body.
check(
  !gatedBranch.includes('dialHouseholdOrFailClosed') && !unentitledBranch.includes('dialHouseholdOrFailClosed'),
  'dialHouseholdOrFailClosed is called neither inside the entitled branch nor inside the unentitled branch — it runs once, unconditionally, after both — call delivery is completely unaffected by this fix either way'
);

console.log(`\n${failures === 0 ? '✓ All' : `✗ ${failures}`} subscription-enforcement-voice-gate checks ${failures === 0 ? 'passed' : 'FAILED'}`);
process.exitCode = failures === 0 ? 0 : 1;
