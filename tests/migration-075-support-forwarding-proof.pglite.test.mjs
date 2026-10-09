// Migration 075 (support-verified forwarding proof, launch blocker B3,
// 2026-10-09): applies after 000→074; every evidence rule is enforced INSIDE
// the database function (so no API caller can bypass it); the audit is
// append-only; only service_role may execute; the rollback refuses while
// proof or audit history exists.
//
// Run with: node tests/migration-075-support-forwarding-proof.pglite.test.mjs

import { PGlite } from '@electric-sql/pglite';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(__dirname, '..', 'supabase', 'migrations');

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
  if (!condition) { failures += 1; console.error(`✗ ${message}`); } else { console.log(`✓ ${message}`); }
}

const SUPPORT = '+447700900301';      // designated support phone
const CUSTOMER_MOBILE = '+447700900456';
const HCG = '+441234560075';
const SUPPORT_LIST = `array['${SUPPORT}']::text[]`;

async function main() {
  const db = new PGlite();
  await db.exec(BOOTSTRAP_SQL);
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  assert(files.includes('075_support_verified_forwarding_proof.sql'), 'migration 075 file is present');
  for (const file of files) {
    const sql = await readFile(path.join(migrationsDir, file), 'utf8');
    try { await db.exec(sql); } catch (err) { console.error(`✗ ${file} failed to apply: ${err.message}`); process.exitCode = 1; return; }
  }
  assert(true, `all ${files.length} migrations applied in order (000 → 075)`);
  const sql075 = await readFile(path.join(migrationsDir, '075_support_verified_forwarding_proof.sql'), 'utf8');
  let again = true; try { await db.exec(sql075); } catch (e) { again = false; console.error(e.message); }
  assert(again, '075 can be re-applied safely (idempotent)');

  const mkHousehold = async (email, extra = {}) => (await db.query(
    `insert into public.households (auth_user_id, email, phone_number, twilio_number, twilio_provisioning_status, status)
     values (null, $1, $2, $3, $4, $5) returning id`,
    [email, extra.phone ?? CUSTOMER_MOBILE, extra.twilio ?? HCG, extra.prov ?? 'active', extra.status ?? 'active'])).rows[0].id;
  let n = 0;
  const mkCall = async (householdId, { from = SUPPORT, dial = 'completed', ageMin = 5 } = {}) => {
    const sid = `CA075${String(++n).padStart(29, '0')}`;
    await db.query(`insert into public.calls (call_sid, number, status, result, household_id, dial_call_status, created_at)
                    values ($1, $2, 'Unknown', 'SAFE', $3, $4, now() - make_interval(mins => $5))`, [sid, from, householdId, dial, ageMin]);
    return sid;
  };
  const record = (h, sid, { last4 = '0456', list = SUPPORT_LIST, reason = 'Attended verification with customer on the phone', actor = 'admin:a1', maxAge = 60 } = {}) =>
    db.query(`select public.hcg_record_support_forwarding_proof($1::uuid, $2, $3, ${list}, $4, $5, $6) as r`, [h, sid, last4, reason, actor, maxAge]);
  const refusal = async (fn) => { try { await fn(); return null; } catch (e) { return e.message; } };

  // Constraint now admits the new method, still rejects arbitrary ones.
  const h0 = await mkHousehold('c0@example.com');
  let bad = false; try { await db.query(`update public.households set forwarding_proof_method = 'direct_call' where id = $1`, [h0]); } catch { bad = true; }
  assert(bad, 'proof method still constrained (arbitrary "direct_call" rejected)');

  // Happy path.
  const h1 = await mkHousehold('c1@example.com');
  const sid1 = await mkCall(h1, { ageMin: 7 });
  const ok = (await record(h1, sid1)).rows[0].r;
  const after = (await db.query(`select forwarding_proven_at, forwarding_proof_method, (select created_at from public.calls where call_sid = $2) as call_at from public.households where id = $1`, [h1, sid1])).rows[0];
  assert(ok.ok === true && after.forwarding_proof_method === 'support_verified', 'valid evidence → proof recorded as support_verified');
  assert(after.forwarding_proven_at.getTime() === after.call_at.getTime(), 'forwarding_proven_at is the EVIDENCE CALL time, not the admin click time');
  const audit = (await db.query(`select * from public.forwarding_proof_audit where household_id = $1`, [h1])).rows;
  assert(audit.length === 1 && audit[0].action === 'recorded' && audit[0].evidence_call_sid === sid1 && audit[0].actor === 'admin:a1'
    && audit[0].evidence_caller_last4 === '0301' && audit[0].attested_dialled_last4 === '0456' && audit[0].hcg_number_last4 === '0075',
  'one audit row: action, evidence SID, actor, masked caller/dialled/HCG digits (no full numbers stored)');

  // Refusals — each leaves the household unproven and writes no audit row.
  const cases = [
    ['unanswered evidence call (dial status no-answer)', async () => { const h = await mkHousehold('r1@example.com'); return [h, await mkCall(h, { dial: 'no-answer' })]; }, {}, /not answered/],
    ['evidence call with no dial outcome', async () => { const h = await mkHousehold('r2@example.com'); return [h, await mkCall(h, { dial: null })]; }, {}, /not answered/],
    ['stale evidence (older than the window)', async () => { const h = await mkHousehold('r3@example.com'); return [h, await mkCall(h, { ageMin: 90 })]; }, {}, /older than/],
    ['caller is not a designated support phone', async () => { const h = await mkHousehold('r4@example.com'); return [h, await mkCall(h, { from: '+447700900999' })]; }, {}, /support phone/],
    ['attested last 4 digits do not match the customer mobile', async () => { const h = await mkHousehold('r5@example.com'); return [h, await mkCall(h)]; }, { last4: '1111' }, /does not match/],
    ['evidence call of ANOTHER household', async () => { const h = await mkHousehold('r6@example.com'); const other = await mkHousehold('r6o@example.com'); return [h, await mkCall(other)]; }, {}, /another household/],
    ['unknown evidence call SID', async () => [await mkHousehold('r7@example.com'), 'CA_does_not_exist'], {}, /not found/],
    ['no active HCG number', async () => { const h = await mkHousehold('r8@example.com', { prov: 'pending' }); return [h, await mkCall(h)]; }, {}, /no active HCG number/],
    ['cancelled/deleted household', async () => { const h = await mkHousehold('r9@example.com', { status: 'cancelled' }); return [h, await mkCall(h)]; }, {}, /cancelled/],
    ['support list empty (not configured)', async () => { const h = await mkHousehold('r10@example.com'); return [h, await mkCall(h)]; }, { list: `array[]::text[]` }, /no designated support/],
    ['reason too short', async () => { const h = await mkHousehold('r11@example.com'); return [h, await mkCall(h)]; }, { reason: 'ok' }, /reason and actor/],
    ['max age above 240 minutes', async () => { const h = await mkHousehold('r12@example.com'); return [h, await mkCall(h)]; }, { maxAge: 1000 }, /max age/],
    ['support phone equal to the customer mobile', async () => { const h = await mkHousehold('r13@example.com', { phone: SUPPORT }); return [h, await mkCall(h)]; }, { last4: '0301' }, /must differ/],
  ];
  for (const [label, setup, opts, re] of cases) {
    const [h, sid] = await setup();
    const msg = await refusal(() => record(h, sid, opts));
    const st = (await db.query(`select forwarding_proven_at, (select count(*)::int from public.forwarding_proof_audit where household_id = $1) as a from public.households where id = $1`, [h])).rows[0];
    assert(msg && re.test(msg) && st.forwarding_proven_at === null && st.a === 0, `refused: ${label}${msg && !re.test(msg) ? ` (got: ${msg})` : ''}`);
  }

  // Evidence predating the current number (062 routing assignment).
  {
    // Own number, so 062's account/assignment machinery gives it its own
    // active primary assignment; then the number is "re-assigned" 10 min ago.
    const own = '+441234560914';
    const h = await mkHousehold('r14@example.com', { twilio: own });
    const sid = await mkCall(h, { ageMin: 30 });
    let rows = (await db.query(`select id from public.routing_assignments where household_id = $1 and e164_number = $2 and state = 'active' and is_primary`, [h, own])).rows;
    if (rows.length === 0) {
      await db.query(`insert into public.routing_assignments (household_id, provider_code, e164_number, state, is_primary)
                      values ($1, 'twilio', $2, 'active', true)`, [h, own]);
    }
    await db.query(`update public.routing_assignments set state_changed_at = now() - interval '10 minutes'
                    where household_id = $1 and e164_number = $2 and state = 'active' and is_primary`, [h, own]);
    rows = (await db.query(`select count(*)::int as n from public.routing_assignments where household_id = $1 and state = 'active' and is_primary`, [h])).rows;
    assert(rows[0].n === 1, 'fixture: exactly one active primary assignment for the current number');
    const msg = await refusal(() => record(h, sid, { last4: '0456' }));
    assert(msg && /predates the current HCG number/.test(msg), `refused: evidence call predates the current HCG number assignment${msg && !/predates/.test(msg) ? ` (got: ${msg})` : ''}`);
    const fresh = await mkCall(h, { ageMin: 2 });
    assert((await record(h, fresh)).rows[0].r.ok === true, 'a call AFTER the current assignment is accepted');
  }

  // Already proven → refused; reuse of the same evidence → refused.
  assert(/already proven/.test(await refusal(() => record(h1, sid1)) || ''), 'refused: household already proven (must clear first)');
  const hReuse = await mkHousehold('r15@example.com');
  // Move h1's evidence call onto hReuse is impossible (household check), so prove reuse via clear + re-record:
  await db.query(`select public.hcg_clear_forwarding_proof($1::uuid, 'Customer reported forwarding switched off', 'admin:a1')`, [h1]);
  assert(/already used/.test(await refusal(() => record(h1, sid1)) || ''), 'refused: the same evidence call cannot be used twice (even after a clear)');
  void hReuse;

  // Clear: audited, gate input removed.
  const cleared = (await db.query(`select forwarding_proven_at, forwarding_proof_method from public.households where id = $1`, [h1])).rows[0];
  const audit2 = (await db.query(`select action, previous_method from public.forwarding_proof_audit where household_id = $1 order by id`, [h1])).rows;
  assert(cleared.forwarding_proven_at === null && cleared.forwarding_proof_method === null
    && audit2.length === 2 && audit2[1].action === 'cleared' && audit2[1].previous_method === 'support_verified',
  'clear removes the proof and appends a "cleared" audit row with the previous method');
  const noop = (await db.query(`select public.hcg_clear_forwarding_proof($1::uuid, 'Second clear should be a no-op', 'admin:a1') as r`, [h1])).rows[0].r;
  assert(noop.cleared === false, 'clearing an unproven household is a no-op (no audit row)');

  // A fresh call proves again.
  const sid1b = await mkCall(h1, { ageMin: 1 });
  assert((await record(h1, sid1b)).rows[0].r.ok === true, 'a NEW evidence call can re-prove after a clear');

  // Append-only audit.
  assert(/append-only/.test(await refusal(() => db.query(`update public.forwarding_proof_audit set actor = 'x' where household_id = $1`, [h1])) || ''), 'audit rows cannot be updated');
  assert(/append-only/.test(await refusal(() => db.query(`delete from public.forwarding_proof_audit where household_id = $1`, [h1])) || ''), 'audit rows cannot be deleted');

  // Privileges: anon/authenticated cannot execute or read; service_role can execute.
  for (const role of ['anon', 'authenticated']) {
    await db.exec(`set role ${role};`);
    const ex = await refusal(() => db.query(`select public.hcg_record_support_forwarding_proof(gen_random_uuid(), 'x', '0000', array['1']::text[], 'reason long enough', 'a1')`));
    const rd = await refusal(() => db.query(`select * from public.forwarding_proof_audit`));
    const cl = await refusal(() => db.query(`select public.hcg_clear_forwarding_proof(gen_random_uuid(), 'reason long enough', 'a1')`));
    await db.exec('reset role;');
    assert(ex && /permission denied/.test(ex) && rd && /permission denied/.test(rd) && cl && /permission denied/.test(cl), `${role}: cannot execute record/clear or read the audit`);
  }
  await db.exec('set role service_role;');
  const svc = await refusal(() => db.query(`select public.hcg_clear_forwarding_proof(gen_random_uuid(), 'reason long enough', 'admin:a1')`));
  await db.exec('reset role;');
  assert(svc && /unknown household/.test(svc), 'service_role can execute (reaches the function body)');

  // Rollback refuses while proof / audit exist; succeeds once clean.
  const rollback = await readFile(path.join(migrationsDir, '_rollbacks', '075_rollback_support_verified_forwarding_proof.sql'), 'utf8');
  let refused = false; try { await db.exec(rollback); } catch (err) { refused = /rollback 075/.test(err.message); }
  await db.exec('rollback;').catch(() => {});
  assert(refused, 'rollback refuses while support-verified proof is recorded');

  const db2 = new PGlite();
  await db2.exec(BOOTSTRAP_SQL);
  for (const file of files) await db2.exec(await readFile(path.join(migrationsDir, file), 'utf8'));
  await db2.exec(rollback);
  const fn = (await db2.query(`select count(*)::int as n from pg_proc where proname in ('hcg_record_support_forwarding_proof','hcg_clear_forwarding_proof')`)).rows[0].n;
  const tbl = (await db2.query(`select to_regclass('public.forwarding_proof_audit') as t`)).rows[0].t;
  let back074 = false; try { await db2.query(`insert into public.households (auth_user_id, email, phone_number, forwarding_proof_method) values (null, 'rb@example.com', '+447700900111', 'support_verified')`); } catch { back074 = true; }
  assert(fn === 0 && tbl === null && back074, 'on a clean database the rollback removes 075 and restores the 074 constraint');
  // 074's own rollback still applies afterwards.
  await db2.exec(await readFile(path.join(migrationsDir, '_rollbacks', '074_rollback_households_forwarding_proof.sql'), 'utf8'));
  assert(true, '074 rollback still applies after the 075 rollback');

  console.log(failures === 0 ? '\nMigration 075: all checks hold.' : `\n${failures} check(s) FAILED`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
