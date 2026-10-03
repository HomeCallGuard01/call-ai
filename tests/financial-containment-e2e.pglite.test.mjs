// Financial containment P0 — END TO END on a real Postgres engine (PGlite):
// the provisional SQL + the real database adapter (database/
// financialContainment.js) + the containment service + the lease sweeper,
// driven against a fake Twilio over a simulated timeline.
// Run with: node tests/financial-containment-e2e.pglite.test.mjs

import { PGlite } from '@electric-sql/pglite';
import { createRequire } from 'node:module';
import { applyAll, pinTestProfiles, rpcClient, rpcs, num } from './financial-containment-harness.mjs';

const require = createRequire(import.meta.url);
const adapter = require('../database/financialContainment');
const { createContainment } = require('../services/containment/containment');
const { createLeaseSweeper } = require('../services/containment/leaseSweeper');
const { createContainmentReadModel } = require('../services/containment/readModel');

let failures = 0;
const check = (c, m) => { if (c) console.log(`✓ ${m}`); else { console.error(`✗ ${m}`); failures++; } };

function clock(startIso = '2026-10-03T09:00:00Z') {
  let t = Date.parse(startIso);
  const now = () => new Date(t);
  now.advance = (sec) => { t += sec * 1000; };
  return now;
}

// Fake Twilio: calls are live until hung up by HCG or ended by the "caller".
function fakeTwilio(now) {
  const calls = new Map();
  return {
    calls,
    start(sid) { calls.set(sid, { status: 'in-progress', startedAt: now().getTime() }); },
    hangUpByCaller(sid) { const c = calls.get(sid); c.status = 'completed'; c.duration = Math.round((now().getTime() - c.startedAt) / 1000); },
    fetchCall: async (sid) => {
      const c = calls.get(sid);
      if (!c) return null;
      return { status: c.status, durationSeconds: c.duration ?? null, live: c.status === 'in-progress', ended: c.status === 'completed' };
    },
    terminate: async (sid) => {
      const c = calls.get(sid);
      if (!c) return { confirmed: true, providerStatus: 'not_live' };
      if (c.status === 'in-progress') { c.status = 'completed'; c.duration = Math.round((now().getTime() - c.startedAt) / 1000); c.terminatedByHcg = true; }
      return { confirmed: true, providerStatus: 'completed' };
    },
  };
}

