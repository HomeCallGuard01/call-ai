// Tests for the Admin Dashboard's onboarding monitor (2026-09):
//   1. services/adminOnboardingStatus.js — the pure admin-state
//      derivation (Protected / Setting up / Needs attention /
//      Provisioning problem / Inactive), the 24-hour clock and its exact
//      boundary, timezone-safe timestamp parsing, and the setup timeline.
//   2. database/adminMetrics.js's getOnboardingMonitor /
//      getHouseholdStatusDetail — run against an in-memory fake Supabase
//      client injected via the require cache (no real database), to prove
//      the shaping and the sensitive-field allow-list.
//   3. routes/admin.js wiring (structural, same convention as
//      tests/admin-quarantine-routes.test.mjs) and admin-business.html's
//      pure Customers-tab helpers (TEST-EXTRACT, same convention as
//      tests/admin-dashboard.test.mjs).
//
// Run with: node tests/admin-onboarding-status.test.mjs

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
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

const {
  ONBOARDING_ATTENTION_THRESHOLD_MS,
  ADMIN_STATES,
  parseTimestampMs,
  isEntitlementCurrentlyActive,
  resolveSetupClockStart,
  deriveAdminCustomerState,
  summariseAdminStates,
} = require('../services/adminOnboardingStatus.js');
const { computeProtectionStatus } = require('../services/callRouting.js');

const HOUR = 3600 * 1000;
const NOW = new Date('2026-09-23T12:00:00.000Z');
const ago = (ms) => new Date(NOW.getTime() - ms).toISOString();

function activeEntitlement(startsAgoMs, extra = {}) {
  return { status: 'active', entitlement_type: 'paid_subscription', starts_at: ago(startsAgoMs), ends_at: null, updated_at: ago(startsAgoMs), ...extra };
}

function household(extra = {}) {
  return {
    id: 'h1',
    email: 'customer@example.com',
    created_at: ago(30 * 24 * HOUR),
    twilio_number: '+447700900001',
    twilio_provisioning_status: 'active',
    twilio_provisioning_updated_at: ago(2 * HOUR),
    activation_verified_at: null,
    voice_client_registered_at: null,
    delivery_verified_at: null,
    ...extra,
  };
}

const derive = (h, ents, lastCallAt = null, now = NOW) => deriveAdminCustomerState({ household: h, entitlements: ents, lastCallAt }, now);

check(ONBOARDING_ATTENTION_THRESHOLD_MS === 24 * HOUR, 'threshold is exactly 24 hours');

// --- 1. Newly setting-up customer, < 24h ---
{
  const r = derive(household({ voice_client_registered_at: ago(1 * HOUR) }), [activeEntitlement(3 * HOUR)]);
  check(r.state === ADMIN_STATES.SETTING_UP, 'new customer, number assigned 2h ago, no forwarded call → Setting up');
  check(r.reason === 'Waiting for first forwarded call', 'setting-up reason names the missing forwarded call');
  check(r.setupClock.source === 'number_provisioned', 'clock runs from the later timestamp (number assigned 2h ago, after membership 3h ago)');
  check(r.setupClock.elapsedMs === 2 * HOUR, 'elapsed time is measured from the clock start, not account creation (30 days ago)');
}

// --- 2. Unverified customer, > 24h ---
{
  const r = derive(household({ twilio_provisioning_updated_at: ago(30 * HOUR) }), [activeEntitlement(31 * HOUR)]);
  check(r.state === ADMIN_STATES.NEEDS_ATTENTION, 'no forwarded call 30h after number assigned → Needs attention');
  check(/24h\+/.test(r.reason), 'needs-attention reason explains the 24h rule');
}

// --- 3. Boundary around exactly 24 hours ---
{
  const justUnder = derive(household({ twilio_provisioning_updated_at: ago(24 * HOUR - 1) }), [activeEntitlement(48 * HOUR)]);
  const exactly = derive(household({ twilio_provisioning_updated_at: ago(24 * HOUR) }), [activeEntitlement(48 * HOUR)]);
  const justOver = derive(household({ twilio_provisioning_updated_at: ago(24 * HOUR + 1) }), [activeEntitlement(48 * HOUR)]);
  check(justUnder.state === ADMIN_STATES.SETTING_UP, '24h minus 1ms → still Setting up');
  check(exactly.state === ADMIN_STATES.NEEDS_ATTENTION, 'exactly 24h → Needs attention (>= threshold)');
  check(justOver.state === ADMIN_STATES.NEEDS_ATTENTION, '24h plus 1ms → Needs attention');
}

