// Device call-readiness (2026-09-30, release readiness P1): a registered app
// that cannot present a call (Android microphone/notification permission off,
// or the Twilio SDK's 31401 "Missing permissions" drop) is UNREACHABLE — not
// "registered, so reachable". Backend parser + health model + mobile model.
//
// Run with: node tests/device-call-readiness.test.mjs

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { parseDeviceReadiness, isDeviceNotReady } = require('../services/deviceReadiness');
const { computeDeliveryHealth, STATES } = require('../services/deliveryHealth');

let failures = 0;
function check(condition, message) {
  if (condition) console.log(`✓ ${message}`);
  else { failures++; console.error(`✗ ${message}`); }
}

// --- backend payload parser ---
check(parseDeviceReadiness(null) === null && parseDeviceReadiness('x') === null && parseDeviceReadiness([]) === null, 'non-object payload → null');
check(parseDeviceReadiness({ platform: 'windows' }) === null, 'unknown platform → null');
{
  const r = parseDeviceReadiness({ platform: 'android', microphone: 'denied', notifications: 'granted', osVersion: 34, extra: '+447700900123' });
  check(r.platform === 'android' && r.microphone === 'denied' && r.notifications === 'granted' && r.osVersion === 34 && r.trigger === 'registration', 'valid android payload parsed');
  check(!('extra' in r), 'unknown keys dropped');
  const junk = parseDeviceReadiness({ platform: 'ios', microphone: 'yes please', osVersion: 9999 });
  check(junk.microphone === 'unknown' && junk.osVersion === undefined, 'invalid values → unknown / dropped');
  check(isDeviceNotReady(r) && !isDeviceNotReady({ microphone: 'granted', notifications: 'unknown' }), 'isDeviceNotReady only on a definite denial');
}

// --- health model ---
const REG = '2026-09-27T14:13:20Z';
const success = { callSid: 'CA1', at: '2026-09-27T11:36:44Z', dialCallStatus: 'completed' };
const noAnswer = { callSid: 'CA2', at: '2026-09-30T12:42:25Z', dialCallStatus: 'no-answer' };

{
  const before = computeDeliveryHealth({ attempts: [noAnswer, success], lastRegisteredAt: REG });
  check(before.state === STATES.HEALTHY, 'baseline (9cb62adb today): one unconfirmed no-answer after a success stays HEALTHY without device evidence');
  const blocked = computeDeliveryHealth({
    attempts: [noAnswer, success],
    lastRegisteredAt: REG,
    deviceReadiness: { reportedAt: '2026-09-28T09:00:00Z', microphone: 'denied', notifications: 'granted' },
  });
  check(blocked.state === STATES.UNREACHABLE && /microphone/.test(blocked.reasons[0]), 'microphone denied (reported after last success) → UNREACHABLE with a plain reason');
  check(blocked.customerStatus === 'unavailable' && blocked.needsAttention, 'customer status unavailable, needs attention');
}
{
  const r = computeDeliveryHealth({
    attempts: [], lastRegisteredAt: REG,
    deviceReadiness: { reportedAt: REG, microphone: 'granted', notifications: 'denied' },
  });
  check(r.state === STATES.UNREACHABLE && /notifications/.test(r.reasons[0]), 'notifications denied → UNREACHABLE before any call has failed');
}
{
  const laterSuccess = { callSid: 'CA3', at: '2026-09-29T10:00:00Z', dialCallStatus: 'completed' };
  const r = computeDeliveryHealth({
    attempts: [laterSuccess], lastRegisteredAt: REG,
    deviceReadiness: { reportedAt: '2026-09-28T09:00:00Z', microphone: 'denied', notifications: 'granted' },
  });
  check(r.state === STATES.HEALTHY, 'a delivered call after the denial report wins (permission since fixed)');
}
{
  const r = computeDeliveryHealth({
    attempts: [success], lastRegisteredAt: REG,
    deviceReadiness: { reportedAt: null, microphone: 'unknown', notifications: 'unknown', presentationBlockedAt: '2026-09-30T12:42:27Z' },
  });
  check(r.state === STATES.UNREACHABLE && /blocked/.test(r.reasons[0]), 'SDK 31401 presentation block → UNREACHABLE');
  const cleared = computeDeliveryHealth({
    attempts: [success], lastRegisteredAt: REG,
    deviceReadiness: { reportedAt: '2026-09-30T13:00:00Z', microphone: 'granted', notifications: 'granted', presentationBlockedAt: '2026-09-30T12:42:27Z' },
  });
  check(cleared.state === STATES.HEALTHY, 'a later all-granted report clears the block');
}
{
  const r = computeDeliveryHealth({
    attempts: [success], lastRegisteredAt: REG,
    deviceReadiness: { reportedAt: REG, microphone: 'unknown', notifications: 'unknown' },
  });
  check(r.state === STATES.HEALTHY, 'unknown permission state is never treated as blocked (iOS reports microphone unknown)');
  const none = computeDeliveryHealth({ attempts: [success], lastRegisteredAt: REG });
  check(none.state === STATES.HEALTHY, 'no readiness evidence → behaviour identical to before');
}
{
  const r = computeDeliveryHealth({ attempts: [], lastRegisteredAt: null, deviceReadiness: { reportedAt: REG, microphone: 'denied' } });
  check(r.state === STATES.UNREGISTERED, 'never registered still reports UNREGISTERED first');
}

