// Financial containment P0 — TRUE concurrency against a real PostgreSQL
// server with many simultaneous connections (each connection stands in for
// a separate server instance). PGlite (single connection) can't prove this.
//
// Needs `embedded-postgres` and `pg`, which are NOT project dependencies
// (they download a Postgres binary). Install them anywhere outside the repo
// and point FC_REALPG_MODULES at that directory:
//
//   mkdir -p /tmp/realpg && cd /tmp/realpg && npm init -y && npm i embedded-postgres pg
//   FC_REALPG_MODULES=/tmp/realpg node tests/financial-containment-realpg.test.mjs
//
// Without FC_REALPG_MODULES the test SKIPS (exit 0) and says so loudly.

import { createRequire } from 'node:module';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import { applyAll, pinTestProfiles, rpcs, at, num, POLICY } from './financial-containment-harness.mjs';

const modules = process.env.FC_REALPG_MODULES;
if (!modules) {
  console.log('⚠ SKIPPED: FC_REALPG_MODULES not set — real multi-connection race test not run (see file header).');
  process.exit(0);
}
const req = createRequire(path.join(modules, 'package.json'));
const EmbeddedPostgres = req('embedded-postgres').default || req('embedded-postgres');
const pg = req('pg');

let failures = 0;
const check = (c, m) => { if (c) console.log(`✓ ${m}`); else { console.error(`✗ ${m}`); failures++; } };

const PORT = 54000 + Math.floor(Math.random() * 900);
const CONNECTIONS = 12;

