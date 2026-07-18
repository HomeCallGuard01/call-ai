// Applies every supabase/migrations/*.sql file, in order, against a single
// in-memory PGlite (Postgres-in-WASM) instance, then runs smoke checks
// against migration 013's two RPC functions.
//
// Why one shared instance instead of a fresh npm project + pglite install
// per migration: pglite is a real Postgres engine, not a mock — every
// later migration builds on tables/roles/functions the earlier ones
// created, exactly like the real target database. Reinstalling pglite
// per migration bought nothing (the package is identical every time) and
// meant every run paid a full npm-install cost instead of hitting the
// already-populated node_modules cache. This project now depends on
// @electric-sql/pglite as a normal devDependency (see package.json), so
// `npm install` once is enough for every future run of this file.
//
// Run with: npm test

import { PGlite } from '@electric-sql/pglite';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(__dirname, '..', 'supabase', 'migrations');

// Minimal stand-in for the platform primitives Supabase provides that our
// migrations assume already exist: the anon/authenticated/service_role
// roles, the auth schema, auth.users, and auth.uid()/auth.jwt(). Real
// Supabase wires auth.uid()/auth.jwt() to GUCs set per-request from the
// caller's JWT (request.jwt.claims); this reproduces that contract closely
// enough to exercise RLS and SECURITY DEFINER functions under `set role`.
const BOOTSTRAP_SQL = `
create role anon;
create role authenticated;
create role service_role;

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

-- public.contacts was created via the Supabase Table Editor, not a
-- tracked migration (see 009_service_role_minimum_app_privileges.sql's
-- own comment on this) — 003_add_household_id_ownership.sql alters it.
-- Stub just enough of it here for the migration chain to apply.
create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  household_id uuid,
  created_at timestamptz not null default now()
);
`;

function asAuthUser(db, userId, email) {
  return db.exec(`
    set local request.jwt.claim.sub = '${userId}';
    set local request.jwt.claims = '{"sub":"${userId}","email":"${email}"}';
    set local role authenticated;
  `);
}

function asServiceRole(db) {
  return db.exec(`reset role; set local role service_role;`);
}

let failures = 0;
function assert(condition, message) {
  if (!condition) {
    failures += 1;
    console.error(`✗ ${message}`);
  } else {
    console.log(`✓ ${message}`);
  }
}

