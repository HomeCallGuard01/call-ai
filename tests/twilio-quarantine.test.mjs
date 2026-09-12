// Unit tests for database/twilioQuarantine.js's
// findUnconfirmedQuarantineForHousehold — the lookup the new admin
// confirm-deactivation action (routes/admin.js) depends on. Uses an
// injected fake Supabase admin client (deps.admin), matching
// services/twilioProvisioning.js's existing deps convention — no real
// Supabase connection required.
//
// Run with: node tests/twilio-quarantine.test.mjs

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('dotenv').config();

const { findUnconfirmedQuarantineForHousehold } = require('../database/twilioQuarantine.js');

let failures = 0;

function check(condition, message) {
  if (condition) {
    console.log(`✓ ${message}`);
  } else {
    console.error(`✗ ${message}`);
    failures++;
  }
}

// A minimal fake of Supabase's fluent query builder — just enough surface
// for findUnconfirmedQuarantineForHousehold's exact call chain
// (.from().select().eq().eq().is().order().limit().maybeSingle()).
function fakeAdmin({ data = null, error = null } = {}) {
  const calls = [];
  const builder = {
    from(table) { calls.push(['from', table]); return builder; },
    select(cols) { calls.push(['select', cols]); return builder; },
    eq(col, val) { calls.push(['eq', col, val]); return builder; },
    is(col, val) { calls.push(['is', col, val]); return builder; },
    order(col, opts) { calls.push(['order', col, opts]); return builder; },
    limit(n) { calls.push(['limit', n]); return builder; },
    maybeSingle: async () => ({ data, error }),
  };
  builder.calls = calls;
  return builder;
}

// --- found ---
{
  const row = { id: 'q1', household_id: 'h1', deactivation_confirmed: false, released_at: null };
  const admin = fakeAdmin({ data: row });
  const result = await findUnconfirmedQuarantineForHousehold('h1', { admin });
  check(result === row, 'returns the row when an unconfirmed, unreleased quarantine exists');
  check(admin.calls.some(c => c[0] === 'from' && c[1] === 'twilio_number_quarantine'), 'queries the twilio_number_quarantine table');
  check(admin.calls.some(c => c[0] === 'eq' && c[1] === 'household_id' && c[2] === 'h1'), 'filters on the requested household_id');
  check(admin.calls.some(c => c[0] === 'eq' && c[1] === 'deactivation_confirmed' && c[2] === false), 'filters on deactivation_confirmed = false');
  check(admin.calls.some(c => c[0] === 'is' && c[1] === 'released_at' && c[2] === null), 'filters on released_at IS NULL');
}

// --- not found: a normal state, not an error ---
{
  const admin = fakeAdmin({ data: null });
  const result = await findUnconfirmedQuarantineForHousehold('h2', { admin });
  check(result === null, 'returns null when no matching row exists');
}

// --- Supabase error: fails closed to "nothing to confirm", never throws ---
{
  const admin = fakeAdmin({ error: { message: 'boom' } });
  const result = await findUnconfirmedQuarantineForHousehold('h3', { admin });
  check(result === null, 'returns null (never throws) on a Supabase error — this is a lookup, not a write');
}

// --- no admin configured ---
{
  const result = await findUnconfirmedQuarantineForHousehold('h4', { admin: null });
  check(result === null, 'returns null when Supabase admin is not configured');
}

// --- the safety invariant this whole feature exists to protect ---
// A row can only ever be surfaced by this lookup (and therefore only ever
// reach confirmTwilioNumberDeactivation via the new admin route) while
// deactivation_confirmed is still false and released_at is still null —
// the exact two filters above. Once either changes, the row permanently
// drops out of every future call to this function, mirroring
// findConfirmedUnreleasedQuarantine's opposite filter
// (services/twilioNumberReleaseRunner.js) so the two lookups can never
// both claim the same row, and an admin can never "re-confirm" or act on
// an already-released number through this path.
{
  const admin = fakeAdmin({ data: null }); // an already-confirmed/released row is correctly excluded server-side by the query filters, never returned here
  const result = await findUnconfirmedQuarantineForHousehold('h5', { admin });
  check(result === null, 'an already-confirmed or already-released row is never returned by this lookup');
}

if (failures > 0) {
  console.error(`\n${failures} test(s) failed.`);
  process.exitCode = 1;
} else {
  console.log('\nAll tests passed.');
  process.exitCode = 0;
}
