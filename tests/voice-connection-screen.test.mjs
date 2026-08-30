// Coverage for the B5 "Connecting Home Call Guard" screen
// (app/(setup)/connecting.tsx), which replaces the old second-phone
// verification screen (app/(setup)/verify.tsx) in the normal onboarding
// flow — 2026-08-30 product decision: a customer should never need a
// second phone, or to call their own number and press "Try again", just
// to activate protection. Green/"active" is gated on a genuine,
// backend-confirmed Voice SDK reachability signal
// (protection.voiceClientReachable, call-ai backend migration 030), never
// on a button press or simply returning to the app.
//
// Two layers, matching this repo's established pattern for React Native
// screens with no rendering harness available (see
// activation-screen-navigation.test.mjs for the same approach applied to
// app/(setup)/activate.tsx):
//   1. Pure decision logic (shouldShowManualRecovery), imported directly
//      and exercised with real inputs.
//   2. A static check of the real screen/source files, confirming the
//      structural properties a renderer would otherwise verify: the
//      screen actually triggers registration and polls the real
//      reachability signal, never shows the confirmed state any other
//      way, never reintroduces second-phone language, and the old
//      screen's navigation targets have all been repointed.
//
// Run with: node tests/voice-connection-screen.test.mjs

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  shouldShowManualRecovery,
  POLL_INTERVAL_MS,
  MAX_WAIT_MS,
} from '../mobile/lib/voiceConnectionStatus.ts';

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

// --- Pure logic: shouldShowManualRecovery ---

check(
  shouldShowManualRecovery(0, 0) === false,
  'shouldShowManualRecovery: false at the very start — no failures, no time elapsed'
);
check(
  shouldShowManualRecovery(1, 5000) === false,
  'shouldShowManualRecovery: a single dropped poll, well within the wait window, does not yet show recovery'
);
check(
  shouldShowManualRecovery(2, 0) === true,
  'shouldShowManualRecovery: two consecutive poll failures show recovery immediately, even with no time elapsed — polling itself is broken'
);
check(
  shouldShowManualRecovery(0, MAX_WAIT_MS) === true,
  'shouldShowManualRecovery: reaching the max wait time shows recovery even with zero poll failures — registration is just genuinely slow/stuck'
);
check(
  shouldShowManualRecovery(0, MAX_WAIT_MS - 1) === false,
  'shouldShowManualRecovery: one millisecond short of the max wait, with no failures, still shows connecting'
);
check(
  POLL_INTERVAL_MS > 0 && POLL_INTERVAL_MS < MAX_WAIT_MS,
  'POLL_INTERVAL_MS is positive and smaller than MAX_WAIT_MS, so at least one real poll always happens before recovery can show on elapsed-time grounds alone'
);

// --- Static structure check of the real connecting.tsx source ---

const connectingSource = readFileSync(
  path.join(__dirname, '..', 'mobile', 'app', '(setup)', 'connecting.tsx'),
  'utf8'
);