// --- 4. Forwarding verified (not yet a delivered call) ---
{
  const r = derive(
    household({ twilio_provisioning_updated_at: ago(72 * HOUR), activation_verified_at: ago(70 * HOUR), voice_client_registered_at: ago(1 * HOUR) }),
    [activeEntitlement(72 * HOUR)]
  );
  check(r.state === ADMIN_STATES.SETTING_UP, 'forwarding verified + app registered, no delivered call yet → Setting up (not Needs attention, even 72h later)');
  check(r.forwardingProven === true, 'activation_verified_at counts as forwarding proven');
  check(/waiting for first delivered call/.test(r.reason), 'reason says forwarding is confirmed and delivery is pending');
}
{
  // Mirrors mobile/lib/homeStatus.ts hasProvenActivation: a delivered call
  // proves forwarding even if activation_verified_at was never stamped.
  const r = derive(
    household({ twilio_provisioning_updated_at: ago(72 * HOUR), delivery_verified_at: ago(5 * HOUR), voice_client_registered_at: ago(6 * HOUR) }),
    [activeEntitlement(72 * HOUR)]
  );
  check(r.forwardingProven === true, 'delivery_verified_at alone also counts as forwarding proven');
  check(r.state === ADMIN_STATES.PROTECTED, 'delivered call + registered app → Protected even with activation_verified_at null');
}
{
  const r = derive(
    household({ twilio_provisioning_updated_at: ago(5 * HOUR), activation_verified_at: ago(4 * HOUR), voice_client_registered_at: null }),
    [activeEntitlement(5 * HOUR)]
  );
  check(r.state === ADMIN_STATES.NEEDS_ATTENTION, 'calls reach HCG but app never registered → Needs attention immediately (HCG has nowhere to deliver)');
  check(/never registered/.test(r.reason), 'reason names the missing app registration');
}

// --- 5. Fully Protected ---
{
  const h = household({ activation_verified_at: ago(20 * HOUR), voice_client_registered_at: ago(1 * HOUR), delivery_verified_at: ago(10 * HOUR) });
  const r = derive(h, [activeEntitlement(21 * HOUR)], ago(10 * HOUR));
  check(r.state === ADMIN_STATES.PROTECTED, 'forwarding + registration + delivered call → Protected');
  check(r.lastCallAt === ago(10 * HOUR), 'last call timestamp passed through');
}

// --- 6. Existing (legacy) protected customer ---
{
  const h = household({
    created_at: '2026-06-01T09:00:00+00:00',
    twilio_provisioning_updated_at: null, // backfilled by migration 016 with no timestamp
    activation_verified_at: '2026-06-02T10:00:00+00:00',
    voice_client_registered_at: '2026-06-02T10:05:00+00:00',
    delivery_verified_at: '2026-07-01T10:00:00+00:00',
  });
  const r = derive(h, [activeEntitlement(100 * 24 * HOUR)]);
  check(r.state === ADMIN_STATES.PROTECTED, 'long-standing protected customer with old timestamps → Protected (age never demotes)');
  check(r.setupClock.source === 'membership_started', 'missing number timestamp falls back to membership start');
}

// --- 7. Inactive entitlement ---
{
  const fully = household({ activation_verified_at: ago(HOUR), voice_client_registered_at: ago(HOUR), delivery_verified_at: ago(HOUR) });
  check(derive(fully, []).state === ADMIN_STATES.INACTIVE, 'no entitlement at all → Inactive (even with protection evidence)');
  check(derive(fully, []).reason === 'Never had a membership', 'never-member reason');
  check(derive(fully, [{ ...activeEntitlement(10 * HOUR), status: 'expired' }]).state === ADMIN_STATES.INACTIVE, 'expired entitlement → Inactive');
  check(derive(fully, [{ ...activeEntitlement(10 * HOUR), status: 'revoked' }]).state === ADMIN_STATES.INACTIVE, 'revoked entitlement → Inactive');
  check(
    derive(fully, [activeEntitlement(10 * HOUR, { ends_at: ago(1) })]).state === ADMIN_STATES.INACTIVE,
    "status 'active' but ends_at already passed → Inactive (mirrors getActiveEntitlement)"
  );
  check(
    derive(fully, [activeEntitlement(-HOUR)]).state === ADMIN_STATES.INACTIVE,
    "status 'active' but starts_at in the future → Inactive (mirrors getActiveEntitlement)"
  );
  check(
    derive(household({ twilio_provisioning_status: 'failed', twilio_number: null }), [{ ...activeEntitlement(HOUR), status: 'expired' }]).state === ADMIN_STATES.INACTIVE,
    'Inactive takes precedence over a provisioning failure (nothing actionable for a non-member)'
  );
  check(
    derive(fully, [{ ...activeEntitlement(90 * 24 * HOUR), status: 'expired', updated_at: ago(80 * 24 * HOUR) }, activeEntitlement(2 * HOUR)]).state === ADMIN_STATES.PROTECTED,
    'an old expired row alongside a current active one → uses the current one'
  );
}

