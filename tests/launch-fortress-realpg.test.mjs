// Launch Fortress — real multi-connection PostgreSQL races for the parts the
// Fortress realpg suite does not cover (integration 2026-10-03):
//   - S45 account-number race: concurrent sign-ups on 12 connections;
//   - S46/S47 routing: one number claimed for two households at once;
//   - S41 top-up replay race through the 068 £ bridge (credit + fc_admin_adjust);
//   - S31 number-purchase double-click: claim_number_provisioning (066);
//   - top-ups racing call authorisations on an exhausted budget.
//
// Opt-in exactly like tests/financial-containment-realpg.test.mjs: set
// FC_REALPG_MODULES to a directory with `embedded-postgres` and `pg`
// installed (OUTSIDE the repo). Without it the test SKIPS (exit 0), loudly.
import { createRequire } from 'node:module';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import { applyAll, pinTestProfiles } from './financial-containment-harness.mjs';

const modules = process.env.FC_REALPG_MODULES;
if (!modules) {
  console.log('⚠ SKIPPED: FC_REALPG_MODULES not set — launch-fortress real multi-connection races not run (see file header).');
  process.exit(0);
}
const req = createRequire(path.join(modules, 'package.json'));
const EmbeddedPostgres = req('embedded-postgres').default || req('embedded-postgres');
const pg = req('pg');
const require = createRequire(import.meta.url);
const { parseAccountNumber } = require('../services/customerIdentity/accountNumber.js');

let failures = 0;
const check = (c, m) => { if (c) console.log(`✓ ${m}`); else { console.error(`✗ ${m}`); failures++; } };
const PORT = 55000 + Math.floor(Math.random() * 900);
const N = 12;
const NOW = Date.now();
const PERIOD = [new Date(NOW - 86400e3).toISOString(), new Date(NOW + 29 * 86400e3).toISOString()];