check(
  connectingSource.includes('registerForIncomingCalls('),
  'connecting.tsx actually triggers Voice SDK registration itself, rather than only waiting on something else to have done it'
);
check(
  connectingSource.includes('fetchDashboard('),
  'connecting.tsx polls the real dashboard endpoint for the reachability signal'
);
check(
  connectingSource.includes('dashboard.protection.voiceClientReachable'),
  'connecting.tsx reads the genuine backend-confirmed voiceClientReachable field'
);
check(
  connectingSource.includes('setPhase("confirmed")') &&
    /if\s*\(\s*dashboard\.protection\.voiceClientReachable\s*\)\s*\{\s*\n?\s*if \(isMounted\.current\) setPhase\("confirmed"\)/.test(connectingSource),
  'the confirmed phase is only ever set from inside the successful poll branch, gated on the real voiceClientReachable value'
);

const confirmedSetCount = (connectingSource.match(/setPhase\("confirmed"\)/g) || []).length;
check(
  confirmedSetCount === 1,
  `setPhase("confirmed") is called from exactly one place in the whole screen (found ${confirmedSetCount}) — no secondary path (a button, a timeout) can independently flip it`
);

check(
  connectingSource.includes('router.replace("/(setup)/complete")'),
  'connecting.tsx continues to the real setup-complete screen once confirmed, not straight to the dashboard'
);

check(
  connectingSource.includes('Connecting Home Call Guard') && connectingSource.includes('Home Call Guard is active'),
  'the two required customer-facing strings are present: the connecting state and the confirmed state'
);

check(
  connectingSource.includes('label="Try again"') && connectingSource.includes('Contact support'),
  'the recovery state offers Try again and Contact support'
);

const noSecondPhoneLanguage = [
  'another phone',
  'call your own number',
  'call yourself',
  'second phone',
].every((phrase) => !connectingSource.toLowerCase().includes(phrase));
check(
  noSecondPhoneLanguage,
  'connecting.tsx never reintroduces second-phone-test language as its recovery mechanism'
);

// --- Static check: activate.tsx now routes to connecting, not verify ---

const activateSource = readFileSync(
  path.join(__dirname, '..', 'mobile', 'app', '(setup)', 'activate.tsx'),
  'utf8'
);

const verifyPushCount = (activateSource.match(/router\.push\("\/\(setup\)\/verify"\)/g) || []).length;
check(
  verifyPushCount === 0,
  'activate.tsx no longer navigates to the old second-phone verification screen from anywhere'
);

const connectingPushCount = (activateSource.match(/router\.push\("\/\(setup\)\/connecting"\)/g) || []).length;
check(
  connectingPushCount === 3,
  `activate.tsx routes to the new connecting screen from all three places the old verify navigation happened (found ${connectingPushCount}, expected 3: AppState auto-advance, landline manual continue, "Already done this?" link)`
);

// --- Static check: the old verify.tsx screen is left intact (rollback path), not deleted ---

const verifySource = readFileSync(
  path.join(__dirname, '..', 'mobile', 'app', '(setup)', 'verify.tsx'),
  'utf8'
);
check(
  verifySource.includes('verifyActivation') && verifySource.includes('export default function Verify'),
  'the old second-phone verification screen still exists and is functionally intact, just no longer linked from the normal flow — a real rollback path, not deleted code'
);
check(
  /NO LONGER PART OF THE NORMAL SETUP FLOW/.test(verifySource),
  'the old screen documents, in its own header, that it has been superseded and why'
);

// --- Static check: the dashboard type contract includes the new field ---

const typesSource = readFileSync(path.join(__dirname, '..', 'mobile', 'lib', 'types.ts'), 'utf8');
check(
  typesSource.includes('voiceClientReachable: boolean'),
  'DashboardResponse.protection declares voiceClientReachable, matching the real backend field'
);

// --- Static check: resume logic recognises the new signal too, not just the old one ---

const welcomeSource = readFileSync(path.join(__dirname, '..', 'mobile', 'app', '(setup)', 'welcome.tsx'), 'utf8');
check(
  welcomeSource.includes('!!data.protection.activationVerifiedAt || data.protection.voiceClientReachable'),
  'welcome.tsx (setup entry point) treats either the old call-verified signal or the new Voice SDK reachability signal as "activation done"'
);

const homeSource = readFileSync(path.join(__dirname, '..', 'mobile', 'app', '(tabs)', 'index.tsx'), 'utf8');
check(
  homeSource.includes('!!data!.protection.activationVerifiedAt || data!.protection.voiceClientReachable'),
  'the Home tab\'s "Finish setup" resume logic treats either signal as "activation done" too, so a customer who completed the new flow is never sent back to redo activation'
);

// --- Static check: setupFlow.ts maps the new screen into the existing macro-step ---

const setupFlowSource = readFileSync(path.join(__dirname, '..', 'mobile', 'lib', 'setupFlow.ts'), 'utf8');
check(
  /connecting:\s*3/.test(setupFlowSource),
  'setupFlow.ts maps the new connecting screen into the same "Activate" macro-step as device-picker/activate/verify, not a new visible step'
);

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