// --- 8. Provisioning failure ---
{
  const failed = derive(household({ twilio_provisioning_status: 'failed', twilio_number: null }), [activeEntitlement(HOUR)]);
  check(failed.state === ADMIN_STATES.PROVISIONING_PROBLEM, "twilio_provisioning_status 'failed' → Provisioning problem");
  check(failed.timeline.find((s) => s.key === 'number').problem === 'Provisioning failed', 'timeline marks the number stage as failed');

  const inconsistent = derive(household({ twilio_number: null }), [activeEntitlement(HOUR)]);
  check(inconsistent.state === ADMIN_STATES.PROVISIONING_PROBLEM, "status 'active' but no number recorded → Provisioning problem");

  const pendingNew = derive(household({ twilio_provisioning_status: 'pending', twilio_number: null, twilio_provisioning_updated_at: null }), [activeEntitlement(2 * HOUR)]);
  check(pendingNew.state === ADMIN_STATES.SETTING_UP && pendingNew.reason === 'Waiting for HCG number', 'pending number < 24h after membership → Setting up (waiting for number)');

  const pendingOld = derive(household({ twilio_provisioning_status: 'pending', twilio_number: null, twilio_provisioning_updated_at: null }), [activeEntitlement(25 * HOUR)]);
  check(pendingOld.state === ADMIN_STATES.PROVISIONING_PROBLEM, 'still no number 24h+ after membership → Provisioning problem');
}

// --- 9. Protected definition is exactly computeProtectionStatus ---
{
  let consistent = true;
  for (const activation of [null, ago(HOUR)]) {
    for (const registered of [null, ago(HOUR)]) {
      for (const delivered of [null, ago(HOUR)]) {
        const h = household({ activation_verified_at: activation, voice_client_registered_at: registered, delivery_verified_at: delivered });
        const r = derive(h, [activeEntitlement(2 * HOUR)]);
        const expected = computeProtectionStatus(h, NOW).fullyProtected;
        if ((r.state === ADMIN_STATES.PROTECTED) !== expected) consistent = false;
      }
    }
  }
  check(consistent, 'for every evidence combination, admin "Protected" ⇔ computeProtectionStatus().fullyProtected (definition not redefined)');
}

// --- 10. Dates & timezones ---
{
  check(parseTimestampMs('2026-09-23T12:00:00+00:00') === NOW.getTime(), 'parses +00:00 offset');
  check(parseTimestampMs('2026-09-23T13:00:00+01:00') === NOW.getTime(), 'parses +01:00 (BST) offset to the same instant');
  check(parseTimestampMs('2026-09-23T12:00:00Z') === NOW.getTime(), 'parses Z');
  check(parseTimestampMs('2026-09-23T12:00:00') === NOW.getTime(), 'zone-less value treated as UTC, never server-local time');
  check(parseTimestampMs('2026-09-23 12:00:00') === NOW.getTime(), 'Postgres-style space separator, zone-less, treated as UTC');
  check(parseTimestampMs('2026-09-23T12:00:00.123456+00:00') === NOW.getTime() + 123, 'microsecond precision (Postgres) parses');
  check(parseTimestampMs('not a date') === null && parseTimestampMs(null) === null && parseTimestampMs('') === null, 'invalid/empty → null');

  // Same instant expressed with different offsets must produce the same state at the boundary.
  const bstBoundary = derive(household({ twilio_provisioning_updated_at: '2026-09-22T13:00:00+01:00' }), [activeEntitlement(48 * HOUR)]);
  check(bstBoundary.state === ADMIN_STATES.NEEDS_ATTENTION && bstBoundary.setupClock.elapsedMs === 24 * HOUR, 'BST-offset timestamp exactly 24h ago → exactly 24h elapsed → Needs attention');

  // Across the UK clocks-go-back change (2026-10-25 01:00 UTC): 24 real hours, not 25 wall-clock hours.
  const afterDst = new Date('2026-10-25T12:00:00Z');
  const dst = derive(household({ twilio_provisioning_updated_at: '2026-10-24T13:00:00+01:00' }), [activeEntitlement(72 * HOUR)], null, afterDst);
  check(dst.setupClock.elapsedMs === 24 * HOUR && dst.state === ADMIN_STATES.NEEDS_ATTENTION, 'across a DST change, elapsed time is real elapsed hours (epoch maths)');

  let threw = false;
  try { derive(household(), [activeEntitlement(HOUR)], null, new Date('nope')); } catch { threw = true; }
  check(threw, 'an invalid `now` throws rather than silently mis-deriving');

  const badClock = derive(household({ twilio_provisioning_updated_at: 'garbage' }), [activeEntitlement(2 * HOUR)]);
  check(badClock.setupClock.source === 'membership_started', 'an unparseable number timestamp falls back to membership start');
}

