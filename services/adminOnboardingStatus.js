// Admin onboarding monitoring (2026-09) — pure derivation of the simple,
// admin-facing customer states shown on the Admin Dashboard's Customers
// tab: Protected / Setting up / Needs attention / Provisioning problem /
// Inactive. Pure and directly unit-testable (tests/admin-onboarding-
// status.test.mjs): no database, no Express, `now` is always passed in.
//
// This is a READ-ONLY interpretation layer for an administrator. It
// never writes anything, never changes call routing, and deliberately
// does NOT redefine "Protected": that state is exactly
// services/callRouting.js's computeProtectionStatus().fullyProtected —
// the same function the web dashboard and mobile app use for "You're
// protected" — called here unchanged.
//
// The 24-hour clock. The backend does not record when a customer
// finished dialling their carrier forwarding code (the app's "I've done
// it" step is local to the device and never reported), so there is no
// reliable "setup completed" timestamp to measure from. Account creation
// time is NOT used either — a household can exist long before it pays or
// has a number to forward to. Instead the clock starts at the moment
// setup first became possible, from two backend-recorded facts:
//
//   - the currently-active entitlement's starts_at (membership began), and
//   - twilio_provisioning_updated_at while the number is active (the HCG
//     number the customer forwards to was assigned — migration 016 stamps
//     it on successful assignment).
//
// Whichever is later is the start. If the number's timestamp is missing
// (legacy households backfilled to 'active' by migration 016 without a
// timestamp) the membership start alone is used, and the source is
// reported so the dashboard can say which one it measured from.

'use strict';

const { computeProtectionStatus } = require('./callRouting');

const ONBOARDING_ATTENTION_THRESHOLD_MS = 24 * 60 * 60 * 1000;

const ADMIN_STATES = {
  PROTECTED: 'protected',
  SETTING_UP: 'setting_up',
  NEEDS_ATTENTION: 'needs_attention',
  PROVISIONING_PROBLEM: 'provisioning_problem',
  INACTIVE: 'inactive',
};

// Postgres timestamptz always serialises with an offset, but a value
// without one (e.g. a hand-written fixture, or a future column typed
// `timestamp` by mistake) would otherwise be parsed by Date as LOCAL time
// — silently shifting the 24-hour boundary by the server's UTC offset.
// Treat a missing designator as UTC. Returns epoch ms, or null.
function parseTimestampMs(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isNaN(ms) ? null : ms;
  }
  if (typeof value !== 'string') return null;

  const hasZone = /(Z|[+-]\d{2}(:?\d{2})?)$/i.test(value.trim());
  const ms = Date.parse(hasZone ? value : value.trim().replace(' ', 'T') + 'Z');
  return Number.isNaN(ms) ? null : ms;
}

function toIso(ms) {
  return ms === null ? null : new Date(ms).toISOString();
}

// Mirrors database/billing.js's getActiveEntitlement() query exactly
// (status 'active', starts_at <= now, ends_at null or > now), so
// "Inactive" here can never disagree with what requireEntitlement lets
// through.
function isEntitlementCurrentlyActive(entitlement, now) {
  if (!entitlement || entitlement.status !== 'active') return false;
  const nowMs = now.getTime();
  const startsMs = parseTimestampMs(entitlement.starts_at);
  if (startsMs === null || startsMs > nowMs) return false;
  const endsMs = parseTimestampMs(entitlement.ends_at);
  return endsMs === null || endsMs > nowMs;
}

// Pure — from a household's entitlement rows, the one currently active
// (at most one can be, per entitlements_one_active_per_household), plus
// its most recent row by updated_at for display when none is active.
function pickEntitlements(entitlementRows, now) {
  const rows = entitlementRows || [];
  const current = rows.find((e) => isEntitlementCurrentlyActive(e, now)) || null;
  let latest = null;
  for (const row of rows) {
    if (!latest || (parseTimestampMs(row.updated_at) || 0) > (parseTimestampMs(latest.updated_at) || 0)) {
      latest = row;
    }
  }
  return { current, latest };
}