// --- mobile pure model (transpiled from the real TypeScript) ---
const ts = require('../mobile/node_modules/typescript');
const mobile = (...p) => path.join(__dirname, '..', 'mobile', ...p);
const js = ts.transpileModule(readFileSync(mobile('lib', 'callReadinessModel.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 },
}).outputText;
const mod = { exports: {} };
new Function('module', 'exports', js)(mod, mod.exports);
const m = mod.exports;

{
  const a12 = m.buildAndroidReadiness(31, true, null);
  check(a12.notifications === 'not_required', 'Android 12 (API 31): notification permission not required');
  const a13 = m.buildAndroidReadiness(33, true, false);
  check(a13.notifications === 'denied' && m.readinessProblem(a13) === 'notifications', 'Android 13+: notifications denied → problem');
  const micOff = m.buildAndroidReadiness(30, false, true);
  check(m.readinessProblem(micOff) === 'microphone' && !m.canPresentCalls(micOff), 'microphone denied → cannot present calls');
  check(m.canPresentCalls(m.buildAndroidReadiness(34, null, null)), 'unknown (check failed) is not treated as blocked');
  check(m.canPresentCalls(null), 'no readiness (web / failure) is not treated as blocked');
  check(/Microphone/.test(m.readinessMessage('microphone')) && /Notifications/.test(m.readinessMessage('notifications')) && m.readinessMessage(null) === null, 'customer copy names the setting to turn on');
  check(m.readinessKey(a13) !== m.readinessKey(m.buildAndroidReadiness(33, true, true)), 'readiness key changes when a permission changes');
}

// --- mobile wiring (source) ---
const voiceClient = readFileSync(mobile('lib', 'voiceClient.ts'), 'utf8');
check(/MISSING_PERMISSIONS_ERROR_CODE = 31401/.test(voiceClient) && /presentationBlocked: true/.test(voiceClient), 'SDK 31401 is reported to the backend as a presentation block');
check(/readiness,\s*\}\)\.catch/.test(voiceClient), 'registration report carries readiness');
check(/presented: canPresentCalls\(readiness\)/.test(voiceClient), 'invite report carries presented');
check(/acceptedCall\.on\(Call\.Event\.Connected, \(\) => \{\s*reportWithRetry\(\(\) => reportCallInviteOutcome\(callSid, "connected"\)/.test(voiceClient), 'connected (media up) reported on both platforms');
check(/if \(lastRegistrationToken\) \{\s*getCallReadiness\(\)/.test(voiceClient), 'foreground readiness check only runs for a registered household');
const api = readFileSync(mobile('lib', 'api.ts'), 'utf8');
check(api.includes('"/api/v1/voice/device-readiness"'), 'api.ts calls the authenticated readiness route');
const home = readFileSync(mobile('app', '(tabs)', 'index.tsx'), 'utf8');
check(home.includes('<CallReadinessBanner />'), 'Home shows the readiness banner');
const banner = readFileSync(mobile('components', 'CallReadinessBanner.tsx'), 'utf8');
check(banner.includes('Linking.openSettings()') && banner.includes('state === "active"'), 'banner links to Settings and re-checks on foreground');

if (failures > 0) { console.error(`\n${failures} check(s) failed.`); process.exit(1); }
console.log('\nAll checks passed.');
