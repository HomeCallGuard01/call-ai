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
-- tracked migration (see 009_service_role_minimum_app_privileges.sql's
-- own comment on this) — 003_add_household_id_ownership.sql alters it.
-- Stub just enough of it here for the migration chain to apply.
create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  household_id uuid,
  created_at timestamptz not null default now()
);
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

  await db.close();

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
