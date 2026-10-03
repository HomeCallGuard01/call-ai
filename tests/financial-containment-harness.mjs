// Shared harness for the financial-containment database tests (not a test
// file itself). Applies every migration in supabase/migrations/ in order,
// then the PROVISIONAL containment SQL, on any engine exposing
// exec(sql) and query(sql, params) → { rows } (PGlite, or node-postgres on a
// real multi-connection server — tests/financial-containment-realpg.test.mjs).

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(__dirname, '..');
// Integration 2026-10-03: the containment ledger is migration 067 (it was the
// unnumbered supabase/provisional/ file). The names are kept for the tests.
export const PROVISIONAL_SQL = path.join(ROOT, 'supabase', 'migrations', '067_financial_containment_authorization_ledger.sql');
export const PROVISIONAL_ROLLBACK_SQL = path.join(ROOT, 'supabase', 'migrations', '_rollbacks', '067_rollback_financial_containment_authorization_ledger.sql');

// Same Supabase platform shim as tests/migrations.pglite.test.mjs.
export const BOOTSTRAP_SQL = `
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

export async function applyAll(db) {
  await db.exec(BOOTSTRAP_SQL);
  const dir = path.join(ROOT, 'supabase', 'migrations');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  // 067 (the containment ledger) is part of the sequence now — applied once, in order.
  for (const f of files) await db.exec(await readFile(path.join(dir, f), 'utf8'));
  return files;
}

// Mirrors fc_call_cost (SQL) for expected values in tests.
export const POLICY = { conn: 0.010718, mon: 0.008069, uplift: 1.1, gran: 60, fixed: 0.0006, lease: 300, grace: 60, monMax: 1800, maxCall: 14400, share: 0.5 };
export function callCost(seconds, { monitored = false, conn = POLICY.conn, mon = POLICY.mon, uplift = POLICY.uplift, gran = POLICY.gran, fixed = POLICY.fixed, monMax = POLICY.monMax } = {}) {
  if (seconds <= 0) return 0;
  const blocks = (s) => Math.ceil(s / gran) * gran / 60;
  return blocks(seconds) * conn * uplift + (monitored ? blocks(Math.min(seconds, monMax)) * mon * uplift : 0) + fixed;
}
export const monWindowCost = () => Math.ceil(POLICY.monMax / POLICY.gran) * POLICY.gran / 60 * POLICY.mon * POLICY.uplift;

export const PERIOD = ['2026-10-01T00:00:00Z', '2026-10-31T00:00:00Z'];
export const T0 = Date.parse('2026-10-03T09:00:00Z');
export const at = (sec) => new Date(T0 + sec * 1000).toISOString();
export const num = (v) => Number(v);
export const near = (a, b, eps = 1e-6) => Math.abs(Number(a) - Number(b)) < eps;

// Test profiles: fixed figures so the DB tests don't depend on the
// commercial seeds (which are a DECISION, D1). £1.00 budget + £0.60
// delivery reserve + £0.50 essential pool.
export const TEST_PROFILE = { budget: 1.0, reserve: 0.6, essential: 0.5 };
export async function pinTestProfiles(q) {
  for (const [profile, b, r, e, mon] of [['standard', 1.0, 0.6, 0.5, true], ['complimentary', 1.0, 0.6, 0.5, true],
    ['internal_test', 1.0, 0.6, 0.5, true], ['unentitled', 0, 0.25, 0.5, false]]) {
    await q('select public.fc_set_budget_profile($1,$2,$3,$4,$5,$6,$7,$8)', [profile, b, r, 'all', e, mon, 'pin test profile', 'tester']);
  }
}

// Thin RPC helpers; `q` is (sql, params) => rows.
export function rpcs(q) {
  const one = async (sql, params) => (await q(sql, params))[0].r;
  return {
    authorize: (hh, sid, { known = false, mon = false, essential = false, now = at(0), overrides = null, period = PERIOD } = {}) =>
      one('select public.fc_authorize_call($1,$2,$3,$4,$5,$6,$7,$8,$9) as r', [hh, sid, known, mon, essential, period[0], period[1], now, overrides ? JSON.stringify(overrides) : null]),
    renew: (sid, now, overrides = null) => one('select public.fc_renew_lease($1,$2,$3) as r', [sid, now, overrides ? JSON.stringify(overrides) : null]),
    settle: (sid, duration, now, { monitoredSeconds = null, source = 'test' } = {}) =>
      one('select public.fc_settle_call($1,$2,$3,$4,$5) as r', [sid, duration, monitoredSeconds, source, now]),
    monStarted: (sid) => one('select public.fc_mark_monitoring_started($1) as r', [sid]),
    spend: (key, hh, category, units, now = at(0)) =>
      one('select public.fc_authorize_spend($1,$2,$3,$4,$5,$6,$7,$8) as r', [key, hh, category, units, PERIOD[0], PERIOD[1], now, null]),
    actual: (ref, sid, category, amount, now = at(0)) =>
      one('select public.fc_record_actual($1,$2,$3,$4,$5,$6) as r', ['twilio', ref, sid, category, amount, now]),
    adjust: (hh, amount, key, { reason = 'test adjustment', actor = 'tester', source = 'admin', now = at(0) } = {}) =>
      one('select public.fc_admin_adjust($1,$2,$3,$4,$5,$6,$7,$8,$9) as r', [hh, amount, reason, actor, key, source, PERIOD[0], PERIOD[1], now]),
    adopt: (hh, sid, startedAt, limit, now) =>
      one('select public.fc_adopt_degraded_call($1,$2,$3,$4,$5,$6,$7) as r', [hh, sid, startedAt, limit, PERIOD[0], PERIOD[1], now]),
    due: (now, limit = 100) => one('select public.fc_due_leases($1,$2) as r', [now, limit]),
    terminated: (sid, confirmed, now) => one('select public.fc_record_termination($1,$2,$3,$4) as r', [sid, confirmed, 'completed', now]),
    kill: (on, reason = 'test kill switch', actor = 'tester') => one('select public.fc_set_kill_switch($1,$2,$3) as r', [on, reason, actor]),
    resetBreaker: (reason = 'test breaker reset', actor = 'tester') => one('select public.fc_reset_breaker($1,$2) as r', [reason, actor]),
    setPolicy: (changes, reason = 'test policy change', actor = 'tester') => one('select public.fc_set_policy($1,$2,$3) as r', [JSON.stringify(changes), reason, actor]),
    refreshCount: (now = at(0)) => one('select public.fc_refresh_entitled_count($1) as r', [now]),
    hhStatus: (hh, now = at(0)) => one('select public.fc_household_status($1,$2) as r', [hh, now]),
    globalStatus: (now = at(0)) => one('select public.fc_global_status($1) as r', [now]),
    invariants: () => one('select public.fc_check_invariants() as r', []),
    account: async (hh) => (await q('select * from public.fc_budget_accounts where household_id = $1 order by period_start desc limit 1', [hh]))[0],
    reservation: async (sid) => (await q("select * from public.fc_reservations where idempotency_key = 'call:' || $1", [sid]))[0],
  };
}

// A supabase-js-shaped client ({ rpc(name, params) → { data, error } }) over
// any engine, using Postgres named-argument notation — lets the REAL
// database/financialContainment.js adapter run against PGlite.
export function rpcClient(q) {
  return {
    async rpc(name, params) {
      const keys = Object.keys(params || {});
      const args = keys.map((k, i) => `${k} => $${i + 1}`).join(', ');
      const values = keys.map((k) => {
        const v = params[k];
        return v !== null && typeof v === 'object' && !(v instanceof Date) ? JSON.stringify(v) : v;
      });
      try {
        const rows = await q(`select public.${name}(${args}) as r`, values);
        return { data: rows[0].r, error: null };
      } catch (err) {
        return { data: null, error: { message: err.message } };
      }
    },
  };
}
