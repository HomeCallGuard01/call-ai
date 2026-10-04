// Customer-visible delivery state (2026-09-29, P0 call-delivery
// resilience): when real calls show the app cannot receive them, no
// surface may keep showing an unqualified "Protection Active". Also
// covers the triage tool's operator answers and the mobile app's
// foreground re-registration rule.
//
// Run with: node tests/customer-delivery-visibility.test.mjs

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { computeProtectionStatus } = require('../services/callRouting.js');
const { buildCustomerProtectionSteps } = require('../services/customerProtectionSteps.js');
const { computeDeliveryHealth } = require('../services/deliveryHealth.js');
const { answerTriageQuestions } = require('../services/incomingCallTriage.js');

let failures = 0;
function check(condition, message) {
  if (condition) console.log(`✓ ${message}`);
  else { failures++; console.error(`✗ ${message}`); }
}

const NOW = new Date('2026-09-26T15:00:00Z');
// f06bc964's shape: number active, forwarding verified, registered, delivered once on 19 Sep.
const household = {
  twilio_provisioning_status: 'active',
  twilio_number: '+441632960533',
  activation_verified_at: '2026-09-24T16:20:14Z',
  voice_client_registered_at: '2026-09-19T10:00:00Z',
  delivery_verified_at: '2026-09-19T14:54:28Z',
};
const attempt = (at, fields) => ({ callSid: 'CA' + at, at, ...fields });
const unreachable = computeDeliveryHealth({
  attempts: [attempt('2026-09-19T14:54:00Z', { dialCallStatus: 'completed' }), attempt('2026-09-25T18:24:26Z', { dialCallStatus: 'no-answer', pushFailure: 'fcm:NotRegistered' })],
  lastRegisteredAt: household.voice_client_registered_at,
});
const suspect = computeDeliveryHealth({
  attempts: [attempt('2026-09-19T14:54:00Z', { dialCallStatus: 'completed' }), attempt('2026-09-25T18:24:26Z', { dialCallStatus: 'no-answer', pushFailure: 'fcm:NotRegistered' })],
  lastRegisteredAt: '2026-09-26T14:07:01Z',
});
const healthy = computeDeliveryHealth({ attempts: [attempt('2026-09-19T14:54:00Z', { dialCallStatus: 'completed' })], lastRegisteredAt: household.voice_client_registered_at });

// --- computeProtectionStatus ---
const legacy = computeProtectionStatus(household, NOW);
check(legacy.fullyProtected === true, 'without delivery health: unchanged (this is the incident — "Protection Active" despite dropped calls)');
check(JSON.stringify(computeProtectionStatus(household, NOW, null)) === JSON.stringify(legacy), 'passing null is identical to the two-argument call');
const withUnreachable = computeProtectionStatus(household, NOW, unreachable);
check(withUnreachable.fullyProtected === false && withUnreachable.deliveryReady === false, 'UNREACHABLE → not fully protected, app not ready');
check(withUnreachable.endToEndDeliveryVerified === true && withUnreachable.forwardingVerified === true, 'historical facts (forwarding, past delivery) are not rewritten');
check(computeProtectionStatus(household, NOW, suspect).fullyProtected === true, 'SUSPECT does not flip the booleans (not conclusive)');
check(computeProtectionStatus(household, NOW, healthy).fullyProtected === true, 'HEALTHY → protected');

