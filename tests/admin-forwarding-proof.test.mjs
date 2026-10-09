// Support-verified forwarding proof (launch blocker B3, 2026-10-09) — the
// admin action END TO END: real router + real requireAdmin + real
// database/forwardingProof.js + real migration 075 SQL on PGlite (a minimal
// supabase-js-shaped adapter turns .from()/.rpc() into SQL; nothing touches a
// network service). requireAuth is the header-driven stand-in used by
// tests/admin-fortress-controls.test.mjs.
//
// Proves: only an authenticated admin with JSON + typed confirmation + reason
// can act; the audited actor is the session's admin; the action is OFF until
// support phones are configured; every evidence refusal from the database
// reaches the operator as 409 with nothing written; the protection gate turns
// Protected only after a recorded proof and back after a clear; full phone
// numbers are never returned.
import { createRequire } from 'node:module';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const check = (c, m) => { if (c) console.log(`✓ ${m}`); else { console.error(`✗ ${m}`); failures++; } };

// ── PGlite with every migration ───────────────────────────────────────────
const db = new PGlite();
await db.exec(`create role anon; create role authenticated; create role service_role bypassrls; create schema auth;
create table auth.users (id uuid primary key default gen_random_uuid(), email text);
create or replace function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
create or replace function auth.jwt() returns jsonb language sql stable as $$ select null::jsonb $$;
grant usage on schema public to anon, authenticated, service_role;`);
const migDir = path.join(ROOT, 'supabase', 'migrations');
for (const f of (await readdir(migDir)).filter((x) => x.endsWith('.sql')).sort()) await db.exec(await readFile(path.join(migDir, f), 'utf8'));
// Supabase grants service_role ALL on public tables by default (058-061 only
// tighten anon/authenticated); mirror that, then act AS service_role.
await db.exec('grant all on all tables in schema public to service_role; grant usage, select on all sequences in schema public to service_role;');
await db.exec('set role service_role;');

// ── minimal supabase-js-shaped adapter (only what forwardingProof.js uses) ─
function from(table) {
  const st = { cols: '*', where: [], params: [], order: null, limit: null };
  const b = {
    select(cols) { st.cols = cols; return b; },
    eq(c, v) { st.params.push(v); st.where.push(`${c} = $${st.params.length}`); return b; },
    gte(c, v) { st.params.push(v); st.where.push(`${c} >= $${st.params.length}`); return b; },
    order(c, { ascending }) { st.order = `${c} ${ascending ? 'asc' : 'desc'}`; return b; },
    limit(n) { st.limit = n; return b; },
    async run() {
      const sql = `select ${st.cols} from public.${table}${st.where.length ? ' where ' + st.where.join(' and ') : ''}${st.order ? ' order by ' + st.order : ''}${st.limit ? ' limit ' + st.limit : ''}`;
      try { return { data: (await db.query(sql, st.params)).rows, error: null }; } catch (e) { return { data: null, error: { message: e.message } }; }
    },
    async maybeSingle() { const r = await b.run(); return r.error ? r : { data: r.data[0] || null, error: null }; },
    then(res, rej) { return b.run().then(res, rej); },
  };
  return b;
}
async function rpc(fn, args) {
  const names = Object.keys(args);
  const sql = `select public.${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(', ')}) as r`;
  try { return { data: (await db.query(sql, names.map((n) => args[n]))).rows[0].r, error: null }; } catch (e) { return { data: null, error: { message: e.message } }; }
}
const supabaseAdmin = { from, rpc };

// ── header-driven requireAuth stand-in ────────────────────────────────────
const authPath = require.resolve(path.join(ROOT, 'middleware', 'requireAuth.js'));
require.cache[authPath] = { id: authPath, filename: authPath, loaded: true, exports: {
  requireAuth: (req, res, next) => {
    if (!req.get('x-test-user')) return res.status(401).json({ error: 'unauthenticated' });
    req.authUserId = req.get('x-test-user'); req.role = req.get('x-test-role') || 'customer'; return next();
  },
} };
const express = require('express');
const { createAdminForwardingProofRoutes } = require(path.join(ROOT, 'routes', 'adminForwardingProof.js'));
const { deriveActivationState } = require(path.join(ROOT, 'services', 'lifecycle', 'activationState.js'));

