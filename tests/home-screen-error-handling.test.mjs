// Structural tests for the Home screen error-handling fix (2026-09-20):
// a failed dashboard load used to show the same "Can't check right now —
// check your connection" message for a genuinely expired/invalid mobile
// session, a real backend 5xx, and an actual network/no-response
// failure — confirmed via a real production account whose session never
// carried through from email confirmation. Only a genuine network/
// no-response failure should say that now; a 401 tells the customer
// their session expired and offers to sign them in again; a 5xx says
// there's a temporary problem on HCG's end.
//
// The actual decision logic (classifyLoadFailure, deriveLoadOutcome) is
// a pure function already exercised with real inputs in
// tests/mobile-app.test.mjs — this file proves the WIRING: the screen
// actually calls it, actually branches on all three reasons, and the
// session-expiry action actually clears the session before navigating,
// rather than just retrying the same failing request.
//
// No HTTP/RN test tooling exists in this project — every file is
// checked directly against its real source (see
// tests/device-picker-landline-device-type.test.mjs for the same
// established convention).
//
// Run with: node tests/home-screen-error-handling.test.mjs

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mobileRoot = path.join(__dirname, '..', 'mobile');

const homeSource = readFileSync(path.join(mobileRoot, 'app', '(tabs)', 'index.tsx'), 'utf8');
const loadFailureSource = readFileSync(path.join(mobileRoot, 'lib', 'loadFailure.ts'), 'utf8');
const homeStatusSource = readFileSync(path.join(mobileRoot, 'lib', 'homeStatus.ts'), 'utf8');

let failures = 0;

function check(condition, message) {
  if (condition) {
    console.log(`✓ ${message}`);
  } else {
    console.error(`✗ ${message}`);
    failures++;
  }
}

// ============================================================
// mobile/lib/loadFailure.ts
// ============================================================

check(
  loadFailureSource.includes('export function classifyLoadFailure('),
  'mobile/lib/loadFailure.ts exports classifyLoadFailure'
);
check(
  loadFailureSource.includes('session_expired') &&
    loadFailureSource.includes('server_error') &&
    loadFailureSource.includes('network_error'),
  'loadFailure.ts defines all three failure reasons'
);

// ============================================================
// mobile/lib/homeStatus.ts — carries the reason through
// ============================================================

check(
  homeStatusSource.includes('import type { LoadFailureReason } from "./loadFailure"'),
  'homeStatus.ts imports LoadFailureReason from the new dependency-free loadFailure module, not react-native/supabase — stays testable with plain Node'
);
check(
  /unavailable";\s*reason:\s*LoadFailureReason\s*}/.test(homeStatusSource) ||
    homeStatusSource.includes('kind: "unavailable"; reason: LoadFailureReason'),
  'LoadOutcome\'s "unavailable" variant now carries a reason, not just a bare kind'
);
check(
  homeStatusSource.includes('failureReason ?? "network_error"'),
  'deriveLoadOutcome defaults to network_error when no failureReason is supplied, preserving every existing call site'
);

// ============================================================
// mobile/app/(tabs)/index.tsx — the actual wiring
// ============================================================

check(
  homeSource.includes('import { classifyLoadFailure, type LoadFailureReason } from "../../lib/loadFailure"'),
  'index.tsx imports classifyLoadFailure'
);
check(
  homeSource.includes('if (!isNotEntitledError) failureReason = classifyLoadFailure(err);'),
  'index.tsx classifies the actual caught error (skipping NotEntitledError, which is already its own distinct outcome) before deciding the next screen state'
);
check(
  /deriveLoadOutcome\(\{\s*succeeded,\s*isNotEntitledError,\s*hadPriorData:\s*!!data,\s*failureReason\s*\}\)/.test(homeSource),
  'the classified failureReason is passed into deriveLoadOutcome'
);
check(
  homeSource.includes('setUnavailableReason(outcome.reason);'),
  'the resolved reason is stored in state so the render branch below can read it'
);

// Three distinct render branches, not one generic message.
check(
  homeSource.includes('unavailableReason === "session_expired"') &&
    homeSource.includes('Please sign in again') &&
    homeSource.includes('Your session has expired'),
  'a session_expired failure shows session-specific copy, not the generic connectivity message'
);
check(
  homeSource.includes('unavailableReason === "server_error"') &&
    homeSource.includes('Temporary problem') &&
    homeSource.includes('temporary problem on our end'),
  'a server_error failure shows HCG-service-problem copy, distinct from both session_expired and a real connectivity failure'
);
check(
  homeSource.includes("Can't check right now") &&
    homeSource.includes('Check your connection and try again'),
  'the original connectivity message is preserved verbatim for the genuine network_error case — existing correct behaviour for a real connectivity blip is unchanged'
);

// Session-expiry action: must actually clear the session and navigate,
// not just retry the same request that will only fail identically again.
check(
  /function handleSessionExpired\(\) \{[\s\S]*?resetVoiceRegistrationState\(\)[\s\S]*?supabase\.auth\.signOut\(\)[\s\S]*?router\.replace\("\/\(auth\)\/login"\)[\s\S]*?\}/.test(homeSource),
  'handleSessionExpired resets voice-registration state, signs the stale session out, and navigates to the login screen, rather than silently retrying — matching the established sign-out pattern (account/index.tsx)'
);
check(
  homeSource.includes('onPress={handleSessionExpired}'),
  'the "Sign in" button on the session_expired branch is wired to handleSessionExpired, not to load() (retrying an expired session would just fail the same way again)'
);
check(
  homeSource.includes('onPress={() => load()}') &&
    (homeSource.match(/onPress={\(\) => load\(\)}/g) || []).length === 2,
  'both the server_error and network_error branches keep "Try again" wired to a real retry (a 5xx or a connectivity blip can both genuinely resolve on retry, unlike an expired session)'
);

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
