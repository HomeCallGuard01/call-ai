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
-- Real Supabase's service_role always has BYPASSRLS — without it here,
-- this stub role would be subject to RLS like any other, silently masked
-- before the SET LOCAL ROLE fix above (every query ran as the bootstrap
-- superuser regardless, which bypasses RLS anyway).
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

-- Reproduce the most permissive real platform default ACL — staging's
-- (project created 2026-07-30; read-only pg_default_acl snapshot
-- 2026-09-30): everything postgres creates in public implicitly grants
-- anon/authenticated/service_role ALL. Production's default is strictly
-- narrower, so replaying the chain under this one is the worst case. Before
-- this, the harness had no default ACL at all and could not reproduce the
-- terms_acceptances exposure (039 + staging defaults); now every
-- "anon/authenticated has no X" assertion below is tested against the grants
-- a real Supabase project would actually hand out. 022/058/059 must undo it.
alter default privileges for role postgres in schema public
  grant all on tables to anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  grant all on sequences to anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  grant all on functions to anon, authenticated, service_role;

-- Real Supabase grants service_role full access to the auth schema by
-- platform default (it's how the service-role key can read/write
-- auth.users at all) — this was never exercised before the SET LOCAL ROLE
-- fix above, since every fixture-setup query was silently running as the
-- bootstrap superuser regardless of asServiceRole(). Now that role
-- switching genuinely applies, this stub needs to grant what Supabase
-- already provides in reality, not what this project's own migrations
-- grant (auth is Supabase-managed, never touched by supabase/migrations/).
grant usage on schema auth to service_role;
grant select, insert, update, delete on auth.users to service_role;

