// Tests for services/adminCustomerHealth.js — the Admin Dashboard's
// single "is this customer OK?" answer (admin control centre, 2026-09-25).
// The central rule under test: only real evidence raises Needs attention —
// silence (no recent calls), unanswered/declined calls, and the absence
// of CallInvite reports from older app builds must never do so.
//
// Run with: node tests/admin-customer-health.test.mjs

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let failures = 0;
function check(condition, message) {
  if (condition) {
    console.log(`✓ ${message}`);
  } else {
    console.error(`✗ ${message}`);
    failures++;
  }
}

const {
  HEALTH,
  providerDisplayName,
  describeAccount,
  describeDeliveryEvidence,
  deriveCustomerHealth,
  summariseCustomerHealth,
} = require('../services/adminCustomerHealth.js');
const { computeProtectionStatus } = require('../services/callRouting.js');

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const NOW = new Date('2026-09-25T12:00:00.000Z');
const ago = (ms) => new Date(NOW.getTime() - ms).toISOString();

const activeEntitlement = (startsAgoMs, extra = {}) => ({
  status: 'active',
  entitlement_type: 'complimentary',
  source: 'admin_manual',
  starts_at: ago(startsAgoMs),
  ends_at: null,
  updated_at: ago(startsAgoMs),
  ...extra,
});

// A fully protected household on an app build that reports telemetry.
function protectedHousehold(extra = {}) {
  return {
    id: 'h1',
    email: 'customer@example.com',
    created_at: ago(60 * DAY),
    twilio_number: '+447700900001',
    twilio_provisioning_status: 'active',
    twilio_provisioning_updated_at: ago(60 * DAY),
    activation_verified_at: ago(59 * DAY),
    voice_client_registered_at: ago(2 * HOUR),
    delivery_verified_at: ago(58 * DAY),
    device_type: 'mobile',
    carrier_provider_key: 'giffgaff',
    app_version: '1.0.1',
    app_build_version: '12',
    app_platform: 'android',
    ...extra,
  };
}

function health(household, { entitlements = [activeEntitlement(60 * DAY)], lastCallAt = null, lastDial = null, classification = 'genuine_customer' } = {}) {
  return deriveCustomerHealth({ household, entitlements, lastCallAt, lastDial, classification }, NOW);
}

const dial = (status, atMs, extra = {}) => ({ dial_call_status: status, created_at: ago(atMs), client_invite_received_at: null, client_outcome: null, ...extra });

// --- 1. Silence is never a fault ---
{
  const r = health(protectedHousehold(), { lastCallAt: ago(45 * DAY) });
  check(r.health === HEALTH.HEALTHY, 'protected customer whose last call was 45 days ago → Healthy');
  const never = health(protectedHousehold(), { lastCallAt: null });
  check(never.health === HEALTH.HEALTHY, 'protected customer with no calls recorded at all → Healthy');
  check(r.reason.startsWith('Protected'), 'healthy reason says Protected');
}

// --- 2. Normal call outcomes are not failures ---
{
  const h = protectedHousehold();
  const cases = [
    ['completed', {}, 'Connected'],
    ['no-answer', { client_invite_received_at: ago(HOUR) }, 'No answer'],
    ['no-answer', { client_invite_received_at: ago(HOUR), client_outcome: 'cancelled' }, 'No answer'],
    ['busy', { client_invite_received_at: ago(HOUR), client_outcome: 'rejected' }, 'Busy / declined'],
    ['canceled', {}, 'Caller hung up'],
  ];
  for (const [status, extra, label] of cases) {
    const r = health(h, { lastDial: dial(status, HOUR, extra) });
    check(r.health === HEALTH.HEALTHY && r.delivery.failure === null && r.delivery.twilioLabel === label, `Twilio "${status}"${extra.client_outcome ? ' / phone ' + extra.client_outcome : ''} → not a failure, still Healthy`);
  }
  const rangNoOutcome = health(h, { lastDial: dial('no-answer', HOUR, { client_invite_received_at: ago(HOUR) }) });
  check(rangNoOutcome.delivery.phoneLabel === 'Rang, no outcome reported', 'phone rang with no outcome reported is labelled, not alarmed');
}

// --- 3. Older app builds never report CallInvite: absence is not evidence ---
{
  const oldApp = protectedHousehold({ app_version: null, app_build_version: null, app_platform: null });
  const r = health(oldApp, { lastDial: dial('no-answer', HOUR) });
  check(r.health === HEALTH.HEALTHY, 'no-answer with no invite report from an app that cannot report invites → Healthy (matches the 2 real production rows)');
  check(r.delivery.phoneLabel === 'Not reported (older app)', 'phone column says "Not reported (older app)"');
  check(r.app === null, 'app version shows as not reported');
}

