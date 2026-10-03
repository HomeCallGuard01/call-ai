// Dedicated PGlite test for
// supabase/migrations/062_customer_identity_and_routing_assignments.sql.
//
// Applies the chain up to 062, seeds "existing customers" (legacy Twilio
// columns, quarantine history, subscriptions, entitlements, contacts,
// calls), THEN applies 062 — so the backfill is exercised against data
// that existed before the migration, exactly as it would be in a real
// database. Then drives the lifecycle RPCs and the legacy mirror.
//
// Concurrency note: PGlite is a single connection. Interleaved async
// inserts here prove the sequence/trigger path never duplicates and that
// unique constraints reject a forced duplicate; true multi-connection
// racing must still be repeated on staging (see the handover's
// docs/architecture/CUSTOMER_IDENTITY_AND_CARRIER_ABSTRACTION.md §Tests).
//
// Run with: node tests/customer-identity.pglite.test.mjs

import { PGlite } from '@electric-sql/pglite';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { formatAccountNumber, parseAccountNumber } = require('../services/customerIdentity/accountNumber.js');
const { STATES, canTransition, summariseRoutingHistory, selectPrimaryAssignment } = require('../services/customerIdentity/routingLifecycle.js');
const { planProviderMigration } = require('../services/customerIdentity/providerMigrationPlanner.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(__dirname, '..', 'supabase', 'migrations');
const TARGET = '062_customer_identity_and_routing_assignments.sql';

const BOOTSTRAP_SQL = `
create role anon;
create role authenticated;
create role service_role bypassrls;
create schema auth;
create table auth.users (id uuid primary key default gen_random_uuid(), email text);
create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid; $$;
create or replace function auth.jwt() returns jsonb language sql stable as $$ select nullif(current_setting('request.jwt.claims', true), '')::jsonb; $$;
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

async function rejects(fn, pattern, message) {
  try {
    await fn();
    assert(false, `${message} (expected an error, none raised)`);
  } catch (err) {
    const ok = pattern ? pattern.test(err.message) : true;
    assert(ok, ok ? message : `${message} (wrong error: ${err.message})`);
  }
}

const asSuperuser = db => db.exec('reset role;');
const asServiceRole = db => db.exec('reset role; set role service_role;');
function asAuthUser(db, userId, email) {
  return db.exec(`
    reset role;
    set request.jwt.claim.sub = '${userId}';
    set request.jwt.claims = '{"sub":"${userId}","email":"${email}"}';
    set role authenticated;
  `);
}

async function one(db, sql, params = []) {
  const { rows } = await db.query(sql, params);
  return rows[0];
}

async function main() {
  const db = new PGlite();
  await db.exec(BOOTSTRAP_SQL);

  const files = (await readdir(migrationsDir)).filter(f => f.endsWith('.sql')).sort();
  assert(files.includes(TARGET), `${TARGET} is present`);
  const before = files.filter(f => f < TARGET);
  const after = files.filter(f => f > TARGET);

  for (const file of before) {
    await db.exec(await readFile(path.join(migrationsDir, file), 'utf8'));
  }

  // ------------------------------------------------------------------
  // Seed "existing customers" before 062 exists.
  // ------------------------------------------------------------------
  await asSuperuser(db);
  const seed = async (email, createdAt, twilioNumber = null) => {
    const row = await one(db,
      `insert into public.households (email, created_at, twilio_number, twilio_provisioning_status)
       values ($1, $2, $3, case when $3::text is null then 'pending' else 'active' end) returning id`,
      [email, createdAt, twilioNumber]);
    return row.id;
  };
  const hOld = await seed('oldest@example.com', '2026-01-01T00:00:00Z', '+441000000001');
  const hMid = await seed('middle@example.com', '2026-02-01T00:00:00Z', '+441000000002');
  const hNew = await seed('newest@example.com', '2026-03-01T00:00:00Z');
  const hCancelled = await seed('cancelled@example.com', '2026-01-15T00:00:00Z');
  await db.query(`update public.households set status = 'cancelled' where id = $1`, [hCancelled]);

  // Quarantine history for hMid: one number already released, one still held.
  await db.query(
    `insert into public.twilio_number_quarantine (household_id, twilio_number, twilio_sid, release_reason, quarantined_at, released_at)
     values ($1, '+441000000090', 'PN_OLD_RELEASED', 'subscription_grace_expired', '2026-02-05T00:00:00Z', '2026-03-10T00:00:00Z'),
            ($1, '+441000000091', 'PN_OLD_HELD', 'subscription_grace_expired', '2026-02-20T00:00:00Z', null)`,
    [hMid]);

  // Billing + customer data keyed by household (must survive every routing change).
  const sub = await one(db,
    `insert into public.subscriptions (household_id, stripe_subscription_id, stripe_price_id, status)
     values ($1, 'sub_1', 'price_1', 'active') returning id`, [hOld]);
  const ent = await one(db,
    `insert into public.entitlements (household_id, entitlement_type, status, source)
     values ($1, 'paid_subscription', 'active', 'stripe') returning id`, [hOld]);
  await db.query(`insert into public.contacts (household_id, name, number) values ($1, 'Mum', '+447700900001'), ($1, 'GP', '+441000009999')`, [hOld]);
  await db.query(
    `insert into public.calls (household_id, number, status, result, monitored_duration_seconds)
     values ($1, '+447700900002', 'Unknown', 'SAFE', 120), ($1, '+447700900003', 'Known', 'SAFE', 0)`, [hOld]);

  const { rows: preCount } = await db.query(`select count(*)::int as n from public.households`);
  const householdCountBefore = preCount[0].n;

  // ------------------------------------------------------------------
  // Apply 062 (and anything after it).
  // ------------------------------------------------------------------
  try {
    await db.exec(await readFile(path.join(migrationsDir, TARGET), 'utf8'));
    for (const file of after) await db.exec(await readFile(path.join(migrationsDir, file), 'utf8'));
    assert(true, '062 applies on top of the existing chain with pre-existing customers');
  } catch (err) {
    assert(false, `062 failed to apply: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  // ------------------------------------------------------------------
  // Account numbers: backfill, determinism, retry
  // ------------------------------------------------------------------
  await asServiceRole(db);
  const { rows: numbered } = await db.query(
    `select id, email, account_number, created_at from public.households order by created_at, id`);
  assert(numbered.length === householdCountBefore, 'backfill did not create or remove any household');
  assert(numbered.every(h => /^HCG-[0-9]{8}$/.test(h.account_number)), 'every existing household has exactly one well-formed account number');
  assert(new Set(numbered.map(h => h.account_number)).size === numbered.length, 'backfilled account numbers are unique');
  const serials = numbered.map(h => parseAccountNumber(h.account_number).serial);
  assert(serials.every((s, i) => i === 0 || s > serials[i - 1]), 'backfill is deterministic: oldest household gets the lowest serial');
  assert(serials[0] === 1001, `first serial honours the sequence start (1001), got ${serials[0]}`);
  assert(numbered[0].account_number === 'HCG-00010017', 'first account number is HCG-00010017');

  const byEmail = Object.fromEntries(numbered.map(h => [h.email, h.account_number]));
  const retried = await one(db, `select public.backfill_household_account_numbers() as n`);
  assert(retried.n === 0, 'retrying the backfill numbers nobody');
  const { rows: afterRetry } = await db.query(`select email, account_number from public.households`);
  assert(afterRetry.every(h => byEmail[h.email] === h.account_number), 'retrying the backfill changes no existing number');

  const registry = await one(db, `select count(*)::int as n, count(distinct household_id)::int as hh from public.hcg_account_numbers`);
  assert(registry.n === numbered.length && registry.hh === numbered.length, 'registry holds exactly one entry per household');

  // JS and SQL formatting agree (check digit parity).
  const { rows: sqlFormats } = await db.query(
    `select s, public.hcg_format_account_number(s) as f from generate_series(1, 3000) s
     union all select s, public.hcg_format_account_number(s) from unnest(array[9999999, 10000000, 123456789]::bigint[]) s`);
  assert(sqlFormats.every(r => formatAccountNumber(Number(r.s)) === r.f), 'JS formatAccountNumber matches SQL hcg_format_account_number for 3003 serials');
  assert(sqlFormats.every(r => parseAccountNumber(r.f).valid), 'every SQL-issued number passes JS check-digit validation');

  // ------------------------------------------------------------------
  // New accounts: server-side generation, forging, immutability
  // ------------------------------------------------------------------
  await asSuperuser(db);
  const forgerId = '22222222-2222-2222-2222-222222222222';
  await db.query(`insert into auth.users (id, email) values ($1, 'forger@example.com')`, [forgerId]);
  // Integration 2026-10-03: with security migration 059 (least-privilege
  // grants, applied on staging) in the sequence, `authenticated` may INSERT
  // households only (auth_user_id, email, status) — naming account_number is
  // refused by the column grant. The trigger is proven separately below, from
  // a role that CAN write the column, so neither layer relies on the other.
  await asAuthUser(db, forgerId, 'forger@example.com');
  await rejects(
    () => db.query(`insert into public.households (auth_user_id, email, account_number) values ($1, 'forger@example.com', $2)`,
      [forgerId, numbered[0].account_number]),
    /permission denied/, 'a customer cannot even name account_number at sign-up (059 column grants)');
  await db.query(`insert into public.households (auth_user_id, email) values ($1, 'forger@example.com')`, [forgerId]);
  await asSuperuser(db);
  const forger = await one(db, `select id, account_number from public.households where auth_user_id = $1`, [forgerId]);
  assert(parseAccountNumber(forger.account_number).valid && forger.account_number !== numbered[0].account_number, 'a customer sign-up gets a server-generated account number');
  assert(parseAccountNumber(forger.account_number).serial > serials[serials.length - 1], 'the sign-up got the next server-generated serial');
  const forgedBySuper = await one(db,
    `insert into public.households (auth_user_id, email, account_number) values (null, 'trigger-proof@example.com', $1) returning account_number`,
    [numbered[0].account_number]);
  assert(forgedBySuper.account_number !== numbered[0].account_number && parseAccountNumber(forgedBySuper.account_number).valid,
    'the trigger overwrites a supplied account_number even from a role with column privilege (client value ignored)');

  await asAuthUser(db, forgerId, 'forger@example.com');
  // Customers have no UPDATE policy on their own row (only the one-off
  // founder claim), so RLS stops this before the trigger; either way the
  // number must be unchanged.
  try {
    await db.query(`update public.households set account_number = 'HCG-00010017' where auth_user_id = $1`, [forgerId]);
  } catch { /* refused outright is equally fine */ }
  await asSuperuser(db);
  assert((await one(db, `select account_number from public.households where auth_user_id = $1`, [forgerId])).account_number === forger.account_number,
    'a customer cannot change their own account number');
  await asAuthUser(db, forgerId, 'forger@example.com');
  await rejects(() => db.query(`select * from public.hcg_account_numbers`), /permission denied/, 'authenticated cannot read the account-number registry');
  await rejects(() => db.query(`select * from public.routing_assignments`), /permission denied/, 'authenticated cannot read routing assignments');
  await rejects(() => db.query(`select public.backfill_household_account_numbers()`), /permission denied/, 'authenticated cannot run the backfill');
  await rejects(
    () => db.query(`select public.routing_assignment_create($1, 'twilio', 'requested', 'purchased', 'me')`, [forger.id]),
    /permission denied/, 'authenticated cannot create routing assignments');

  await asServiceRole(db);
  await rejects(
    () => db.query(`update public.households set account_number = 'HCG-00099990' where id = $1`, [hOld]),
    /permission denied/, 'service_role has no direct write access to households');
  await asSuperuser(db);
  await rejects(
    () => db.query(`update public.households set account_number = 'HCG-00099990' where id = $1`, [hOld]),
    /permanent/, 'even a superuser UPDATE cannot change an issued account number (trigger)');

  // Interleaved creation: 60 sign-ups issued concurrently from JS.
  await asSuperuser(db);
  const created = await Promise.all(Array.from({ length: 60 }, (_, i) =>
    db.query(`insert into public.households (email) values ($1) returning account_number`, [`burst${i}@example.com`])));
  const burst = created.map(r => r.rows[0].account_number);
  assert(new Set(burst).size === 60, '60 interleaved sign-ups received 60 distinct account numbers');
  await rejects(
    () => db.query(`insert into public.hcg_account_numbers (account_number, serial) values ($1, $2)`,
      [burst[0], parseAccountNumber(burst[0]).serial]),
    /duplicate key/, 'a forced duplicate registry entry is rejected by the unique constraint');

  // A rolled-back sign-up burns its serial; it is never handed to anyone else.
  await db.exec('begin');
  const ghost = await one(db, `insert into public.households (email) values ('ghost@example.com') returning account_number`);
  await db.exec('rollback');
  const nextAfterGhost = await one(db, `insert into public.households (email) values ('after-ghost@example.com') returning account_number`);
  assert(parseAccountNumber(nextAfterGhost.account_number).serial > parseAccountNumber(ghost.account_number).serial,
    'a rolled-back sign-up\'s number is never re-issued');

  // Cancellation and reactivation keep the same number.
  await db.query(`update public.households set status = 'active' where id = $1`, [hCancelled]);
  const reactivated = await one(db, `select account_number from public.households where id = $1`, [hCancelled]);
  assert(reactivated.account_number === byEmail['cancelled@example.com'], 'cancellation then reactivation keeps the same account number');

  // Deleted account: number stays retired.
  const doomed = await one(db, `insert into public.households (email) values ('doomed@example.com') returning id, account_number`);
  await db.query(`delete from public.households where id = $1`, [doomed.id]);
  const tomb = await one(db, `select household_id from public.hcg_account_numbers where account_number = $1`, [doomed.account_number]);
  assert(tomb && tomb.household_id === null, 'a deleted household\'s number stays in the registry (tombstoned)');
  const later = await one(db, `insert into public.households (email) values ('later@example.com') returning account_number`);
  assert(later.account_number !== doomed.account_number, 'a deleted household\'s number is not reassigned to the next customer');
  await rejects(() => db.query(`delete from public.hcg_account_numbers where account_number = $1`, [doomed.account_number]),
    /append-only/, 'registry rows cannot be deleted');
  await rejects(() => db.query(`update public.hcg_account_numbers set household_id = $2 where account_number = $1`, [doomed.account_number, hOld]),
    /append-only/, 'a retired number cannot be re-pointed at another household');

  // Admin lookup by account number (exact, via canonical form).
  await asServiceRole(db);
  const typed = parseAccountNumber(` hcg ${byEmail['oldest@example.com'].slice(4, 8)} ${byEmail['oldest@example.com'].slice(8)} `);
  const found = await one(db, `select id from public.households where account_number = $1`, [typed.canonical]);
  assert(found && found.id === hOld, 'admin lookup by a typed account number finds the right household');
  const typo = byEmail['oldest@example.com'].replace(/.$/, d => String((Number(d) + 1) % 10));
  assert(!parseAccountNumber(typo).valid, 'a one-digit typo is caught by the check digit before any lookup');

  // ------------------------------------------------------------------
  // Legacy routing backfill
  // ------------------------------------------------------------------
  const routes = async hh => (await db.query(
    `select * from public.routing_assignments where household_id = $1 order by created_at, id`, [hh])).rows;

  const oldRoutes = await routes(hOld);
  assert(oldRoutes.length === 1 && oldRoutes[0].state === 'active' && oldRoutes[0].is_primary
    && oldRoutes[0].acquisition === 'legacy_backfill' && oldRoutes[0].e164_number === '+441000000001',
  'existing Twilio number backfilled as the active primary assignment');

  const midRoutes = await routes(hMid);
  assert(midRoutes.length === 3, 'household with history has three assignments (released, quarantined, active)');
  assert(midRoutes.some(r => r.state === 'released' && r.e164_number === '+441000000090' && r.provider_resource_id === 'PN_OLD_RELEASED'),
    'released quarantine history backfilled as released, with its SID');
  assert(midRoutes.some(r => r.state === 'quarantined' && r.e164_number === '+441000000091'),
    'unreleased quarantine backfilled as quarantined');
  assert(midRoutes.filter(r => r.is_primary).length === 1 && midRoutes.find(r => r.is_primary).e164_number === '+441000000002',
    'only the current number is primary');
  const rerun = await one(db, `select public.backfill_routing_assignments_from_legacy() as n`);
  assert(rerun.n === 0, 'routing backfill is idempotent (re-run inserts nothing)');
  assert((await routes(hNew)).length === 0, 'a household without a number gets no assignment');

  const historyView = summariseRoutingHistory(midRoutes);
  assert(historyView.length === 3 && historyView.every(h => !('provider_resource_id' in h) && !('resourceId' in h)),
    'summarised routing history keeps all numbers and exposes no provider resource ids');

  // ------------------------------------------------------------------
  // Legacy mirror follows the unchanged Twilio code paths
  // ------------------------------------------------------------------
  const { id: hMirror } = await (async () => { await asSuperuser(db); return one(db, `insert into public.households (email) values ('mirror@example.com') returning id`); })();
  await asServiceRole(db);
  const assigned = await one(db, `select public.assign_household_twilio_number($1, '+441000000050') as ok`, [hMirror]);
  assert(assigned.ok === true, 'legacy assign RPC still works unchanged');
  let m = await routes(hMirror);
  assert(m.length === 1 && m[0].state === 'active' && m[0].is_primary && m[0].acquisition === 'legacy_mirror',
    'assigning a Twilio number mirrors an active primary assignment');

  await db.query(`select public.release_household_twilio_number_immediately($1)`, [hMirror]);
  m = await routes(hMirror);
  assert(m[0].state === 'releasing' && !m[0].is_primary, 'clearing the Twilio number mirrors to releasing (not released)');

  await db.query(
    `insert into public.twilio_number_quarantine (household_id, twilio_number, twilio_sid, release_reason) values ($1, '+441000000050', 'PN_MIRROR', 'account_deletion')`,
    [hMirror]);
  m = await routes(hMirror);
  assert(m[0].state === 'quarantined' && m[0].provider_resource_id === 'PN_MIRROR', 'quarantine insert mirrors to quarantined and records the SID');

  await db.query(`update public.twilio_number_quarantine set released_at = now() where twilio_sid = 'PN_MIRROR'`);
  m = await routes(hMirror);
  assert(m[0].state === 'released', 'confirmed provider release mirrors to released');

  const mirrorEvents = await db.query(
    `select to_state, actor from public.routing_assignment_events
      where assignment_id = $1 and event_type in ('created', 'state_changed') order by id`, [m[0].id]);
  assert(mirrorEvents.rows.map(e => e.to_state).join('>') === 'active>releasing>quarantined>released'
    && mirrorEvents.rows.every(e => e.actor === 'legacy_mirror'), 'every mirrored step is in the audit trail');

  // A mirror conflict never blocks the legacy write.
  const { id: hThief } = await (async () => { await asSuperuser(db); return one(db, `insert into public.households (email) values ('thief@example.com') returning id`); })();
  await asServiceRole(db);
  const stolen = await one(db, `select public.assign_household_twilio_number($1, '+441000000091') as ok`, [hThief]);
  const thiefRow = await one(db, `select twilio_number from public.households where id = $1`, [hThief]);
  assert(stolen.ok === true && thiefRow.twilio_number === '+441000000091', 'legacy assignment still succeeds when the mirror refuses it');
  assert((await routes(hThief)).length === 0, 'mirror did not give a number still held (quarantined) by another household to a second household');
  const anomaly = await one(db, `select count(*)::int as n from public.customer_identity_sync_anomalies where household_id = $1`, [hThief]);
  assert(anomaly.n === 1, 'the refused mirror is recorded as an anomaly for follow-up');

  // ------------------------------------------------------------------
  // Lifecycle parity and guards
  // ------------------------------------------------------------------
  const { rows: matrix } = await db.query(
    `select f, t, public.routing_assignment_transition_allowed(f, t, false) as normal,
            public.routing_assignment_transition_allowed(f, t, true) as port
       from unnest($1::text[]) f cross join unnest($1::text[]) t`, [STATES]);
  assert(matrix.length === STATES.length ** 2 && matrix.every(r =>
    r.normal === canTransition(r.f, r.t) && r.port === canTransition(r.f, r.t, { viaPortCompletion: true })),
  'JS lifecycle table matches the SQL lifecycle for all 81 state pairs (with and without port completion)');

  const oldActive = oldRoutes[0];
  await rejects(() => db.query(`select public.routing_assignment_transition($1, 'active', 'released', 'test')`, [oldActive.id]),
    /not allowed/, 'active -> released directly is refused (must go via quarantine or a completed port)');
  await rejects(() => db.query(`update public.routing_assignments set state = 'requested' where id = $1`, [oldActive.id]),
    /permission denied/, 'service_role cannot write routing_assignments directly (RPCs only)');
  const cas = await one(db, `select public.routing_assignment_transition($1, 'quarantined', 'released', 'test') as ok`, [oldActive.id]);
  assert(cas.ok === false, 'compare-and-set transition returns false when the expected state is stale');
  await rejects(() => db.query(`select public.routing_assignment_transition($1, 'active', 'releasing', '')`, [oldActive.id]),
    /actor is required/, 'every routing change needs an actor');
  await asSuperuser(db);
  await rejects(() => db.query(`update public.routing_assignments set state = 'requested' where id = $1`, [oldActive.id]),
    /not allowed/, 'even a superuser UPDATE must follow the lifecycle (trigger)');
  await rejects(() => db.query(`update public.routing_assignments set household_id = $2 where id = $1`, [oldActive.id, hNew]),
    /cannot change/, 'an assignment cannot be moved to another household');
  await rejects(() => db.query(`update public.routing_assignments set e164_number = '+440000000000' where id = $1`, [oldActive.id]),
    /set once/, 'a recorded number cannot be rewritten');
  await rejects(() => db.query(`delete from public.routing_assignments where id = $1`, [oldActive.id]),
    /history/, 'assignments are never deleted');
  await rejects(() => db.query(`delete from public.routing_assignment_events`), /history/, 'audit events are append-only');
  await rejects(() => db.query(`update public.routing_assignment_events set actor = 'someone else'`), /history/, 'audit events cannot be edited');
  await asServiceRole(db);
  await rejects(
    () => db.query(`select public.routing_assignment_create($1, 'magrathea', 'requested', 'purchased', 'test')`, [hNew]),
    /unknown provider/, 'an unregistered provider is refused');

  await asSuperuser(db);
  await db.query(`insert into public.telephony_providers (code, display_name, status) values ('telnyx', 'Telnyx (test fixture)', 'active'), ('aql', 'AQL (test fixture)', 'inactive')`);
  await asServiceRole(db);
  await rejects(
    () => db.query(`select public.routing_assignment_create($1, 'aql', 'requested', 'purchased', 'test')`, [hNew]),
    /not active/, 'an inactive provider is refused');
  await rejects(
    () => db.query(`select public.routing_assignment_create($1, 'telnyx', 'provisioning', 'purchased', 'test', null, '+441000000001')`, [hNew]),
    /already held by another household/, 'a number held by one household cannot be assigned to another');

  // ------------------------------------------------------------------
  // Replacement number, cut-over, rollback
  // ------------------------------------------------------------------
  const snapshotHousehold = async hh => one(db,
    `select h.account_number, h.stripe_customer_id,
            (select count(*)::int from public.subscriptions s where s.household_id = h.id) as subs,
            (select string_agg(s.id::text, ',') from public.subscriptions s where s.household_id = h.id) as sub_ids,
            (select string_agg(e.id::text, ',') from public.entitlements e where e.household_id = h.id) as ent_ids,
            (select count(*)::int from public.contacts c where c.household_id = h.id) as contacts,
            (select coalesce(sum(c.monitored_duration_seconds), 0)::int from public.calls c where c.household_id = h.id) as monitored
       from public.households h where h.id = $1`, [hh]);
  const baseline = await snapshotHousehold(hOld);
  const householdsBefore = await one(db, `select count(*)::int as n from public.households`);

  const repl = await one(db,
    `select public.routing_assignment_create($1, 'telnyx', 'provisioning', 'purchased', 'ops:test', 'replacement', null, null, $2) as id`,
    [hOld, oldActive.id]);
  await rejects(() => db.query(`select public.routing_assignment_transition($1, 'provisioning', 'replacement_pending', 'ops:test')`, [repl.id]),
    /number_required|violates check/, 'replacement_pending requires the new number to be known');
  assert((await one(db, `select public.routing_assignment_transition($1, 'provisioning', 'replacement_pending', 'ops:test', 'bought', '+442000000001', 'TX_1') as ok`, [repl.id])).ok,
    'replacement number provisioned -> replacement_pending');
  assert((await one(db, `select public.routing_assignment_transition($1, 'replacement_pending', 'active', 'ops:test') as ok`, [repl.id])).ok,
    'replacement goes active alongside the old number (overlap)');
  let oldNow = await routes(hOld);
  assert(oldNow.filter(r => r.state === 'active').length === 2 && oldNow.find(r => r.id === oldActive.id).is_primary,
    'during overlap both numbers are active and the old one is still primary');

  await db.query(`select public.routing_assignment_make_primary($1, 'ops:test', 'customer verified forwarding')`, [repl.id]);
  oldNow = await routes(hOld);
  assert(oldNow.find(r => r.id === repl.id).is_primary && !oldNow.find(r => r.id === oldActive.id).is_primary,
    'cut-over moves primary to the replacement atomically');

  await db.query(`select public.routing_assignment_rollback_replacement($1, 'ops:test', 'forwarding broke')`, [repl.id]);
  oldNow = await routes(hOld);
  assert(oldNow.find(r => r.id === oldActive.id).is_primary && oldNow.find(r => r.id === repl.id).state === 'releasing',
    'rollback restores the old number as primary and sends the replacement to releasing');

  // Second attempt, completed this time.
  const repl2 = await one(db,
    `select public.routing_assignment_create($1, 'telnyx', 'provisioning', 'purchased', 'ops:test', 'replacement #2', null, null, $2) as id`,
    [hOld, oldActive.id]);
  await db.query(`select public.routing_assignment_transition($1, 'provisioning', 'replacement_pending', 'ops:test', null, '+442000000002', 'TX_2')`, [repl2.id]);
  await db.query(`select public.routing_assignment_transition($1, 'replacement_pending', 'active', 'ops:test')`, [repl2.id]);
  await db.query(`select public.routing_assignment_make_primary($1, 'ops:test')`, [repl2.id]);
  await db.query(`select public.routing_assignment_transition($1, 'active', 'releasing', 'ops:test')`, [oldActive.id]);
  await db.query(`select public.routing_assignment_transition($1, 'releasing', 'quarantined', 'ops:test')`, [oldActive.id]);
  await db.query(`select public.routing_assignment_transition($1, 'quarantined', 'released', 'ops:test')`, [oldActive.id]);
  await rejects(() => db.query(`select public.routing_assignment_rollback_replacement($1, 'ops:test')`, [repl2.id]),
    /rollback window closed/, 'rollback is refused once the previous number has been released');

  const afterReplacement = await snapshotHousehold(hOld);
  const householdsAfter = await one(db, `select count(*)::int as n from public.households`);
  assert(JSON.stringify(afterReplacement) === JSON.stringify(baseline),
    'replacing the routing number (and changing provider) left account number, subscription, entitlement, contacts and monitored minutes untouched');
  assert(householdsAfter.n === householdsBefore.n, 'no new household/customer row was created by the replacement');
  oldNow = await routes(hOld);
  assert(oldNow.length === 3 && oldNow.filter(r => r.state === 'released').length === 1 && selectPrimaryAssignment(oldNow).id === repl2.id,
    'multiple historical numbers are kept; the current primary is the newest replacement');

  // ------------------------------------------------------------------
  // Port: success, failure, guards
  // ------------------------------------------------------------------
  const midActive = (await routes(hMid)).find(r => r.state === 'active');
  await rejects(
    () => db.query(`select public.routing_assignment_create($1, 'telnyx', 'port_pending', 'ported_in', 'ops:test', null, '+449999999999', null, $2)`, [hMid, midActive.id]),
    /keeps the same number/, 'a port must keep the same number');
  await rejects(
    () => db.query(`select public.routing_assignment_create($1, 'twilio', 'port_pending', 'ported_in', 'ops:test', null, $3, null, $2)`, [hMid, midActive.id, midActive.e164_number]),
    /different provider/, 'a port must move to a different provider');
  await rejects(
    () => db.query(`select public.routing_assignment_create($1, 'telnyx', 'port_pending', 'purchased', 'ops:test')`, [hMid]),
    /only for ported_in/, 'port_pending is only for ported_in assignments');

  const failedPort = await one(db,
    `select public.routing_assignment_create($1, 'telnyx', 'port_pending', 'ported_in', 'ops:test', 'port attempt 1', $3, null, $2) as id`,
    [hMid, midActive.id, midActive.e164_number]);
  await db.query(`select public.routing_assignment_transition($1, 'port_pending', 'failed', 'ops:test', 'losing carrier rejected', null, null, 'LOA mismatch')`, [failedPort.id]);
  let midNow = await routes(hMid);
  assert(midNow.find(r => r.id === midActive.id).state === 'active' && midNow.find(r => r.id === midActive.id).is_primary,
    'port failure leaves the original number active and primary (nothing to roll back)');

  const planAfterFailure = planProviderMigration(
    { households: [{ id: hMid, account_number: byEmail['middle@example.com'], status: 'active', device_type: 'mobile' }], assignments: midNow },
    { targetProvider: 'telnyx', targetCapabilities: { portIn: true }, portability: { [midActive.e164_number]: 'portable' } });
  assert(planAfterFailure.rows[0].plan === 'replace_number_after_port_failure'
    && planAfterFailure.rows[0].forwardingAction === 'customer_reenters_mobile_forwarding_codes_for_new_number',
  'dry-run planner reports the fallback (replacement + forwarding change) after a failed port');

  const port = await one(db,
    `select public.routing_assignment_create($1, 'telnyx', 'port_pending', 'ported_in', 'ops:test', 'port attempt 2', $3, null, $2) as id`,
    [hMid, midActive.id, midActive.e164_number]);
  await db.query(`select public.routing_assignment_complete_port($1, 'ops:test', 'port completed', 'TX_PORTED')`, [port.id]);
  midNow = await routes(hMid);
  const source = midNow.find(r => r.id === midActive.id);
  const target = midNow.find(r => r.id === port.id);
  assert(source.state === 'released' && !source.is_primary && target.state === 'active' && target.is_primary && target.provider_resource_id === 'TX_PORTED',
    'port success: source released, target active and primary, same number');
  const activeForNumber = await one(db, `select count(*)::int as n from public.routing_assignments where e164_number = $1 and state = 'active'`, [midActive.e164_number]);
  assert(activeForNumber.n === 1, 'exactly one active assignment answers the ported number');
  assert((await one(db, `select account_number from public.households where id = $1`, [hMid])).account_number === byEmail['middle@example.com'],
    'port leaves the HCG account number unchanged');

  // ------------------------------------------------------------------
  // Provider resource id collisions
  // ------------------------------------------------------------------
  const { id: hRes } = await (async () => { await asSuperuser(db); return one(db, `insert into public.households (email) values ('res@example.com') returning id`); })();
  await asServiceRole(db);
  await rejects(
    () => db.query(`select public.routing_assignment_create($1, 'telnyx', 'provisioning', 'purchased', 'ops:test', null, null, 'TX_2')`, [hRes]),
    /duplicate key/, 'a live provider resource id cannot be claimed twice at the same provider');
  const crossProvider = await one(db,
    `select public.routing_assignment_create($1, 'twilio', 'provisioning', 'purchased', 'ops:test', null, null, 'TX_2') as id`, [hRes]);
  assert(!!crossProvider.id, 'the same resource id string at a different provider is allowed');
  const reuseReleased = await one(db,
    `select public.routing_assignment_create($1, 'twilio', 'provisioning', 'purchased', 'ops:test', null, null, 'PN_OLD_RELEASED') as id`, [hRes]);
  assert(!!reuseReleased.id, 'a resource id that only appears on released history can be reused by a live resource');
  await rejects(
    () => db.query(`select public.routing_assignment_transition($1, 'provisioning', 'active', 'ops:test', null, '+443000000001', 'PN_DIFFERENT')`, [reuseReleased.id]),
    /differs/, 'a recorded resource id cannot be silently replaced');

  // ------------------------------------------------------------------
  // Household deletion vs held numbers
  // ------------------------------------------------------------------
  await asSuperuser(db);
  // hRes holds live (provisioning) assignments and has no billing rows.
  await rejects(() => db.query(`delete from public.households where id = $1`, [hRes]),
    /routing_assignments_household_required_while_held|cannot change/, 'a household still holding a number cannot be hard-deleted');
  const { id: hGone } = await one(db, `insert into public.households (email) values ('gone@example.com') returning id`);
  await asServiceRole(db);
  const gone = await one(db, `select public.routing_assignment_create($1, 'twilio', 'requested', 'purchased', 'ops:test') as id`, [hGone]);
  await db.query(`select public.routing_assignment_transition($1, 'requested', 'failed', 'ops:test')`, [gone.id]);
  await asSuperuser(db);
  await db.query(`delete from public.households where id = $1`, [hGone]);
  const kept = await one(db, `select household_id, state from public.routing_assignments where id = $1`, [gone.id]);
  assert(kept && kept.household_id === null && kept.state === 'failed', 'terminal history survives a hard delete (owner nulled)');

  // ------------------------------------------------------------------
  // Audit trail
  // ------------------------------------------------------------------
  const ev = await one(db,
    `select count(*)::int as n, count(*) filter (where actor = 'unknown')::int as unknown
       from public.routing_assignment_events where household_id = $1`, [hOld]);
  assert(ev.n >= 10 && ev.unknown === 0, `every routing change for the household is audited with an actor (${ev.n} events)`);

  // ------------------------------------------------------------------
  // Rollback script: removes everything 062 added, legacy paths keep
  // working, and 062 re-applies cleanly afterwards.
  // ------------------------------------------------------------------
  await asSuperuser(db);
  await db.exec(await readFile(path.join(migrationsDir, '_rollbacks', '062_rollback_customer_identity_and_routing_assignments.sql'), 'utf8'));
  const leftovers = await one(db, `
    select (select count(*)::int from information_schema.columns where table_schema = 'public' and table_name = 'households' and column_name = 'account_number')
         + (select count(*)::int from information_schema.tables where table_schema = 'public'
              and table_name in ('routing_assignments', 'routing_assignment_events', 'hcg_account_numbers', 'telephony_providers', 'customer_identity_sync_anomalies'))
         + (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and (p.proname like 'routing_%' or p.proname like 'hcg_account%' or p.proname like 'hcg_format%'
                or p.proname in ('households_mirror_twilio_number', 'twilio_quarantine_mirror', 'backfill_household_account_numbers',
                                 'backfill_routing_assignments_from_legacy', 'hcg_set_audit_context', 'hcg_record_identity_anomaly',
                                 'households_assign_account_number', 'households_register_account_number')))
         + (select count(*)::int from pg_class where relname = 'hcg_account_serial_seq') as n`);
  assert(leftovers.n === 0, 'rollback removes every object 062 created');
  const { id: hAfterRollback } = await one(db, `insert into public.households (email) values ('post-rollback@example.com') returning id`);
  await asServiceRole(db);
  assert((await one(db, `select public.assign_household_twilio_number($1, '+441000000077') as ok`, [hAfterRollback])).ok === true,
    'legacy Twilio assignment works after rollback');
  await asSuperuser(db);
  await db.exec(await readFile(path.join(migrationsDir, TARGET), 'utf8'));
  const reapplied = await one(db, `select count(*)::int as n, count(account_number)::int as numbered from public.households`);
  assert(reapplied.n === reapplied.numbered, '062 re-applies cleanly after rollback and numbers every household');

  await db.close();
  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