// --- 11. Clock start & entitlement helpers ---
{
  const later = resolveSetupClockStart(household({ twilio_provisioning_updated_at: ago(10 * HOUR) }), activeEntitlement(2 * HOUR));
  check(later.source === 'membership_started' && later.atMs === NOW.getTime() - 2 * HOUR, 'membership started after number assigned (e.g. resubscribe) → membership start is the clock');
  const noEnt = resolveSetupClockStart(household({ twilio_provisioning_status: 'pending', twilio_number: null }), null);
  check(noEnt.atMs === null && noEnt.source === null, 'no entitlement and no number → no clock start');
  check(isEntitlementCurrentlyActive(activeEntitlement(HOUR, { ends_at: new Date(NOW.getTime() + HOUR).toISOString() }), NOW), 'future ends_at → currently active');
  check(!isEntitlementCurrentlyActive(activeEntitlement(HOUR, { ends_at: NOW.toISOString() }), NOW), 'ends_at == now → not active (strict gt, as getActiveEntitlement)');
}

// --- 12. Timeline ---
{
  const r = derive(household({ voice_client_registered_at: ago(HOUR) }), [activeEntitlement(3 * HOUR)]);
  const keys = r.timeline.map((s) => s.key);
  check(JSON.stringify(keys) === JSON.stringify(['membership', 'number', 'app', 'forwarding', 'delivery', 'last_call']), 'timeline has the six stages in order');
  const flagged = r.timeline.filter((s) => s.firstIncomplete);
  check(flagged.length === 1 && flagged[0].key === 'forwarding', 'first missing stage (forwarding) is the only one highlighted');
  check(r.timeline.find((s) => s.key === 'last_call').informational === true, 'last call is informational, never the highlighted blocker');

  const p = derive(household({ activation_verified_at: ago(HOUR), voice_client_registered_at: ago(HOUR), delivery_verified_at: ago(HOUR) }), [activeEntitlement(3 * HOUR)]);
  check(!p.timeline.some((s) => s.firstIncomplete), 'a Protected customer has no highlighted stage');
}

// --- 13. Summary counts ---
{
  const counts = summariseAdminStates([{ state: 'protected' }, { state: 'needs_attention' }, { state: 'needs_attention' }, { state: 'inactive' }]);
  check(counts.all === 4 && counts.needs_attention === 2 && counts.protected === 1 && counts.setting_up === 0 && counts.provisioning_problem === 0, 'summariseAdminStates counts every state, zeros included');
}