async function main() {
  const db = new PGlite();

  console.log('Bootstrapping auth/role shim...');
  await db.exec(BOOTSTRAP_SQL);

  // 005_household_rls.sql is explicitly frozen in its own header ("STATUS:
  // REVIEWED DRAFT — NOT APPLIED... Do not run against production until
  // explicitly re-approved") and was superseded for contacts by
  // 008_household_isolation_contacts.sql, which creates the same policy
  // names. Applying both would collide, and 005 was never actually run
  // against the real database, so skip it here to match reality.
  const SKIP = new Set(['005_household_rls.sql']);

  const files = (await readdir(migrationsDir))
    .filter((f) => f.endsWith('.sql') && !SKIP.has(f))
    .sort();

  for (const file of files) {
    const sql = await readFile(path.join(migrationsDir, file), 'utf8');
    console.log(`Applying ${file}...`);
    try {
      await db.exec(sql);
    } catch (err) {
      console.error(`✗ ${file} failed: ${err.message}`);
      process.exitCode = 1;
      return;
    }
  }

  console.log('\nAll migrations applied. Running smoke checks on migration 013...\n');

  // --- fixtures: one auth user + household, as service_role (bypasses RLS) ---
  await asServiceRole(db);
  const userId = '11111111-1111-1111-1111-111111111111';
  await db.query(`insert into auth.users (id, email) values ($1, $2)`, [userId, 'a@example.com']);
  const { rows: [household] } = await db.query(
    `insert into public.households (auth_user_id, email) values ($1, $2) returning id`,
    [userId, 'a@example.com']
  );
  const householdId = household.id;

  // --- set_household_stripe_customer_id: first set succeeds ---
  await asServiceRole(db);
  await db.query(`select public.set_household_stripe_customer_id($1, $2)`, [householdId, 'cus_123']);
  const { rows: [afterSet] } = await db.query(
    `select stripe_customer_id from public.households where id = $1`,
    [householdId]
  );
  assert(afterSet.stripe_customer_id === 'cus_123', 'set_household_stripe_customer_id sets the value on first call');

  // --- idempotent no-op on identical value ---
  await asServiceRole(db);
  await db.query(`select public.set_household_stripe_customer_id($1, $2)`, [householdId, 'cus_123']);
  assert(true, 'set_household_stripe_customer_id no-ops on identical value (did not throw)');

  // --- rejects on differing value ---
  await asServiceRole(db);
  let rejected = false;
  try {
    await db.query(`select public.set_household_stripe_customer_id($1, $2)`, [householdId, 'cus_DIFFERENT']);
  } catch {
    rejected = true;
  }
  assert(rejected, 'set_household_stripe_customer_id rejects a differing value');

  // --- process_stripe_webhook_event: qualifying status activates entitlement ---
  await asServiceRole(db);
  const eventId = 'evt_active_1';
  await db.query(
    `insert into public.stripe_webhook_events (stripe_event_id, event_type, payload, status) values ($1, 'customer.subscription.updated', '{}'::jsonb, 'received')`,
    [eventId]
  );
  const { rows: [activeResult] } = await db.query(
    `select public.process_stripe_webhook_event($1,$2,$3,$4,$5,$6,$7,$8) as result`,
    [eventId, householdId, 'cus_123', 'sub_123', 'price_123', 'active', new Date(Date.now() + 86400000).toISOString(), false]
  );
  assert(activeResult.result === 'processed', 'process_stripe_webhook_event processes a qualifying (active) status');

  const { rows: [entitlement] } = await db.query(
    `select status from public.entitlements where household_id = $1 and status = 'active'`,
    [householdId]
  );
  assert(entitlement?.status === 'active', 'active status creates an active entitlement');

  // --- non-qualifying status expires the entitlement ---
  await asServiceRole(db);
  const eventId2 = 'evt_canceled_1';
  await db.query(
    `insert into public.stripe_webhook_events (stripe_event_id, event_type, payload, status) values ($1, 'customer.subscription.deleted', '{}'::jsonb, 'received')`,
    [eventId2]
  );
  await db.query(
    `select public.process_stripe_webhook_event($1,$2,$3,$4,$5,$6,$7,$8) as result`,
    [eventId2, householdId, 'cus_123', 'sub_123', 'price_123', 'canceled', new Date().toISOString(), false]
  );
  const { rows: [expired] } = await db.query(
    `select status from public.entitlements where household_id = $1 order by created_at desc limit 1`,
    [householdId]
  );
  assert(expired?.status === 'expired', 'canceled status expires the active entitlement');

  // --- customer_id mismatch is refused and recorded as failed, not thrown to caller ---
  await asServiceRole(db);
  const eventId3 = 'evt_mismatch_1';
  await db.query(
    `insert into public.stripe_webhook_events (stripe_event_id, event_type, payload, status) values ($1, 'customer.subscription.updated', '{}'::jsonb, 'received')`,
    [eventId3]
  );
  const { rows: [mismatchResult] } = await db.query(
    `select public.process_stripe_webhook_event($1,$2,$3,$4,$5,$6,$7,$8) as result`,
    [eventId3, householdId, 'cus_WRONG', 'sub_123', 'price_123', 'active', new Date().toISOString(), false]
  );
  assert(mismatchResult.result === 'failed', 'customer_id mismatch returns failed rather than throwing');
  const { rows: [failedEvent] } = await db.query(
    `select status, error from public.stripe_webhook_events where stripe_event_id = $1`,
    [eventId3]
  );
  assert(failedEvent.status === 'failed' && !!failedEvent.error, 'mismatch is durably recorded on the event row');

  // --- direct execute privilege is not available to authenticated ---
  await asAuthUser(db, userId, 'a@example.com');
  let deniedToAuthenticated = false;
  try {
    await db.query(`select public.set_household_stripe_customer_id($1, $2)`, [householdId, 'cus_999']);
  } catch {
    deniedToAuthenticated = true;
  }
  assert(deniedToAuthenticated, 'authenticated role cannot execute set_household_stripe_customer_id directly');

  await db.close();

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