const SUPPORT = '+447700900301';
const env = { HCG_SUPPORT_VERIFICATION_CALLERS: '' };
const app = express();
app.use(createAdminForwardingProofRoutes({ supabaseAdmin, env }));
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const port = server.address().port;
const req = (method, p, body, headers = {}) => new Promise((resolve, reject) => {
  const data = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
  const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...headers } }, (res) => {
    let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(t); } catch {} resolve({ status: res.statusCode, body: j, text: t }); });
  });
  r.on('error', reject); r.end(data);
});
const ADMIN = { 'x-test-user': '9a7c1d2e-0000-4000-8000-00000000000a', 'x-test-role': 'admin' };

// ── fixtures ──────────────────────────────────────────────────────────────
const H = (await db.query(`insert into public.households (auth_user_id, email, phone_number, twilio_number, twilio_provisioning_status)
  values (null, 'fp@example.com', '+447700900456', '+441234560876', 'active') returning id`)).rows[0].id;
// The number was assigned yesterday (062 stamps the assignment at insert).
await db.query(`update public.routing_assignments set state_changed_at = now() - interval '1 day' where household_id = $1`, [H]);
const sid = (n) => 'CA' + n.toString(16).padStart(32, '0');
const mkCall = (s, { from = SUPPORT, dial = 'completed', ageMin = 3 } = {}) => db.query(
  `insert into public.calls (call_sid, number, status, result, household_id, dial_call_status, created_at)
   values ($1, $2, 'Unknown', 'SAFE', $3, $4, now() - make_interval(mins => $5))`, [s, from, H, dial, ageMin]);
await mkCall(sid(1), { from: '+447700900999' });       // stranger
await mkCall(sid(2), { dial: 'no-answer' });           // support, unanswered
await mkCall(sid(3));                                  // support, answered → good evidence
const P = `/admin/api/households/${H}/forwarding-proof`;
const good = { evidenceCallSid: sid(3), dialledLast4: '0456', reason: 'Attended check with the customer on speaker', confirm: 'RECORD FORWARDING PROOF' };
const proofState = async () => (await db.query(`select forwarding_proven_at, forwarding_proof_method from public.households where id = $1`, [H])).rows[0];
const auditCount = async () => (await db.query(`select count(*)::int as n from public.forwarding_proof_audit where household_id = $1`, [H])).rows[0].n;