async function main() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lf-realpg-'));
  const server = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'pw', port: PORT, persistent: false, onLog: () => {}, onError: () => {} });
  await server.initialise();
  await server.start();
  const cfg = { host: 'localhost', port: PORT, user: 'postgres', password: 'pw', database: 'postgres' };
  const admin = new pg.Client(cfg);
  await admin.connect();
  const conns = [];
  try {
    await applyAll({ exec: (sql) => admin.query(sql), query: (sql, p) => admin.query(sql, p) });
    await pinTestProfiles(async (sql, p) => (await admin.query(sql, p)).rows);
    check(true, `every migration 046–070 applies on real ${(await admin.query('select version()')).rows[0].version.split(' on ')[0]}`);
    for (let i = 0; i < N; i++) { const c = new pg.Client(cfg); await c.connect(); conns.push(c); }

    // ── S45: account-number race ─────────────────────────────────────────
    // 12 workers (one connection each) × 5 sequential sign-ups, all racing.
    const perWorker = await Promise.all(conns.map(async (c, w) => {
      const out = [];
      for (let k = 0; k < 5; k++) out.push((await c.query('insert into public.households (auth_user_id, email) values (null, $1) returning id, account_number', [`race-${w}-${k}@example.com`])).rows[0]);
      return out;
    }));
    const signups = perWorker.flat();
    const nums = signups.map((r) => r.account_number);
    check(new Set(nums).size === 60 && nums.every((n) => parseAccountNumber(n).valid), 'S45: 60 sign-ups racing on 12 connections → 60 distinct, check-digit-valid account numbers');
    const reg = (await admin.query('select count(*)::int n from public.hcg_account_numbers')).rows[0].n;
    check(reg >= 60, `S45: every issued number is in the append-only registry (${reg})`);

    // ── S46/S47: one number, two households, simultaneously ──────────────
    for (const c of conns) await c.query('set role service_role');
    const [hA, hB] = [signups[0].id, signups[1].id];
    const claim = (c, h) => c.query("select public.routing_assignment_create($1, 'twilio', 'provisioning', 'purchased', 'race-test', null, '+441615559000')", [h])
      .then(() => 'ok').catch((e) => (/already held by another household|duplicate key/.test(e.message) ? 'refused' : `error:${e.message}`));
    const routeRace = await Promise.all(Array.from({ length: N }, (_, i) => claim(conns[i], i % 2 ? hA : hB)));
    const holders = (await admin.query("select count(distinct household_id)::int n from public.routing_assignments where e164_number = '+441615559000' and state not in ('released')")).rows[0].n;
    check(holders === 1 && routeRace.every((r) => r === 'ok' || r === 'refused'), `S46: one routing number claimed for two households on ${N} connections → exactly one household holds it (${routeRace.filter((r) => r === 'ok').length} ok / ${routeRace.filter((r) => r === 'refused').length} refused, no errors)`);

    // ── S31: provisioning double-click → exactly one claim ───────────────
    const claims = await Promise.all(conns.map((c) => c.query('select public.claim_number_provisioning($1, 60) as ok', [signups[2].id]).then((r) => r.rows[0].ok)));
    check(claims.filter(Boolean).length === 1, `S31: number-purchase claim raced on ${N} connections → exactly one winner`);

    // ── S41: top-up replay race through the £ bridge ─────────────────────
    const hh = signups[3].id;
    await admin.query(`insert into public.entitlements (household_id, entitlement_type, status, source, starts_at) values ($1, 'paid_subscription', 'active', 'stripe', $2)`, [hh, PERIOD[0]]);
    const credit = (c, txn) => c.query('select public.credit_allowance($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) as r',
      [hh, PERIOD[0], PERIOD[1], 'topup', 1800, 'stripe', 'production', txn, null, 'topup_small', 299, 'gbp', null, null, false, 0.5637]).then((r) => r.rows[0].r);
    const dupCredits = await Promise.all(conns.map((c) => credit(c, 'pi_realpg_dup')));
    const adj = Number((await admin.query('select coalesce(sum(adjustments_gbp),0) s from public.fc_budget_accounts where household_id = $1', [hh])).rows[0].s);
    const ledger = (await admin.query("select count(*)::int n from public.fc_ledger where idempotency_key = 'adjust:topup:allowance:topup:stripe:pi_realpg_dup'")).rows[0].n;
    check(dupCredits.filter((r) => r.credited).length === 1 && Math.abs(adj - 0.5637) < 1e-9 && ledger === 1, `S41: one payment delivered on ${N} connections at once → credited once: £${adj} on the Fortress account, one ledger entry`);

    // ── top-ups racing call authorisations on an exhausted budget ─────────
    const hx = signups[4].id;
    await admin.query(`insert into public.entitlements (household_id, entitlement_type, status, source, starts_at) values ($1, 'paid_subscription', 'active', 'stripe', $2)`, [hx, PERIOD[0]]);
    await admin.query('select public.fc_admin_adjust($1,$2,$3,$4,$5,$6,$7,$8,$9)', [hx, -0.95, 'realpg exhaust', 'tester', 'realpg-exhaust', 'test', PERIOD[0], PERIOD[1], new Date().toISOString()]);
    const auth = (c, i) => c.query('select public.fc_authorize_call($1,$2,$3,$4,$5,$6,$7,$8,$9) as r', [hx, `CA-realpg-mix-${i}`, false, false, false, PERIOD[0], PERIOD[1], new Date().toISOString(), null]).then((r) => r.rows[0].r);
    const credX = (c, i) => c.query('select public.credit_allowance($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) as r',
      [hx, PERIOD[0], PERIOD[1], 'topup', 600, 'stripe', 'production', `pi_mix_${i}`, null, 'topup_small', 99, 'gbp', null, null, false, 0.15]).then((r) => r.rows[0].r);
    await Promise.all(conns.map((c, i) => (i % 3 === 0 ? credX(c, i) : auth(c, i))));
    const acc = (await admin.query('select * from public.fc_budget_accounts where household_id = $1', [hx])).rows[0];
    const prof = (await admin.query("select period_budget_gbp from public.fc_budget_profiles where profile = 'standard'")).rows[0];
    const capacity = Number(prof.period_budget_gbp) + Number(acc.adjustments_gbp);
    const live = (await admin.query("select coalesce(sum(reserved_gbp),0) s from public.fc_reservations where household_id = $1 and state = 'active' and funding = 'budget'", [hx])).rows[0].s;
    check(Number(live) <= capacity + 1e-9 && Math.abs(Number(acc.adjustments_gbp) - (-0.95 + 0.15 * 4)) < 1e-9,
      `top-ups racing authorisations: Σ budget-funded reservations £${Number(live).toFixed(4)} ≤ capacity £${capacity.toFixed(4)} (base + adjustments incl. 4 racing top-ups)`);

    const inv = (await admin.query('select public.fc_check_invariants() as r')).rows[0].r;
    check(inv && inv.ok === true, `Fortress invariants hold after the races (${JSON.stringify(inv).slice(0, 120)})`);
  } finally {
    for (const c of conns) await c.end().catch(() => {});
    await admin.end().catch(() => {});
    await server.stop().catch(() => {});
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  console.log(failures === 0 ? '\nAll launch-fortress real-PostgreSQL race checks passed.' : `\n${failures} check(s) FAILED`);
  process.exitCode = failures === 0 ? 0 : 1;
}
main().catch((err) => { console.error(err); process.exitCode = 1; });