async function main() {
  const pg = new PGlite();
  await applyAll(pg);
  const q = async (sql, params = []) => (await pg.query(sql, params)).rows;
  await pinTestProfiles(q);
  const mk = async (email) => {
    const id = (await q('insert into public.households (auth_user_id, email) values (null, $1) returning id', [email]))[0].id;
    await q(`insert into public.entitlements (household_id, entitlement_type, status, source, starts_at) values ($1, 'paid_subscription', 'active', 'test', '2026-09-01')`, [id]);
    return { id };
  };
  const A = await mk('a@example.com');
  const B = await mk('b@example.com');
  const C = await mk('c@example.com');
  const mk2 = async (email) => {
    await pg.exec('reset role;');
    const h = await mk(email);
    await pg.exec('set role service_role;');
    return h;
  };
  await pg.exec('set role service_role;');

  // The real adapter, bound to PGlite through a supabase-shaped client,
  // with a switch to simulate a database outage.
  let dbDown = false;
  const client = rpcClient(async (sql, p) => { if (dbDown) throw new Error('connection refused'); return q(sql, p); });
  const db = Object.fromEntries(Object.entries(adapter).map(([k, fn]) => [k, (args) => (k === 'checkInvariants' ? fn(client) : fn(args, client))]));
  const R = rpcs(q);

  const now = clock();
  const tw = fakeTwilio(now);
  const events = [];
  const containment = createContainment({ db, now, recordEvent: async (e) => events.push(e), env: { FC_RPC_TIMEOUT_MS: '2000' } });
  const sweeper = createLeaseSweeper({ containment, db, callControl: tw, now, recordEvent: async (e) => events.push(e) });
  const readModel = createContainmentReadModel({ db, now });
  const period = { periodStart: new Date('2026-10-01T00:00:00Z'), periodEnd: new Date('2026-10-31T00:00:00Z') };
  const voice = async (hh, sid, opts = {}) => {
    const d = await containment.authorizeCall({ household: hh, callSid: sid, from: '+447700900001', isKnown: false, wantsMonitoring: true, signatureValid: true, period, ...opts });
    if (d.allowed) tw.start(sid);
    return d;
  };
  const tick = async (seconds, step = 15) => { for (let s = 0; s < seconds; s += step) { now.advance(step); await sweeper.sweepOnce(); } };

  // 1. Normal monitored call, renewed while live, settled at hang-up.
  const a1 = await voice(A, 'CA-e2e-1');
  check(a1.allowed && a1.monitoring && a1.source === 'database', 'monitored call authorised by the ledger');
  check(await containment.markMonitoringStarted('CA-e2e-1'), 'stream start confirmed against the reservation');
  await tick(600);
  const r1 = await R.reservation('CA-e2e-1');
  check(r1.extensions >= 1 && r1.state === 'active', `live call renewed by the sweeper (${r1.extensions} renewals) while the provider says it is live`);
  tw.hangUpByCaller('CA-e2e-1');
  await containment.settleCall({ callSid: 'CA-e2e-1', source: 'dial_action' });
  const r1s = await R.reservation('CA-e2e-1');
  check(r1s.state === 'settled' && num(r1s.committed_gbp) <= num(r1s.total_authorized_gbp) + 1e-9 && num(r1s.overrun_gbp) === 0,
    `settled: committed £${num(r1s.committed_gbp).toFixed(4)} ≤ authorised £${num(r1s.total_authorized_gbp).toFixed(4)}, no overrun`);

  // 2. Allowance exhausted DURING a live call → ended through the provider at lease end.
  const b1 = await voice(B, 'CA-e2e-2', { wantsMonitoring: false });
  check(b1.allowed, 'call admitted for household B');
  await tick(120);
  await R.adjust(B.id, -1.55, 'e2e-drain-B', { now: now().toISOString() });   // headroom consumed elsewhere mid-call
  const leaseEnd = Date.parse((await R.reservation('CA-e2e-2')).lease_expires_at);
  let cutAt = null;
  for (let i = 0; i < 60 && !cutAt; i++) {
    now.advance(15);
    await sweeper.sweepOnce();
    if (tw.calls.get('CA-e2e-2').terminatedByHcg) cutAt = now().getTime();
  }
  const r2 = await R.reservation('CA-e2e-2');
  check(cutAt && cutAt >= leaseEnd && cutAt - leaseEnd <= 30000, `budget gone mid-call: HCG hung the call up ${Math.round((cutAt - leaseEnd) / 1000)} s after its paid lease ended (never before)`);
  check(r2.state === 'settled' && num(r2.overrun_gbp) === 0, 'terminated call settled within its reservation (no overrun)');
  const v = await readModel.getCustomerAllowanceView(B);
  check(v.state === 'exhausted' && v.callsDelivered === false, 'customer view reports the exhaustion');
  const b2 = await voice(B, 'CA-e2e-3');
  check(!b2.allowed && b2.reason === 'household_budget_exhausted', 'next call refused (<Reject>, unbilled)');

  // 3. Global breaker opens while calls are live → every live call ends within one lease.
  const liveSids = [];
  for (let i = 0; i < 3; i++) { const sid = `CA-e2e-g${i}`; await voice(i % 2 ? C : A, sid, { wantsMonitoring: false }); liveSids.push(sid); }
  await q("select public.fc_set_kill_switch(true, 'e2e: compromise drill', 'tester')");
  const t0 = now().getTime();
  await tick(420);
  const ended = liveSids.filter((s) => tw.calls.get(s).terminatedByHcg);
  check(ended.length === 3, `kill switch: all ${ended.length}/3 live calls ended by HCG within ${Math.round((now().getTime() - t0) / 1000)} s (≤ one lease + sweep)`);
  const killed = await voice(A, 'CA-e2e-k');
  check(!killed.allowed && killed.reason === 'kill_switch', 'new calls refused while the kill switch is on');
  await q("select public.fc_set_kill_switch(false, 'e2e: drill over', 'tester')");

  // 4. Database outage mid-call: degraded admission, local fail-closed termination, adoption on recovery.
  const c1 = await voice(C, 'CA-e2e-o1', { wantsMonitoring: false });
  check(c1.allowed && c1.source === 'database', 'call admitted before the outage');
  dbDown = true;
  const c2 = await voice(C, 'CA-e2e-o2');
  check(c2.allowed && c2.source === 'degraded' && c2.monitoring === false && c2.timeLimitSeconds === 600, 'during the outage: degraded admission, unmonitored, 600 s provider limit');
  await tick(420);
  check(tw.calls.get('CA-e2e-o1').terminatedByHcg === true, 'outage outlasted the paid lease + grace → this instance ended the call itself (fail closed)');
  dbDown = false;
  await tick(30);
  const o1 = await R.reservation('CA-e2e-o1');
  const o2 = await R.reservation('CA-e2e-o2');
  check(o1.state === 'settled', 'after recovery the outage-terminated call is settled in the ledger');
  check(o2 && o2.funding === 'degraded', 'the degraded admission is adopted into the ledger after recovery');
  tw.hangUpByCaller('CA-e2e-o2');
  await tick(400);
  check((await R.reservation('CA-e2e-o2')).state === 'settled', 'adopted call settled from provider status');

  // 5. Lost callback for every call → the sweeper still settles them all.
  const lost = [];
  for (let i = 0; i < 3; i++) { const sid = `CA-e2e-l${i}`; await voice(A, sid, { wantsMonitoring: false }); lost.push(sid); }
  now.advance(60);
  lost.forEach((s) => tw.hangUpByCaller(s));
  await tick(300);
  const lostRows = await q("select count(*)::int n from public.fc_reservations where call_sid = any($1) and state = 'settled' and settle_source = 'provider_status'", [lost]);
  check(lostRows[0].n === 3, 'no Dial callbacks at all: every reservation settled from provider status within one lease');

  // 6. Server restart mid-call: a NEW instance (no local memory) takes over
  //    the lease purely from the database and ends the call when it can no
  //    longer be paid for.
  const instance1 = createContainment({ db, now, recordEvent: async () => {} });
  const r6 = await instance1.authorizeCall({ household: C, callSid: 'CA-e2e-restart', from: '+447700900001', isKnown: false, wantsMonitoring: false, signatureValid: true, period });
  tw.start('CA-e2e-restart');
  check(r6.allowed, 'call admitted by instance 1 (which then "crashes" — its memory is gone)');
  const instance2 = createContainment({ db, now, recordEvent: async () => {} });
  const sweeper2 = createLeaseSweeper({ containment: instance2, db, callControl: tw, now });
  for (let s = 0; s < 300; s += 15) { now.advance(15); await sweeper2.sweepOnce(); }
  check((await R.reservation('CA-e2e-restart')).extensions >= 1, 'after the restart the new instance renews the lease from the database alone');
  await R.adjust(C.id, -1.6, 'e2e-drain-C', { now: now().toISOString() });
  for (let s = 0; s < 420 && !tw.calls.get('CA-e2e-restart').terminatedByHcg; s += 15) { now.advance(15); await sweeper2.sweepOnce(); }
  check(tw.calls.get('CA-e2e-restart').terminatedByHcg === true, '…and ends it via the provider when renewal is refused');

  // 7. Provider status API failing: renew conservatively (assume live) and
  //    still terminate when unaffordable — never "unknown ⇒ free".
  const flaky = { ...tw, fetchCall: async () => { throw new Error('Twilio 503'); } };
  const sweeper3 = createLeaseSweeper({ containment, db, callControl: flaky, now });
  const A2 = await mk2('a2@example.com');
  const r7 = await voice(A2, 'CA-e2e-flaky', { wantsMonitoring: false });
  check(r7.allowed, 'call admitted while the provider status API is failing');
  for (let s = 0; s < 300; s += 15) { now.advance(15); await sweeper3.sweepOnce(); }
  check((await R.reservation('CA-e2e-flaky')).extensions >= 1, 'provider status unreadable → lease renewed (treated as live and paid for, not as ended)');

  const inv = await R.invariants();
  check(inv.ok === true, 'ledger invariants hold after the whole timeline');
  tw.hangUpByCaller('CA-e2e-flaky');
  await containment.settleCall({ callSid: 'CA-e2e-flaky', source: 'dial_action' });
  const gl = await readModel.getAdminGlobalView();
  check(gl.available && gl.activeCount === 0 && num(gl.activeReservedGbp) === 0, 'admin global view: nothing left live or reserved');

  if (failures) { console.error(`\n${failures} check(s) FAILED`); process.exit(1); }
  console.log('\nAll financial-containment end-to-end checks passed.');
}

main().catch((err) => { console.error(err); process.exit(1); });
