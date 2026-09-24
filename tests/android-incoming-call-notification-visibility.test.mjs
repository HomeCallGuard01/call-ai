// Locked-screen Answer/Decline fix (2026-09-23) — a real, physically
// reproduced Build 11 defect on a Motorola device: an incoming forwarded
// HCG call rang and identified "Home Call Guard" on the lock screen, but
// had no visible Answer control at all, and tapping the notification did
// not answer the call.
//
// Root cause (traced, not assumed — see the session's own investigation
// report): @twilio/voice-react-native-sdk's incoming-call notification
// (NotificationUtility.createIncomingCallNotification) still calls
// setFullScreenIntent() unconditionally, but that can never actually fire
// on any Android version once android.permission.USE_FULL_SCREEN_INTENT
// is blocked (see android-full-screen-intent-permission.test.mjs) — so
// the notification is only ever shown as an ordinary notification. With
// no explicit visibility set, NotificationCompat.Builder defaults to
// VISIBILITY_PRIVATE, which Android redacts on a LOCKED device —
// including this CallStyle's Answer/Decline actions, not just the
// caller's name.
//
// Fix: mobile/patches/@twilio+voice-react-native-sdk+2.0.0-preview.2.patch
// (the same established mechanism already used for the full-screen-intent
// redirect) adds .setVisibility(NotificationCompat.VISIBILITY_PUBLIC) to
// the incoming-call notification only — the standard, Play-policy-
// compliant way for a CATEGORY_CALL notification to show its content and
// actions on a locked device without a working full-screen intent.
// android.permission.USE_FULL_SCREEN_INTENT itself remains blocked/absent
// throughout — this fix does not restore it, and does not touch
// ConnectionService/Telecom or call-routing logic.
//
// Deliberately NOT applied to the ongoing-call/outgoing-call
// notifications: by the time either is shown, the call has already been
// answered (this fix's whole purpose already achieved), so their
// visibility has no bearing on the ability to answer a locked-screen
// incoming call. This test proves that scope boundary explicitly, not
// just the positive case, so a future edit can't silently broaden the
// patch "for consistency" without this test catching it.
//
// What this test PROVES: the patch file's source diff genuinely adds
// VISIBILITY_PUBLIC to createIncomingCallNotification only, AND — not
// just trusting the diff text — that patch-package mechanically applying
// it to a real, freshly-installed copy of the unpatched package produces
// a NotificationUtility.java that actually contains the call, in the
// right place. Same two-layer approach as
// android-full-screen-intent-permission.test.mjs (config declaration +
// a real mechanism run), applied here to the Java patch layer instead of
// the manifest-merger layer.
//
// What this test CANNOT prove: that a real compiled AAB/Java bytecode
// exhibits this at runtime, or that Android/this specific OEM actually
// renders the actions on the lock screen as a result — that requires an
// actual EAS build and a real physical-device test, both deliberate,
// separate, later steps.
//
// Run with: node tests/android-incoming-call-notification-visibility.test.mjs

