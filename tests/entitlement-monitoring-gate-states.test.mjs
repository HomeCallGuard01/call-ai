// Dedicated PGlite (in-memory Postgres-in-WASM, not a real database) test
// for the DB-level entitlement states services/callRouting.js's
// shouldStartPaidMonitoring depends on via database/billing.js's
// getActiveEntitlement — closing the gap between "the pure decision
// function is tested" (tests/call-routing.test.mjs) and "the real query
// that resolves an entitlement from the database correctly discriminates
// every state that matters" (this file).
//
// getActiveEntitlement's query, mirrored exactly here (same three
// conditions, same table): entitlements where household_id = X AND
// status = 'active' AND starts_at <= now AND (ends_at IS NULL OR
// ends_at > now). This file runs that exact SQL against a real (if
// in-memory) Postgres engine, seeded with one row per requested scenario,
// rather than re-testing the pure function (already covered) or mocking
// the Supabase client (this codebase's established convention for
// DB-backed logic is a real pglite instance, not a mock).
//
// Scenarios requested explicitly: active, expired, cancelled, missing,
// complimentary/admin, and test-account entitlements. Two "expired"
// shapes are covered on purpose, because they are genuinely different
// database states with the same real-world meaning:
//   - status explicitly set to 'expired' by the webhook/admin flow
//   - status still 'active' but ends_at has already passed (the exact
//     shape found in a real production household during a prior audit:
//     a 1-day Stripe subscription that lapsed with no status update)
//
// Run with: node tests/entitlement-monitoring-gate-states.test.mjs