async function main() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fc-realpg-'));
  const server = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'pw', port: PORT, persistent: false, onLog: () => {}, onError: () => {} });
  await server.initialise();
  await server.start();
  const cfg = { host: 'localhost', port: PORT, user: 'postgres', password: 'pw', database: 'postgres' };
  const admin = new pg.Client(cfg);
  await admin.connect();
  const adminDb = { exec: (sql) => admin.query(sql), query: (sql, p) => admin.query(sql, p) };
  try {
    await applyAll(adminDb);
    await pinTestProfiles(async (sql, p) => (await admin.query(sql, p)).rows);
    check(true, `provisional SQL applies on real ${(await admin.query('select version()')).rows[0].version.split(' on ')[0]}`);

    const mk = async (email) => {
      const id = (await admin.query('insert into public.households (auth_user_id, email) values (null, $1) returning id', [email])).rows[0].id;
      await admin.query(`insert into public.entitlements (household_id, entitlement_type, status, source, starts_at) values ($1, 'paid_subscription', 'active', 'test', '2026-09-01')`, [id]);
      return id;
    };

    // One client per "server instance", each acting as service_role.
    const conns = [];
    for (let i = 0; i < CONNECTIONS; i++) {
      const c = new pg.Client(cfg);
      await c.connect();
      await c.query('set role service_role');
      conns.push(rpcs(async (sql, params) => (await c.query(sql, params)).rows));
      conns[i].client = c;
    }
    const A = rpcs(async (sql, params) => (await admin.query(sql, params)).rows);

    // 1. £0.20 left, 10 simultaneous calls on 10 different connections.
    const tiny = await mk('tiny@example.com');
    await A.adjust(tiny, -1.4, 'realpg-tiny');
    for (let round = 0; round < 5; round++) {
      const res = await Promise.all(Array.from({ length: 10 }, (_, i) => conns[i].authorize(tiny, `CA-tiny-r${round}-${i}`, { now: at(round * 1000) })));
      const live = (await admin.query("select coalesce(sum(reserved_gbp),0) res, coalesce(sum(worst_case_gbp),0) worst, count(*)::int n from public.fc_reservations where household_id = $1 and state = 'active'", [tiny])).rows[0];
      const acc = (await admin.query('select * from public.fc_budget_accounts where household_id = $1', [tiny])).rows[0];
      const headroom = 1.6 + num(acc.adjustments_gbp) - num(acc.consumed_gbp);
      check(num(live.res) <= headroom + 1e-9 && num(live.worst) <= headroom + 1e-9 && res.some((r) => r.allowed),
        `round ${round}: 10 concurrent connections, ${res.filter((r) => r.allowed).length} admitted — Σ reserved £${num(live.res).toFixed(4)}, Σ worst £${num(live.worst).toFixed(4)} ≤ headroom £${headroom.toFixed(4)}`);
      for (let i = 0; i < 10; i++) if (res[i].allowed) await A.settle(`CA-tiny-r${round}-${i}`, 20, at(round * 1000 + 30));
    }
    const tinyAcc = (await admin.query('select * from public.fc_budget_accounts where household_id = $1', [tiny])).rows[0];
    check(num(tinyAcc.consumed_gbp) <= 0.2 + 1e-9, `after 50 racing calls the household consumed £${num(tinyAcc.consumed_gbp).toFixed(4)} ≤ its £0.20`);

    // 2. Same CallSid delivered to 12 instances at once (duplicate webhook race).
    const dup = await mk('dup@example.com');
    const d = await Promise.all(conns.map((c) => c.authorize(dup, 'CA-dup-1', { mon: true, now: at(10) })));
    const dupRows = (await admin.query("select count(*)::int n from public.fc_reservations where call_sid = 'CA-dup-1'")).rows[0].n;
    check(dupRows === 1 && new Set(d.map((r) => r.timeLimitSeconds)).size === 1 && d.filter((r) => !r.existing).length === 1,
      'duplicate /voice for one CallSid on 12 connections at once: exactly one reservation, one winner, identical time limits');

    // 3. Global live-call cap under a 48-call race across 24 households.
    await A.setPolicy({ global_active_floor: 10 });
    const hhs = [];
    for (let i = 0; i < 24; i++) hhs.push(await mk(`g${i}@example.com`));
    const before = (await A.globalStatus(at(20))).activeCount;
    const g = await Promise.all(Array.from({ length: 48 }, (_, i) => conns[i % CONNECTIONS].authorize(hhs[i % 24], `CA-g-${i}`, { now: at(20) })));
    const gs = await A.globalStatus(at(21));
    check(gs.activeCount <= 10 && g.filter((r) => r.allowed).length === 10 - before,
      `48 simultaneous calls across 24 households, global cap 10: live calls = ${gs.activeCount} (never above the cap)`);

    // 4. Two (and more) sweeper instances renewing the same leases at once.
    const liveSids = (await admin.query("select call_sid from public.fc_reservations where state = 'active' and call_sid like 'CA-g-%'")).rows.map((r) => r.call_sid);
    const renewAt = at(20 + POLICY.lease - 60);
    const rr = await Promise.all(liveSids.flatMap((sid) => conns.slice(0, 4).map((c) => c.renew(sid, renewAt))));
    const ext = (await admin.query("select max(extensions)::int mx, min(extensions)::int mn from public.fc_reservations where call_sid = any($1)", [liveSids])).rows[0];
    check(ext.mx === 1 && ext.mn === 1 && rr.filter((r) => r.action === 'renewed').length === liveSids.length,
      `4 sweeper instances renewing ${liveSids.length} leases concurrently: each lease extended exactly once`);

    // 5. Settle racing renew + duplicate settles on many connections.
    const race = liveSids.slice(0, 5);
    await Promise.all(race.flatMap((sid, k) => [
      conns[k].settle(sid, 90, at(400)),
      conns[k + 5].settle(sid, 9999, at(401)),
      conns[(k + 7) % CONNECTIONS].renew(sid, at(20 + 2 * POLICY.lease - 60)),
    ]));
    const settled = (await admin.query("select count(*)::int n, count(distinct settled_duration_seconds)::int d from public.fc_reservations where call_sid = any($1) and state = 'settled'", [race])).rows[0];
    const commits = (await admin.query("select count(*)::int n from public.fc_ledger where call_sid = any($1) and entry_type = 'commit'", [race])).rows[0].n;
    check(settled.n === 5 && commits === 5, 'settle racing a duplicate settle and a renewal: each call committed exactly once');

    // 6. Duplicate provider-actual records racing on every connection.
    const act = await Promise.all(conns.map((c) => c.actual('CAparent-race', race[0], 'call', 0.9, at(500))));
    const actRows = (await admin.query("select count(*)::int n from public.fc_ledger where provider_ref = 'CAparent-race' and entry_type = 'actual'")).rows[0].n;
    check(actRows === 1 && act.filter((r) => !r.duplicate).length === 1, 'provider actual cost delivered 12× concurrently: recorded and charged once');

    // 7. Breaker trip racing many authorisations: once open, nothing slips through.
    const pre = await A.globalStatus(at(600));
    const preSpend = num(pre.window.hourCommitted) + num(pre.activeReservedGbp);
    const cap = Math.round((preSpend + 0.6) * 10000) / 10000;
    await A.setPolicy({ global_hourly_floor_gbp: cap, global_active_floor: 100 });
    const storm = await Promise.all(Array.from({ length: 60 }, (_, i) => conns[i % CONNECTIONS].authorize(hhs[i % 24], `CA-storm-${i}`, { now: at(600) })));
    const st = await A.globalStatus(at(601));
    const w = st.window;
    check(st.breakerOpen && storm.some((r) => r.allowed) && num(w.hourCommitted) + num(st.activeReservedGbp) <= cap + 1e-9,
      `60-call storm on 12 connections: ${storm.filter((r) => r.allowed).length} admitted, then the breaker opened; committed + in-flight £${(num(w.hourCommitted) + num(st.activeReservedGbp)).toFixed(4)} never exceeded the £${cap} hourly cap`);
    check(storm.filter((r) => !r.allowed).every((r) => ['global_hourly_cap', 'breaker_open'].includes(r.reason)), 'every storm refusal is the breaker, never an error');

    // 8. Counters still consistent after all of the above.
    const inv = await A.invariants();
    check(inv.ok === true, `invariants hold after the races (${JSON.stringify(inv)})`);

    for (const c of conns) await c.client.end();
  } finally {
    await admin.end().catch(() => {});
    await server.stop().catch(() => {});
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  if (failures) { console.error(`\n${failures} check(s) FAILED`); process.exit(1); }
  console.log('\nAll real-Postgres concurrency checks passed.');
}

main().catch((err) => { console.error(err); process.exit(1); });