function hasProvisionedNumber(household) {
  return household.twilio_provisioning_status === 'active' && !!household.twilio_number;
}

// See the file header: the later of "membership started" and "HCG number
// assigned". Returns { atMs, source } — source is 'number_provisioned' or
// 'membership_started', or null when no usable timestamp exists.
function resolveSetupClockStart(household, currentEntitlement) {
  const membershipMs = currentEntitlement ? parseTimestampMs(currentEntitlement.starts_at) : null;
  const numberMs = hasProvisionedNumber(household) ? parseTimestampMs(household.twilio_provisioning_updated_at) : null;

  if (numberMs !== null && (membershipMs === null || numberMs >= membershipMs)) {
    return { atMs: numberMs, source: 'number_provisioned' };
  }
  if (membershipMs !== null) {
    return { atMs: membershipMs, source: 'membership_started' };
  }
  return { atMs: null, source: null };
}

// Pure — the six-stage setup timeline for the customer detail panel.
// `done` is strictly evidence-based; the first stage that is not done is
// marked `firstIncomplete` so the dashboard can highlight exactly where
// this customer stopped. "Last HCG call" is informational only (a
// customer can be fully protected and simply not have been called
// recently), so it never counts as an incomplete stage.
function buildSetupTimeline({ household, currentEntitlement, protection, lastCallAtMs }) {
  const stages = [
    {
      key: 'membership',
      label: 'Membership active',
      done: !!currentEntitlement,
      at: currentEntitlement ? toIso(parseTimestampMs(currentEntitlement.starts_at)) : null,
    },
    {
      key: 'number',
      label: 'HCG number provisioned',
      done: hasProvisionedNumber(household),
      at: hasProvisionedNumber(household) ? toIso(parseTimestampMs(household.twilio_provisioning_updated_at)) : null,
      problem: household.twilio_provisioning_status === 'failed' ? 'Provisioning failed' : null,
    },
    {
      key: 'app',
      label: 'App registered for calls',
      done: protection.deliveryReady,
      // voice_client_registered_at is re-stamped on every registration
      // (migration 035), so this is the MOST RECENT registration, not the
      // first.
      at: toIso(parseTimestampMs(household.voice_client_registered_at)),
      atLabel: 'last registered',
    },
    {
      key: 'forwarding',
      label: 'Forwarding confirmed',
      done: protection.forwardingVerified || protection.endToEndDeliveryVerified,
      at: toIso(parseTimestampMs(household.activation_verified_at)),
    },
    {
      key: 'delivery',
      label: 'First successful delivery',
      done: protection.endToEndDeliveryVerified,
      // delivery_verified_at moves forward on every completed delivery
      // (migration 036) — most recent, not first.
      at: toIso(parseTimestampMs(household.delivery_verified_at)),
      atLabel: 'last delivered',
    },
  ];

  const firstIncomplete = stages.find((s) => !s.done);
  if (firstIncomplete) firstIncomplete.firstIncomplete = true;

  stages.push({
    key: 'last_call',
    label: 'Last HCG call',
    done: lastCallAtMs !== null,
    at: toIso(lastCallAtMs),
    informational: true,
  });

  return stages;
}