try {
  // Access control.
  check((await req('POST', P, good)).status === 401 && !(await proofState()).forwarding_proven_at, 'unauthenticated → 401, nothing written');
  check((await req('POST', P, good, { 'x-test-user': 'c1', 'x-test-role': 'customer' })).status === 302 && (await auditCount()) === 0, 'authenticated NON-admin → refused by requireAdmin');
  check((await req('GET', P, undefined, { 'x-test-user': 'c1', 'x-test-role': 'customer' })).status === 302, 'NON-admin cannot read the evidence page data');
  check((await req('POST', P, 'evidenceCallSid=x', { ...ADMIN, 'content-type': 'application/x-www-form-urlencoded' })).status === 415, 'non-JSON (cross-site form) → 415');
  check((await req('POST', P, { ...good, confirm: 'record' }, ADMIN)).status === 400, 'wrong confirmation phrase → 400');
  check((await req('POST', P, { ...good, reason: 'short' }, ADMIN)).status === 400, 'reason under 10 characters → 400');
  check((await req('POST', `/admin/api/households/not-a-uuid/forwarding-proof`, good, ADMIN)).status === 400, 'malformed household id → 400');
  check((await req('POST', P, { ...good, evidenceCallSid: "CA'; drop table calls;--" }, ADMIN)).status === 400, 'evidence SID must be a Twilio Call SID');
  check((await req('POST', P, { ...good, dialledLast4: '45' }, ADMIN)).status === 400, 'dialled last-4 must be 4 digits');

  // Off until configured.
  const off = await req('POST', P, good, ADMIN);
  check(off.status === 503 && off.body.error === 'not_configured' && (await auditCount()) === 0, 'no designated support phone configured → 503, action OFF');
  env.HCG_SUPPORT_VERIFICATION_CALLERS = `${SUPPORT}, not-a-number`;

  // Read model: candidates, masking.
  const st = await req('GET', P, undefined, ADMIN);
  const c = st.body && st.body.candidates || [];
  check(st.status === 200 && c.length === 3 && st.body.supportPhonesConfigured === 1, 'GET lists the 3 recent calls; invalid configured entries are dropped');
  check(c.find((x) => x.callSid === sid(3)).eligible === true && c.find((x) => x.callSid === sid(2)).why === 'not answered in the app'
    && c.find((x) => x.callSid === sid(1)).why === 'not from a designated support phone', 'eligibility shown per call with the reason');
  check(!/447700900456|447700900301|441234560876|7700900456/.test(st.text) && st.body.household.mobileLast4 === '0456',
    'no full phone number is ever returned (last 4 digits only)');

  // Database refusals surface as 409, nothing written.
  for (const [label, body, re] of [
    ['stranger caller', { ...good, evidenceCallSid: sid(1) }, /support phone/],
    ['unanswered call', { ...good, evidenceCallSid: sid(2) }, /not answered/],
    ['wrong attested number', { ...good, dialledLast4: '9999' }, /does not match/],
    ['unknown call', { ...good, evidenceCallSid: sid(99) }, /not found/],
  ]) {
    const r = await req('POST', P, body, ADMIN);
    check(r.status === 409 && re.test(r.body.message) && (await auditCount()) === 0 && !(await proofState()).forwarding_proven_at, `refused by the database (${label}) → 409 "${r.body && r.body.message}", nothing written`);
  }

  // Protection gate BEFORE: not protected.
  const hhRow = async () => (await db.query(`select * from public.households where id = $1`, [H])).rows[0];
  const gate = async () => deriveActivationState({ household: await hhRow(), entitlements: [] }, new Date()).gates || {};
  check((await gate()).forwardingVerifiedForCurrentNumber === false, 'gate before: forwardingVerifiedForCurrentNumber = false');

  // Success; actor from session, not body.
  const ok = await req('POST', P, { ...good, actor: 'someone-else' }, ADMIN);
  const a = (await db.query(`select actor, evidence_call_sid from public.forwarding_proof_audit where household_id = $1`, [H])).rows;
  check(ok.status === 200 && ok.body.ok === true && (await proofState()).forwarding_proof_method === 'support_verified', 'valid evidence → 200, proof recorded');
  check(a.length === 1 && a[0].actor === `admin:${ADMIN['x-test-user']}` && a[0].evidence_call_sid === sid(3), 'audit actor is the AUTHENTICATED admin (body actor ignored)');
  check((await gate()).forwardingVerifiedForCurrentNumber === true, 'gate after: forwardingVerifiedForCurrentNumber = true');

  // Already proven → 409. Clear → audited, gate false again.
  check((await req('POST', P, good, ADMIN)).status === 409, 'second record while proven → 409');
  check((await req('POST', `${P}/clear`, { reason: 'Customer switched forwarding off', confirm: 'RECORD FORWARDING PROOF' }, ADMIN)).status === 400, 'clear needs its own phrase');
  const cl = await req('POST', `${P}/clear`, { reason: 'Customer switched forwarding off', confirm: 'CLEAR FORWARDING PROOF' }, ADMIN);
  check(cl.status === 200 && cl.body.cleared === true && (await auditCount()) === 2 && (await gate()).forwardingVerifiedForCurrentNumber === false, 'clear → proof removed, audited, gate false');

  // The page itself is admin-only.
  check((await req('GET', '/admin/forwarding-proof', undefined, {})).status === 401, 'admin page requires authentication');
  const page = await req('GET', '/admin/forwarding-proof', undefined, ADMIN);
  check(page.status === 200 && /Support-verified forwarding proof/.test(page.text) && !/innerHTML/.test(page.text), 'admin page served to admins; renders data with textContent only (no innerHTML)');
} finally {
  server.close();
  await db.close();
}
console.log(failures === 0 ? '\nAdmin forwarding proof: all checks hold.' : `\n${failures} check(s) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