-- public.contacts was created via the Supabase Table Editor, not a
-- tracked migration — this used to require a stub table here. As of
-- docs/engineering/MIGRATION_RECOVERY_PLAN.md,
-- 000_baseline_contacts_table.sql now creates the real, authoritative
-- table (captured by read-only introspection of production), so no stub
-- is needed: the migration chain itself now provides it.
`;

// Plain SET (not SET LOCAL) is used deliberately here, not as a stylistic
// choice: SET LOCAL is scoped to the current transaction and reverts the
// instant the statement's own implicit transaction ends — which happens
// before the *next*, separate db.query() call in this file ever runs, so
// every "role" set this way silently reverted to the PGlite default
// (effectively superuser) before it could matter. That made every
// previous "authenticated/anon cannot do X" assertion in this file pass
// for the wrong reason (hitting an unrelated business-logic exception,
// not an actual permission-denied error) rather than genuinely exercising
// the REVOKE/GRANT this test suite exists to verify. Confirmed directly:
// SET LOCAL ROLE followed by a separate query() call reports
// current_user as the original superuser role, not the one just set;
// plain SET ROLE persists correctly across separate calls, which is what
// every asAuthUser/asServiceRole call site here actually needs — this
// harness is one long-lived instance, not a connection pool where LOCAL
// scoping would matter.
function asAuthUser(db, userId, email) {
  return db.exec(`
    set request.jwt.claim.sub = '${userId}';
    set request.jwt.claims = '{"sub":"${userId}","email":"${email}"}';
    set role authenticated;
  `);
}

function asServiceRole(db) {
  return db.exec(`reset role; set role service_role;`);
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

  // 005_household_rls.sql used to need a name-based skip here (frozen,
  // superseded for contacts by 008_household_isolation_contacts.sql —
  // applying both collides on policy names). As of
  // docs/engineering/MIGRATION_RECOVERY_PLAN.md it's been physically
  // relocated to supabase/migrations/_superseded/, along with the 019 and
  // 021 rollback scripts (supabase/migrations/_rollbacks/), so a plain
  // readdir of this directory no longer sees any of them — no filename
  // skip-list needed to match reality anymore.
  const files = (await readdir(migrationsDir))
    .filter((f) => f.endsWith('.sql'))
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

  // --- fixtures: one auth user + household ---
  //
  // Seeded at the default (superuser-equivalent) connection role, not
  // service_role: service_role only ever has SELECT on households in
  // reality (migration 009) — the real app path that creates a household
  // row (ensureHouseholdAndRole() in server.js) does so via the signed-in
  // user's own RLS-scoped session, not supabaseAdmin. (database/households.js's
  // claimOrCreateHousehold/setUserRole, which do use supabaseAdmin, are
  // dead code per migration 009's own audit — never called from a live
  // route.) Fixture setup here is standing in for "this row already
  // exists," the same way any DB test seeds its starting state, not for
  // exercising how it got there.
  await db.exec(`reset role;`);
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

  // --- out-of-order webhook delivery (019): an older event arriving after
  // a newer one must not overwrite the newer state or resurrect an
  // entitlement the newer event already correctly expired ---
  await asServiceRole(db);
  const orderingSubId = 'sub_ordering_test';
  const tEarly = new Date('2026-01-01T00:00:00Z').toISOString();
  const tLate = new Date('2026-01-01T00:05:00Z').toISOString();
  const tLatest = new Date('2026-01-01T00:10:00Z').toISOString();

  // The genuinely newer event, processed first (as it should be in a
  // correctly-ordered world): the subscription is cancelled.
  await db.query(
    `insert into public.stripe_webhook_events (stripe_event_id, event_type, payload, status) values ('evt_order_newer', 'customer.subscription.deleted', '{}'::jsonb, 'received')`
  );
  const { rows: [newerResult] } = await db.query(
    `select public.process_stripe_webhook_event($1,$2,$3,$4,$5,$6,$7,$8,$9) as result`,
    [
      'evt_order_newer', householdId, 'cus_123', orderingSubId, 'price_123',
      'canceled', new Date().toISOString(), false, tLate,
    ]
  );
  assert(newerResult.result === 'processed', 'ordering: the genuinely newer (cancellation) event is processed normally');

  const { rows: [activeAfterCancel] } = await db.query(
    `select status from public.entitlements where household_id = $1 and status = 'active' and external_reference = $2`,
    [householdId, orderingSubId]
  );
  assert(!activeAfterCancel, 'ordering: no active entitlement exists for this subscription after the newer cancellation event');

  // A DIFFERENT, older event for the same subscription now arrives late
  // (its own timestamp, tEarly, predates what's already stored, tLate) —
  // simulating exactly the out-of-order delivery Stripe does not rule out.
  await db.query(
    `insert into public.stripe_webhook_events (stripe_event_id, event_type, payload, status) values ('evt_order_stale', 'customer.subscription.updated', '{}'::jsonb, 'received')`
  );
  const { rows: [staleResult] } = await db.query(
    `select public.process_stripe_webhook_event($1,$2,$3,$4,$5,$6,$7,$8,$9) as result`,
    [
      'evt_order_stale', householdId, 'cus_123', orderingSubId, 'price_123',
      'active', new Date().toISOString(), false, tEarly,
    ]
  );
  assert(staleResult.result === 'ignored_stale', 'ordering: a stale event returns ignored_stale (migrations/027), distinguishable from a genuine apply — nothing went wrong, it was correctly evaluated and its subscription.status must not be acted on');

  const { rows: [subAfterStale] } = await db.query(
    `select status from public.subscriptions where stripe_subscription_id = $1`,
    [orderingSubId]
  );
  assert(subAfterStale.status === 'canceled', 'ordering: the stale event does NOT overwrite the subscription — status remains the newer "canceled"');

  const { rows: [noReactivation] } = await db.query(
    `select status from public.entitlements where household_id = $1 and status = 'active' and external_reference = $2`,
    [householdId, orderingSubId]
  );
  assert(!noReactivation, 'ordering: the stale "active" event does not resurrect the entitlement the newer cancellation already expired');

  const { rows: [staleEventRow] } = await db.query(
    `select status from public.stripe_webhook_events where stripe_event_id = 'evt_order_stale'`
  );
  assert(staleEventRow.status === 'ignored', 'ordering: the stale event is recorded as ignored, distinguishable later from one that actually changed state');

  // A genuinely newer event still applies correctly on top of an already-
  // processed one (proves the guard only blocks strictly-older events, not
  // every subsequent event for the same subscription).
  await db.query(
    `insert into public.stripe_webhook_events (stripe_event_id, event_type, payload, status) values ('evt_order_latest', 'customer.subscription.updated', '{}'::jsonb, 'received')`
  );
  await db.query(
    `select public.process_stripe_webhook_event($1,$2,$3,$4,$5,$6,$7,$8,$9) as result`,
    [
      'evt_order_latest', householdId, 'cus_123', orderingSubId, 'price_123',
      'active', new Date(Date.now() + 86400000).toISOString(), false, tLatest,
    ]
  );
  const { rows: [subAfterLatest] } = await db.query(
    `select status from public.subscriptions where stripe_subscription_id = $1`,
    [orderingSubId]
  );
  assert(subAfterLatest.status === 'active', 'ordering: a genuinely newer event (tLatest > tLate) is applied normally, reactivating the subscription');

  const { rows: [reactivated] } = await db.query(
    `select status from public.entitlements where household_id = $1 and status = 'active' and external_reference = $2`,
    [householdId, orderingSubId]
  );
  assert(reactivated?.status === 'active', 'ordering: the genuinely newer active event does create a fresh active entitlement');

  // Existing call sites that predate this migration (8 positional args, no
  // stripe_event_created) still work — the new parameter's default (now())
  // covers them without any call site needing to change.
  await db.query(
    `insert into public.stripe_webhook_events (stripe_event_id, event_type, payload, status) values ('evt_order_legacy_call', 'customer.subscription.updated', '{}'::jsonb, 'received')`
  );
  // Status is 'canceled' (not 'active') deliberately: householdId already
  // has a live subscription from the ordering tests above, and only one
  // live subscription per household is allowed at all
  // (subscriptions_one_live_per_household, 011) — unrelated to this
  // migration, just a fact about the fixture state at this point. This
  // check only needs to prove the old 8-argument call shape still
  // resolves and runs, which 'canceled' does just as well.
  const { rows: [legacyCallResult] } = await db.query(
    `select public.process_stripe_webhook_event($1,$2,$3,$4,$5,$6,$7,$8) as result`,
    ['evt_order_legacy_call', householdId, 'cus_123', 'sub_legacy_call_test', 'price_123', 'canceled', new Date().toISOString(), false]
  );
  assert(legacyCallResult.result === 'processed', 'ordering: the pre-019 8-argument call shape still works, defaulting stripe_event_created to now()');

  // --- direct execute privilege is not available to authenticated ---
  await asAuthUser(db, userId, 'a@example.com');
  let deniedToAuthenticated = false;
  try {
    await db.query(`select public.set_household_stripe_customer_id($1, $2)`, [householdId, 'cus_999']);
  } catch {
    deniedToAuthenticated = true;
  }
  assert(deniedToAuthenticated, 'authenticated role cannot execute set_household_stripe_customer_id directly');

  console.log('\nRunning smoke checks on migration 016 (Twilio number provisioning)...\n');

  // --- fresh household for the provisioning tests, so twilio_number starts null ---
  await db.exec(`reset role;`);
  const userId2 = '22222222-2222-2222-2222-222222222222';
  await db.query(`insert into auth.users (id, email) values ($1, $2)`, [userId2, 'b@example.com']);
  const { rows: [household2] } = await db.query(
    `insert into public.households (auth_user_id, email) values ($1, $2) returning id`,
    [userId2, 'b@example.com']
  );
  const householdId2 = household2.id;

  const { rows: [initial] } = await db.query(
    `select twilio_number, twilio_provisioning_status, twilio_provisioning_attempts from public.households where id = $1`,
    [householdId2]
  );
  assert(
    initial.twilio_number === null && initial.twilio_provisioning_status === 'pending' && initial.twilio_provisioning_attempts === 0,
    'a new household starts pending, with no number and no failed attempts'
  );

  // --- assign_household_twilio_number: rejects a nonexistent household ---
  //
  // Regression test for a real bug found via direct RPC testing: the
  // original body selected a literal `true` into a second target
  // variable to detect whether the row existed. On zero matching rows,
  // PL/pgSQL sets every SELECT INTO target to NULL, not false — so
  // `if not v_found then raise exception` never fired (NULL isn't true
  // under three-valued logic), and a nonexistent household id silently
  // no-op'd and returned true instead of raising. Fixed using Postgres's
  // built-in FOUND variable. See
  // docs/engineering/sql/016_twilio_assign_function_fix.sql.
  await asServiceRole(db);
  const nonexistentHouseholdId = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
  let rejectedNonexistentHousehold = false;
  try {
    await db.query(
      `select public.assign_household_twilio_number($1, $2)`,
      [nonexistentHouseholdId, '+447700900999']
    );
  } catch (err) {
    rejectedNonexistentHousehold = /does not exist/.test(err.message);
  }
  assert(
    rejectedNonexistentHousehold,
    'assign_household_twilio_number raises "does not exist" for a nonexistent household rather than silently no-opping'
  );

  // --- assign_household_twilio_number: first assignment succeeds ---
  await asServiceRole(db);
  const { rows: [firstAssign] } = await db.query(
    `select public.assign_household_twilio_number($1, $2) as assigned`,
    [householdId2, '+447700900001']
  );
  assert(firstAssign.assigned === true, 'assign_household_twilio_number succeeds on first assignment');

  const { rows: [afterAssign] } = await db.query(
    `select twilio_number, twilio_provisioning_status from public.households where id = $1`,
    [householdId2]
  );
  assert(
    afterAssign.twilio_number === '+447700900001' && afterAssign.twilio_provisioning_status === 'active',
    'the assigned number is stored and status moves to active'
  );

  // --- idempotent no-op on identical value ---
  await asServiceRole(db);
  const { rows: [sameAssign] } = await db.query(
    `select public.assign_household_twilio_number($1, $2) as assigned`,
    [householdId2, '+447700900001']
  );
  assert(sameAssign.assigned === true, 'assigning the same number again is an idempotent no-op success');

  // --- duplicate prevention: a different number is refused, not thrown ---
  await asServiceRole(db);
  const { rows: [differentAssign] } = await db.query(
    `select public.assign_household_twilio_number($1, $2) as assigned`,
    [householdId2, '+447700900002']
  );
  assert(differentAssign.assigned === false, 'assigning a different number once one is set returns false rather than overwriting it (never two numbers for one household)');

  const { rows: [stillOriginal] } = await db.query(
    `select twilio_number from public.households where id = $1`,
    [householdId2]
  );
  assert(stillOriginal.twilio_number === '+447700900001', 'the original number is preserved after a rejected re-assignment');

  // --- record_household_twilio_provisioning_failure: increments attempts, flags failed ---
  await db.exec(`reset role;`);
  const { rows: [household3] } = await db.query(
    `insert into public.households (auth_user_id, email) values (null, $1) returning id`,
    ['c@example.com']
  );
  const householdId3 = household3.id;

  await asServiceRole(db);
  await db.query(`select public.record_household_twilio_provisioning_failure($1, $2)`, [householdId3, 'no numbers available']);
  const { rows: [afterFailure] } = await db.query(
    `select twilio_provisioning_status, twilio_provisioning_attempts, twilio_provisioning_last_error from public.households where id = $1`,
    [householdId3]
  );
  assert(
    afterFailure.twilio_provisioning_status === 'failed' &&
      afterFailure.twilio_provisioning_attempts === 1 &&
      afterFailure.twilio_provisioning_last_error === 'no numbers available',
    'a failed provisioning attempt is recorded: status, attempt count, and error message'
  );

  await db.query(`select public.record_household_twilio_provisioning_failure($1, $2)`, [householdId3, 'no numbers available']);
  const { rows: [afterSecondFailure] } = await db.query(
    `select twilio_provisioning_attempts from public.households where id = $1`,
    [householdId3]
  );
  assert(afterSecondFailure.twilio_provisioning_attempts === 2, 'attempt count accumulates across repeated failures (retry behaviour)');

  // --- a failure reported after success never downgrades an active household ---
  await asServiceRole(db);
  await db.query(`select public.record_household_twilio_provisioning_failure($1, $2)`, [householdId2, 'late/racing failure report']);
  const { rows: [stillActive] } = await db.query(
    `select twilio_provisioning_status from public.households where id = $1`,
    [householdId2]
  );
  assert(stillActive.twilio_provisioning_status === 'active', 'a household that already has a number is never downgraded by a late failure report');

  // --- direct execute privilege is not available to authenticated ---
  await asAuthUser(db, userId2, 'b@example.com');
  let twilioRpcDeniedToAuthenticated = false;
  try {
    await db.query(`select public.assign_household_twilio_number($1, $2)`, [householdId2, '+447700900999']);
  } catch {
    twilioRpcDeniedToAuthenticated = true;
  }
  assert(twilioRpcDeniedToAuthenticated, 'authenticated role cannot execute assign_household_twilio_number directly');

  console.log('\nRunning smoke checks on migration 017 (Twilio number lifecycle)...\n');

  // householdId2 still holds '+447700900001' with status 'active' here.

  // --- regression: nonexistent-household checks for all three functions
  // that had the same FOUND-vs-manually-selected-boolean bug as
  // assign_household_twilio_number ---
  await asServiceRole(db);
  const nonexistentId017 = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

  let markRejected = false;
  try {
    await db.query(`select public.mark_household_twilio_number_pending_release($1)`, [nonexistentId017]);
  } catch (err) {
    markRejected = /does not exist/.test(err.message);
  }
  assert(markRejected, 'mark_household_twilio_number_pending_release raises "does not exist" for a nonexistent household');

  let releaseRejected = false;
  try {
    await db.query(`select public.release_household_twilio_number($1, $2)`, [nonexistentId017, '+447700900999']);
  } catch (err) {
    releaseRejected = /does not exist/.test(err.message);
  }
  assert(releaseRejected, 'release_household_twilio_number raises "does not exist" for a nonexistent household');

  let releaseImmediatelyRejected = false;
  try {
    await db.query(`select public.release_household_twilio_number_immediately($1)`, [nonexistentId017]);
  } catch (err) {
    releaseImmediatelyRejected = /does not exist/.test(err.message);
  }
  assert(releaseImmediatelyRejected, 'release_household_twilio_number_immediately raises "does not exist" for a nonexistent household');

  // --- mark_household_twilio_number_pending_release: starts the grace-period clock ---
  await asServiceRole(db);
  const { rows: [firstMark] } = await db.query(
    `select public.mark_household_twilio_number_pending_release($1) as marked`,
    [householdId2]
  );
  assert(firstMark.marked === true, 'marking a household with a number for release sets a deadline');

  const { rows: [afterMark] } = await db.query(
    `select twilio_number_pending_release_at from public.households where id = $1`,
    [householdId2]
  );
  assert(afterMark.twilio_number_pending_release_at !== null, 'the pending-release deadline is actually stored');

  // --- idempotent: a second mark does not push the deadline further out ---
  await asServiceRole(db);
  const { rows: [secondMark] } = await db.query(
    `select public.mark_household_twilio_number_pending_release($1) as marked`,
    [householdId2]
  );
  assert(secondMark.marked === false, 'marking an already-pending household again is a no-op (deadline is not extended)');

  const { rows: [afterSecondMark] } = await db.query(
    `select twilio_number_pending_release_at from public.households where id = $1`,
    [householdId2]
  );
  assert(
    afterSecondMark.twilio_number_pending_release_at.getTime() === afterMark.twilio_number_pending_release_at.getTime(),
    'the deadline itself is unchanged by the redundant mark (Stripe can redeliver events; this must not keep extending the clock)'
  );

  // --- release attempted before the deadline is refused ---
  await asServiceRole(db);
  const { rows: [tooEarly] } = await db.query(
    `select public.release_household_twilio_number($1, $2) as released`,
    [householdId2, '+447700900001']
  );
  assert(tooEarly.released === false, 'releasing before the grace-period deadline has passed is refused');

  const { rows: [stillHasNumber] } = await db.query(
    `select twilio_number from public.households where id = $1`,
    [householdId2]
  );
  assert(stillHasNumber.twilio_number === '+447700900001', 'the number is untouched by a premature release attempt');

  // --- cancel_household_twilio_number_pending_release: reactivation keeps the same number ---
  await asServiceRole(db);
  await db.query(`select public.cancel_household_twilio_number_pending_release($1)`, [householdId2]);
  const { rows: [afterCancel] } = await db.query(
    `select twilio_number, twilio_number_pending_release_at from public.households where id = $1`,
    [householdId2]
  );
  assert(
    afterCancel.twilio_number === '+447700900001' && afterCancel.twilio_number_pending_release_at === null,
    'cancelling a pending release clears the deadline and keeps the same number'
  );

  // --- release refuses a number that no longer matches, even past deadline ---
  await asServiceRole(db);
  await db.query(
    `select public.mark_household_twilio_number_pending_release($1, interval '-1 second') as marked`,
    [householdId2]
  );
  const { rows: [wrongNumber] } = await db.query(
    `select public.release_household_twilio_number($1, $2) as released`,
    [householdId2, '+447700900999']
  );
  assert(wrongNumber.released === false, 'release refuses when the expected number no longer matches the household\'s actual number');

  const { rows: [stillOriginalAfterMismatch] } = await db.query(
    `select twilio_number from public.households where id = $1`,
    [householdId2]
  );
  assert(stillOriginalAfterMismatch.twilio_number === '+447700900001', 'a mismatched release call never touches the real number');

  // --- release succeeds once the deadline has passed and the number matches ---
  await asServiceRole(db);
  const { rows: [correctRelease] } = await db.query(
    `select public.release_household_twilio_number($1, $2) as released`,
    [householdId2, '+447700900001']
  );
  assert(correctRelease.released === true, 'release succeeds once the deadline has passed and the number matches');

  const { rows: [afterRelease] } = await db.query(
    `select twilio_number, twilio_provisioning_status, twilio_provisioning_attempts, twilio_number_pending_release_at
     from public.households where id = $1`,
    [householdId2]
  );
  assert(
    afterRelease.twilio_number === null &&
      afterRelease.twilio_provisioning_status === 'pending' &&
      afterRelease.twilio_provisioning_attempts === 0 &&
      afterRelease.twilio_number_pending_release_at === null,
    'a released household is reset cleanly: no number, back to pending, attempts zeroed, no lingering deadline'
  );

  // --- release_household_twilio_number_immediately: no number to release ---
  await asServiceRole(db);
  const { rows: [nothingToRelease] } = await db.query(
    `select public.release_household_twilio_number_immediately($1) as released_number`,
    [householdId3]
  );
  assert(nothingToRelease.released_number === null, 'immediate release on a household with no number returns null rather than erroring');

  // --- release_household_twilio_number_immediately: bypasses the grace period entirely ---
  await asServiceRole(db);
  await db.query(`select public.assign_household_twilio_number($1, $2)`, [householdId3, '+447700900777']);
  const { rows: [immediateRelease] } = await db.query(
    `select public.release_household_twilio_number_immediately($1) as released_number`,
    [householdId3]
  );
  assert(immediateRelease.released_number === '+447700900777', 'immediate release returns the number that was released, with no deadline required');

  const { rows: [afterImmediate] } = await db.query(
    `select twilio_number, twilio_provisioning_status from public.households where id = $1`,
    [householdId3]
  );
  assert(
    afterImmediate.twilio_number === null && afterImmediate.twilio_provisioning_status === 'pending',
    'a household released immediately is reset the same way as a grace-period release'
  );

  // --- direct execute privilege is not available to authenticated (lifecycle RPCs) ---
  await asAuthUser(db, userId2, 'b@example.com');
  let lifecycleRpcDeniedToAuthenticated = false;
  try {
    await db.query(`select public.release_household_twilio_number_immediately($1)`, [householdId2]);
  } catch {
    lifecycleRpcDeniedToAuthenticated = true;
  }
  assert(lifecycleRpcDeniedToAuthenticated, 'authenticated role cannot execute release_household_twilio_number_immediately directly');

  console.log('\nRunning smoke checks on migration 029 (anonymize_inactive_household deletes contacts and calls)...\n');

  // --- fixture: a household with contacts, calls, an expired
  // entitlement, and an expired/canceled subscription — the shape of a
  // genuinely deletable, no-longer-protected account ---
  await db.exec(`reset role;`);
  const { rows: [delHousehold] } = await db.query(
    `insert into public.households (auth_user_id, email, phone_number)
     values (null, $1, $2) returning id`,
    ['delete-me@example.com', '+447700900111']
  );
  const delHouseholdId = delHousehold.id;

  await db.query(
    `insert into public.contacts (household_id, name, number) values ($1, $2, $3), ($1, $4, $5)`,
    [delHouseholdId, 'Trusted Friend', '+447700900222', 'Trusted Family', '+447700900333']
  );

  await db.query(
    `insert into public.calls (household_id, call_sid, number, status, result)
     values ($1, $2, $3, 'Unknown', 'SAFE'), ($1, $4, $5, 'Known', 'SAFE')`,
    [delHouseholdId, 'CA-delete-test-1', '+447700900444', 'CA-delete-test-2', '+447700900555']
  );

  await db.query(
    `insert into public.subscriptions (household_id, stripe_subscription_id, stripe_price_id, status)
     values ($1, $2, $3, 'canceled')`,
    [delHouseholdId, 'sub_delete_test_1', 'price_delete_test_1']
  );

  await db.query(
    `insert into public.entitlements (household_id, entitlement_type, status, source, external_reference)
     values ($1, 'paid_subscription', 'expired', 'stripe', 'sub_delete_test_1')`,
    [delHouseholdId]
  );

  const { rows: [beforeCounts] } = await db.query(
    `select
       (select count(*) from public.contacts where household_id = $1) as contacts,
       (select count(*) from public.calls where household_id = $1) as calls,
       (select count(*) from public.subscriptions where household_id = $1) as subscriptions,
       (select count(*) from public.entitlements where household_id = $1) as entitlements`,
    [delHouseholdId]
  );
  assert(
    Number(beforeCounts.contacts) === 2 && Number(beforeCounts.calls) === 2 &&
      Number(beforeCounts.subscriptions) === 1 && Number(beforeCounts.entitlements) === 1,
    'fixture set up correctly: 2 contacts, 2 calls, 1 subscription, 1 (expired) entitlement before deletion'
  );

  // --- a second, untouched household — proves no cross-household deletion ---
  const { rows: [otherHousehold] } = await db.query(
    `insert into public.households (auth_user_id, email, phone_number)
     values (null, $1, $2) returning id`,
    ['keep-me@example.com', '+447700900666']
  );
  const otherHouseholdId = otherHousehold.id;

  await db.query(
    `insert into public.contacts (household_id, name, number) values ($1, $2, $3)`,
    [otherHouseholdId, 'Someone Else Entirely', '+447700900777']
  );
  await db.query(
    `insert into public.calls (household_id, call_sid, number, status, result)
     values ($1, $2, $3, 'Unknown', 'SAFE')`,
    [otherHouseholdId, 'CA-other-household', '+447700900888']
  );

  // --- failure/rollback: an active entitlement blocks the whole
  // operation, and blocks it before any deletion happens ---
  await asServiceRole(db);
  const { rows: [blockingEntitlement] } = await db.query(
    `insert into public.entitlements (household_id, entitlement_type, status, source)
     values ($1, 'complimentary', 'active', 'admin_manual') returning id`,
    [delHouseholdId]
  );
  let blockedByActiveEntitlement = false;
  try {
    await db.query(`select public.anonymize_inactive_household($1, $2)`, [delHouseholdId, 'test: should be blocked']);
  } catch (err) {
    blockedByActiveEntitlement = /still has an active entitlement/.test(err.message);
  }
  assert(blockedByActiveEntitlement, 'anonymize_inactive_household refuses to run while an active entitlement exists');

  const { rows: [afterBlockedAttempt] } = await db.query(
    `select
       (select count(*) from public.contacts where household_id = $1) as contacts,
       (select count(*) from public.calls where household_id = $1) as calls
     from public.households where id = $1`,
    [delHouseholdId]
  );
  assert(
    Number(afterBlockedAttempt.contacts) === 2 && Number(afterBlockedAttempt.calls) === 2,
    'a blocked (exception-raised) attempt deletes nothing — contacts and calls are untouched, not partially removed'
  );

  // Resolve the blocking entitlement so the real deletion below can
  // proceed — matching how the real system actually clears one (expired
  // via the normal subscription lifecycle), not a raw delete: service_role
  // itself only has select/insert/update on entitlements (migration 012),
  // never delete, so a real delete here would fail exactly as it should.
  await db.query(`update public.entitlements set status = 'expired' where id = $1`, [blockingEntitlement.id]);

  // --- the real anonymisation: household scrubbed, contacts and calls
  // deleted, subscription/entitlement history retained ---
  await db.query(`select public.anonymize_inactive_household($1, $2)`, [delHouseholdId, 'test: genuine deletion']);

  const { rows: [afterHousehold] } = await db.query(
    `select email, phone_number, auth_user_id, status from public.households where id = $1`,
    [delHouseholdId]
  );
  assert(
    afterHousehold.email === `anonymized-${delHouseholdId}@deleted.homecallguard.internal` &&
      afterHousehold.phone_number === null &&
      afterHousehold.auth_user_id === null &&
      afterHousehold.status === 'cancelled',
    'household anonymisation itself is unchanged: email/phone/auth_user_id scrubbed, status cancelled'
  );

  const { rows: [afterCounts] } = await db.query(
    `select
       (select count(*) from public.contacts where household_id = $1) as contacts,
       (select count(*) from public.calls where household_id = $1) as calls,
       (select count(*) from public.subscriptions where household_id = $1) as subscriptions,
       (select count(*) from public.entitlements where household_id = $1) as entitlements`,
    [delHouseholdId]
  );
  assert(Number(afterCounts.contacts) === 0, 'all trusted-contact rows for the deleted household are gone');
  assert(Number(afterCounts.calls) === 0, 'all call/screening records for the deleted household are gone');
  assert(Number(afterCounts.subscriptions) === 1, 'the subscription (billing) record is retained, not deleted');
  assert(Number(afterCounts.entitlements) === 2, 'both entitlement records (the original expired one, and the one used to test the active-entitlement guard, now itself expired) are retained, not deleted');

  // --- the other household's data survived completely untouched ---
  const { rows: [otherCounts] } = await db.query(
    `select
       (select count(*) from public.contacts where household_id = $1) as contacts,
       (select count(*) from public.calls where household_id = $1) as calls,
       (select email from public.households where id = $1) as email`,
    [otherHouseholdId]
  );
  assert(
    Number(otherCounts.contacts) === 1 && Number(otherCounts.calls) === 1 && otherCounts.email === 'keep-me@example.com',
    'a different household\'s contacts, calls, and account data are completely unaffected by deleting another household'
  );

  // --- direct execute privilege is not available to authenticated ---
  await asAuthUser(db, userId2, 'c-anon-test@example.com');
  let anonymizeRpcDeniedToAuthenticated = false;
  try {
    await db.query(`select public.anonymize_inactive_household($1, $2)`, [otherHouseholdId, 'should be denied']);
  } catch {
    anonymizeRpcDeniedToAuthenticated = true;
  }
  assert(anonymizeRpcDeniedToAuthenticated, 'authenticated role cannot execute anonymize_inactive_household directly');

  // --- 035: households.voice_client_registered_at + mark_household_voice_client_registered ---
  await asServiceRole(db);
  const { rows: [beforeVoiceReg] } = await db.query(
    `select voice_client_registered_at from public.households where id = $1`,
    [householdId]
  );
  assert(beforeVoiceReg.voice_client_registered_at === null, 'voice_client_registered_at defaults to null');

  const { rows: [firstVoiceReg] } = await db.query(
    `select public.mark_household_voice_client_registered($1) as result`,
    [householdId]
  );
  assert(!!firstVoiceReg.result, 'mark_household_voice_client_registered returns the new timestamp');

  // Deliberately not idempotent-once (unlike mark_household_activation_verified):
  // a second call must move the timestamp forward, since staleness is the signal.
  await new Promise((resolve) => setTimeout(resolve, 10));
  const { rows: [secondVoiceReg] } = await db.query(
    `select public.mark_household_voice_client_registered($1) as result`,
    [householdId]
  );
  assert(
    new Date(secondVoiceReg.result).getTime() > new Date(firstVoiceReg.result).getTime(),
    'mark_household_voice_client_registered moves the timestamp forward on every call, not just the first'
  );

  let voiceRegNonexistentThrew = false;
  try {
    await db.query(`select public.mark_household_voice_client_registered($1)`, ['00000000-0000-0000-0000-000000000000']);
  } catch {
    voiceRegNonexistentThrew = true;
  }
  assert(voiceRegNonexistentThrew, 'mark_household_voice_client_registered raises for a nonexistent household');

  await asAuthUser(db, userId2, 'c-voice-reg-test@example.com');
  let voiceRegDeniedToAuthenticated = false;
  try {
    await db.query(`select public.mark_household_voice_client_registered($1)`, [householdId]);
  } catch {
    voiceRegDeniedToAuthenticated = true;
  }
  assert(voiceRegDeniedToAuthenticated, 'authenticated role cannot execute mark_household_voice_client_registered directly');

  // --- 036: households.delivery_verified_at + mark_household_delivery_verified ---
  await asServiceRole(db);
  const { rows: [beforeDeliveryVerified] } = await db.query(
    `select delivery_verified_at from public.households where id = $1`,
    [householdId]
  );
  assert(beforeDeliveryVerified.delivery_verified_at === null, 'delivery_verified_at defaults to null');

  const { rows: [firstDelivery] } = await db.query(
    `select public.mark_household_delivery_verified($1) as result`,
    [householdId]
  );
  assert(!!firstDelivery.result, 'mark_household_delivery_verified returns the new timestamp');

  await new Promise((resolve) => setTimeout(resolve, 10));
  const { rows: [secondDelivery] } = await db.query(
    `select public.mark_household_delivery_verified($1) as result`,
    [householdId]
  );
  assert(
    new Date(secondDelivery.result).getTime() > new Date(firstDelivery.result).getTime(),
    'mark_household_delivery_verified moves the timestamp forward on every call (every real completed delivery is fresh evidence)'
  );

  let deliveryVerifiedNonexistentThrew = false;
  try {
    await db.query(`select public.mark_household_delivery_verified($1)`, ['00000000-0000-0000-0000-000000000000']);
  } catch {
    deliveryVerifiedNonexistentThrew = true;
  }
  assert(deliveryVerifiedNonexistentThrew, 'mark_household_delivery_verified raises for a nonexistent household');

  await asAuthUser(db, userId2, 'c-delivery-verified-test@example.com');
  let deliveryVerifiedDeniedToAuthenticated = false;
  try {
    await db.query(`select public.mark_household_delivery_verified($1)`, [householdId]);
  } catch {
    deliveryVerifiedDeniedToAuthenticated = true;
  }
  assert(deliveryVerifiedDeniedToAuthenticated, 'authenticated role cannot execute mark_household_delivery_verified directly');

  // --- 037: twilio_number_quarantine (P0 Batch 1, component D) ---
  await asServiceRole(db);

  const { rows: [quarantineRow] } = await db.query(
    `insert into public.twilio_number_quarantine (household_id, twilio_number, twilio_sid, release_reason)
     values ($1, $2, $3, 'subscription_grace_expired') returning *`,
    [householdId, '+447700900321', 'PN_test_sid_321']
  );
  assert(
    quarantineRow.deactivation_confirmed === false &&
      quarantineRow.deactivation_confirmed_at === null &&
      quarantineRow.released_at === null,
    'a freshly quarantined number starts unconfirmed and unreleased — this is the foundation of the "never auto-release an unconfirmed number" correction'
  );
  assert(quarantineRow.twilio_sid === 'PN_test_sid_321', 'the Twilio SID captured at quarantine time is stored on the row');

  let invalidReleaseReasonRejected = false;
  try {
    await db.query(
      `insert into public.twilio_number_quarantine (household_id, twilio_number, release_reason)
       values ($1, $2, 'not_a_real_reason')`,
      [householdId, '+447700900322']
    );
  } catch {
    invalidReleaseReasonRejected = true;
  }
  assert(invalidReleaseReasonRejected, 'release_reason is constrained to the two known values — an invalid value is rejected at the database level');

  // authenticated (a real customer's own session) has no access at all —
  // this table is purely internal, matching acquisition_events'
  // established precedent (migration 032).
  await asAuthUser(db, userId2, 'c-quarantine-test@example.com');
  let quarantineSelectDeniedToAuthenticated = false;
  try {
    await db.query(`select * from public.twilio_number_quarantine where id = $1`, [quarantineRow.id]);
  } catch {
    quarantineSelectDeniedToAuthenticated = true;
  }
  assert(quarantineSelectDeniedToAuthenticated, 'authenticated cannot read twilio_number_quarantine at all — no policy grants it access');

  let quarantineInsertDeniedToAuthenticated = false;
  try {
    await db.query(
      `insert into public.twilio_number_quarantine (household_id, twilio_number, release_reason)
       values ($1, $2, 'account_deletion')`,
      [householdId, '+447700900323']
    );
  } catch {
    quarantineInsertDeniedToAuthenticated = true;
  }
  assert(quarantineInsertDeniedToAuthenticated, 'authenticated cannot insert into twilio_number_quarantine — a customer session can never quarantine (or fabricate a release of) any number directly');

  // --- confirming deactivation and marking released are both service-role-only, additive updates ---
  await asServiceRole(db);
  const { rows: [confirmed] } = await db.query(
    `update public.twilio_number_quarantine
       set deactivation_confirmed = true, deactivation_confirmed_at = now(), deactivation_confirmed_method = 'manual_support_review'
       where id = $1
       returning *`,
    [quarantineRow.id]
  );
  assert(
    confirmed.deactivation_confirmed === true && confirmed.released_at === null,
    'confirming deactivation marks it confirmed without touching released_at — confirmation and release remain two distinct steps'
  );

  const { rows: [released] } = await db.query(
    `update public.twilio_number_quarantine set released_at = now() where id = $1 returning released_at`,
    [quarantineRow.id]
  );
  assert(released.released_at !== null, 'a confirmed quarantine row can be marked released');

  // --- confirmed-but-not-yet-released IS selected; unconfirmed never is —
  // this is the actual proof that "confirmed quarantine becomes eligible
  // for the existing safe release path" (no real Twilio API is ever
  // touched by this test — this only exercises the database query shape
  // services/twilioNumberReleaseRunner.js's runConfirmedQuarantineRelease
  // uses to find candidates, via database/twilioQuarantine.js's
  // findConfirmedUnreleasedQuarantine) ---
  const { rows: [confirmedNotYetReleasedRow] } = await db.query(
    `insert into public.twilio_number_quarantine (household_id, twilio_number, release_reason, deactivation_confirmed, deactivation_confirmed_at, deactivation_confirmed_method)
     values ($1, $2, 'subscription_grace_expired', true, now(), 'manual_support_review') returning id`,
    [householdId, '+447700900325']
  );
  const { rows: [unconfirmedRow] } = await db.query(
    `insert into public.twilio_number_quarantine (household_id, twilio_number, release_reason)
     values ($1, $2, 'subscription_grace_expired') returning id`,
    [householdId, '+447700900324']
  );
  const { rows: readyForRelease } = await db.query(
    `select id from public.twilio_number_quarantine where deactivation_confirmed = true and released_at is null`
  );
  assert(
    readyForRelease.some((r) => r.id === confirmedNotYetReleasedRow.id),
    'a confirmed, not-yet-released quarantine row DOES appear in the confirmed-and-unreleased query — this is what makes it genuinely eligible for the existing safe release path'
  );
  assert(
    !readyForRelease.some((r) => r.id === unconfirmedRow.id),
    'an unconfirmed quarantine row never appears in the confirmed-and-unreleased query the release runner uses — it is never selected for release no matter how long it has been sitting there'
  );

  // --- deleting the household SETS NULL, never CASCADEs — corrected
  // 2026-09-10 after review: the whole point of this table is to retain
  // the quarantine record (Twilio number/SID, reason, timestamps,
  // confirmation state, release state) for as long as the number itself
  // remains un-released, specifically INCLUDING after the customer's own
  // household/auth data is gone. A CASCADE would silently delete the one
  // record proving an un-recycled number still exists — backwards for a
  // safety mechanism whose job is "never forget about this number."
  // households.id is never actually hard-deleted anywhere in this
  // codebase today (anonymize_inactive_household anonymises in place,
  // never deletes the row) — this plain DELETE, via the bootstrap/
  // superuser connection (service_role only has SELECT on households,
  // migration 009), exists purely to exercise the foreign-key behaviour
  // itself, defensively, against a hypothetical future hard-delete.
  await db.exec('reset role;');
  const { rows: [cascadeHousehold] } = await db.query(
    `insert into public.households (auth_user_id, email, phone_number) values (null, $1, $2) returning id`,
    ['quarantine-cascade-test@example.com', '+447700900950']
  );
  await asServiceRole(db);
  const { rows: [survivingRow] } = await db.query(
    `insert into public.twilio_number_quarantine (household_id, twilio_number, twilio_sid, release_reason)
     values ($1, $2, $3, 'account_deletion') returning id, twilio_number, twilio_sid, release_reason, quarantined_at`,
    [cascadeHousehold.id, '+447700900951', 'PN_test_sid_951']
  );
  await db.exec('reset role;');
  await db.query(`delete from public.households where id = $1`, [cascadeHousehold.id]);
  const { rows: [afterDelete] } = await db.query(
    `select * from public.twilio_number_quarantine where id = $1`,
    [survivingRow.id]
  );
  assert(!!afterDelete, 'the quarantine row survives deletion of its household — it is not cascaded away');
  assert(afterDelete.household_id === null, 'household_id is set null once the household is gone');
  assert(
    afterDelete.twilio_number === survivingRow.twilio_number &&
      afterDelete.twilio_sid === survivingRow.twilio_sid &&
      afterDelete.release_reason === survivingRow.release_reason,
    'the Twilio number, SID, and release reason are all still fully intact after the household is gone — exactly the fields that must survive'
  );

  // --- 038: household carrier-compatibility capture (P0 Batch 1 continuation) ---
  await asServiceRole(db);

  const { rows: [beforeCarrier] } = await db.query(
    `select carrier_provider_key, carrier_tariff_type, carrier_compatibility_captured_at
       from public.households where id = $1`,
    [householdId]
  );
  assert(
    beforeCarrier.carrier_provider_key === null &&
      beforeCarrier.carrier_tariff_type === null &&
      beforeCarrier.carrier_compatibility_captured_at === null,
    'all three carrier-compatibility columns default to null'
  );

  const { rows: [firstCapture] } = await db.query(
    `select public.set_household_carrier_compatibility($1, $2, $3, $4) as result`,
    [householdId, 'mobile', 'vodafone', 'pay_monthly']
  );
  assert(!!firstCapture.result, 'set_household_carrier_compatibility returns the new captured-at timestamp');

  const { rows: [afterFirstCapture] } = await db.query(
    `select carrier_provider_key, carrier_tariff_type from public.households where id = $1`,
    [householdId]
  );
  assert(
    afterFirstCapture.carrier_provider_key === 'vodafone' && afterFirstCapture.carrier_tariff_type === 'pay_monthly',
    'the exact provider and tariff values passed in are persisted, unaltered'
  );

  // Deliberately not idempotent-once (unlike mark_household_activation_verified)
  // — a customer can change their selection (corrected a mistake, actually
  // switched carrier), and the most recent capture is what matters. Matches
  // mark_household_voice_client_registered/mark_household_delivery_verified's
  // own established "always move forward" precedent, not
  // mark_household_activation_verified's "first time only" one.
  await new Promise((resolve) => setTimeout(resolve, 10));
  const { rows: [secondCapture] } = await db.query(
    `select public.set_household_carrier_compatibility($1, $2, $3, $4) as result`,
    [householdId, 'mobile', 'tesco', null]
  );
  assert(
    new Date(secondCapture.result).getTime() > new Date(firstCapture.result).getTime(),
    'a later call moves carrier_compatibility_captured_at forward, not idempotent-once'
  );

  const { rows: [afterSecondCapture] } = await db.query(
    `select carrier_provider_key, carrier_tariff_type from public.households where id = $1`,
    [householdId]
  );
  assert(
    afterSecondCapture.carrier_provider_key === 'tesco' && afterSecondCapture.carrier_tariff_type === null,
    'a corrected/changed selection overwrites the previous one — the most recent capture wins, and a genuinely absent tariff persists as null, not a stale previous value'
  );

  // No CHECK constraint on carrier_provider_key — deliberate, per migration
  // 038's own header: PROVIDER_POLICY's key set is expected to grow, and an
  // unrecognised key is already handled safely by getProviderPolicy's
  // fallback to 'other' (unverified, blocked) in application code, not by
  // a database constraint that would need updating in lockstep with it.
  // This proves the ACTUAL constraint (none) rather than inventing one.
  let junkValueRejected = false;
  try {
    await db.query(
      `select public.set_household_carrier_compatibility($1, $2, $3, $4)`,
      [householdId, 'mobile', 'some-completely-made-up-provider-xyz', 'not-a-real-tariff-either']
    );
  } catch {
    junkValueRejected = true;
  }
  assert(
    !junkValueRejected,
    'an unrecognised provider/tariff value is accepted at the database level, not rejected — validation is deliberately owned entirely by services/providerPolicy.js (getProviderPolicy\'s fallback to \'other\'), never duplicated as a database constraint'
  );
  const { rows: [afterJunkValue] } = await db.query(
    `select carrier_provider_key, carrier_tariff_type from public.households where id = $1`,
    [householdId]
  );
  assert(
    afterJunkValue.carrier_provider_key === 'some-completely-made-up-provider-xyz',
    'the junk value is stored verbatim, exactly as the application layer\'s own fallback-to-unverified logic expects to receive it'
  );

  let carrierCompatNonexistentThrew = false;
  try {
    await db.query(
      `select public.set_household_carrier_compatibility($1, $2, $3, $4)`,
      ['00000000-0000-0000-0000-000000000000', 'mobile', 'o2', null]
    );
  } catch {
    carrierCompatNonexistentThrew = true;
  }
  assert(carrierCompatNonexistentThrew, 'set_household_carrier_compatibility raises for a nonexistent household');

  await asAuthUser(db, userId2, 'c-carrier-compat-test@example.com');
  let carrierCompatDeniedToAuthenticated = false;
  try {
    await db.query(`select public.set_household_carrier_compatibility($1, $2, $3, $4)`, [householdId, 'mobile', 'o2', null]);
  } catch {
    carrierCompatDeniedToAuthenticated = true;
  }
  assert(carrierCompatDeniedToAuthenticated, 'authenticated role cannot execute set_household_carrier_compatibility directly — grants/security match every other households-lifecycle RPC in this codebase');

  // --- 040: households.device_type — Mobile/Landline persisted onboarding
  // configuration (landline checkout-eligibility fix, 2026-09-16) ---
  await asServiceRole(db);

  let oldThreeArgSignatureGone = false;
  try {
    await db.query(`select public.set_household_carrier_compatibility($1, $2, $3)`, [householdId, 'o2', null]);
  } catch {
    oldThreeArgSignatureGone = true;
  }
  assert(oldThreeArgSignatureGone, 'migration 040 dropped the old 3-arg set_household_carrier_compatibility — only the 4-arg (device_type-aware) version exists now');

  let invalidDeviceTypeRaised = false;
  try {
    await db.query(
      `select public.set_household_carrier_compatibility($1, $2, $3, $4)`,
      [householdId, 'tablet', 'o2', null]
    );
  } catch {
    invalidDeviceTypeRaised = true;
  }
  assert(invalidDeviceTypeRaised, 'an invalid device_type (neither mobile nor landline) is rejected by the RPC itself, not just application-layer validation');

  let nullDeviceTypeRaised = false;
  try {
    await db.query(
      `select public.set_household_carrier_compatibility($1, $2, $3, $4)`,
      [householdId, null, 'o2', null]
    );
  } catch {
    nullDeviceTypeRaised = true;
  }
  assert(nullDeviceTypeRaised, 'a null device_type is rejected by the RPC — never silently treated as one device type or the other');

  let deviceTypeCheckConstraintRejected = false;
  try {
    await db.query(`update public.households set device_type = 'tablet' where id = $1`, [householdId]);
  } catch {
    deviceTypeCheckConstraintRejected = true;
  }
  assert(deviceTypeCheckConstraintRejected, 'households.device_type has a real CHECK constraint — an invalid value is rejected even by a direct write, not only through the RPC');

  // Mobile -> Landline: carrier_provider_key/carrier_tariff_type must be
  // cleared atomically the same instant device_type flips to landline —
  // this is the actual security-refinement fix, proven directly against
  // the database rather than only against the JS layer that calls it.
  await db.query(
    `select public.set_household_carrier_compatibility($1, $2, $3, $4)`,
    [householdId, 'mobile', 'vodafone', 'pay_monthly']
  );
  const { rows: [beforeLandlineSwitch] } = await db.query(
    `select device_type, carrier_provider_key, carrier_tariff_type from public.households where id = $1`,
    [householdId]
  );
  assert(
    beforeLandlineSwitch.device_type === 'mobile' &&
      beforeLandlineSwitch.carrier_provider_key === 'vodafone' &&
      beforeLandlineSwitch.carrier_tariff_type === 'pay_monthly',
    'household is a real mobile household with carrier/tariff captured, immediately before switching to landline'
  );

  // 2026-09-19 launch-safety correction (migration 043): landline now
  // PERSISTS the provider key (the landline provider itself, e.g. 'bt')
  // rather than clearing it — this is the actual mechanism the checkout
  // gate now reads to decide whether an unsupported/unaudited landline
  // provider may proceed. Only carrier_tariff_type (a mobile-only
  // concept) still clears atomically.
  await db.query(
    `select public.set_household_carrier_compatibility($1, $2, $3, $4)`,
    [householdId, 'landline', 'bt', 'this-tariff-should-still-be-cleared']
  );
  const { rows: [afterLandlineSwitch] } = await db.query(
    `select device_type, carrier_provider_key, carrier_tariff_type from public.households where id = $1`,
    [householdId]
  );
  assert(afterLandlineSwitch.device_type === 'landline', 'device_type is persisted as landline');
  assert(
    afterLandlineSwitch.carrier_provider_key === 'bt',
    'switching to landline now PERSISTS the landline provider as carrier_provider_key (migration 043) — this is what the checkout gate reads to enforce LANDLINE_SUPPORTED_PROVIDERS, not a mobile-carrier leftover being tolerated'
  );
  assert(
    afterLandlineSwitch.carrier_tariff_type === null,
    'carrier_tariff_type still clears atomically on a landline switch, even though a non-null value was passed — tariff is a mobile-only concept and never applies to landline'
  );

  // Landline -> Mobile: switching back requires a fresh, real carrier
  // capture — nothing about the previous landline state can make a new
  // mobile selection succeed without going through this same call again.
  await db.query(
    `select public.set_household_carrier_compatibility($1, $2, $3, $4)`,
    [householdId, 'mobile', 'giffgaff', null]
  );
  const { rows: [afterSwitchBackToMobile] } = await db.query(
    `select device_type, carrier_provider_key, carrier_tariff_type from public.households where id = $1`,
    [householdId]
  );
  assert(
    afterSwitchBackToMobile.device_type === 'mobile' && afterSwitchBackToMobile.carrier_provider_key === 'giffgaff',
    'switching back to mobile persists the newly-supplied provider — the household is never left in a state where an old landline flag and a new carrier disagree'
  );

  // --- 041: households.device_type widened to include 'iphone'
  // (IOS_COMING_SOON, 2026-09-19) — already applied by the bulk
  // migration loop at the top of this file (every migration in
  // supabase/migrations/ is applied in order before any test body runs,
  // same as 040's own section above never re-runs 040 either); this
  // section tests its effects directly. ---
  await asServiceRole(db);

  await db.query(
    `select public.set_household_carrier_compatibility($1, $2, $3, $4)`,
    [householdId, 'mobile', 'giffgaff', null]
  );
  // 2026-09-30 (migration 065, drafted as 061): the iPhone coming-soon path passes no
  // provider — stale mobile-carrier data must still be cleared.
  await db.query(
    `select public.set_household_carrier_compatibility($1, $2, $3, $4)`,
    [householdId, 'iphone', null, null]
  );
  const { rows: [afterIphoneSwitch] } = await db.query(
    `select device_type, carrier_provider_key, carrier_tariff_type from public.households where id = $1`,
    [householdId]
  );
  assert(afterIphoneSwitch.device_type === 'iphone', 'after migration 041, device_type can be set to iphone via the RPC');
  assert(
    afterIphoneSwitch.carrier_provider_key === null && afterIphoneSwitch.carrier_tariff_type === null,
    'switching to iphone with no carrier (coming-soon/waiting-list path) clears carrier_provider_key/carrier_tariff_type — no stale mobile-carrier data survives the switch'
  );
  // 061: an iPhone household onboarded through the iOS app's carrier step
  // keeps its carrier, so checkout eligibility can evaluate it once
  // IOS_COMING_SOON is off (before 061 it was always NULL → unverified →
  // no iPhone customer could ever pay).
  await db.query(
    `select public.set_household_carrier_compatibility($1, $2, $3, $4)`,
    [householdId, 'iphone', 'o2', 'pay_monthly']
  );
  const { rows: [iphoneWithCarrier] } = await db.query(
    `select device_type, carrier_provider_key, carrier_tariff_type from public.households where id = $1`,
    [householdId]
  );
  assert(
    iphoneWithCarrier.device_type === 'iphone' && iphoneWithCarrier.carrier_provider_key === 'o2' && iphoneWithCarrier.carrier_tariff_type === 'pay_monthly',
    'migration 065: an iPhone household stores the carrier and tariff it is given (was always NULL under 041)'
  );
  await db.query(
    `select public.set_household_carrier_compatibility($1, $2, $3, $4)`,
    [householdId, 'landline', 'bt', 'ignored']
  );
  const { rows: [landlineAfter061] } = await db.query(
    `select carrier_provider_key, carrier_tariff_type from public.households where id = $1`,
    [householdId]
  );
  assert(landlineAfter061.carrier_provider_key === 'bt' && landlineAfter061.carrier_tariff_type === null, 'migration 065 leaves landline unchanged (043): provider persisted, tariff cleared');
  await db.query(
    `select public.set_household_carrier_compatibility($1, $2, $3, $4)`,
    [householdId, 'iphone', null, null]
  );

  // reset role (the full bootstrap superuser, same technique the
  // SECURITY DEFINER grant-check section below already relies on) —
  // service_role itself has no direct UPDATE grant on households at all
  // (every real mutation goes through a SECURITY DEFINER RPC instead),
  // so proving the CHECK constraint's own shape needs a role that can
  // attempt a raw write in the first place.
  await db.exec('reset role;');

  let iphoneCheckConstraintAcceptedAfterMigration041 = true;
  try {
    await db.query(`update public.households set device_type = 'iphone' where id = $1`, [householdId]);
  } catch {
    iphoneCheckConstraintAcceptedAfterMigration041 = false;
  }
  assert(iphoneCheckConstraintAcceptedAfterMigration041, 'after migration 041, the CHECK constraint itself permits device_type = iphone via a direct write too, not just through the RPC');

  let invalidDeviceTypeStillRejectedAfterMigration041 = false;
  try {
    await db.query(`update public.households set device_type = 'tablet' where id = $1`, [householdId]);
  } catch {
    invalidDeviceTypeStillRejectedAfterMigration041 = true;
  }
  assert(invalidDeviceTypeStillRejectedAfterMigration041, 'the CHECK constraint still rejects a genuinely invalid value after migration 041 — widening to iphone did not accidentally open the constraint up entirely');

  await asServiceRole(db);

  // Switching iphone -> mobile requires a fresh, real carrier selection,
  // same as landline -> mobile already does.
  await db.query(
    `select public.set_household_carrier_compatibility($1, $2, $3, $4)`,
    [householdId, 'mobile', 'o2', null]
  );
  const { rows: [afterSwitchBackFromIphone] } = await db.query(
    `select device_type, carrier_provider_key from public.households where id = $1`,
    [householdId]
  );
  assert(
    afterSwitchBackFromIphone.device_type === 'mobile' && afterSwitchBackFromIphone.carrier_provider_key === 'o2',
    'switching from iphone back to mobile persists the newly-supplied provider correctly'
  );

  // --- 042: waiting_list_signups (IOS_COMING_SOON / unsupported-carrier
  // waiting list, 2026-09-19) — already applied by the bulk migration
  // loop at the top of this file; this section tests it directly. ---
  const { rows: [insertedSignup] } = await db.query(
    `insert into public.waiting_list_signups (email, reason, provider_key, device_type) values ($1, $2, $3, $4) returning id, email, reason, provider_key, device_type`,
    ['waitlist-test@example.com', 'ios_coming_soon', null, 'iphone']
  );
  assert(
    insertedSignup.email === 'waitlist-test@example.com' && insertedSignup.reason === 'ios_coming_soon' && insertedSignup.device_type === 'iphone',
    'service_role can insert a waiting-list signup with the exact fields supplied'
  );

  const { rows: [carrierSignup] } = await db.query(
    `insert into public.waiting_list_signups (email, reason, provider_key) values ($1, $2, $3) returning provider_key`,
    ['carrier-waitlist-test@example.com', 'unsupported_carrier', 'tesco']
  );
  assert(carrierSignup.provider_key === 'tesco', 'a waiting-list signup can independently record an unsupported-carrier reason with its provider key');

  await asAuthUser(db, userId2, 'waitlist-rls-test@example.com');
  let authenticatedWaitingListInsertDenied = false;
  try {
    await db.query(`insert into public.waiting_list_signups (email, reason) values ($1, $2)`, ['should-fail@example.com', 'ios_coming_soon']);
  } catch {
    authenticatedWaitingListInsertDenied = true;
  }
  assert(authenticatedWaitingListInsertDenied, 'authenticated role cannot insert into waiting_list_signups directly — every real signup goes through the service-role-mediated backend route, matching every other unauthenticated-capture table in this project');

  let authenticatedWaitingListSelectDenied = false;
  try {
    await db.query(`select * from public.waiting_list_signups limit 1`);
  } catch {
    authenticatedWaitingListSelectDenied = true;
  }
  assert(authenticatedWaitingListSelectDenied, 'authenticated role cannot read waiting_list_signups directly either — no customer or dashboard code path can enumerate other people\'s waiting-list signups');

  await asServiceRole(db);

  // --- 051: financial_entries + telephony_call_legs (financial ledger core) ---
  //
  // The constraints ARE the ledger's trust guarantees (absence of a charge is
  // never a zero; allocated/estimated rows can't pass as provider-actual;
  // costs are always classified), so each one is exercised directly.
  await db.exec('reset role;');
  const { rows: [ledgerHousehold] } = await db.query(
    `insert into public.households (auth_user_id, email) values (null, $1) returning id`,
    ['ledger-test@example.com']
  );
  const { rows: [ledgerCall] } = await db.query(
    `insert into public.calls (household_id, call_sid, number, status, result)
     values ($1, 'CA_ledger_parent', 'redacted', 'Known', 'SAFE') returning id`,
    [ledgerHousehold.id]
  );

  async function rejects(sql, params, message) {
    try {
      await db.query(sql, params);
      assert(false, message);
    } catch (err) {
      assert(true, `${message} (${err.message.split('\n')[0]})`);
    }
  }

  await asServiceRole(db);
  const { rows: [leg] } = await db.query(
    `insert into public.telephony_call_legs
       (provider, provider_account_ref, provider_call_id, leg_type, provider_direction, provider_status,
        call_id, household_id, household_match, provider_duration_seconds, billing_model,
        billing_increment_seconds, billed_quantity, billed_unit, reconciliation_status, finalised_at, provider_evidence)
     values ('twilio', 'AC_test', 'CA_ledger_parent', 'inbound_pstn', 'inbound', 'completed',
             $1, $2, 'via_call', 239, 'per_started_minute', 60, 4, 'minute', 'final', now(),
             '{"price": "-0.03023", "price_unit": "GBP"}')
     returning id`,
    [ledgerCall.id, ledgerHousehold.id]
  );
  assert(!!leg.id, '051: service_role can record a provider call leg with native billed duration and evidence');

  await rejects(
    `insert into public.telephony_call_legs (provider, provider_call_id, leg_type) values ('twilio', 'CA_ledger_parent', 'inbound_pstn')`,
    [],
    '051: the same provider call id cannot be recorded twice'
  );
  await rejects(
    `insert into public.telephony_call_legs (provider, provider_call_id, leg_type) values ('Twilio!', 'CA_x', 'inbound_pstn')`,
    [],
    '051: provider must be a lower-case slug (no free-form supplier names)'
  );

  const entryCols = `(source_system, supplier, entry_key, entry_class, category, cost_class, billing_model,
                      provenance, charge_observation, reconciliation_status, finalised_at,
                      native_amount, native_currency, native_quantity, native_unit, amount,
                      household_id, call_id, telephony_leg_id, allocation_basis, source_reference,
                      period_start, period_end)`;
  const entrySql = `insert into public.financial_entries ${entryCols}
                    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`;
  const entry = (o) => [
    o.source_system ?? 'twilio', o.supplier ?? 'twilio', o.entry_key, o.entry_class ?? 'cost', o.category ?? 'inbound_voice',
    o.cost_class === undefined ? 'variable_direct' : o.cost_class, o.billing_model ?? 'per_started_minute',
    o.provenance ?? 'provider_actual', o.charge_observation === undefined ? 'reported_amount' : o.charge_observation,
    o.reconciliation_status ?? 'provisional', o.finalised_at ?? null,
    o.native_amount === undefined ? -0.03023 : o.native_amount, o.native_currency === undefined ? 'GBP' : o.native_currency,
    o.native_quantity ?? null, o.native_unit ?? null, o.amount === undefined ? 0.03023 : o.amount,
    o.household_id === undefined ? ledgerHousehold.id : o.household_id, o.call_id ?? null,
    o.telephony_leg_id === undefined ? leg.id : o.telephony_leg_id, o.allocation_basis ?? null, o.source_reference ?? null,
    o.period_start ?? null, o.period_end ?? null,
  ];

  await db.query(entrySql, entry({ entry_key: 'CA_ledger_parent:inbound_voice', native_quantity: 4, native_unit: 'minute' }));
  const { rows: [stored] } = await db.query(
    `select native_amount, native_currency, amount from public.financial_entries where entry_key = 'CA_ledger_parent:inbound_voice'`
  );
  assert(
    Number(stored.native_amount) === -0.03023 && stored.native_currency === 'GBP' && Number(stored.amount) === 0.03023,
    '051: supplier-native signed amount and currency are preserved verbatim alongside the sign-normalised amount'
  );
  await rejects(entrySql, entry({ entry_key: 'CA_ledger_parent:inbound_voice' }),
    '051: the same (source_system, entry_key) cannot be recorded twice (idempotency)');

  await db.query(entrySql, entry({
    entry_key: 'CA_child:app_leg:not_observed', category: 'app_leg', charge_observation: 'not_observed',
    native_amount: null, amount: null, native_currency: null, reconciliation_status: 'final', finalised_at: new Date().toISOString(),
  }));
  assert(true, '051: "no charge observed after reconciliation" is recordable WITHOUT an amount');
  await rejects(entrySql, entry({
    entry_key: 'CA_child:app_leg:fake_zero', category: 'app_leg', charge_observation: 'not_observed', native_amount: 0, amount: 0,
  }), '051: a not_observed charge can never be stored as £0');
  await rejects(entrySql, entry({
    entry_key: 'CA_child:app_leg:pending_zero', category: 'app_leg', charge_observation: 'pending', native_amount: null, amount: 0,
  }), '051: a pending charge can never carry an amount');
  await rejects(entrySql, entry({
    entry_key: 'CA_child:app_leg:unavailable_amt', category: 'app_leg', charge_observation: 'unavailable', native_amount: -0.01, amount: 0.01,
  }), '051: an unavailable charge can never carry an amount');
  await db.query(entrySql, entry({
    entry_key: 'CA_child:app_leg:reported_zero', category: 'app_leg', charge_observation: 'reported_zero', native_amount: 0, amount: 0,
  }));
  assert(true, '051: a supplier-reported explicit zero is recordable as zero');
  await rejects(entrySql, entry({
    entry_key: 'CA_child:app_leg:bad_zero', category: 'app_leg', charge_observation: 'reported_zero', native_amount: 0, amount: 0.01,
  }), '051: a reported_zero row must actually be zero');
  await rejects(entrySql, entry({
    entry_key: 'CA_x:no_observation', charge_observation: null,
  }), '051: a provider_actual row must state what the provider reported');

  await rejects(entrySql, entry({
    entry_key: 'media:alloc:no_source', category: 'media_stream', provenance: 'provider_allocated', charge_observation: null,
    native_amount: null, amount: 0.01663, allocation_basis: 'daily total apportioned by stream seconds', source_reference: null,
  }), '051: an allocated charge must cite the provider aggregate it was apportioned from');
  await db.query(entrySql, entry({
    entry_key: 'usage:calls-media-stream-minutes:2026-09-19:CA_ledger_parent', category: 'media_stream',
    provenance: 'provider_allocated', charge_observation: null, native_amount: null, amount: 0.01663,
    allocation_basis: 'daily total apportioned by stream seconds', source_reference: 'twilio usage calls-media-stream-minutes 2026-09-19',
  }));
  const { rows: [alloc] } = await db.query(
    `select provenance, charge_observation from public.financial_entries where entry_key like 'usage:calls-media-stream-minutes:%'`
  );
  assert(alloc.provenance === 'provider_allocated' && alloc.charge_observation === null,
    '051: an allocated daily Media Stream charge is stored as provider_allocated with no provider observation — it cannot pass as a per-call provider charge');
  await rejects(entrySql, entry({
    entry_key: 'media:estimate:with_observation', category: 'media_stream', provenance: 'estimated', charge_observation: 'reported_amount',
    allocation_basis: 'ceil(stream_seconds/60) × rate',
  }), '051: an estimated row cannot claim a provider observation');
  await rejects(entrySql, entry({
    entry_key: 'media:estimate:no_basis', category: 'media_stream', provenance: 'estimated', charge_observation: null,
    native_amount: null, amount: 0.0183,
  }), '051: an estimated row must state how it was calculated');

  await rejects(entrySql, entry({ entry_key: 'cost:no_class', cost_class: null }),
    '051: every cost must carry a cost class');
  await rejects(entrySql, entry({
    entry_key: 'revenue:with_class', entry_class: 'revenue', category: 'subscription', cost_class: 'variable_direct',
    source_system: 'stripe', supplier: 'stripe', telephony_leg_id: null,
  }), '051: revenue never carries a cost class');

  await db.query(entrySql, entry({
    entry_key: 'channels:2026-10', source_system: 'telnyx', supplier: 'telnyx', category: 'channel_capacity',
    cost_class: 'semi_variable', billing_model: 'per_channel', provenance: 'provider_actual', charge_observation: 'reported_amount',
    native_amount: 150, native_currency: 'USD', native_quantity: 10, native_unit: 'channel-month', amount: 150,
    household_id: null, telephony_leg_id: null, period_start: '2026-10-01T00:00:00Z', period_end: '2026-11-01T00:00:00Z',
  }));
  assert(true, '051: channel-based (per_channel, period, no leg, USD) pricing fits without schema change');
  await db.query(entrySql, entry({
    entry_key: 'schedule:railway:2026-09', source_system: 'manual', supplier: 'railway', category: 'hosting',
    cost_class: 'fixed_overhead', billing_model: 'fixed_period', provenance: 'manual', charge_observation: null,
    native_amount: null, native_currency: 'USD', amount: 20, household_id: null, telephony_leg_id: null,
    allocation_basis: 'monthly invoice entered manually', period_start: '2026-09-01T00:00:00Z', period_end: '2026-10-01T00:00:00Z',
  }));
  assert(true, '051: a manually entered overhead cost fits the same ledger');
  await rejects(entrySql, entry({
    entry_key: 'period:backwards', period_start: '2026-10-01T00:00:00Z', period_end: '2026-09-01T00:00:00Z',
  }), '051: a period must end after it starts');

  // --- 051 reporting views (the dashboard's read interface) ---
  await asServiceRole(db);
  await db.query(entrySql, entry({
    entry_key: 'stripe:rev:1', source_system: 'stripe', supplier: 'stripe', entry_class: 'revenue', category: 'subscription',
    cost_class: null, billing_model: 'fixed_period', native_amount: 4.99, native_currency: 'GBP', amount: 4.99, telephony_leg_id: null,
  }));
  await db.query(entrySql, entry({
    entry_key: 'openai:est:1', source_system: 'hcg', supplier: 'openai', category: 'transcription', provenance: 'estimated',
    charge_observation: null, native_amount: null, native_currency: 'USD', amount: 0.0295, telephony_leg_id: null,
    allocation_basis: 'HCG estimate: monitored seconds × list price',
  }));
  const { rows: rep } = await db.query(
    `select entry_key, dashboard_bucket, amount_quality, is_unallocated, signed_amount from public.finance_entries_reporting order by entry_key`
  );
  const by = Object.fromEntries(rep.map((r) => [r.entry_key, r]));
  assert(by['CA_ledger_parent:inbound_voice'].dashboard_bucket === 'telephony' && by['CA_ledger_parent:inbound_voice'].amount_quality === 'ACTUAL'
      && Number(by['CA_ledger_parent:inbound_voice'].signed_amount) === -0.03023,
    '051 view: a priced Twilio leg is telephony / ACTUAL with a negative signed amount');
  assert(by['CA_child:app_leg:not_observed'].amount_quality === 'UNKNOWN' && by['CA_child:app_leg:not_observed'].signed_amount === null,
    '051 view: an unobserved charge is UNKNOWN with no amount (never shown as £0)');
  assert(by['usage:calls-media-stream-minutes:2026-09-19:CA_ledger_parent'].amount_quality === 'ALLOCATED', '051 view: an allocated share is ALLOCATED');
  assert(by['openai:est:1'].dashboard_bucket === 'ai_transcription' && by['openai:est:1'].amount_quality === 'ESTIMATED', '051 view: a transcription estimate is ai_transcription / ESTIMATED');
  assert(by['schedule:railway:2026-09'].dashboard_bucket === 'infrastructure' && by['schedule:railway:2026-09'].amount_quality === 'MANUAL'
      && by['schedule:railway:2026-09'].is_unallocated === true, '051 view: manual hosting cost is infrastructure / MANUAL / unallocated');
  assert(by['stripe:rev:1'].dashboard_bucket === 'revenue' && Number(by['stripe:rev:1'].signed_amount) === 4.99 && by['stripe:rev:1'].is_unallocated === false,
    '051 view: revenue is positive and never counted as unallocated cost');
  const { rows: contrib } = await db.query(`select native_currency, revenue, direct_service_costs, contribution, unknown_items from public.finance_monthly_contribution order by native_currency`);
  const usdRow = contrib.filter((r) => r.native_currency === 'USD');
  const nullRows = contrib.filter((r) => r.native_currency === null);
  const gbpRows = contrib.filter((r) => r.native_currency === 'GBP');
  assert(usdRow.some((r) => Number(r.direct_service_costs) === -0.0295) && usdRow.every((r) => Number(r.revenue) === 0)
      && gbpRows.length === 1 && Number(gbpRows[0].revenue) === 4.99 && Number(gbpRows[0].direct_service_costs) === -0.04686,
    '051 contribution view keeps each currency on its own row (USD transcription and USD channel fees never added to GBP)');
  assert(nullRows.every((r) => Number(r.revenue) === 0 && Number(r.direct_service_costs) === 0 && Number(r.unknown_items) > 0),
    '051 contribution view: items with no amount (UNKNOWN) have no currency, carry no money and are counted as unknown_items');
  const { rows: [summaryCount] } = await db.query(`select count(*)::int as n from public.finance_monthly_summary`);
  assert(summaryCount.n > 0, '051 monthly summary view returns grouped rows');

  await asAuthUser(db, userId, 'a@example.com');
  await rejects(`select count(*) from public.finance_entries_reporting`, [], '051: authenticated users cannot read the reporting views');
  await rejects(`select count(*) from public.finance_monthly_contribution`, [], '051: authenticated users cannot read the contribution view');
  await db.exec('reset role; set role anon;');
  await rejects(`select count(*) from public.finance_monthly_summary`, [], '051: anon cannot read the reporting views');
  await db.exec('reset role;');
  await db.query(`delete from public.financial_entries where entry_key in ('stripe:rev:1', 'openai:est:1')`);

  await asAuthUser(db, userId, 'a@example.com');
  await rejects(`select count(*) from public.financial_entries`, [], '051: authenticated users cannot read financial_entries');
  await rejects(`select count(*) from public.telephony_call_legs`, [], '051: authenticated users cannot read telephony_call_legs');
  await db.exec('reset role; set role anon;');
  await rejects(`select count(*) from public.financial_entries`, [], '051: anon cannot read financial_entries');

  await db.exec('reset role;');
  await rejects(`delete from public.telephony_call_legs where id = $1`, [leg.id],
    '051: a leg with money recorded against it cannot be deleted out from under the ledger');
  await db.query(`delete from public.calls where id = $1`, [ledgerCall.id]);
  await db.query(`delete from public.households where id = $1`, [ledgerHousehold.id]);
  const { rows: [legAfter] } = await db.query(`select household_id, call_id from public.telephony_call_legs where id = $1`, [leg.id]);
  const { rows: [entryAfter] } = await db.query(
    `select household_id, amount from public.financial_entries where entry_key = 'CA_ledger_parent:inbound_voice'`
  );
  assert(legAfter.household_id === null && legAfter.call_id === null && entryAfter.household_id === null && Number(entryAfter.amount) === 0.03023,
    '051: deleting a household or call keeps the cost history (links set null, amounts intact)');
  const { rows: callIdx } = await db.query(
    `select 1 from pg_indexes where schemaname = 'public' and tablename = 'financial_entries' and indexdef like '%(call_id)%'`);
  assert(callIdx.length === 1, '051: financial_entries.call_id (the calls FK) is indexed, so call deletion never scans the ledger');

  // Rollback, then re-apply: the rollback removes exactly the 051 objects and
  // the migration applies cleanly again afterwards.
  await db.exec(await readFile(path.join(migrationsDir, '_rollbacks', '051_rollback_financial_ledger_and_telephony_usage.sql'), 'utf8'));
  const { rows: [gone] } = await db.query(`select to_regclass('public.financial_entries') as fe, to_regclass('public.telephony_call_legs') as tl,
    to_regclass('public.finance_entries_reporting') as v, to_regclass('public.calls') as calls`);
  assert(gone.fe === null && gone.tl === null && gone.v === null && gone.calls !== null,
    '051 rollback: drops the ledger tables and views and nothing else');
  await db.exec(await readFile(path.join(migrationsDir, '051_financial_ledger_and_telephony_usage.sql'), 'utf8'));
  const { rows: [back] } = await db.query(`select to_regclass('public.financial_entries') as fe, to_regclass('public.finance_monthly_contribution') as v`);
  assert(back.fe !== null && back.v !== null, '051: re-applies cleanly after rollback');
  await asServiceRole(db);

  // --- 047: number release must never take a number from an entitled household ---
  //
  // Replays the real 2026-09-23 failure (production household 30f01a7a):
  // a Stripe test subscription was cancelled (release scheduled +30 days),
  // an open-ended complimentary entitlement was then granted through a path
  // that didn't cancel the schedule, and the daily job released the number
  // from the now-entitled household. Every scenario runs against the real
  // migration functions; fixtures are seeded as the bootstrap superuser.
  {
    let seq = 0;
    async function lifecycleHousehold(label) {
      await db.exec('reset role;');
      seq += 1;
      const number = `+4417000049${String(seq).padStart(2, '0')}`;
      const { rows: [h] } = await db.query(
        `insert into public.households (auth_user_id, email, twilio_number, twilio_provisioning_status)
         values (null, $1, $2, 'active') returning id`,
        [`lifecycle-${label}@example.com`, number]
      );
      return { id: h.id, number };
    }
    async function addEntitlement(householdId, { type = 'paid_subscription', status = 'active', startsAt = "now() - interval '40 days'", endsAt = null, source = 'stripe' } = {}) {
      await db.exec('reset role;');
      const { rows: [e] } = await db.query(
        `insert into public.entitlements (household_id, entitlement_type, status, starts_at, ends_at, source)
         values ($1, $2, $3, ${startsAt}, ${endsAt || 'null'}, $4) returning id`,
        [householdId, type, status, source]
      );
      return e.id;
    }
    async function expireEntitlement(id, endsAt = "now() - interval '35 days'") {
      await db.exec('reset role;');
      await db.query(`update public.entitlements set status = 'expired', ends_at = ${endsAt} where id = $1`, [id]);
    }
    async function household(id) {
      await db.exec('reset role;');
      const { rows: [h] } = await db.query(
        `select twilio_number, twilio_number_pending_release_at, twilio_provisioning_status from public.households where id = $1`, [id]
      );
      return h;
    }
    async function asService(sql, params) {
      await asServiceRole(db);
      const { rows: [r] } = await db.query(sql, params);
      return r;
    }
    const mark = (id) => asService(`select public.mark_household_twilio_number_pending_release($1, interval '30 days') as ok`, [id]);
    const release = (id, n) => asService(`select public.release_household_twilio_number($1, $2) as ok`, [id, n]);
    const releaseNow = (id) => asService(`select public.release_household_twilio_number_immediately($1) as released`, [id]);
    const blocks = (id) => asService(`select public.household_blocks_number_release($1) as blocked`, [id]);
    async function forcePendingInPast(id) {
      await db.exec('reset role;');
      await db.query(`update public.households set twilio_number_pending_release_at = now() - interval '1 day' where id = $1`, [id]);
    }

    // (a) #8 as it actually existed in production: complimentary entitlement
    //     in force AND a stale pending release already past its deadline
    //     (state created before this migration). The release must refuse,
    //     keep the number and clear the stale schedule.
    {
      const h = await lifecycleHousehold('n8-legacy-state');
      const paid = await addEntitlement(h.id);
      await expireEntitlement(paid);
      await addEntitlement(h.id, { type: 'complimentary', source: 'admin_manual', startsAt: "now() - interval '30 days'" });
      await forcePendingInPast(h.id); // the stale schedule, exactly as found in production
      const r = await release(h.id, h.number);
      const after = await household(h.id);
      assert(r.ok === false, '047 #8 replay (legacy state): release refuses while an open-ended complimentary entitlement is in force');
      assert(after.twilio_number === h.number && after.twilio_provisioning_status === 'active', '047 #8 replay: the entitled household keeps its number');
      assert(after.twilio_number_pending_release_at === null, '047 #8 replay: the stale release schedule is cancelled, so it cannot fire later');
    }

    // (b) #8 in real event order: cancellation → schedule → complimentary
    //     grant → deadline passes → daily job. The grant itself now cancels
    //     the schedule (trigger), and the release re-check is a second wall.
    {
      const h = await lifecycleHousehold('n8-event-order');
      const paid = await addEntitlement(h.id);
      await expireEntitlement(paid);
      const scheduled = await mark(h.id);
      assert(scheduled.ok === true, '047 #8 event order: the Stripe cancellation schedules a release (no other entitlement yet)');
      await addEntitlement(h.id, { type: 'complimentary', source: 'admin_manual', startsAt: 'now()' });
      const afterGrant = await household(h.id);
      assert(afterGrant.twilio_number_pending_release_at === null, '047 #8 event order: granting the complimentary entitlement cancels the pending release immediately (any grant path, via trigger)');
      await forcePendingInPast(h.id); // even if something re-set it, the release still refuses
      const r = await release(h.id, h.number);
      assert(r.ok === false && (await household(h.id)).twilio_number === h.number, '047 #8 event order: the daily release job cannot take the number from the entitled household');
    }

    // (b2) The grant arrives through the real application role (service_role,
    //      e.g. the admin grant endpoint / invite redemption), which has no
    //      UPDATE on households — the trigger must still cancel the schedule.
    {
      const h = await lifecycleHousehold('grant-as-service-role');
      const paid = await addEntitlement(h.id);
      await expireEntitlement(paid);
      assert((await mark(h.id)).ok === true, '047 service-role grant: release scheduled after cancellation');
      await asServiceRole(db);
      await db.query(
        `insert into public.entitlements (household_id, entitlement_type, status, starts_at, source) values ($1, 'complimentary', 'active', now(), 'admin_manual')`,
        [h.id]
      );
      assert((await household(h.id)).twilio_number_pending_release_at === null,
        '047 service-role grant: an entitlement inserted by service_role cancels the pending release (trigger runs with definer rights)');
    }

    // (c) A cancellation of one entitlement must not even schedule a release
    //     while another entitlement covers the household (reverse order).
    {
      const h = await lifecycleHousehold('reverse-order');
      await addEntitlement(h.id, { type: 'complimentary', source: 'admin_manual', startsAt: "now() - interval '1 day'" });
      const r = await mark(h.id);
      assert(r.ok === false && (await household(h.id)).twilio_number_pending_release_at === null,
        '047: a late cancellation event cannot schedule a release while a current entitlement exists');
    }

    // (d) Normal cancellation still works end to end.
    {
      const h = await lifecycleHousehold('normal-cancel');
      const paid = await addEntitlement(h.id);
      await expireEntitlement(paid);
      assert((await mark(h.id)).ok === true, '047 normal cancellation: release is scheduled');
      const early = await release(h.id, h.number);
      assert(early.ok === false, '047 normal cancellation: nothing is released before the grace period ends');
      await forcePendingInPast(h.id);
      const r = await release(h.id, h.number);
      const after = await household(h.id);
      assert(r.ok === true && after.twilio_number === null && after.twilio_provisioning_status === 'pending',
        '047 normal cancellation: after the grace period the number is released (unchanged behaviour)');
    }

    // (e) Re-subscribing during the grace period keeps the number.
    {
      const h = await lifecycleHousehold('resubscribe');
      const paid = await addEntitlement(h.id);
      await expireEntitlement(paid);
      await mark(h.id);
      await addEntitlement(h.id, { startsAt: 'now()' });
      assert((await household(h.id)).twilio_number_pending_release_at === null, '047 resubscribe during grace: the new subscription cancels the pending release');
      await forcePendingInPast(h.id);
      assert((await release(h.id, h.number)).ok === false && (await household(h.id)).twilio_number === h.number,
        '047 resubscribe during grace: the number is kept');
    }

    // (f) Complimentary expiry by date: while in force it blocks; once its
    //     end date has passed it no longer blocks, so the lifecycle can proceed.
    {
      const live = await lifecycleHousehold('comp-live');
      await addEntitlement(live.id, { type: 'complimentary', source: 'admin_manual', startsAt: "now() - interval '5 days'", endsAt: "now() + interval '10 days'" });
      assert((await blocks(live.id)).blocked === true, '047 complimentary with a future end date blocks release');
      assert((await mark(live.id)).ok === false, '047 complimentary in force: no release can be scheduled');

      const ended = await lifecycleHousehold('comp-ended');
      await addEntitlement(ended.id, { type: 'complimentary', source: 'admin_manual', startsAt: "now() - interval '20 days'", endsAt: "now() - interval '1 day'" });
      assert((await blocks(ended.id)).blocked === false, '047 complimentary whose end date has passed (status still "active") no longer blocks release');
      assert((await mark(ended.id)).ok === true, '047 date-expired complimentary: a release can be scheduled (the daily sweep that does this automatically is Step 2)');
    }

    // (g) Extending an entitlement's end date also cancels a pending release.
    {
      const h = await lifecycleHousehold('extend');
      const comp = await addEntitlement(h.id, { type: 'complimentary', source: 'admin_manual', startsAt: "now() - interval '20 days'", endsAt: "now() - interval '1 day'" });
      assert((await mark(h.id)).ok === true, '047 extend: an ended complimentary household is scheduled for release');
      await db.exec('reset role;');
      await db.query(`update public.entitlements set ends_at = now() + interval '30 days' where id = $1`, [comp]);
      assert((await household(h.id)).twilio_number_pending_release_at === null, '047 extend: extending the end date cancels the pending release');
    }

    // (h) Scheduled (upcoming) entitlements protect the number; revoked and
    //     expired ones don't.
    {
      const up = await lifecycleHousehold('scheduled');
      await addEntitlement(up.id, { status: 'scheduled', startsAt: "now() + interval '2 days'" });
      assert((await blocks(up.id)).blocked === true, '047 an upcoming (scheduled) entitlement blocks release');
      const rev = await lifecycleHousehold('revoked');
      await addEntitlement(rev.id, { type: 'complimentary', status: 'revoked', source: 'admin_manual', startsAt: "now() - interval '3 days'" });
      assert((await blocks(rev.id)).blocked === false, '047 a revoked entitlement does not block release');
    }

    // (h2) Property test over every membership shape: "currently entitled"
    //      must equal /voice's rule exactly (database/billing.js
    //      getActiveEntitlement: status active, starts_at <= now, not
    //      ended); everything /voice accepts must block release; and an
    //      upcoming membership blocks release WITHOUT being currently
    //      entitled (so it never grants /voice access early).
    {
      const statuses = ['active', 'scheduled', 'expired', 'revoked'];
      const starts = { past: "now() - interval '5 days'", future: "now() + interval '5 days'" };
      const ends = { open: null, ended: "now() - interval '1 day'", later: "now() + interval '10 days'" };
      let combos = 0;
      let voiceAccepted = 0;
      let upcomingSeen = 0;
      const mismatches = [];
      for (const status of statuses) {
        for (const [startKey, startSql] of Object.entries(starts)) {
          for (const [endKey, endSql] of Object.entries(ends)) {
            if (startKey === 'future' && endKey === 'ended') continue; // ends_at > starts_at constraint
            const h = await lifecycleHousehold(`prop-${status}-${startKey}-${endKey}`);
            await addEntitlement(h.id, { status, startsAt: startSql, endsAt: endSql, type: 'complimentary', source: 'admin_manual' });
            const voice = status === 'active' && startKey === 'past' && endKey !== 'ended';
            const upcoming = (status === 'scheduled' || (status === 'active' && startKey === 'future')) && endKey !== 'ended';
            await asServiceRole(db);
            const { rows: [r] } = await db.query(
              `select public.household_is_currently_entitled($1) as cur,
                      public.household_has_upcoming_entitlement($1) as up,
                      public.household_blocks_number_release($1) as blocks`,
              [h.id]
            );
            combos += 1;
            if (voice) voiceAccepted += 1;
            if (upcoming) upcomingSeen += 1;
            const shape = `${status}/${startKey}/${endKey}`;
            if (r.cur !== voice) mismatches.push(`${shape}: currently_entitled=${r.cur} but /voice=${voice}`);
            if (voice && !r.blocks) mismatches.push(`${shape}: /voice accepts but release NOT blocked`);
            if (r.up !== upcoming) mismatches.push(`${shape}: upcoming=${r.up} expected ${upcoming}`);
            if (upcoming && (!r.blocks || r.cur)) mismatches.push(`${shape}: upcoming must block without being currently entitled`);
            if (!voice && !upcoming && r.blocks) mismatches.push(`${shape}: neither current nor upcoming but blocks`);
          }
        }
      }
      const detail = mismatches.length ? ` — MISMATCHES: ${mismatches.join('; ')}` : '';
      assert(mismatches.length === 0,
        `047 property: across ${combos} membership shapes, household_is_currently_entitled equals /voice's rule exactly${detail}`);
      assert(voiceAccepted > 0 && mismatches.length === 0,
        `047 property: every one of the ${voiceAccepted} shape(s) /voice accepts blocks number release`);
      assert(upcomingSeen > 0 && mismatches.length === 0,
        `047 property: all ${upcomingSeen} upcoming shape(s) block release without granting /voice-level entitlement`);
      assert(mismatches.length === 0, '047 property: expired, revoked and ended memberships neither entitle nor block');
    }

    // (i) Immediate (account-deletion) release respects the same guard.
    {
      const h = await lifecycleHousehold('deletion-entitled');
      await addEntitlement(h.id, { type: 'complimentary', source: 'admin_manual', startsAt: "now() - interval '1 day'" });
      const r = await releaseNow(h.id);
      assert(r.released === null && (await household(h.id)).twilio_number === h.number, '047 immediate release refuses while the household is still entitled');
      const d = await lifecycleHousehold('deletion-revoked');
      const comp = await addEntitlement(d.id, { type: 'complimentary', source: 'admin_manual', startsAt: "now() - interval '1 day'" });
      await db.exec('reset role;');
      await db.query(`update public.entitlements set status = 'revoked' where id = $1`, [comp]);
      const r2 = await releaseNow(d.id);
      assert(r2.released === d.number && (await household(d.id)).twilio_number === null, '047 immediate release proceeds once deletion has revoked the entitlement');
    }

    // (j) The guard is service-role only.
    await asAuthUser(db, userId, 'a@example.com');
    let authDenied = false;
    try { await db.query(`select public.household_blocks_number_release($1)`, [householdId]); } catch { authDenied = true; }
    assert(authDenied, '047 authenticated users cannot call household_blocks_number_release');
    await db.exec('reset role; set role anon;');
    let anonDenied = false;
    try { await db.query(`select public.household_blocks_number_release($1)`, [householdId]); } catch { anonDenied = true; }
    assert(anonDenied, '047 anon cannot call household_blocks_number_release');
    await asServiceRole(db);
  }

  // --- SECURITY DEFINER grant/search_path/owner policy, checked dynamically ---
  //
  // Discovers every SECURITY DEFINER function in public from pg_proc
  // itself (prosecdef = true), not a hardcoded name list — a future
  // migration that adds a new one is covered automatically, without this
  // file needing an edit. Enforces the fail-closed convention migration
  // 022 establishes: PUBLIC/anon/authenticated get nothing, service_role
  // must be explicit, search_path must be pinned, owner must be the
  // project's administrative role.
  //
  // Important limitation, stated plainly: PGlite never reproduces
  // Supabase's platform default-privilege behavior (the actual root cause
  // of the anon/authenticated exposure found on staging — see
  // docs/engineering/MIGRATION_RECOVERY_PLAN.md) — there is no phantom
  // default grant here to accidentally pass against. This check catches a
  // *future migration* that forgets its own revoke/grant lines; it cannot
  // catch a live Supabase project's default-ACL configuration diverging
  // from what every migration assumes. That real-database check is
  // scripts/verify-security-definer-grants.js, run against staging/
  // production directly — this test and that script are deliberately
  // complementary, not redundant.
  console.log('\nChecking SECURITY DEFINER grant/search_path/owner policy...\n');
  // information_schema.role_routine_grants only shows grants visible to
  // the *current* role (as grantee, grantor, or a role it's a member of)
  // — the preceding check left the session as `authenticated`, under
  // which service_role's own grants are invisible, not absent. Reset to
  // the full-visibility bootstrap role before reading grants for real.
  await db.exec('reset role;');
  const ADMIN_OWNER = 'postgres';
  const { rows: secdefFns } = await db.query(`
    select p.proname, pg_get_function_identity_arguments(p.oid) as args,
           pg_get_userbyid(p.proowner) as owner, p.proconfig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef = true
    order by p.proname;
  `);
  assert(secdefFns.length > 0, 'at least one SECURITY DEFINER function exists to check (sanity check on the check itself)');

  for (const fn of secdefFns) {
    const label = `${fn.proname}(${fn.args})`;

    const { rows: grants } = await db.query(
      `select grantee, privilege_type from information_schema.role_routine_grants
       where routine_schema = 'public' and routine_name = $1`,
      [fn.proname]
    );
    const grantees = new Set(grants.map((g) => g.grantee));

    assert(!grantees.has('PUBLIC'), `${label}: PUBLIC has no EXECUTE`);
    assert(!grantees.has('anon'), `${label}: anon has no EXECUTE`);
    assert(!grantees.has('authenticated'), `${label}: authenticated has no EXECUTE`);
    assert(grantees.has('service_role'), `${label}: service_role has EXECUTE`);

    const searchPathEntry = (fn.proconfig || []).find((c) => c.startsWith('search_path='));
    assert(
      searchPathEntry === 'search_path=""' || searchPathEntry === "search_path=",
      `${label}: search_path is safely fixed (empty), found: ${searchPathEntry ?? '<not set>'}`
    );

    assert(fn.owner === ADMIN_OWNER, `${label}: owner is the intended administrative role (${ADMIN_OWNER}), found: ${fn.owner}`);
  }

  // --- RLS coverage + migration 057 (terms_acceptances lockdown) ---
  //
  // Migration 039 shipped terms_acceptances without RLS, relying on "no
  // grants" — false on staging, whose newer Supabase default ACL grants
  // anon/authenticated ALL on every new public table. This harness has no
  // such default ACL, so it cannot reproduce that exposure; what it can do
  // is fail any future migration that creates a public table without RLS,
  // and pin 057's grants so the lockdown can't silently regress.
  console.log('\nChecking RLS coverage and migration 057 (terms_acceptances)...\n');
  await db.exec('reset role;');
  const { rows: noRls } = await db.query(`
    select c.relname from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity
    order by c.relname;
  `);
  assert(noRls.length === 0, `every public table has RLS enabled (missing: ${noRls.map((r) => r.relname).join(', ') || 'none'})`);

  for (const role of ['anon', 'authenticated']) {
    for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) {
      const { rows: [{ has }] } = await db.query(
        `select has_table_privilege($1, 'public.terms_acceptances', $2) as has`, [role, priv]
      );
      assert(!has, `terms_acceptances: ${role} has no ${priv}`);
    }
  }
  for (const [priv, expected] of [['SELECT', true], ['INSERT', true], ['UPDATE', false], ['DELETE', false], ['TRUNCATE', false]]) {
    const { rows: [{ has }] } = await db.query(
      `select has_table_privilege('service_role', 'public.terms_acceptances', $1) as has`, [priv]
    );
    assert(has === expected, `terms_acceptances: service_role ${expected ? 'has' : 'has no'} ${priv} (append-only evidence)`);
  }

  const { rows: [{ id: termsHouseholdId }] } = await db.query(
    `insert into public.households (auth_user_id, email) values (null, $1) returning id`,
    ['terms@example.com']
  );
  await asServiceRole(db);
  const { rows: [{ accepted_at: acceptedAt }] } = await db.query(
    `select public.record_terms_acceptance($1, 'test-terms', 'test-privacy') as accepted_at`, [termsHouseholdId]
  );
  assert(acceptedAt !== null, 'record_terms_acceptance() still inserts via service_role after 057');
  await db.exec('reset role;');
  await db.query(`delete from public.households where id = $1`, [termsHouseholdId]);
  const { rows: [{ n: termsLeft }] } = await db.query(
    `select count(*)::int as n from public.terms_acceptances where household_id = $1`, [termsHouseholdId]
  );
  assert(termsLeft === 0, 'household delete still cascades to terms_acceptances after 057');

  // --- migrations 058/059: least-privilege anon/authenticated table grants ---
  //
  // Runs under the staging-model default ACL set up in BOOTSTRAP_SQL, so a
  // future table that forgets RLS, or a migration that re-grants broadly,
  // fails here instead of shipping an anon-readable table.
  console.log('\nChecking migrations 058/059 (anon/authenticated table grants)...\n');
  await db.exec('reset role;');
  const aclQuery = (roleFilter) => db.query(`
    select c.relname, a.privilege_type
    from pg_class c, aclexplode(c.relacl) a
    where c.relnamespace = 'public'::regnamespace
      and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
      and ${roleFilter}
    order by 1, 2;
  `);
  const { rows: anonGrants } = await aclQuery(`(a.grantee = 0 or a.grantee = 'anon'::regrole)`);
  assert(anonGrants.length === 0,
    `anon/PUBLIC hold no privilege on any public relation (found: ${anonGrants.map((r) => `${r.relname}:${r.privilege_type}`).join(', ') || 'none'})`);

  // 060 removed the unused 008/011 grants on contacts/subscriptions/
  // entitlements — only ensureHouseholdAndRole()'s tables remain.
  const AUTHENTICATED_TABLE_GRANTS = ['households:SELECT', 'user_roles:SELECT'];
  const { rows: authGrants } = await aclQuery(`a.grantee = 'authenticated'::regrole`);
  const authFound = authGrants.map((r) => `${r.relname}:${r.privilege_type}`).sort();
  assert(JSON.stringify(authFound) === JSON.stringify(AUTHENTICATED_TABLE_GRANTS),
    `authenticated table-level grants are exactly the allowlist (found: ${authFound.join(', ')})`);

  const { rows: authColumnGrants } = await db.query(`
    select c.relname || '.' || att.attname || ':' || a.privilege_type as g
    from pg_attribute att
    join pg_class c on c.oid = att.attrelid, aclexplode(att.attacl) a
    where c.relnamespace = 'public'::regnamespace and a.grantee = 'authenticated'::regrole
    order by 1;
  `);
  assert(JSON.stringify(authColumnGrants.map((r) => r.g)) === JSON.stringify([
    'households.auth_user_id:INSERT', 'households.auth_user_id:UPDATE',
    'households.email:INSERT', 'households.email:UPDATE', 'households.status:INSERT',
    'user_roles.auth_user_id:INSERT', 'user_roles.role:INSERT',
  ]), `authenticated column-level grants are exactly what ensureHouseholdAndRole() writes (found: ${authColumnGrants.map((r) => r.g).join(', ')})`);

  const { rows: badDefaults } = await db.query(`
    select d.defaclobjtype, d.defaclacl::text as acl from pg_default_acl d
    where d.defaclrole = 'postgres'::regrole and d.defaclnamespace = 'public'::regnamespace
      and d.defaclacl::text ~ '(^|[{,])(anon|authenticated)=';
  `);
  assert(badDefaults.length === 0,
    `public default ACL grants nothing to anon/authenticated (found: ${badDefaults.map((r) => `${r.defaclobjtype}=${r.acl}`).join('; ') || 'none'})`);

  // Canary: a table created after every migration must start closed.
  await db.exec(`create table public.zz_default_acl_canary (id int); create sequence public.zz_default_acl_canary_seq;`);
  for (const role of ['anon', 'authenticated']) {
    const { rows: [{ t, s }] } = await db.query(`
      select has_table_privilege($1, 'public.zz_default_acl_canary', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') as t,
             has_sequence_privilege($1, 'public.zz_default_acl_canary_seq', 'USAGE,SELECT,UPDATE') as s`, [role]);
    assert(!t && !s, `a newly created public table/sequence grants ${role} nothing by default`);
  }
  await db.exec(`drop table public.zz_default_acl_canary; drop sequence public.zz_default_acl_canary_seq;`);

  // Function canary (022's default): a new function is not executable by
  // anon/authenticated until a migration grants it explicitly.
  await db.exec(`create function public.zz_default_acl_canary_fn() returns int language sql as 'select 1';`);
  for (const role of ['anon', 'authenticated']) {
    const { rows: [{ x }] } = await db.query(
      `select has_function_privilege($1, 'public.zz_default_acl_canary_fn()', 'EXECUTE') as x`, [role]);
    assert(!x, `a newly created public function is not executable by ${role} by default`);
  }
  await db.exec(`drop function public.zz_default_acl_canary_fn();`);

  // Views run with their owner's privileges (bypassing RLS) unless
  // security_invoker is set — any view reachable by anon/authenticated must
  // be security_invoker.
  const { rows: unsafeViews } = await db.query(`
    select c.relname from pg_class c
    where c.relnamespace = 'public'::regnamespace and c.relkind in ('v', 'm')
      and not coalesce(c.reloptions @> array['security_invoker=true'], false)
      and (has_table_privilege('anon', c.oid, 'SELECT') or has_table_privilege('authenticated', c.oid, 'SELECT'));
  `);
  assert(unsafeViews.length === 0,
    `no owner-privileged view is readable by anon/authenticated (found: ${unsafeViews.map((r) => r.relname).join(', ') || 'none'})`);

  // 060: the shared updated_at trigger function is pinned and not callable.
  const { rows: [trg] } = await db.query(`
    select proconfig, has_function_privilege('anon', oid, 'EXECUTE') as anon_x,
           has_function_privilege('authenticated', oid, 'EXECUTE') as auth_x
    from pg_proc where oid = 'public.hcg_set_updated_at()'::regprocedure;
  `);
  assert((trg.proconfig || []).some((c) => c === 'search_path=""' || c === 'search_path='),
    'hcg_set_updated_at has a pinned empty search_path (060)');
  assert(!trg.anon_x && !trg.auth_x, 'anon/authenticated cannot execute hcg_set_updated_at (060)');
  await db.query(`update public.households set email = email where id = $1`, [householdId]);
  assert(true, 'updated_at trigger still fires after 060 revoked EXECUTE (update succeeded)');

  // Static lint over the migration files themselves: patterns that have
  // caused or could reintroduce Data API exposure. Files already applied
  // before this check existed are allowlisted by name.
  const LINT_ALLOW = new Set(['000_baseline_contacts_table.sql']);
  for (const file of files) {
    if (LINT_ALLOW.has(file)) continue;
    const sql = (await readFile(path.join(migrationsDir, file), 'utf8'))
      .split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').toLowerCase();
    assert(!/grant\s+[^;]*\bto\s+[^;]*\banon\b/.test(sql), `${file}: no GRANT ... TO anon`);
    assert(!/disable\s+row\s+level\s+security/.test(sql), `${file}: never disables RLS`);
    assert(!/grant\s+all\b[^;]*\bto\s+[^;]*\b(authenticated|public)\b/.test(sql), `${file}: no GRANT ALL to authenticated/PUBLIC`);
    assert(!/alter\s+default\s+privileges[^;]*\bgrant\b/.test(sql), `${file}: never widens default privileges`);
  }

  // The only real authenticated write path — ensureHouseholdAndRole() —
  // still works, while arbitrary households columns are refused.
  const bootUser = '33333333-3333-4333-8333-333333333333';
  const bootEmail = 'boot@example.com';
  await db.query(`insert into auth.users (id, email) values ($1, $2)`, [bootUser, bootEmail]);
  await asAuthUser(db, bootUser, bootEmail);
  const { rows: claimRows } = await db.query(
    `update public.households set auth_user_id = $1, email = $2 where auth_user_id is null returning id`, [bootUser, bootEmail]
  );
  assert(claimRows.length === 0, 'bootstrap: claim-default UPDATE (auth_user_id/email) is permitted and claims nothing');
  let privilegedInsertError = null;
  try {
    await db.query(
      `insert into public.households (auth_user_id, email, status, twilio_number) values ($1, $2, 'active', '+447000000001')`,
      [bootUser, bootEmail]
    );
  } catch (err) {
    privilegedInsertError = err;
  }
  assert(privilegedInsertError?.code === '42501', `authenticated cannot set households.twilio_number on insert (got: ${privilegedInsertError?.code ?? 'no error'})`);
  await db.query(`insert into public.households (auth_user_id, email, status) values ($1, $2, 'active')`, [bootUser, bootEmail]);
  await db.query(`insert into public.user_roles (auth_user_id, role) values ($1, 'household')`, [bootUser]);
  const { rows: ownHouseholds } = await db.query(`select auth_user_id from public.households`);
  assert(ownHouseholds.length === 1 && ownHouseholds[0].auth_user_id === bootUser,
    'bootstrap: authenticated creates and sees only its own household');
  const { rows: ownRoles } = await db.query(`select auth_user_id from public.user_roles`);
  assert(ownRoles.length === 1 && ownRoles[0].auth_user_id === bootUser, 'bootstrap: authenticated creates and sees only its own role');

  await db.exec(`reset role; set role anon;`);
  let anonReadError = null;
  try {
    await db.query(`select 1 from public.households limit 1`);
  } catch (err) {
    anonReadError = err;
  }
  assert(anonReadError?.code === '42501', `anon is refused (42501) on households, not merely filtered by RLS (got: ${anonReadError?.code ?? 'no error'})`);
  await db.exec('reset role;');

  await db.close();

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
