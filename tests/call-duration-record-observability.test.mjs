// Structural proof that server.js's recordApprovedCallDeliveryOutcome
// makes a zero-row-matched update loud instead of silent (2026-09-26).
// Matches this codebase's established convention for testing server.js
// internals (source-string assertions; server.js is never required
// directly, since doing so would start the real app.listen()).
//
// Real production evidence this closes (found via a read-only audit,
// 2026-09-26): Twilio's own Call resource confirmed several genuinely
// answered, multi-second Client-leg calls whose calls.duration_seconds
// (and, separately, dial_call_status) were never recorded — the UPDATE's
// .eq("call_sid", callSid) matched zero rows for them, and .maybeSingle()
// treats that as an ordinary, error-free result ({ data: null, error:
// null }), so the failure left no trace anywhere. Twilio's own Debugger/
// Monitor Alerts showed no webhook-delivery failure for any affected
// call, so the exact trigger (most likely a race with /voice's
// fire-and-forget logCall() INSERT, not proven) is intentionally NOT
// guessed at here — this fix only makes the failure observable.
//
// Run with: node tests/call-duration-record-observability.test.mjs

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

const fnMatch = serverSrc.match(/async function recordApprovedCallDeliveryOutcome\(callSid, dialCallStatus, durationSeconds\) \{[\s\S]*?\n\}\n/);
check(Boolean(fnMatch), 'sanity check: recordApprovedCallDeliveryOutcome function body is found in server.js');
const fnBody = fnMatch ? fnMatch[0] : '';

// --- the update itself is unchanged in shape — this fix adds detection
// AFTER it, never changes what's written or how the row is matched ---
check(
  fnBody.includes('.update({ duration_seconds: durationSeconds, dial_call_status: dialCallStatus || null })') &&
    fnBody.includes('.eq("call_sid", callSid)') &&
    fnBody.includes('.select("household_id")') &&
    fnBody.includes('.maybeSingle()'),
  'the underlying update/select/maybeSingle shape is completely unchanged — this fix only adds detection of its zero-row-matched outcome, never a broader rewrite'
);

// --- the new zero-match branch must exist, come AFTER the existing error
// branch (a genuine Supabase error still returns early exactly as
// before), and BEFORE the row is ever destructured for household_id ---
const errorBranchIndex = fnBody.indexOf('if (error) {');
const zeroMatchBranchIndex = fnBody.indexOf('if (!data) {');
const destructureIndex = fnBody.indexOf('const householdId = data.household_id;');

check(errorBranchIndex !== -1, 'the pre-existing "if (error)" branch is still present, unmodified in position');
check(zeroMatchBranchIndex !== -1, 'a new "if (!data)" branch exists — the zero-row-matched case is now explicitly checked, not silently passed through');
check(
  errorBranchIndex !== -1 && zeroMatchBranchIndex !== -1 && zeroMatchBranchIndex > errorBranchIndex,
  'the zero-match check runs AFTER the genuine-Supabase-error check — a real query error is still reported as an error, never relabelled as "no matching row"'
);
check(
  destructureIndex !== -1 && zeroMatchBranchIndex !== -1 && destructureIndex > zeroMatchBranchIndex,
  'household_id is only ever read from `data` AFTER the zero-match branch has already returned — the old code\'s implicit `data && data.household_id` null-guard is now unreachable dead code by construction, not just usually-safe'
);

// --- the zero-match branch itself: must log AND alert (this is real,
// confirmed production data loss — a console.error alone, as used for the
// merely-expected no-active-entitlement case elsewhere in this file,
// would not be enough here), must never throw, and must return before
// ever attempting markHouseholdDeliveryVerified with an undefined household ---
const zeroMatchBranchMatch = fnBody.match(/if \(!data\) \{([\s\S]*?)\n  \}\n\n  const householdId/);
check(Boolean(zeroMatchBranchMatch), 'sanity check: the zero-match branch body is found');
const zeroMatchBranch = zeroMatchBranchMatch ? zeroMatchBranchMatch[1] : '';

check(
  zeroMatchBranch.includes('console.error(') && /\{ callSid, dialCallStatus, durationSeconds \}/.test(zeroMatchBranch),
  'the zero-match branch logs the CallSid and the outcome it failed to record — enough for a future occurrence to actually be looked up in Twilio\'s own Console'
);
check(
  /sendCriticalAlert\(\s*"call_duration_record_no_matching_row"/.test(zeroMatchBranch),
  'the zero-match branch raises a real critical alert under its own distinct type ("call_duration_record_no_matching_row") — this is confirmed data loss, not routine/expected behaviour, so it must not be silently swallowed the way the subscription-enforcement no-active-entitlement case correctly is'
);
check(
  /\.catch\(\(\) => \{\}\)/.test(zeroMatchBranch),
  'the alert call is fire-and-forget with its own .catch — an alerting-service failure must never throw out of this function or affect the already-returned TwiML response'
);
check(
  /^\s*return;\s*$/m.test(zeroMatchBranch),
  'the zero-match branch returns immediately — markHouseholdDeliveryVerified is never reached with an undefined/garbage householdId'
);

console.log(`\n${failures === 0 ? '✓ All' : `✗ ${failures}`} call-duration-record-observability checks ${failures === 0 ? 'passed' : 'FAILED'}`);
process.exitCode = failures === 0 ? 0 : 1;
