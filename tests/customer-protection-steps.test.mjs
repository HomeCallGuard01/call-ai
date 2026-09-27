// Coverage for services/customerProtectionSteps.js — the 5-step
// customer-facing protection checklist (2026-09-27, launch hardening).
//
// This is a pure presentation layer over computeProtectionStatus and
// hasProvisionedNumber, both already exhaustively tested elsewhere
// (tests/call-routing.test.mjs, tests/admin-onboarding-status.test.mjs).
// This file focuses on what's genuinely new here: the 5-step shape, the
// guidance selection logic, and — the single most important property —
// that "Protection Active" can NEVER show done unless fullyProtected is
// genuinely true, no matter how far the other steps get.
//
// Run with: node tests/customer-protection-steps.test.mjs

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { buildCustomerProtectionSteps } = require('../services/customerProtectionSteps');

let failures = 0;
function check(condition, message) {
  if (condition) {
    console.log(`✓ ${message}`);
  } else {
    console.error(`✗ ${message}`);
    failures++;
  }
}

const NOW = new Date('2026-09-27T12:00:00Z');

function baseHousehold(overrides = {}) {
  return {
    twilio_provisioning_status: null,
    twilio_number: null,
    activation_verified_at: null,
    voice_client_registered_at: null,
    delivery_verified_at: null,
    ...overrides,
  };
}

function stepDone(steps, key) {
  return steps.find(s => s.key === key)?.done;
}

// --- nothing set up at all ---
{
  const { steps, guidance } = buildCustomerProtectionSteps(baseHousehold(), NOW);
  check(steps.length === 5, 'always returns exactly 5 steps');
  check(steps.map(s => s.key).join(',') === 'number_active,forwarding_detected,app_registered,delivery_confirmed,protection_active', 'steps are in the exact requested order');
  check(steps.every(s => s.done === false), 'a brand-new household has all 5 steps not-done');
  check(guidance?.key === 'number_pending', 'guidance points at the number-provisioning step first');
}

// --- step 1 only ---
{
  const household = baseHousehold({ twilio_provisioning_status: 'active', twilio_number: '+441234567890' });
  const { steps, guidance } = buildCustomerProtectionSteps(household, NOW);
  check(stepDone(steps, 'number_active') === true, 'number_active is done once provisioned and a number exists');
  check(stepDone(steps, 'forwarding_detected') === false, 'forwarding_detected still not done');
  check(guidance?.key === 'forwarding_not_detected', 'guidance now points at forwarding — "turn on call forwarding"');
}

// --- steps 1-2 ---
{
  const household = baseHousehold({
    twilio_provisioning_status: 'active',
    twilio_number: '+441234567890',
    activation_verified_at: '2026-09-20T10:00:00Z',
  });
  const { steps, guidance } = buildCustomerProtectionSteps(household, NOW);
  check(stepDone(steps, 'forwarding_detected') === true, 'forwarding_detected is done once activation_verified_at is set');
  check(stepDone(steps, 'app_registered') === false, 'app_registered still not done');
  check(guidance?.key === 'app_not_ready', 'first-time case: guidance is "open the app", not the reconnect wording');
}

// --- steps 1-3, never yet delivered (first-time "confirming delivery") ---
{
  const household = baseHousehold({
    twilio_provisioning_status: 'active',
    twilio_number: '+441234567890',
    activation_verified_at: '2026-09-20T10:00:00Z',
    voice_client_registered_at: '2026-09-27T09:00:00Z',
  });
  const { steps, guidance } = buildCustomerProtectionSteps(household, NOW);
  check(stepDone(steps, 'app_registered') === true, 'app_registered done once voice_client_registered_at is set');
  check(stepDone(steps, 'delivery_confirmed') === false, 'delivery_confirmed still not done');
  check(stepDone(steps, 'protection_active') === false, 'protection_active still not done');
  check(guidance?.key === 'confirming_delivery', 'guidance mirrors the Home tab\'s confirming_delivery wording exactly');
  check(guidance?.message.includes('completes automatically the next time a real call comes through'), 'the exact reviewed copy is reused verbatim, not paraphrased');
}

// --- all 5 steps done ---
{
  const household = baseHousehold({
    twilio_provisioning_status: 'active',
    twilio_number: '+441234567890',
    activation_verified_at: '2026-09-20T10:00:00Z',
    voice_client_registered_at: '2026-09-27T09:00:00Z',
    delivery_verified_at: '2026-09-27T09:05:00Z',
  });
  const { steps, guidance } = buildCustomerProtectionSteps(household, NOW);
  check(steps.every(s => s.done === true), 'a fully protected household has all 5 steps done');
  check(guidance === null, 'no guidance is shown once everything is done');
}

// --- THE critical rule: delivered before, but app not currently
// reachable (voice_client_registered_at cleared/stale) — reconnect case,
// never "Protection Active", never sent back through forwarding setup ---
{
  const household = baseHousehold({
    twilio_provisioning_status: 'active',
    twilio_number: '+441234567890',
    activation_verified_at: '2026-09-20T10:00:00Z',
    voice_client_registered_at: null, // cleared — app not currently reachable
    delivery_verified_at: '2026-09-20T10:05:00Z', // but delivery HAS worked before
  });
  const { steps, guidance } = buildCustomerProtectionSteps(household, NOW);
  check(stepDone(steps, 'app_registered') === false, 'app_registered correctly shows not-done when voice_client_registered_at is null, even though delivery worked once before');
  check(stepDone(steps, 'protection_active') === false, 'protection_active is NOT done — the critical rule: delivery having worked before is not enough on its own');
  check(guidance?.key === 'reconnecting', 'guidance correctly distinguishes this as a RECONNECT (delivered before), not first-time app setup');
  check(guidance?.message.includes("don't need to redo call forwarding"), 'reconnect guidance explicitly reassures forwarding does not need to be redone — mirrors the Home tab reconnect_needed wording exactly');
}

// --- THE critical rule, most directly: forwarding alone (a call reaching
// the HCG backend) must NEVER be enough for step 5 ---
{
  const household = baseHousehold({
    twilio_provisioning_status: 'active',
    twilio_number: '+441234567890',
    activation_verified_at: '2026-09-27T11:59:00Z', // a call JUST reached HCG
    voice_client_registered_at: null,
    delivery_verified_at: null,
  });
  const { steps } = buildCustomerProtectionSteps(household, NOW);
  check(stepDone(steps, 'forwarding_detected') === true, 'forwarding_detected is done — a call did reach HCG');
  check(stepDone(steps, 'protection_active') === false, 'CRITICAL: protection_active remains false — reaching the HCG backend is never sufficient on its own');
}

// --- missing/null household never throws ---
{
  let threw = false;
  let result;
  try {
    result = buildCustomerProtectionSteps(null, NOW);
  } catch (err) {
    threw = true;
  }
  check(threw === false, 'a null household never throws');
  check(Boolean(result) && result.steps.every(s => s.done === false), 'a null household safely reports all 5 steps not-done, fails toward showing less progress, never more');
}

console.log(`\n${failures === 0 ? '✓ All' : `✗ ${failures}`} customer-protection-steps checks ${failures === 0 ? 'passed' : 'FAILED'}`);
process.exitCode = failures === 0 ? 0 : 1;