// --- 5-step checklist guidance ---
const stepsUnreachable = buildCustomerProtectionSteps(household, NOW, unreachable);
check(stepsUnreachable.guidance && stepsUnreachable.guidance.key === 'calls_not_reaching_app', 'UNREACHABLE → "calls can\'t currently reach this phone" guidance');
check(stepsUnreachable.steps.find(s => s.key === 'protection_active').done === false, 'UNREACHABLE → "Protection Active" step not ticked');
const stepsSuspect = buildCustomerProtectionSteps(household, NOW, suspect);
check(stepsSuspect.guidance && stepsSuspect.guidance.key === 'delivery_needs_attention', 'SUSPECT → gentle needs-attention guidance');
check(stepsSuspect.steps.every(s => s.done), 'SUSPECT → steps unchanged (all done)');
check(buildCustomerProtectionSteps(household, NOW, healthy).guidance === null, 'HEALTHY → no guidance');
check(buildCustomerProtectionSteps(household, NOW).guidance === null, 'no health passed → previous behaviour (no guidance)');
for (const g of [stepsUnreachable.guidance, stepsSuspect.guidance]) {
  check(!/fcm|twilio|push|token|sdk|52103|voip/i.test(g.message), `guidance "${g.key}" uses no provider terminology`);
  check(!/##21#|turn off (call )?forwarding/i.test(g.message), `guidance "${g.key}" does not instruct turning off forwarding (open product decision)`);
}
const notSetUp = { ...household, activation_verified_at: null, delivery_verified_at: null };
check(buildCustomerProtectionSteps(notSetUp, NOW, unreachable).guidance.key === 'forwarding_not_detected', 'setup guidance still takes priority over delivery health');

// --- API/web wiring ---
const mobileApi = readFileSync(path.join(__dirname, '..', 'routes', 'mobileApi.js'), 'utf8');
check(mobileApi.includes('getHouseholdDeliveryHealth({ supabase: supabaseAdmin, household: req.household }).catch('), 'mobile dashboard reads delivery health, fail-open');
check(/deliveryHealth: deliveryHealth\n\s+\? \{\n\s+status: deliveryHealth\.customerStatus,/.test(mobileApi), 'mobile dashboard exposes only the plain customer status (+ timestamps)');
const server = readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
check(server.includes('const { protection } = await resolveCanonicalProtection({ supabase: supabaseAdmin, household: req.household, deliveryHealth, now: new Date() });'), 'web /dashboard-data uses the same delivery health (via the canonical status, 2026-10-04)');

// --- routing is untouched ---
const dialFn = (server.match(/function dialHouseholdOrFailClosed\(twiml, household(?:, dialOptions = \{\})?\) \{[\s\S]*?\n\}\n/) || [''])[0];
check(dialFn && !dialFn.includes('deliveryHealth') && !dialFn.includes('DeliveryHealth'), 'call routing (dialHouseholdOrFailClosed) never reads delivery health');

// --- triage operator answers ---
const failing = {
  verdict: 'delivery_failing',
  attempts: [{ callSid: 'CAp', at: '2026-09-25T18:24:26Z', clientLegStatus: 'no-answer', pushFailure: 'fcm:NotRegistered' }],
  findings: [],
};
const a1 = answerTriageQuestions({ triage: failing, health: unreachable });
check(a1.reachedHcg === 'yes' && a1.appDeliveryAttempted === 'yes' && a1.pushFailed === 'yes' && a1.answered === 'no', 'triage: push-failed call answered correctly');
check(a1.clientRang === 'unknown', 'triage: phone-rang is "unknown" without device evidence, never guessed');
check(a1.registrationState === 'UNREACHABLE' && a1.nextSteps.length >= 2, 'triage: health state and next steps given');
const quietT = answerTriageQuestions({ triage: { verdict: 'no_traffic_in_window', attempts: [], findings: [] } });
check(quietT.reachedHcg === 'no' && quietT.appDeliveryAttempted === 'unknown' && quietT.nextSteps[0].includes('*#21#'), 'triage: nothing reached HCG → handset divert check');
const rang = answerTriageQuestions({
  triage: { verdict: 'delivery_failing', attempts: [{ callSid: 'CAq', clientLegStatus: 'no-answer' }], findings: [] },
  latestDbAttempt: { call_sid: 'CAq', client_invite_received_at: '2026-09-26T14:05:26Z' },
});
check(rang.clientRang === 'yes' && rang.pushFailed === 'no', 'triage: device-confirmed ring → push did not fail');
check(answerTriageQuestions({ triage: { verdict: 'number_not_owned', attempts: [], findings: [] } }).reachedHcg === 'no', 'triage: released number → did not reach HCG');

// --- mobile: foreground re-registration rule (transpiled from the real TS) ---
const ts = require('../mobile/node_modules/typescript');
const src = readFileSync(path.join(__dirname, '..', 'mobile', 'lib', 'registrationFreshness.ts'), 'utf8');
const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 } }).outputText;
const mod = { exports: {} };
new Function('module', 'exports', js)(mod, mod.exports);
const { isRegistrationOverdue } = mod.exports;
const T0 = 1_000_000_000_000;
check(isRegistrationOverdue(T0 + 3299_000, T0, 3600, 300) === false, 'mobile: 54m59s after registering (1h token, 5m margin) → not overdue');
check(isRegistrationOverdue(T0 + 3300_000, T0, 3600, 300) === true, 'mobile: at the refresh point (55m) → overdue, re-register on foreground');
check(isRegistrationOverdue(T0 + 86_400_000, T0, 3600, 300) === true, 'mobile: a day in the background → overdue');
check(isRegistrationOverdue(T0, 0, 3600, 300) === false, 'mobile: never registered → handled by the existing !registered path, not this rule');
check(isRegistrationOverdue(T0 + 31_000, T0, 60, 300) === true, 'mobile: short TTL floors at 30s, same arithmetic as scheduleRefresh');
const voiceClient = readFileSync(path.join(__dirname, '..', 'mobile', 'lib', 'voiceClient.ts'), 'utf8');
check(voiceClient.includes('isRegistrationOverdue(Date.now(), lastRegisteredAtMs, lastRegistrationTtlSeconds, REFRESH_MARGIN_SECONDS)'), 'mobile: foreground handler uses the rule');
check(voiceClient.includes('lastRegisteredAtMs = Date.now();') && voiceClient.includes('lastRegistrationTtlSeconds = ttlSeconds;'), 'mobile: set only after a successful voice.register()');
check(!/setInterval\(/.test(voiceClient), 'mobile: no polling introduced');

if (failures) {
  console.error(`\n✗ ${failures} customer-delivery-visibility checks FAILED`);
  process.exit(1);
}
console.log('\n✓ All customer-delivery-visibility checks passed');
