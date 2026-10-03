// Launch Fortress — integrated adversarial suite (2026-10-03).
//
// The REAL server.js (signature guard → webhook integrity → abuse screening →
// 056 admission → Financial Fortress reservation → trusted decision →
// monitoring decision → <Dial timeLimit>) against the REAL SQL of every
// migration (056, 066, 067, 068 …) on PGlite, through a local PostgREST-shaped
// fake (tests/helpers/pgliteRestBridge.mjs). No provider credentials, no
// network. Scenario numbers refer to the integration brief's list (§18) and
// docs/integration/2026-10-03-LAUNCH_GATE_RESULT.md.
//
// LIMITS (stated, not hidden): PGlite is one connection, so "simultaneous"
// calls are interleaved by the single database session — this proves the
// pipeline and the SQL rules, not multi-server races (see
// tests/financial-containment-realpg.test.mjs). No Twilio REST client exists
// here, so the lease sweeper does not run (its behaviour is proven in
// tests/financial-containment-e2e.pglite.test.mjs).
import { spawn } from 'node:child_process';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createFortressBridge } from './helpers/pgliteRestBridge.mjs';

const require = createRequire(import.meta.url);
const twilio = require('twilio');
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
const results = [];
const check = (c, m) => { results.push([c, m]); if (c) console.log(`✓ ${m}`); else { console.error(`✗ ${m}`); failures++; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const AUTH_TOKEN = 'test_twilio_auth_token_fortress';
const APP_URL = 'https://hcg.test';
const hhIds = Array.from({ length: 12 }, (_, i) => `00000000-0000-4000-8000-0000000000${String(i + 10)}`);
const households = hhIds.map((id, i) => ({
  id, twilio_number: `+44161555030${String(i).padStart(2, '0')}`.slice(0, 13), phone_number: `+44770090030${i % 10}`,
  email: `fortress-${i}@example.invalid`, voice_client_registered_at: new Date().toISOString(), auth_user_id: null, activation_verified_at: null,
}));
households.forEach((h, i) => { h.twilio_number = `+4416155503${String(i).padStart(2, '0')}`; });
const H = Object.fromEntries(['budget', 'sameCaller', 'flood', 'kill', 'trust', 'dup', 'outage', 'globalA', 'globalB', 'hold', 'incident', 'spare'].map((k, i) => [k, households[i]]));
const TRUSTED = '+447700900555';
const contacts = [
  { id: 'c1', household_id: H.trust.id, name: 'UK legacy row', number: '7700900555' },
  { id: 'c2', household_id: H.flood.id, name: 'UK legacy row', number: '7700900555' },
  { id: 'c3', household_id: H.kill.id, name: 'UK legacy row', number: '7700900555' },
  { id: 'c4', household_id: H.trust.id, name: 'personal 070', number: '7012345678' },
  { id: 'c5', household_id: H.trust.id, name: 'pager 076', number: '7612345678' },
  { id: 'c6', household_id: H.trust.id, name: 'revenue 087', number: '8712345678' },
  { id: 'c7', household_id: H.trust.id, name: 'premium 09', number: '9098790123' },
];

const bridge = await createFortressBridge({
  households,
  entitlements: households.map((h) => ({ household_id: h.id, source: 'stripe' })),
  profile: { budget: 50, reserve: 5, scope: 'trusted_only', essential: 0.1 },
});
const q = bridge.q;
const fault = { rpcDown: false, allDown: false };
// Every household shares the pinned 'standard' profile (£50 budget, £5
// trusted-only reserve). A scenario gives its household an effective budget
// with the REAL audited mechanism (fc_admin_adjust), never a test-only path.
let adjustN = 0;
async function budgetTo(hh, targetGbp) {
  await q('select public.fc_admin_adjust($1,$2,$3,$4,$5,$6,$7,$8,$9)', [hh.id, targetGbp - 50, 'integration scenario budget', 'tester', `scenario-${++adjustN}`, 'test', null, null, new Date().toISOString()]);
}

function startFakeSupabase() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', async () => {
        const u = new URL(req.url, 'http://x');
        res.setHeader('content-type', 'application/json');
        if (u.pathname.startsWith('/v1/')) { res.end(JSON.stringify({ text: '' })); return; }
        if (fault.allDown) { res.statusCode = 503; res.end(JSON.stringify({ message: 'database unavailable' })); return; }
        if (u.pathname.startsWith('/rest/v1/rpc/')) {
          if (fault.rpcDown) { res.statusCode = 503; res.end(JSON.stringify({ message: 'database unavailable' })); return; }
          const r = await bridge.rpc(u.pathname.slice('/rest/v1/rpc/'.length), body);
          res.statusCode = r.status; res.end(r.body); return;
        }
        const table = u.pathname.replace('/rest/v1/', '');
        const single = String(req.headers.accept || '').includes('vnd.pgrst.object');
        let rows = [];
        if (req.method === 'GET') {
          if (table === 'households') {
            const inList = /twilio_number=in\.\(([^)]*)\)/.exec(decodeURIComponent(u.search));
            const idEq = /id=eq\.([^&]+)/.exec(u.search);
            rows = households
              .filter((h) => !inList || inList[1].split(',').map((s) => s.replace(/"/g, '')).includes(h.twilio_number))
              .filter((h) => !idEq || h.id === decodeURIComponent(idEq[1]));
          } else if (table === 'contacts') {
            const hh = /household_id=eq\.([^&]+)/.exec(u.search);
            rows = hh ? contacts.filter((c) => c.household_id === decodeURIComponent(hh[1])) : contacts;
          } else if (table === 'entitlements') {
            const hh = /household_id=eq\.([^&]+)/.exec(u.search);
            const id = hh ? decodeURIComponent(hh[1]) : households[0].id;
            rows = [{ id: `e-${id}`, household_id: id, status: 'active', entitlement_type: 'paid_subscription', source: 'stripe', starts_at: '2026-09-01T00:00:00Z', ends_at: null }];
          }
        }
        if (single) {
          if (rows.length) res.end(JSON.stringify(rows[0])); else { res.statusCode = 406; res.end(JSON.stringify({ code: 'PGRST116' })); }
          return;
        }
        res.statusCode = req.method === 'POST' ? 201 : 200;
        res.end(JSON.stringify(rows));
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

function request(port, method, p, { headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { host: 'hcg.test', ...headers, 'content-length': Buffer.byteLength(body) } }, (res) => {
      let text = ''; res.on('data', (c) => { text += c; }); res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject); req.end(body);
  });
}
async function bootServer(supabasePort, extraEnv = {}) {
  const port = 42000 + Math.floor(Math.random() * 7000);
  const env = {
    PATH: process.env.PATH, NODE_ENV: 'test', PORT: String(port),
    SUPABASE_URL: `http://127.0.0.1:${supabasePort}`, SUPABASE_ANON_KEY: 'anon-test', SUPABASE_SERVICE_ROLE_KEY: 'service-test',
    // No TWILIO_ACCOUNT_SID: the server must build NO provider REST client here
    // (no outbound attempt to the provider from a test, ever).
    APP_URL, TWILIO_AUTH_TOKEN: AUTH_TOKEN,
    OPENAI_API_KEY: 'sk-test-local-stub', OPENAI_BASE_URL: `http://127.0.0.1:${supabasePort}/v1`,
    ...extraEnv,
  };
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  for (let i = 0; i < 100; i++) {
    await sleep(100);
    try { await request(port, 'GET', '/health'); return { port, child, logs: () => out }; } catch { /* not up */ }
  }
  throw new Error(`server.js did not start:\n${out.slice(-2000)}`);
}
const form = (params) => new URLSearchParams(params).toString();
function post(port, p, params, { sign = true } = {}) {
  const headers = { 'content-type': 'application/x-www-form-urlencoded' };
  if (sign) headers['x-twilio-signature'] = twilio.getExpectedTwilioSignature(AUTH_TOKEN, `https://hcg.test${p}`, params);
  return request(port, 'POST', p, { headers, body: form(params) });
}
let n = 0;
const sid = () => `CA${(++n).toString(16).padStart(8, '0')}${'ab12cd34'}${'0'.repeat(16)}`;
const voice = (port, hh, from, over = {}) => { const params = { CallSid: sid(), From: from, To: hh.twilio_number, AccountSid: 'ACtest', Direction: 'inbound', ...over }; return post(port, '/voice', params).then((r) => ({ ...r, params })); };
const ended = (port, callSid, duration = '5') => post(port, '/call-delivery-failed', { CallSid: callSid, DialCallStatus: 'completed', DialCallDuration: duration, AccountSid: 'ACtest' });
const isReject = (t) => /<Reject/.test(t) && !/<Dial|<Stream/.test(t);
const connects = (t, hh) => new RegExp(`<Client>household_${hh.id}</Client>`).test(t);
const monitored = (t) => /<Stream /.test(t);
const timeLimit = (t) => { const m = /timeLimit="(\d+)"/.exec(t); return m ? Number(m[1]) : null; };
const reservations = async (hh) => (await q("select count(*)::int n, coalesce(sum(reserved_gbp),0)::float s from public.fc_reservations where household_id = $1 and state in ('active','terminating')", [hh.id]))[0];
const reservationRows = async (callSid) => (await q("select count(*)::int n from public.fc_reservations where idempotency_key = 'call:' || $1", [callSid]))[0].n;

const supa = await startFakeSupabase();
const supaPort = supa.address().port;
await q('select public.fc_refresh_entitled_count($1)', [new Date().toISOString()]);
const main = await bootServer(supaPort);
const { port } = main;

try {
  // ── 1 / 30: 10 simultaneous calls, nearly exhausted household budget ──
  await budgetTo(H.budget, 0.15);
  const ten = await Promise.all(Array.from({ length: 10 }, (_, i) => voice(port, H.budget, `+4477009007${String(i).padStart(2, '0')}`)));
  const okTen = ten.filter((r) => connects(r.text, H.budget));
  const resv = await reservations(H.budget);
  check(okTen.length >= 1 && okTen.length <= 2 && ten.filter((r) => isReject(r.text)).length === 10 - okTen.length,
    `S1/S30: 10 simultaneous calls on £0.15 → ${okTen.length} connected (≤ 2 leases fit), the rest <Reject> (unbilled)`);
  check(resv.s <= 0.15 + 1e-9, `S1: Σ reserved £${resv.s.toFixed(4)} never exceeds the £0.15 household budget (no double spend of the same balance)`);
  check(okTen.every((r) => timeLimit(r.text) && timeLimit(r.text) <= 14400), 'every admitted call carries a provider-enforced <Dial timeLimit> backstop');
  for (const r of okTen) await ended(port, r.params.CallSid);

  // ── 2: 10 simultaneous calls from the SAME caller ──
  const same = await Promise.all(Array.from({ length: 10 }, () => voice(port, H.sameCaller, '+447700900801')));
  const okSame = same.filter((r) => connects(r.text, H.sameCaller)).length;
  check(okSame >= 1 && okSame <= 2, `S2: 10 simultaneous calls from one caller → ${okSame} connected (per-caller concurrency 2, claimed atomically), the rest refused`);
  for (const r of same.filter((x) => connects(x.text, H.sameCaller))) await ended(port, r.params.CallSid);

  // ── 3 / 4: many callers flood one household; trusted callers survive ──
  await budgetTo(H.flood, 0.25);
  const flood = [];
  for (let i = 0; i < 40; i++) {
    const r = await voice(port, H.flood, `+4477009009${String(i).padStart(2, '0')}`);
    flood.push(r);
    if (connects(r.text, H.flood)) await ended(port, r.params.CallSid);
  }
  const delivered = flood.filter((r) => connects(r.text, H.flood)).length;
  const refused = flood.filter((r) => isReject(r.text)).length;
  check(delivered > 0 && refused > 0 && delivered + refused === 40, `S3: 40-caller flood → ${delivered} delivered until the household £ budget is spent, then ${refused} refused (cost bounded)`);
  const committed = (await q("select coalesce(sum(committed_gbp),0)::float c from public.fc_reservations where household_id = $1", [H.flood.id]))[0].c;
  check(committed <= 0.25 + 1e-6, `S3: the flood's committed cost £${committed.toFixed(4)} stays within the household budget`);
  const trustedDuringFlood = await voice(port, H.flood, TRUSTED);
  check(connects(trustedDuringFlood.text, H.flood) && !monitored(trustedDuringFlood.text), 'S4: a trusted caller is still delivered after an unknown-caller flood exhausted the budget (delivery reserve is trusted-only → no victim lockout)');
  await ended(port, trustedDuringFlood.params.CallSid);
  const unknownAfter = await voice(port, H.flood, '+447700900999');
  check(isReject(unknownAfter.text), 'S4: … while unknown callers stay refused (the reserve is not theirs)');

  // ── 6 / 7 / 8: trust can never be obtained by spoofing or number class ──
  const trustOk = await voice(port, H.trust, TRUSTED);
  check(connects(trustOk.text, H.trust) && !monitored(trustOk.text), 'control: a genuine trusted CLI gets the monitoring bypass (still reserved/authorised)');
  await ended(port, trustOk.params.CallSid);
  const malformed = await voice(port, H.trust, '+44+7700900555');
  check(connects(malformed.text, H.trust) && monitored(malformed.text), 'S6: a malformed CLI resembling a trusted contact is delivered but NEVER trusted (monitored)');
  await ended(port, malformed.params.CallSid);
  const spoofStir = await voice(port, H.trust, TRUSTED, { StirVerstat: 'TN-Validation-Failed-A' });
  check(connects(spoofStir.text, H.trust) && monitored(spoofStir.text), 'S6: a trusted CLI with failed STIR verification loses the bypass');
  await ended(port, spoofStir.params.CallSid);
  const fr = await voice(port, H.trust, '+337700900555');
  check(connects(fr.text, H.trust) && monitored(fr.text), 'S7: +33 7700 900555 does not match the UK trusted 07700 900555 (full E.164)');
  await ended(port, fr.params.CallSid);
  for (const [label, cli] of [['070 personal', '+447012345678'], ['076 pager', '+447612345678'], ['087 revenue-share', '+448712345678'], ['09 premium', '+449098790123']]) {
    const r = await voice(port, H.trust, cli);
    check(!(connects(r.text, H.trust) && !monitored(r.text)), `S8: a ${label} CLI stored as a "trusted contact" never gets the bypass`);
    if (connects(r.text, H.trust)) await ended(port, r.params.CallSid);
    check(!/<Number|<Sip/.test(r.text), `S8/S9: no outbound leg is ever created to a ${label} number`);
  }

  // ── 10: forwarding loop ──
  check(isReject((await voice(port, H.trust, H.spare.twilio_number)).text), 'S10: an HCG number calling an HCG number → <Reject>');
  check(isReject((await voice(port, H.trust, H.trust.twilio_number)).text), 'S10: From == To → <Reject>');

  // ── 11 / 12: duplicate + captured signed replay ──
  const dupParams = { CallSid: sid(), From: '+447700900611', To: H.dup.twilio_number, AccountSid: 'ACtest', Direction: 'inbound' };
  const d1 = await post(port, '/voice', dupParams);
  const d2 = await post(port, '/voice', dupParams);
  check(d1.text === d2.text && (await reservationRows(dupParams.CallSid)) === 1, 'S11/S12: a duplicate/replayed signed /voice gets identical TwiML and exactly ONE reservation (no second token, count or spend)');
  await ended(port, dupParams.CallSid);

  // ── 13: unsigned webhook ──
  const unsignedParams = { CallSid: sid(), From: TRUSTED, To: H.trust.twilio_number, AccountSid: 'ACtest' };
  const unsigned = await post(port, '/voice', unsignedParams, { sign: false });
  check(unsigned.status === 403 && (await reservationRows(unsignedParams.CallSid)) === 0, 'S13: unsigned /voice (even from a trusted CLI) → 403, nothing reserved');

  // ── 16: forged call-ended cannot free a live call's lease ──
  const live = await voice(port, H.dup, '+447700900612');
  const forgedEnd = await post(port, '/call-delivery-failed', { CallSid: live.params.CallSid, DialCallStatus: 'completed', DialCallDuration: '1', AccountSid: 'ACtest' }, { sign: false });
  const stillActive = (await q("select state from public.fc_reservations where idempotency_key = 'call:' || $1", [live.params.CallSid]))[0];
  check(forgedEnd.status === 403 && stillActive && stillActive.state === 'active', 'S16: a forged (unsigned) call-ended → 403; the live reservation stays active');
  await ended(port, live.params.CallSid);
  let settled = null;
  for (let i = 0; i < 40 && !(settled && settled.state === 'settled'); i++) { // settlement is fire-and-forget after the response
    await sleep(50);
    settled = (await q("select state from public.fc_reservations where idempotency_key = 'call:' || $1", [live.params.CallSid]))[0];
  }
  check(settled && settled.state === 'settled', 'control: the genuine signed call-ended settles it');

  // ── 29: customer below cap, global cap reached ──
  await q(`select public.fc_set_policy($1::jsonb, 'integration: tiny global live cap', 'tester')`, [JSON.stringify({ global_active_floor: 1, global_active_households_per_call: 1000 })]);
  await q('select public.fc_refresh_entitled_count($1)', [new Date().toISOString()]);
  const g1 = await voice(port, H.globalA, '+447700900701');
  const g2 = await voice(port, H.globalB, '+447700900702');
  const g2t = await voice(port, H.globalB, TRUSTED);
  check(connects(g1.text, H.globalA) && isReject(g2.text) && isReject(g2t.text), 'S29: global live-call cap reached → another household (even a trusted caller) is refused although its own budget is untouched');
  await ended(port, g1.params.CallSid);
  await q(`select public.fc_set_policy($1::jsonb, 'integration: restore global live cap', 'tester')`, [JSON.stringify({ global_active_floor: 20, global_active_households_per_call: 5 })]);

  // ── 5 / 50: trusted caller during the kill switch (full emergency stop) ──
  await q("select public.fc_set_kill_switch(true, 'integration emergency stop', 'tester')");
  await sleep(5200); // incident mode reads the Fortress state with a 5 s cache
  const killTrusted = await voice(port, H.kill, TRUSTED);
  const killUnknown = await voice(port, H.kill, '+447700900703');
  check(isReject(killTrusted.text) && isReject(killUnknown.text), 'S5/S50: kill switch on → every call refused, the trusted caller included (trust never bypasses the global stop)');
  check(/incident_mode_full_stop|kill_switch/.test(main.logs()), 'S50: the stop is visible in the audit as one incident state (incident_mode_full_stop / kill_switch)');
  await q("select public.fc_set_kill_switch(false, 'integration emergency stop over', 'tester')");
  await sleep(5200);
  const afterKill = await voice(port, H.kill, TRUSTED);
  check(connects(afterKill.text, H.kill), 'S50: after the audited reset, delivery resumes');
  await ended(port, afterKill.params.CallSid);

  // ── 21: database outage at admission ──
  fault.rpcDown = true;
  const deg = await voice(port, H.outage, '+447700900801');
  check(connects(deg.text, H.outage) && !monitored(deg.text) && timeLimit(deg.text) && timeLimit(deg.text) <= 600,
    `S21: Fortress authority unreachable → bounded degraded envelope: delivered UNMONITORED with timeLimit ${timeLimit(deg.text)} s ≤ 600`);
  const degMore = [];
  for (let i = 0; i < 4; i++) degMore.push(await voice(port, H.outage, `+44770090082${i}`));
  check(degMore.some((r) => isReject(r.text)), 'S21: the degraded envelope is bounded (per-instance concurrency) — further calls are refused');
  fault.rpcDown = false;
  fault.allDown = true;
  const total = await voice(port, H.outage, '+447700900830');
  check(isReject(total.text), 'S21/D: whole database unavailable → the household cannot be resolved → <Reject> (unbilled; customer misses the call)');
  fault.allDown = false;

  // ── invariants after every attack above ──
  const inv = (await q('select public.fc_check_invariants() as r'))[0].r;
  check(inv && (inv.ok === true || inv.violations === 0 || (Array.isArray(inv.violations) && inv.violations.length === 0)), `Fortress invariants hold after the whole run (${JSON.stringify(inv).slice(0, 160)})`);
} finally {
  main.child.kill();
}

// ── 48 / 49: account hold and incident modes (separate boots) ──
{
  const s = await bootServer(supaPort, { ABUSE_HELD_HOUSEHOLD_IDS: H.hold.id });
  try {
    const r = await voice(s.port, H.hold, TRUSTED);
    check(isReject(r.text), 'S48: a household under an abuse hold → <Reject> (trusted callers included)');
    const other = await voice(s.port, H.spare, '+447700900901');
    check(connects(other.text, H.spare), 'S48: other households are unaffected by one hold');
    await ended(s.port, other.params.CallSid);
  } finally { s.child.kill(); }
}
for (const [level, delivered, mon] of [['contain', true, true], ['suspend_paid', true, false], ['full_stop', false, false]]) {
  const s = await bootServer(supaPort, { HCG_INCIDENT_MODE: level });
  try {
    const r = await voice(s.port, H.incident, '+447700900902');
    check(connects(r.text, H.incident) === delivered && monitored(r.text) === mon, `S49: HCG_INCIDENT_MODE=${level} → delivered=${delivered}, new paid monitoring=${mon}`);
    if (connects(r.text, H.incident)) await ended(s.port, r.params.CallSid);
  } finally { s.child.kill(); }
}

supa.close();
await bridge.close();
console.log(`\n${failures === 0 ? 'All launch-fortress integration checks passed' : `${failures} launch-fortress integration check(s) FAILED`} (${results.length} checks)`);
process.exitCode = failures === 0 ? 0 : 1;
