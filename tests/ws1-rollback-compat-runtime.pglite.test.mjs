// WS1 2026-10-10 — rollback compatibility, RUNTIME half (PGlite, real SQL).
//
// Applies supabase/migrations 000…075 to an in-memory PGlite with the same
// Supabase role/auth shim as tests/migrations.pglite.test.mjs (read from that
// file, so the two never diverge), then replays production eb43368's own
// database calls against the post-deploy schema:
//   R1  eb43368's user-scoped sign-up path (services/householdBootstrap.js
//       ensureHouseholdAndRole) AS ROLE authenticated, statement for statement;
//   R2  EVERY eb43368 RPC (extracted from `git show eb43368:…`) called AS
//       service_role with eb43368's exact named arguments — proves each one
//       still resolves (no 42883 undefined_function / 42725 ambiguous) and is
//       executable (no 42501), whatever the business outcome of null inputs;
//   R3  eb43368's number lifecycle with real values (assign → mark pending →
//       cancel), through the 047 guard and the 062 mirror triggers.
// What this does NOT prove: PostgREST's HTTP layer and RLS for every
// table read (eb43368 reads through service_role, which bypasses RLS), and
// Railway/runtime behaviour. Those remain covered by the static check
// (tests/ws1-rollback-compat.test.mjs) and the R1 runbook drill.
//
// Run: node tests/ws1-rollback-compat-runtime.pglite.test.mjs
import { PGlite } from '@electric-sql/pglite';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractUsage, oldBackendFiles } from '../scripts/production/rollback-compat-check.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const check = (c, m) => { if (c) console.log(`✓ ${m}`); else { console.error(`✗ ${m}`); failures++; } };

try { execFileSync('git', ['cat-file', '-e', 'eb43368^{commit}'], { cwd: ROOT, stdio: 'ignore' }); } catch {
  console.log('SKIP: commit eb43368 is not in this clone'); process.exit(0);
}

const harness = readFileSync(path.join(ROOT, 'tests', 'migrations.pglite.test.mjs'), 'utf8');
const BOOTSTRAP_SQL = /const BOOTSTRAP_SQL = `([\s\S]*?)`;/.exec(harness)[1];
const db = new PGlite();
await db.exec(BOOTSTRAP_SQL);
const migDir = path.join(ROOT, 'supabase', 'migrations');
const files = readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort();
for (const f of files) await db.exec(readFileSync(path.join(migDir, f), 'utf8'));
check(files[files.length - 1].startsWith('075_'), `applied ${files.length} migrations through ${files[files.length - 1]}`);

const asAuth = (uid, email) => db.exec(`reset role; set request.jwt.claim.sub = '${uid}'; set request.jwt.claims = '{"sub":"${uid}","email":"${email}"}'; set role authenticated;`);
const asService = () => db.exec('reset role; set role service_role;');
const asOwner = () => db.exec('reset role;');

// ── R1: sign-up path as authenticated (eb43368 ensureHouseholdAndRole) ──
const uid = 'aaaaaaaa-1111-4111-8111-111111111111';
const email = 'rollback-drill@example.invalid';
await asOwner();
await db.query('insert into auth.users (id, email) values ($1, $2)', [uid, email]);
let r1err = null;
try {
  await asAuth(uid, email);
  const sel = await db.query('select id from public.households where auth_user_id = $1', [uid]);
  check(sel.rows.length === 0, 'R1 select households by auth_user_id (as authenticated) works');
  // claim path: update … where auth_user_id is null returning * (eb43368 .update().is().select())
  const claimed = await db.query('update public.households set auth_user_id = $1, email = $2 where auth_user_id is null returning *', [uid, email]);
  if (claimed.rows.length === 0) await db.query("insert into public.households (auth_user_id, email, status) values ($1, $2, 'active')", [uid, email]);
  const role = await db.query('select auth_user_id from public.user_roles where auth_user_id = $1', [uid]);
  if (role.rows.length === 0) await db.query("insert into public.user_roles (auth_user_id, role) values ($1, 'household')", [uid]);
} catch (e) { r1err = e; }
check(!r1err, `R1 eb43368 sign-up statements succeed as authenticated on the 075 schema${r1err ? ` — ${r1err.message}` : ''}`);
await asOwner();
const hh = (await db.query('select id, account_number from public.households where auth_user_id = $1', [uid])).rows[0];
check(hh && /^HCG-/.test(hh.account_number || '') || (hh && hh.account_number), `R1 the new household got an account number from the 062 trigger (${hh && hh.account_number})`);
const reg = hh ? (await db.query('select 1 from public.hcg_account_numbers where household_id = $1', [hh.id])).rows.length : 0;
check(reg === 1, 'R1 the account number is registered (SECURITY DEFINER trigger ran under authenticated)');