import { PGlite } from '@electric-sql/pglite';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { shouldStartPaidMonitoring } = require('../services/callRouting.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(__dirname, '..', 'supabase', 'migrations');

const BOOTSTRAP_SQL = `
create role anon;
create role authenticated;
create role service_role bypassrls;

create schema auth;

create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text
);

create or replace function auth.uid() returns uuid
language sql stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

create or replace function auth.jwt() returns jsonb
language sql stable
as $$
  select nullif(current_setting('request.jwt.claims', true), '')::jsonb;
$$;

grant usage on schema public to anon, authenticated, service_role;
grant usage on schema auth to service_role;
grant select, insert, update, delete on auth.users to service_role;
`;

let failures = 0;
function assert(condition, message) {
  if (!condition) {
    failures += 1;
    console.error(`✗ ${message}`);
  } else {
    console.log(`✓ ${message}`);
  }
}

// Exact mirror of database/billing.js's getActiveEntitlement query — same
// three conditions, same table, same "at most one" expectation
// (maybeSingle in the real Supabase client; LIMIT 1 here since pglite has
// no equivalent helper — the real code's own uniqueness assumption, that
// a household never has two simultaneously-active entitlement rows, is
// not itself re-verified by this test).
async function getActiveEntitlementRow(db, householdId, now) {
  const { rows } = await db.query(
    `select * from public.entitlements
     where household_id = $1
       and status = 'active'
       and starts_at <= $2
       and (ends_at is null or ends_at > $2)
     limit 1`,
    [householdId, now]
  );
  return rows[0] || null;
}

async function main() {
  const db = new PGlite();

  console.log('Bootstrapping auth/role shim...');
  await db.exec(BOOTSTRAP_SQL);

  const files = (await readdir(migrationsDir)).filter(f => f.endsWith('.sql')).sort();
  for (const file of files) {
    const sql = await readFile(path.join(migrationsDir, file), 'utf8');
    try {
      await db.exec(sql);
    } catch (err) {
      console.error(`✗ ${file} failed to apply: ${err.message}`);
      process.exitCode = 1;
      return;
    }
  }
  console.log('All migrations applied cleanly.\n');

  await db.exec(`reset role;`);
  const now = new Date('2026-09-27T09:00:00.000Z');

  // One household per scenario — clearer failure attribution than reusing
  // one household and mutating its entitlement between checks.
  async function makeHousehold(label) {
    const { rows: [h] } = await db.query(
      `insert into public.households (auth_user_id, email, phone_number) values (null, $1, $2) returning id`,
      [`${label}@example.com`, '+441234560000']
    );
    return h.id;
  }

  async function insertEntitlement(householdId, { entitlementType, status, startsAt, endsAt, source }) {
    await db.query(
      `insert into public.entitlements (household_id, entitlement_type, status, starts_at, ends_at, source)
       values ($1, $2, $3, $4, $5, $6)`,
      [householdId, entitlementType, status, startsAt, endsAt, source]
    );
  }

  // --- 1. Active, open-ended (no ends_at) — the common ongoing-subscription shape ---
  {
    const hh = await makeHousehold('active-open-ended');
    await insertEntitlement(hh, { entitlementType: 'paid_subscription', status: 'active', startsAt: '2026-08-01T00:00:00Z', endsAt: null, source: 'stripe' });
    const row = await getActiveEntitlementRow(db, hh, now);
    assert(row !== null, 'ACTIVE (open-ended, no ends_at): resolves to a real row');
    assert(shouldStartPaidMonitoring({ id: hh }, row) === true, 'ACTIVE (open-ended): shouldStartPaidMonitoring -> true');
  }

  // --- 2. Active with a future ends_at (mid-period, real paid subscription) ---
  {
    const hh = await makeHousehold('active-future-end');
    await insertEntitlement(hh, { entitlementType: 'paid_subscription', status: 'active', startsAt: '2026-09-01T00:00:00Z', endsAt: '2026-10-01T00:00:00Z', source: 'stripe' });
    const row = await getActiveEntitlementRow(db, hh, now);
    assert(row !== null, 'ACTIVE (future ends_at): resolves to a real row');
    assert(shouldStartPaidMonitoring({ id: hh }, row) === true, 'ACTIVE (future ends_at): shouldStartPaidMonitoring -> true');
  }

  // --- 3. Expired: status explicitly 'expired' ---
  {
    const hh = await makeHousehold('status-expired');
    await insertEntitlement(hh, { entitlementType: 'paid_subscription', status: 'expired', startsAt: '2026-07-01T00:00:00Z', endsAt: '2026-08-01T00:00:00Z', source: 'stripe' });
    const row = await getActiveEntitlementRow(db, hh, now);
    assert(row === null, 'EXPIRED (status explicitly expired): resolves to null — never treated as active');
    assert(shouldStartPaidMonitoring({ id: hh }, row) === false, 'EXPIRED (status): shouldStartPaidMonitoring -> false');
  }

  // --- 4. Expired: status still 'active' but ends_at already in the past
  // (the real production shape found in a prior audit — a 1-day Stripe
  // subscription that lapsed with no status update) ---
  {
    const hh = await makeHousehold('date-lapsed-status-stale');
    await insertEntitlement(hh, { entitlementType: 'paid_subscription', status: 'active', startsAt: '2026-08-22T17:11:40Z', endsAt: '2026-08-23T18:52:32Z', source: 'stripe' });
    const row = await getActiveEntitlementRow(db, hh, now);
    assert(row === null, 'EXPIRED (date-lapsed, status field stale at "active"): resolves to null — the date check catches what the status field missed');
    assert(shouldStartPaidMonitoring({ id: hh }, row) === false, 'EXPIRED (date-lapsed): shouldStartPaidMonitoring -> false — this is the exact real-world gap this fix closes');
  }

  // --- 5. Cancelled/revoked ---
  {
    const hh = await makeHousehold('revoked');
    await insertEntitlement(hh, { entitlementType: 'paid_subscription', status: 'revoked', startsAt: '2026-08-01T00:00:00Z', endsAt: null, source: 'stripe' });
    const row = await getActiveEntitlementRow(db, hh, now);
    assert(row === null, 'CANCELLED (status revoked): resolves to null');
    assert(shouldStartPaidMonitoring({ id: hh }, row) === false, 'CANCELLED (revoked): shouldStartPaidMonitoring -> false');
  }

  // --- 6. Missing: household exists, zero entitlement rows at all ---
  {
    const hh = await makeHousehold('no-entitlement-ever');
    const row = await getActiveEntitlementRow(db, hh, now);
    assert(row === null, 'MISSING (never subscribed, zero entitlement rows): resolves to null');
    assert(shouldStartPaidMonitoring({ id: hh }, row) === false, 'MISSING: shouldStartPaidMonitoring -> false — never silently resolves to any plan');
  }

  // --- 7. Complimentary / admin-granted, open-ended — the real shape found
  // in production for a household given goodwill access after a rocky start ---
  {
    const hh = await makeHousehold('complimentary-admin');
    await insertEntitlement(hh, { entitlementType: 'complimentary', status: 'active', startsAt: '2026-08-27T18:54:57Z', endsAt: null, source: 'admin_manual' });
    const row = await getActiveEntitlementRow(db, hh, now);
    assert(row !== null, 'COMPLIMENTARY/ADMIN (active, open-ended): resolves to a real row');
    assert(shouldStartPaidMonitoring({ id: hh }, row) === true, 'COMPLIMENTARY/ADMIN: shouldStartPaidMonitoring -> true — a genuine, currently-active grant, regardless of who paid for it');
  }

  // --- 8. Scheduled but not yet started (starts_at in the future) — a
  // genuinely different "not yet" case, distinct from "never" or "lapsed" ---
  {
    const hh = await makeHousehold('scheduled-future');
    await insertEntitlement(hh, { entitlementType: 'paid_subscription', status: 'scheduled', startsAt: '2026-10-01T00:00:00Z', endsAt: null, source: 'stripe' });
    const row = await getActiveEntitlementRow(db, hh, now);
    assert(row === null, 'SCHEDULED (starts in the future): resolves to null — not active yet, must not grant monitoring early');
    assert(shouldStartPaidMonitoring({ id: hh }, row) === false, 'SCHEDULED: shouldStartPaidMonitoring -> false');
  }

  // --- 9. "Test" entitlement — an active entitlement belonging to a
  // household ALSO classified internal_test/qa/reviewer in
  // account_classifications. Deliberately proves these are two completely
  // independent concerns: account_classifications exists purely for
  // business reporting (services/businessMetrics/accountClassification.js
  // — "never assume genuine", the opposite direction of this test's
  // point) and has no bearing on runtime call behaviour. A test account
  // with a genuinely active entitlement is correctly monitored exactly
  // like any other — this is intentional, not a gap: classification-based
  // call-routing exceptions do not exist anywhere in this codebase, and
  // this test exists so nobody adds one by mistake while "fixing" this
  // area later. ---
  {
    const hh = await makeHousehold('internal-test-account');
    await db.query(`insert into public.account_classifications (household_id, classification) values ($1, $2)`, [hh, 'internal_test']);
    await insertEntitlement(hh, { entitlementType: 'paid_subscription', status: 'active', startsAt: '2026-09-01T00:00:00Z', endsAt: null, source: 'stripe' });
    const row = await getActiveEntitlementRow(db, hh, now);
    assert(row !== null, 'TEST ACCOUNT (classified internal_test, but with a real active entitlement): resolves to a real row');
    assert(
      shouldStartPaidMonitoring({ id: hh }, row) === true,
      'TEST ACCOUNT: shouldStartPaidMonitoring -> true — account_classifications never gates call-time monitoring behaviour; it is a reporting-only concern, confirmed here so it is never conflated with entitlement status'
    );
  }

  console.log(`\n${failures === 0 ? '✓ All' : `✗ ${failures}`} entitlement-monitoring-gate-states checks ${failures === 0 ? 'passed' : 'FAILED'}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exitCode = 1;
});