import { readFileSync, mkdtempSync, rmSync, cpSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const mobileRoot = path.join(root, 'mobile');

let failures = 0;
function check(condition, message) {
  if (condition) console.log(`✓ ${message}`);
  else { console.error(`✗ ${message}`); failures++; }
}

// ============================================================
// 1. The patch file itself: VISIBILITY_PUBLIC is added to the incoming-
//    call notification's hunk, and ONLY that hunk — not the ongoing-call
//    or outgoing-call notification builders.
// ============================================================
const patchPath = path.join(
  mobileRoot,
  'patches',
  '@twilio+voice-react-native-sdk+2.0.0-preview.2.patch'
);
const patchSource = readFileSync(patchPath, 'utf8');

check(
  patchSource.includes('.setVisibility(NotificationCompat.VISIBILITY_PUBLIC)'),
  'the patch adds .setVisibility(NotificationCompat.VISIBILITY_PUBLIC) somewhere'
);

// Locate the createIncomingCallNotification hunk specifically (the one
// that also touches setFullScreenIntent(piFullScreenIntent...), the
// existing, already-approved fix) and confirm the visibility call is
// inside it, immediately alongside the full-screen-intent line — not
// floating in some other, unrelated hunk.
const incomingHunkStart = patchSource.indexOf('setFullScreenIntent(piFullScreenIntent, true)');
check(incomingHunkStart !== -1, 'the pre-existing setFullScreenIntent(piFullScreenIntent...) fix is still present, unremoved');

const afterIncomingFullScreenIntent = patchSource.slice(incomingHunkStart, incomingHunkStart + 2000);
check(
  afterIncomingFullScreenIntent.includes('.setVisibility(NotificationCompat.VISIBILITY_PUBLIC)') &&
    afterIncomingFullScreenIntent.includes('CallStyle.forIncomingCall'),
  'VISIBILITY_PUBLIC is set on the SAME notification builder chain as the incoming-call CallStyle — proves it is wired to the actual incoming-call notification, not a different one'
);

// The ongoing-call notification (createCallAnsweredNotificationWithLowImportance)
// and outgoing-call notification (createOutgoingCallNotificationWithLowImportance)
// must NOT be touched by this patch — the fix is deliberately scoped to
// the incoming-call notification only (see this file's own header for
// why broadening it would be unrelated scope).
check(
  !patchSource.includes('CallStyle.forOngoingCall'),
  'the patch does not touch the ongoing/outgoing-call notification builders at all (CallStyle.forOngoingCall never appears in the patch) — the fix stays scoped to the incoming-call notification only, not broadened "for consistency"'
);

// ============================================================
// 2. USE_FULL_SCREEN_INTENT remains blocked/absent — this fix must never
//    restore it. (android-full-screen-intent-permission.test.mjs already
//    covers this exhaustively; this is a narrow, local sanity check that
//    THIS patch specifically doesn't reintroduce it.)
// ============================================================
check(
  !patchSource.includes('uses-permission') && !patchSource.includes('AndroidManifest'),
  'this patch touches Java source only — no AndroidManifest.xml hunk exists in it, so it cannot be reintroducing any permission'
);

const configSource = readFileSync(path.join(mobileRoot, 'app.config.js'), 'utf8');
check(
  configSource.includes('"android.permission.USE_FULL_SCREEN_INTENT"'),
  'mobile/app.config.js still blocks android.permission.USE_FULL_SCREEN_INTENT — unchanged by this fix, exactly as required'
);

// ============================================================
// 3. Real mechanism check, no network dependency (this is a permanent
//    regression test, run in every `npm test`/CI invocation — a fetch
//    from the npm registry here would make it flaky for reasons
//    unrelated to the fix itself). Two local-only proofs instead:
//
//    a) The actual installed node_modules Java source (the exact file
//       patch-package's own postinstall hook produced the last time
//       `npm install` ran in this repo state) genuinely contains the
//       change, correctly scoped — not just the patch file's diff text.
//    b) The patch file's hunk is byte-consistent with that installed
//       file: reverse-applying it with the real `patch` CLI against a
//       scratch copy must cleanly detect "already applied" — proving
//       the diff text and the installed file are not just similar but
//       exactly consistent with each other.
// ============================================================
const installedNotificationUtilityPath = path.join(
  mobileRoot,
  'node_modules', '@twilio', 'voice-react-native-sdk',
  'android', 'src', 'main', 'java', 'com', 'twiliovoicereactnative', 'NotificationUtility.java'
);
let installedSource = '';
try {
  installedSource = readFileSync(installedNotificationUtilityPath, 'utf8');
} catch {
  // Handled by the check below, which fails loudly rather than silently skipping.
}
check(installedSource.length > 0, 'the real, installed Twilio NotificationUtility.java exists in node_modules to inspect');

const installedIncomingStart = installedSource.indexOf('createIncomingCallNotification');
const installedIncomingEnd = installedSource.indexOf('createCallAnsweredNotificationWithLowImportance');
const installedIncomingBody = installedSource.slice(installedIncomingStart, installedIncomingEnd);
check(
  installedIncomingStart !== -1 && installedIncomingEnd !== -1 &&
    installedIncomingBody.includes('.setVisibility(NotificationCompat.VISIBILITY_PUBLIC)'),
  'the real, currently-installed createIncomingCallNotification() (produced by patch-package\'s own postinstall hook, not just the patch file text) actually contains .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)'
);
check(
  installedIncomingBody.includes('setFullScreenIntent(piFullScreenIntent, true)'),
  'the pre-existing full-screen-intent redirect fix is also present in the real installed file (still points at piFullScreenIntent, not the original piForegroundIntent) — confirms both fixes coexist correctly in what is actually installed, not just in source control'
);

const installedAnsweredStart = installedSource.indexOf('createCallAnsweredNotificationWithLowImportance');
const installedAnsweredEnd = installedSource.indexOf('createOutgoingCallNotificationWithLowImportance');
const installedAnsweredBody = installedSource.slice(installedAnsweredStart, installedAnsweredEnd);
check(
  installedAnsweredStart !== -1 && installedAnsweredEnd !== -1 && !installedAnsweredBody.includes('setVisibility'),
  'the real, currently-installed ongoing-call notification builder does NOT have VISIBILITY_PUBLIC — confirms the fix stayed scoped to the incoming-call notification only, in what is actually installed, not just the patch file text'
);

// Reverse-apply proof: the patch file's own hunks, run with -R against a
// scratch copy of the real installed source, must cleanly detect
// "already applied" (patch's own wording for a successful reverse
// application) — proving the patch text and the installed file are
// exactly, byte-for-byte consistent, not just similar.
let scratchDir = null;
try {
  scratchDir = mkdtempSync(path.join(os.tmpdir(), 'hcg-notif-visibility-reverse-check-'));
  const scratchNodeModules = path.join(scratchDir, 'node_modules');
  cpSync(path.join(mobileRoot, 'node_modules', '@twilio'), path.join(scratchNodeModules, '@twilio'), { recursive: true });

  // execFileSync throws on a non-zero exit code — patch(1) exits non-zero
  // and reports "FAILED"/writes a .rej file the moment any hunk doesn't
  // apply cleanly, so reaching this line at all (no throw) already proves
  // success; the explicit text checks below are belt-and-braces, not the
  // primary proof.
  const reverseOutput = execFileSync(
    'patch',
    ['-p1', '--dry-run', '-R', '-f', '-i', patchPath],
    { cwd: scratchDir, encoding: 'utf8' }
  );
  check(
    !/FAILED|reject/i.test(reverseOutput) &&
      reverseOutput.includes('NotificationUtility.java'),
    `patch -p1 --dry-run -R exited successfully (no throw) and reported no FAILED/rejected hunks against the real installed source for this exact patch file — proves the patch text and the installed file are byte-consistent, not just similar (output: ${reverseOutput.trim().slice(0, 300)})`
  );
} catch (err) {
  check(false, `reverse-apply consistency check ran without error (${String(err && err.stdout ? err.stdout : err && err.message).slice(0, 300)})`);
} finally {
  if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