// ── R2: every eb43368 RPC with its exact named args, as service_role ───
const rev = 'eb43368';
const srcFiles = oldBackendFiles(rev).map((f) => ({ file: f, src: execFileSync('git', ['show', `${rev}:${f}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }) }));
const { rpcs } = extractUsage(srcFiles);
// process_stripe_webhook_event passes a `params` variable: read its keys from the same source.
const billing = srcFiles.find((f) => f.file === 'database/billing.js').src;
const paramsBlock = /const params = \{([\s\S]*?)\};/.exec(billing)[1];
const stripeKeys = [...paramsBlock.matchAll(/(p_\w+):/g)].map((m) => m[1]);
const optional = [...billing.matchAll(/params\.(p_\w+)\s*=/g)].map((m) => m[1]);
const calls = new Map();
for (const r of rpcs) {
  if (calls.has(r.fn)) continue;
  calls.set(r.fn, r.keys || (r.fn === 'process_stripe_webhook_event' ? stripeKeys : null));
}
if (calls.has('process_stripe_webhook_event')) calls.set('process_stripe_webhook_event+created', [...stripeKeys, ...optional]);
check(calls.size >= 17, `R2 ${calls.size} eb43368 RPC call shapes extracted`);
const RESOLUTION_ERRORS = new Set(['42883', '42725', '42501', '42P13']);
for (const [label, keys] of calls) {
  const fn = label.replace(/\+.*$/, '');
  if (!keys) { check(false, `R2 ${fn}: argument names unknown`); continue; }
  await asService();
  let code = null; let msg = '';
  try {
    await db.exec('begin');
    await db.query(`select public.${fn}(${keys.map((k) => `${k} => null`).join(', ')})`);
  } catch (e) { code = e.code || null; msg = e.message; }
  finally { await db.exec('rollback').catch(() => {}); }
  check(!RESOLUTION_ERRORS.has(code), `R2 ${label}(${keys.join(', ')}) resolves and is executable by service_role${code ? ` (business outcome for null input: ${code} ${msg.slice(0, 60)})` : ''}`);
}

// ── R3: number lifecycle with real values ──────────────────────────────
await asService();
let r3err = null; let assigned; let marked;
try {
  assigned = (await db.query('select public.assign_household_twilio_number(p_household_id => $1, p_twilio_number => $2) as ok', [hh.id, '+441615550199'])).rows[0].ok;
  marked = (await db.query("select public.mark_household_twilio_number_pending_release(p_household_id => $1, p_grace_period => '30 days') as ok", [hh.id])).rows[0].ok;
  await db.query('select public.cancel_household_twilio_number_pending_release(p_household_id => $1)', [hh.id]);
} catch (e) { r3err = e; }
check(!r3err, `R3 assign → mark pending → cancel run without error on the 075 schema${r3err ? ` — ${r3err.message}` : ''}`);
check(assigned === true, 'R3 assign_household_twilio_number returns true (eb43368 treats true as success)');
check(marked === true, 'R3 mark pending release returns true for a household with no entitlement (047 guard allows it)');
await asOwner();
const mirror = (await db.query("select state from public.routing_assignments where household_id = $1 and e164_number = '+441615550199'", [hh.id])).rows;
check(mirror.length === 1 && mirror[0].state === 'active', 'R3 the 062 mirror trigger recorded the assignment without affecting the RPC');
// With an active entitlement the 047 guard refuses to start the release clock (safer for the customer).
await db.query("insert into public.entitlements (household_id, entitlement_type, source, status, starts_at) values ($1, 'paid_subscription', 'stripe', 'active', now() - interval '1 day')", [hh.id]).catch((e) => console.log(`  (entitlement fixture: ${e.message})`));
await asService();
let guarded = null;
try { guarded = (await db.query("select public.mark_household_twilio_number_pending_release(p_household_id => $1, p_grace_period => '30 days') as ok", [hh.id])).rows[0].ok; } catch (e) { guarded = `error ${e.code}`; }
check(guarded === false || /^error/.test(String(guarded)), `R3 entitled household: 047 guard refuses the release clock (got ${guarded}); eb43368 then releases nothing`);
await asOwner();

// ── R4 (admin hardening): no self-escalation to admin on the 075 schema ─
const uid2 = 'bbbbbbbb-2222-4222-8222-222222222222';
await db.query('insert into auth.users (id, email) values ($1, $2)', [uid2, 'escalate@example.invalid']);
await asAuth(uid2, 'escalate@example.invalid');
let escalated = true;
try { await db.query("insert into public.user_roles (auth_user_id, role) values ($1, 'admin')", [uid2]); } catch { escalated = false; }
let updated = 0;
try { updated = (await db.query("update public.user_roles set role = 'admin' where auth_user_id = $1", [uid])).affectedRows || 0; } catch { updated = 0; }
await asOwner();
const admins = (await db.query("select count(*)::int as n from public.user_roles where role = 'admin'")).rows[0].n;
check(!escalated && updated === 0 && admins === 0, 'R4 a signed-in user cannot insert or update a user_roles row to admin (006 policy + 059 column grants)');

console.log(failures === 0 ? '\nAll WS1 runtime rollback compatibility checks passed.' : `\n${failures} WS1 runtime rollback compatibility check(s) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