// --- 14. Data layer against a fake Supabase client ---
{
  const tables = {
    households: [
      household({ id: '11111111-1111-4111-8111-111111111111', email: 'new@example.com', created_at: ago(3 * HOUR), twilio_provisioning_updated_at: ago(2 * HOUR), stripe_customer_id: 'cus_SECRET', auth_user_id: 'auth-uuid', phone_number: '+447700900999', twilio_number_sid: 'PN_SECRET', twilio_provisioning_attempts: 0, twilio_provisioning_last_error: null, device_type: 'mobile', carrier_provider_key: 'ee', carrier_compatibility_captured_at: ago(4 * HOUR), app_version: '1.0.1', app_build_version: '12', app_platform: 'android' }),
      household({ id: '22222222-2222-4222-8222-222222222222', email: 'stuck@example.com', created_at: ago(50 * HOUR), twilio_provisioning_updated_at: ago(40 * HOUR) }),
      household({ id: '33333333-3333-4333-8333-333333333333', email: 'qa@example.com', created_at: ago(50 * HOUR) }),
    ],
    entitlements: [
      { household_id: '11111111-1111-4111-8111-111111111111', ...activeEntitlement(3 * HOUR), source: 'stripe' },
      { household_id: '22222222-2222-4222-8222-222222222222', ...activeEntitlement(41 * HOUR), source: 'stripe' },
    ],
    subscriptions: [{ household_id: '22222222-2222-4222-8222-222222222222', status: 'past_due', cancel_at_period_end: false, updated_at: ago(HOUR) }],
    calls: [
      { household_id: '22222222-2222-4222-8222-222222222222', created_at: ago(30 * HOUR) },
      { household_id: '22222222-2222-4222-8222-222222222222', created_at: ago(5 * HOUR) },
      // dial_call_status null (screened/never dialled) — must be excluded
      // by getMostRecentDialOutcome's .not("dial_call_status", "is", null),
      // proving a genuinely more recent but undialled row never masks the
      // real most recent dial attempt below.
      { household_id: '11111111-1111-4111-8111-111111111111', created_at: ago(30 * 60 * 1000), dial_call_status: null, client_invite_received_at: null, client_outcome: null },
      { household_id: '11111111-1111-4111-8111-111111111111', created_at: ago(HOUR), dial_call_status: 'completed', client_invite_received_at: ago(HOUR - 5000), client_outcome: 'accepted', number: '+447700123456', status: 'Unknown', result: 'SAFE' },
    ],
    account_classifications: [
      { household_id: '22222222-2222-4222-8222-222222222222', classification: 'genuine_customer' },
      { household_id: '33333333-3333-4333-8333-333333333333', classification: 'qa_automation' },
    ],
  };

  function fakeQuery(table) {
    let rows = (tables[table] || []).slice();
    let selected = null;
    let single = false;
    const q = {
      select(cols) { selected = cols.split(',').map((c) => c.trim()); return q; },
      eq(col, val) { rows = rows.filter((r) => r[col] === val); return q; },
      // Only the "is null" negation database/calls.js's getMostRecentDialOutcome
      // actually uses is implemented — matches the real supabase-js .not()
      // signature closely enough for this fake client's purposes.
      not(col, operator, val) {
        if (operator !== 'is' || val !== null) throw new Error(`fakeQuery.not: unsupported .not(${col}, ${operator}, ${val})`);
        rows = rows.filter((r) => r[col] !== null && r[col] !== undefined);
        return q;
      },
      order(col, { ascending }) { rows.sort((a, b) => (ascending ? 1 : -1) * (new Date(a[col]) - new Date(b[col]))); return q; },
      limit(n) { rows = rows.slice(0, n); return q; },
      maybeSingle() { single = true; return q; },
      then(resolve) {
        const project = (r) => (selected ? Object.fromEntries(selected.map((c) => [c, r[c] === undefined ? null : r[c]])) : r);
        const data = single ? (rows[0] ? project(rows[0]) : null) : rows.map(project);
        return Promise.resolve({ data, error: null }).then(resolve);
      },
    };
    return q;
  }

  const clientsPath = require.resolve('../services/supabaseClients.js');
  require.cache[clientsPath] = { id: clientsPath, filename: clientsPath, loaded: true, exports: { supabaseAdmin: { from: fakeQuery }, supabase: null } };
  const stripePath = require.resolve('../services/stripeClient.js');
  require.cache[stripePath] = { id: stripePath, filename: stripePath, loaded: true, exports: { stripe: null } };

  const { getOnboardingMonitor, getHouseholdStatusDetail } = require('../database/adminMetrics.js');

  const monitor = await getOnboardingMonitor(NOW);
  check(monitor.available && monitor.rows.length === 3, 'getOnboardingMonitor returns every household');
  check(monitor.thresholdHours === 24, 'reports the 24h threshold');
  const byEmail = Object.fromEntries(monitor.rows.map((r) => [r.email, r]));
  check(byEmail['new@example.com'].state === 'setting_up' && byEmail['new@example.com'].classification === 'unclassified', 'new unclassified signup → Setting up, classification unclassified (visible in default scope)');
  check(byEmail['stuck@example.com'].state === 'needs_attention', 'genuine customer 40h without a forwarded call → Needs attention');
  check(byEmail['stuck@example.com'].membershipStatus === 'payment_issue', 'membership label reuses deriveMembershipStatus (past_due → payment_issue)');
  check(byEmail['stuck@example.com'].lastCallAt === ago(5 * HOUR), 'last call is the most recent call for that household');
  check(byEmail['qa@example.com'].state === 'inactive' && byEmail['qa@example.com'].membershipStatus === 'none', 'household with no entitlement → Inactive / No membership');

  const allowedRowKeys = ['householdId', 'email', 'signedUpAt', 'classification', 'membershipStatus', 'provisioningStatus', 'state', 'reason', 'forwardingProven', 'appRegistered', 'deliveryVerified', 'fullyProtected', 'setupClock', 'lastCallAt',
    // admin control centre (2026-09-25)
    'health', 'healthReason', 'account', 'subscriptionIssue', 'setupLabel', 'network', 'device', 'app', 'lastConfirmed', 'latestCall', 'lastDelivery', 'deletedAccount'];
  check(monitor.rows.every((r) => Object.keys(r).every((k) => allowedRowKeys.includes(k))), 'list rows contain only the allow-listed fields');
  const serialized = JSON.stringify(monitor);
  check(!/cus_SECRET|PN_SECRET|auth-uuid|\+447700900999/.test(serialized), 'list response never contains Stripe/Twilio SIDs, auth IDs or the customer’s own phone number');

  const detail = await getHouseholdStatusDetail('11111111-1111-4111-8111-111111111111', NOW);
  check(detail.found && detail.customer.state === 'setting_up', 'detail returns the same derived state as the list');
  check(detail.timeline.length === 6, 'detail includes the six-stage timeline');
  check(detail.technical.hcgNumber === '+447700900001' && detail.technical.carrierProviderKey === 'ee', 'detail technical section includes HCG number and carrier');
  check(!/cus_SECRET|PN_SECRET|auth-uuid|\+447700900999/.test(JSON.stringify(detail)), 'detail response never contains Stripe/Twilio SIDs, auth IDs or the customer’s own phone number');

  // --- Diagnostic instrumentation folded into the detail panel
  // (reconciliation, 2026-09-24): app version + most recent real dial
  // outcome, distinct from the historical activation/delivery verified-at
  // flags already asserted above. ---
  check(
    detail.technical.appVersion === '1.0.1' && detail.technical.appBuildVersion === '12' && detail.technical.appPlatform === 'android',
    'detail technical section includes the app-reported version/build/platform'
  );
  check(
    detail.technical.mostRecentDialOutcome &&
      detail.technical.mostRecentDialOutcome.dialCallStatus === 'completed' &&
      detail.technical.mostRecentDialOutcome.clientOutcome === 'accepted',
    'detail technical section surfaces the most recent DIALLED attempt (dial_call_status set), skipping the more recent but never-dialled row'
  );

  const noDialHistory = await getHouseholdStatusDetail('22222222-2222-4222-8222-222222222222', NOW);
  check(
    noDialHistory.technical.appVersion === null && noDialHistory.technical.mostRecentDialOutcome === null,
    'a household with no app-version report and no dialled calls shows both as null, never a fabricated value'
  );

  // Admin control centre (2026-09-25): list health fields + detail recent calls.
  const newRow = byEmail['new@example.com'];
  check(newRow.health === 'setup_incomplete' && newRow.network === 'EE' && newRow.device === 'Android', 'list row carries health, network display name and device');
  check(newRow.app && newRow.app.version === '1.0.1' && newRow.app.build === '12', 'list row carries app version and build');
  check(newRow.lastDelivery && newRow.lastDelivery.twilioLabel === 'Connected' && newRow.lastDelivery.phoneLabel === 'Answered' && newRow.lastDelivery.failure === null, 'list row carries last Twilio dial outcome and phone outcome');
  check(newRow.latestCall && newRow.latestCall.at === ago(30 * 60 * 1000), 'latest call is the most recent call of any kind (including never-dialled ones)');
  check(byEmail['stuck@example.com'].health === 'needs_attention', 'overdue setup → health Needs attention');
  check(byEmail['qa@example.com'].health === 'inactive', 'no membership → health Inactive');
  check(monitor.summary && monitor.summary.customers === 2 && monitor.summary.needs_attention === 1 && monitor.summary.setup_incomplete === 1, 'summary counts active customers by health');
  check(Array.isArray(detail.recentCalls) && detail.recentCalls.length === 2, 'detail lists recent calls');
  const dialled = detail.recentCalls.find((c) => c.dialCallStatus === 'completed');
  check(dialled && dialled.caller === '…3456' && dialled.clientOutcome === 'accepted', 'recent calls show the caller only as last four digits, plus Twilio and phone outcomes');
  check(!JSON.stringify(detail).includes('+447700123456'), 'full caller number never leaves the server');

  const missing = await getHouseholdStatusDetail('99999999-9999-4999-8999-999999999999', NOW);
  check(missing.available && missing.found === false, 'unknown household → found:false (route turns this into 404)');
}

