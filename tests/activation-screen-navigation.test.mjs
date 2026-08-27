// Coverage for the Activation screen's provisioning-wait UX (2026-08-08),
// second pass — a real iPhone test found the first pass (the polling
// stage-list screen) still trapped the customer: a genuinely "failed"
// Twilio provisioning status routed to an entirely separate screen with
// no path back to the dashboard, only "Change device" (which just
// returns to the device picker, still mid-setup).
//
// Two layers, matching this repo's established pattern for React Native
// screens with no rendering harness available (see
// contact-picker-feature-detection.test.mjs for the same approach
// applied to upload.html):
//   1. Pure decision logic (provisioningExplanation,
//      computeProvisioningStages, shouldShowManualRetry), imported
//      directly and exercised with real inputs.
//   2. A static check of the real screen's source, confirming the
//      structural properties a renderer would otherwise verify: the
//      dashboard link appears on every state, the old dead-end failed
//      screen is gone, the stage list is rendered once (not duplicated
//      per state), and "Check again" only ever appears behind the
//      polling-failure guard.
//
// Run with: node tests/activation-screen-navigation.test.mjs

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  computeProvisioningStages,
  provisioningExplanation,
  shouldShowManualRetry,
  PROVISIONING_EXPLANATION_NORMAL,
  PROVISIONING_EXPLANATION_SLOW_OR_FAILED,
} from '../mobile/lib/provisioningStages.ts';

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

// --- Pure logic: wording adapts, stage list does not ---

check(
  provisioningExplanation(null) === PROVISIONING_EXPLANATION_NORMAL,
  'provisioningExplanation: before the first poll resolves (null), uses the normal "you don\'t need to do anything" wording, not an alarming one'
);
check(
  provisioningExplanation('pending') === PROVISIONING_EXPLANATION_NORMAL,
  'provisioningExplanation: pending uses the normal wording'
);
check(
  provisioningExplanation('active') === PROVISIONING_EXPLANATION_NORMAL,
  'provisioningExplanation: active (about to auto-advance) still uses the normal wording'
);
check(
  provisioningExplanation('failed') === PROVISIONING_EXPLANATION_SLOW_OR_FAILED,
  'provisioningExplanation: failed switches to "taking a little longer than usual" — never a separate "something is wrong" message'
);

const pendingStages = computeProvisioningStages('pending');
const failedStages = computeProvisioningStages('failed');
check(
  JSON.stringify(pendingStages) === JSON.stringify(failedStages),
  'computeProvisioningStages: pending and failed produce the exact same stage list — the blocked step stays visibly ⏳ either way, never a different or missing stage list for a failed status'
);
check(
  failedStages.find(s => s.key === 'number').state === 'in_progress',
  'computeProvisioningStages: a failed status never marks the blocked stage "done" — stays truthfully in progress'
);

check(shouldShowManualRetry(0) === false, 'shouldShowManualRetry: no manual retry while polling itself is working, regardless of provisioning status');
check(shouldShowManualRetry(1) === false, 'shouldShowManualRetry: one dropped poll is not enough to show a manual retry');
check(shouldShowManualRetry(2) === true, 'shouldShowManualRetry: repeated poll failures are the one case a manual retry is shown');

// --- Static structure check of the real screen source ---

const source = readFileSync(
  path.join(__dirname, '..', 'mobile', 'app', '(setup)', 'activate.tsx'),
  'utf8'
);

const backToDashboardUsages = (source.match(/<BackToDashboardLink\s*\/>/g) || []).length;
check(
  backToDashboardUsages >= 4,
  `BackToDashboardLink is rendered on every screen state — loading, waiting/failed, error, and ready (found ${backToDashboardUsages} usages, expected at least 4)`
);

check(
  source.includes('router.replace("/(tabs)")'),
  'BackToDashboardLink navigates to the real Home dashboard route, not just back within the setup flow'
);

check(
  !source.includes("We're sorting out one part of your setup"),
  'the old separate, dead-end "failed" screen (no stage list, no dashboard link, only Change device) no longer exists'
);

const stageListRenders = (source.match(/stages\.map\(/g) || []).length;
check(
  stageListRenders === 1,
  `the stage list is rendered from exactly one place, shared by both waiting and failed states, not duplicated per state (found ${stageListRenders})`
);

const checkAgainUsages = (source.match(/label="Check again"/g) || []).length;
check(
  checkAgainUsages === 1,
  `"Check again" appears exactly once in the whole screen (found ${checkAgainUsages})`
);

const pollingBrokenGuardIndex = source.indexOf('pollingBroken &&');
const checkAgainIndex = source.indexOf('label="Check again"');
const between = pollingBrokenGuardIndex !== -1 && checkAgainIndex !== -1
  ? source.slice(pollingBrokenGuardIndex, checkAgainIndex)
  : '';
check(
  pollingBrokenGuardIndex !== -1 &&
    checkAgainIndex > pollingBrokenGuardIndex &&
    between.length < 500 &&
    !between.includes('function ') &&
    !between.includes('return ('),
  '"Check again" is only ever reachable behind the pollingBroken guard — never shown during normal provisioning, only when polling itself is failing'
);

// --- Fail-safe #1/#2 (2026-08-08/09): undo code shown, loop blocked before activation ---

check(
  source.includes('forwardingLoopError') && source.includes('err.code === "forwarding_loop"'),
  'the screen handles a forwarding_loop ApiError from the backend as its own distinct state, not a generic error'
);

check(
  source.includes('params.protectedNumber') &&
    source.includes('fetchActivationInstructions(params.deviceType, params.provider, params.protectedNumber, session?.access_token)'),
  'the confirmed phone number from device-picker is actually sent to the backend for the loop check, not silently dropped'
);

check(
  source.includes('UndoForwardingSection') && source.includes('instructions.cancelCode'),
  'the real cancel code from the backend response is shown on the activation screen — never a hardcoded/invented universal code'
);

check(
  source.includes('saveActivationDevice'),
  'the activation screen persists which device/provider was used, so the cancel code stays reachable after setup (Account tab) rather than only existing on this one-time screen'
);

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