// --- 4. Genuine delivery failures ---
{
  const h = protectedHousehold();
  const failed = health(h, { lastDial: dial('failed', HOUR) });
  check(failed.health === HEALTH.NEEDS_ATTENTION && /could not be delivered/.test(failed.reason), 'Twilio "failed" after the last success → Needs attention');

  const neverReached = health(h, { lastDial: dial('no-answer', HOUR) });
  check(neverReached.health === HEALTH.NEEDS_ATTENTION && /never reached/.test(neverReached.reason), 'reporting-capable app, no-answer, invite never received → Needs attention');

  const oldFailure = health(protectedHousehold({ delivery_verified_at: ago(HOUR) }), { lastDial: dial('failed', 2 * HOUR) });
  check(oldFailure.health === HEALTH.HEALTHY, 'a failure followed by a later successful delivery → back to Healthy');

  const sameInstant = health(protectedHousehold({ delivery_verified_at: ago(HOUR) }), { lastDial: dial('failed', HOUR) });
  check(sameInstant.health === HEALTH.HEALTHY, 'failure at the same instant as the last success is treated as superseded');

  const neverDelivered = health(protectedHousehold({ delivery_verified_at: null }), { lastDial: dial('failed', HOUR) });
  check(neverDelivered.health === HEALTH.NEEDS_ATTENTION, 'failure with no successful delivery ever → Needs attention');

  const cancelledNoInvite = health(h, { lastDial: dial('canceled', HOUR) });
  check(cancelledNoInvite.health === HEALTH.HEALTHY, 'caller hung up before the invite arrived → not a failure');
}

// --- 5. Setup states ---
{
  const settingUp = {
    ...protectedHousehold(),
    activation_verified_at: null,
    delivery_verified_at: null,
    voice_client_registered_at: ago(HOUR),
    twilio_provisioning_updated_at: ago(3 * HOUR),
  };
  const r = health(settingUp, { entitlements: [activeEntitlement(4 * HOUR)] });
  check(r.health === HEALTH.SETUP_INCOMPLETE, 'new customer, 3h since number assigned, no forwarded call → Setup incomplete');
  check(r.setup.label === 'Forwarding not confirmed yet', 'setup label');

  const overdue = health({ ...settingUp, twilio_provisioning_updated_at: ago(30 * HOUR) }, { entitlements: [activeEntitlement(31 * HOUR)] });
  check(overdue.health === HEALTH.NEEDS_ATTENTION && /24h\+/.test(overdue.reason), 'no forwarded call 24h+ after setup became possible → Needs attention');
  check(overdue.setup.label === 'Forwarding not confirmed (overdue)', 'overdue setup label');

  const awaiting = health({ ...settingUp, activation_verified_at: ago(2 * HOUR) }, { entitlements: [activeEntitlement(40 * DAY)] });
  check(awaiting.health === HEALTH.SETUP_INCOMPLETE && awaiting.setup.label === 'Forwarding on · awaiting first delivered call', 'forwarding confirmed, app registered, no delivered call yet → Setup incomplete (never alarmed for lack of calls)');

  const noApp = health({ ...settingUp, activation_verified_at: ago(2 * HOUR), voice_client_registered_at: null }, { entitlements: [activeEntitlement(4 * HOUR)] });
  check(noApp.health === HEALTH.NEEDS_ATTENTION && /never registered/.test(noApp.reason), 'calls reaching HCG with no registered app → Needs attention immediately');

  const failedNumber = health({ ...settingUp, twilio_provisioning_status: 'failed', twilio_number: null }, { entitlements: [activeEntitlement(HOUR)] });
  check(failedNumber.health === HEALTH.NEEDS_ATTENTION && failedNumber.setup.label === 'No HCG number', 'provisioning failed → Needs attention, setup "No HCG number"');
}

// --- 6. Missing information ---
{
  const settingUpNoCarrier = {
    ...protectedHousehold({ carrier_provider_key: null, device_type: null }),
    activation_verified_at: null,
    delivery_verified_at: null,
    twilio_provisioning_updated_at: ago(3 * HOUR),
  };
  const r = health(settingUpNoCarrier, { entitlements: [activeEntitlement(4 * HOUR)] });
  check(r.health === HEALTH.NEEDS_ATTENTION && /network and device not recorded/.test(r.reason), 'setup incomplete with network and device unknown → Needs attention, reason names both');

  const legacyProtected = health(protectedHousehold({ carrier_provider_key: null, device_type: null }));
  check(legacyProtected.health === HEALTH.HEALTHY, 'already-protected customer with network/device not recorded → still Healthy (no false alarm)');
  check(legacyProtected.network === null && legacyProtected.device === null, 'missing network/device reported as null for display');
}