// --- 15. Route wiring (structural) ---
{
  const adminSource = readFileSync(path.join(__dirname, '..', 'routes', 'admin.js'), 'utf8');
  for (const anchor of ['router.get("/admin/api/customers/onboarding"', 'router.get("/admin/api/households/:id/status"']) {
    const idx = adminSource.indexOf(anchor);
    check(idx !== -1, `${anchor} is declared`);
    const head = adminSource.slice(idx, idx + anchor.length + 40);
    check(head.includes('requireAuth') && head.includes('requireAdmin'), `${anchor} is gated behind requireAuth and requireAdmin`);
    const block = adminSource.slice(idx, adminSource.indexOf('\n});', idx));
    check(!/\.(insert|update|upsert|delete|rpc)\(/.test(block) && !/recordAdminAction/.test(block), `${anchor} is read-only`);
  }
  const statusBlock = adminSource.slice(adminSource.indexOf('router.get("/admin/api/households/:id/status"'));
  check(statusBlock.indexOf('looksLikeUuid(req.params.id)') < statusBlock.indexOf('getHouseholdStatusDetail('), 'detail route rejects a non-UUID id before querying');

  const metricsSource = readFileSync(path.join(__dirname, '..', 'database', 'adminMetrics.js'), 'utf8');
  const monitorSection = metricsSource.slice(metricsSource.indexOf('const ONBOARDING_HOUSEHOLD_COLUMNS'), metricsSource.indexOf('module.exports'));
  check(!monitorSection.includes('select("*")'), 'onboarding queries never select("*") from households');
  check(!/\.(insert|update|upsert|delete|rpc)\(/.test(monitorSection), 'onboarding data layer performs no writes');
}

// --- 16. Customers tab helpers (admin-business.html) ---
{
  const html = readFileSync(path.join(__dirname, '..', 'admin-business.html'), 'utf8');
  const extract = (name) => {
    const s = `// TEST-EXTRACT-START: ${name}`;
    const e = `// TEST-EXTRACT-END: ${name}`;
    const i = html.indexOf(s);
    const j = html.indexOf(e);
    return i === -1 || j === -1 ? null : html.slice(i + s.length, j);
  };
  const helpers = extract('customerMonitorHelpers');
  const timeline = extract('describeTimelineStage');
  check(helpers && timeline, 'Customers tab helpers are extractable');

  const api = new Function(`${helpers}\n${timeline}\nreturn { customerRowsForView, countCustomerHealth, sortCustomerRows, formatElapsed, formatRelativeTime, describeAccountCell, describeNetworkCell, describeAppCell, describeLastConfirmedCell, describeLatestCallCell, describeCallResult, escapeHtml, describeTimelineStage, CUSTOMER_FILTERS };`)();

  const rows = [
    { householdId: 'a', email: 'a@x.com', health: 'healthy', signedUpAt: ago(10 * HOUR), network: 'giffgaff', device: 'Android' },
    { householdId: 'b', email: 'b@x.com', health: 'needs_attention', signedUpAt: ago(40 * HOUR) },
    { householdId: 'c', email: 'c@x.com', health: 'needs_attention', signedUpAt: ago(5 * HOUR), account: { testLabel: 'Reviewer' } },
    { householdId: 'd', email: 'd@x.com', health: 'setup_incomplete', signedUpAt: ago(1 * HOUR) },
    { householdId: 'e', email: 'e@x.com', health: 'inactive', signedUpAt: ago(2 * HOUR) },
    { householdId: 'f', email: 'anonymized-f@deleted.homecallguard.internal', health: 'inactive', signedUpAt: ago(2 * HOUR), deletedAccount: true },
  ];
  check(api.customerRowsForView(rows, 'active', '').map((r) => r.householdId).join() === 'a,b,c,d', 'default view = every customer with a membership, test/reviewer accounts included');
  check(api.customerRowsForView(rows, 'needs_attention', '').map((r) => r.householdId).join() === 'b,c', 'Needs attention filter');
  check(api.customerRowsForView(rows, 'inactive', '').map((r) => r.householdId).join() === 'e', 'Inactive filter never shows deleted/anonymised accounts');
  check(api.customerRowsForView(rows, 'active', 'GIFF').map((r) => r.householdId).join() === 'a', 'search matches network (case-insensitive)');
  const counts = api.countCustomerHealth(rows);
  check(counts.active === 4 && counts.healthy === 1 && counts.needs_attention === 2 && counts.setup_incomplete === 1 && counts.inactive === 1, 'counts exclude deleted accounts; active = everything with a membership');
  check(api.sortCustomerRows(api.customerRowsForView(rows, 'active', '')).map((r) => r.householdId).join() === 'c,b,d,a', 'sorted Needs attention first, newest first within a group');
  check(api.CUSTOMER_FILTERS.join() === 'active,needs_attention,setup_incomplete,healthy,inactive', 'filters: All customers / Needs attention / Setup incomplete / Healthy / Inactive');

  check(api.formatElapsed(30 * 60 * 1000) === '30m' && api.formatElapsed(5 * HOUR) === '5h' && api.formatElapsed(47 * HOUR) === '47h' && api.formatElapsed(50 * HOUR) === '2d 2h', 'formatElapsed renders minutes/hours/days');
  check(api.formatElapsed(null) === '—' && api.formatElapsed(-5) === '—', 'formatElapsed handles missing/negative');
  check(api.formatRelativeTime(null, NOW.getTime()) === 'Never', 'no timestamp → "Never"');
  check(api.formatRelativeTime(ago(3 * HOUR), NOW.getTime()) === '3h ago', 'relative time');

  check(api.describeAccountCell({ account: { label: 'Complimentary', kind: 'complimentary', until: '2026-12-12T00:00:00Z', testLabel: 'Reviewer' } }).sub === 'until 12 Dec 2026', 'account cell: complimentary with end date and test label');
  check(api.describeAccountCell({ account: { label: 'Paying', kind: 'paying' }, subscriptionIssue: 'payment_issue' }).sub === 'Payment issue', 'account cell: payment issue shown');
  check(api.describeNetworkCell({ network: 'giffgaff', device: 'Android' }) === 'giffgaff · Android', 'network cell');
  check(api.describeNetworkCell({}) === 'Not recorded', 'network cell when nothing recorded');
  check(api.describeAppCell({ app: { version: '1.0.1', build: '12', platform: 'android' } }) === '1.0.1 (12) · android' && api.describeAppCell({ app: null }) === 'Not reported', 'app cell');
  check(api.describeLastConfirmedCell({ lastConfirmed: { kind: 'delivered', at: ago(3 * HOUR) } }, NOW.getTime()) === 'Call delivered 3h ago', 'last confirmed: delivered call');
  check(api.describeLastConfirmedCell({ lastConfirmed: { kind: 'forwarding_only', at: ago(50 * HOUR) } }, NOW.getTime()) === 'Forwarding only · 2d 2h ago', 'last confirmed: forwarding only');
  check(api.describeLastConfirmedCell({ lastConfirmed: { kind: 'none' } }, NOW.getTime()) === 'Not yet', 'last confirmed: none');
  const callCell = api.describeLatestCallCell({ latestCall: { at: ago(2 * HOUR), status: 'Known', result: 'SAFE' }, lastDelivery: { twilioLabel: 'No answer', phoneLabel: 'Not reported (older app)', failure: null } }, NOW.getTime());
  check(callCell.main === '2h ago · Known contact' && callCell.delivery === 'Twilio: No answer · Phone: Not reported (older app)' && callCell.failure === false, 'latest call cell: call, Twilio and phone outcome; unanswered is not a failure');
  check(api.describeLatestCallCell({ latestCall: null, lastDelivery: null }, NOW.getTime()).main === 'No calls yet', 'latest call cell with no calls');
  check(api.describeCallResult({ status: 'Unknown', result: 'SCAM' }) === 'Unknown caller · blocked' && api.describeCallResult({ terminatedBySystem: true }) === 'Ended by HCG', 'call result wording');

  check(api.escapeHtml('<img src=x onerror=alert(1)>"\'&') === '&lt;img src=x onerror=alert(1)&gt;&quot;&#39;&amp;', 'escapeHtml neutralises customer-supplied markup (emails are rendered through it)');
  check(api.describeTimelineStage({ done: false, firstIncomplete: true }).className === 'timeline-blocker', 'first incomplete stage renders as the highlighted blocker');
  check(api.describeTimelineStage({ done: true }).icon === '✓', 'done stage renders a tick');

  check(/fetch\('\/admin\/api\/customers\/onboarding'/.test(html), 'Customers tab loads from the onboarding endpoint');
  check(!/d\.customers\.recentList/.test(html), 'Customers tab no longer reads the old 20-row recentList');
  check(!/includeInternalCustomers|isInDefaultCustomerScope/.test(html), 'classification never hides a customer row');
  check(!/Recent signups<\/h3>/.test(html), 'duplicate "Recent signups" card (same data as Recent registrations) removed');
  check(!/(sendEmail|sendSms|messages\.create|\/notify|\/remind)/i.test(html.slice(html.indexOf('// CUSTOMERS TAB'), html.indexOf('// SYSTEM HEALTH TAB'))), 'Customers tab has no customer-messaging action');
}

console.log('');
if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log('All admin onboarding status checks passed.');