// Pure — the admin-facing state for one household. Precedence, first
// match wins:
//
//   1. Inactive — no currently-active entitlement. Nothing else is
//      actionable for a non-member.
//   2. Provisioning problem — twilio_provisioning_status 'failed', or an
//      'active' status with no number (inconsistent row), or still no
//      number 24h+ after the membership started.
//   3. Protected — computeProtectionStatus().fullyProtected, unchanged.
//   4. Needs attention — forwarding proven (calls reach HCG) but the app
//      has never registered for calls, so HCG has nowhere to deliver an
//      approved call; OR forwarding not proven and >= 24h have elapsed
//      since the setup clock started.
//   5. Setting up — everything else: waiting for a number (<24h),
//      forwarding not yet proven (<24h), or forwarding proven and waiting
//      for the first delivered call.
//
// "Forwarding proven" = activation_verified_at OR delivery_verified_at,
// the same OR mobile/lib/homeStatus.ts's hasProvenActivation uses (a
// delivered call is strictly stronger proof than activation alone).
function deriveAdminCustomerState({ household, entitlements, lastCallAt }, now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new Error('deriveAdminCustomerState: now must be a valid Date');
  }

  const nowMs = now.getTime();
  const { current: currentEntitlement, latest: latestEntitlement } = pickEntitlements(entitlements, now);
  const protection = computeProtectionStatus(household, now);
  const forwardingProven = protection.forwardingVerified || protection.endToEndDeliveryVerified;
  const lastCallAtMs = parseTimestampMs(lastCallAt);
  const clock = resolveSetupClockStart(household, currentEntitlement);
  const elapsedMs = clock.atMs === null ? null : nowMs - clock.atMs;
  const overThreshold = elapsedMs === null || elapsedMs >= ONBOARDING_ATTENTION_THRESHOLD_MS;

  const result = (state, reason) => ({
    state,
    reason,
    forwardingProven,
    protection,
    setupClock: {
      startedAt: toIso(clock.atMs),
      source: clock.source,
      elapsedMs,
      thresholdMs: ONBOARDING_ATTENTION_THRESHOLD_MS,
    },
    lastCallAt: toIso(lastCallAtMs),
    hasCurrentEntitlement: !!currentEntitlement,
    currentEntitlement,
    latestEntitlement,
    timeline: buildSetupTimeline({ household, currentEntitlement, protection, lastCallAtMs }),
  });

  if (!currentEntitlement) {
    return result(ADMIN_STATES.INACTIVE, latestEntitlement ? 'Membership not active' : 'Never had a membership');
  }

  if (household.twilio_provisioning_status === 'failed') {
    return result(ADMIN_STATES.PROVISIONING_PROBLEM, 'HCG number provisioning failed');
  }
  if (household.twilio_provisioning_status === 'active' && !household.twilio_number) {
    return result(ADMIN_STATES.PROVISIONING_PROBLEM, 'Marked provisioned but no HCG number recorded');
  }

  if (protection.fullyProtected) {
    return result(ADMIN_STATES.PROTECTED, 'Forwarding and call delivery both proven');
  }

  if (!hasProvisionedNumber(household)) {
    return overThreshold
      ? result(ADMIN_STATES.PROVISIONING_PROBLEM, 'Still no HCG number 24h+ after membership started')
      : result(ADMIN_STATES.SETTING_UP, 'Waiting for HCG number');
  }

  if (forwardingProven) {
    if (!protection.deliveryReady) {
      return result(ADMIN_STATES.NEEDS_ATTENTION, 'Calls reach HCG but the app has never registered to receive them');
    }
    return result(ADMIN_STATES.SETTING_UP, 'Forwarding confirmed — waiting for first delivered call');
  }

  if (clock.atMs === null) {
    return result(ADMIN_STATES.NEEDS_ATTENTION, 'No forwarded call yet (setup start time unknown)');
  }
  if (overThreshold) {
    return result(ADMIN_STATES.NEEDS_ATTENTION, 'No forwarded call 24h+ after setup became possible');
  }
  return result(ADMIN_STATES.SETTING_UP, 'Waiting for first forwarded call');
}

// Pure — counts per state, always including every state (zeros too) so
// the filter bar has a stable shape.
function summariseAdminStates(rows) {
  const counts = { all: 0 };
  for (const s of Object.values(ADMIN_STATES)) counts[s] = 0;
  for (const row of rows || []) {
    counts.all += 1;
    if (Object.prototype.hasOwnProperty.call(counts, row.state)) counts[row.state] += 1;
  }
  return counts;
}

module.exports = {
  ONBOARDING_ATTENTION_THRESHOLD_MS,
  ADMIN_STATES,
  parseTimestampMs,
  isEntitlementCurrentlyActive,
  pickEntitlements,
  resolveSetupClockStart,
  buildSetupTimeline,
  deriveAdminCustomerState,
  summariseAdminStates,
};