// --- 7. Inactive ---
{
  const r = health(protectedHousehold(), { entitlements: [], lastDial: dial('failed', HOUR) });
  check(r.health === HEALTH.INACTIVE, 'no membership → Inactive, even with a failed call');
  const ended = health(protectedHousehold(), { entitlements: [{ ...activeEntitlement(90 * DAY), status: 'expired' }] });
  check(ended.health === HEALTH.INACTIVE && ended.account.label === 'Membership ended', 'expired membership → Inactive / Membership ended');
}

// --- 8. Protected definition is not loosened ---
{
  let consistent = true;
  for (const activation of [null, ago(HOUR)]) {
    for (const registered of [null, ago(HOUR)]) {
      for (const delivered of [null, ago(HOUR)]) {
        const h = protectedHousehold({ activation_verified_at: activation, voice_client_registered_at: registered, delivery_verified_at: delivered });
        const r = health(h);
        if (r.health === HEALTH.HEALTHY && !computeProtectionStatus(h, NOW).fullyProtected) consistent = false;
      }
    }
  }
  check(consistent, 'Healthy is only ever given to customers computeProtectionStatus() calls fullyProtected');
}

// --- 9. Account type ---
{
  const paying = describeAccount({ currentEntitlement: activeEntitlement(DAY, { entitlement_type: 'paid_subscription', source: 'stripe' }), latestEntitlement: null, classification: 'genuine_customer' });
  check(paying.kind === 'paying' && paying.label === 'Paying' && paying.testLabel === null, 'paid subscription → Paying');
  const comp = describeAccount({ currentEntitlement: activeEntitlement(DAY, { ends_at: '2026-12-12T00:00:00Z' }), latestEntitlement: null, classification: 'reviewer' });
  check(comp.kind === 'complimentary' && comp.testLabel === 'Reviewer' && comp.until === '2026-12-12T00:00:00Z', 'complimentary reviewer account → Complimentary + Reviewer label + end date');
  const trial = describeAccount({ currentEntitlement: activeEntitlement(DAY, { entitlement_type: 'free_trial' }), latestEntitlement: null, classification: 'unclassified' });
  check(trial.kind === 'trial', 'free trial → Trial');
  check(describeAccount({ currentEntitlement: null, latestEntitlement: null, classification: 'internal_test' }).testLabel === 'Test', 'internal_test → Test label');
  check(describeAccount({ currentEntitlement: null, latestEntitlement: null, classification: 'unclassified' }).label === 'No membership', 'no entitlement ever → No membership');
}

// --- 10. Display names ---
{
  check(providerDisplayName('giffgaff') === 'giffgaff' && providerDisplayName('id_mobile') === 'iD Mobile' && providerDisplayName('EE') === 'EE', 'provider display names (giffgaff kept lower-case, iD Mobile, case-insensitive keys)');
  check(providerDisplayName('newco') === 'newco' && providerDisplayName(null) === null, 'unknown provider falls back to its key; missing → null');
  const r = health(protectedHousehold({ device_type: 'iphone', carrier_provider_key: 'o2' }));
  check(r.device === 'iPhone' && r.network === 'O2', 'device and network display names');
}

// --- 11. describeDeliveryEvidence without a dial ---
{
  const none = describeDeliveryEvidence(null, protectedHousehold());
  check(none.attempted === false && none.failure === null && none.twilioLabel === null, 'no dial attempt yet → nothing to show, no failure');
}

// --- 12. Summary ---
{
  const rows = [
    { health: 'healthy', account: { kind: 'paying', testLabel: null } },
    { health: 'needs_attention', account: { kind: 'complimentary', testLabel: 'Reviewer' } },
    { health: 'setup_incomplete', account: { kind: 'complimentary', testLabel: null } },
    { health: 'inactive', account: { kind: 'none', testLabel: null } },
  ];
  const s = summariseCustomerHealth(rows);
  check(s.customers === 3 && s.healthy === 1 && s.needs_attention === 1 && s.setup_incomplete === 1 && s.inactive === 1, 'summary counts by health (inactive not counted as a customer)');
  check(s.paying === 1 && s.complimentary === 2 && s.test === 1, 'summary counts account mix, test/reviewer included not hidden');
}

console.log('');
if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log('All admin customer health checks passed.');
