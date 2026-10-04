// Defence in depth (integration 2026-10-04, decision 7). Each HCG level must
// stop HCG-funded spend ON ITS OWN, with every other level permissive:
//   LEVEL 1 per-call authorisation/reservation   (household budget can't fund it)
//   LEVEL 2 per-household economic cap / kill switch (household hold)
//   LEVEL 3 HCG-wide spend/rate/exposure breaker  (latched breaker; kill switch; exposure cap)
//   LEVEL 4 provider/account hard ceiling        — NOT testable here; provider
//           configuration, unverified (docs/integration/2026-10-04-PROVIDER_FINANCIAL_CONTAINMENT.md).
// Real SQL, PGlite.
import { PGlite } from '@electric-sql/pglite';
import { applyAll, pinTestProfiles, rpcs } from './financial-containment-harness.mjs';

let failures = 0;
const check = (c, m) => { if (c) console.log(`✓ ${m}`); else { console.error(`✗ ${m}`); failures++; } };
const NOW = Date.now();
const at = (s) => new Date(NOW + s * 1000).toISOString();
const P = [new Date(NOW - 86400e3).toISOString(), new Date(NOW + 29 * 86400e3).toISOString()];
let n = 0; const sid = () => `CA${String(++n).padStart(32, '0')}`;

const db = new PGlite();
await applyAll(db);
const q = async (sql, p = []) => (await db.query(sql, p)).rows;
await pinTestProfiles(q);
const R = rpcs(q);
const mk = async (email) => {
  const id = (await q('insert into public.households (auth_user_id, email) values (null, $1) returning id', [email]))[0].id;
  await q(`insert into public.entitlements (household_id, entitlement_type, status, source, starts_at) values ($1, 'paid_subscription', 'active', 'stripe', $2)`, [id, P[0]]);
  return id;
};
const auth = (hh, o = {}) => R.authorize(hh, sid(), { period: P, now: at(o.t || 0), known: true, mon: false });

const base = await mk('base@example.com');
check((await auth(base)).allowed, 'control: with every level permissive the call is authorised');

// LEVEL 1 alone: budget cannot fund one lease (no hold, no breaker).
const l1 = await mk('l1@example.com');
await R.adjust(l1, -0.999, 'did-l1', { now: at(1) });
await q("select public.fc_set_budget_profile('standard', 1.0, 0, 'none', 0, true, 'did: no reserve', 'tester')");
const r1 = await auth(l1, { t: 2 });
check(!r1.allowed && r1.reason === 'household_budget_exhausted', 'LEVEL 1 alone stops spend: per-call reservation refused when the budget cannot fund it');
await q("select public.fc_set_budget_profile('standard', 1.0, 0.6, 'trusted_only', 0.5, true, 'did: restore', 'tester')");

// LEVEL 2 alone: plenty of budget, no breaker — household hold.
const l2 = await mk('l2@example.com');
await q("select public.fc_set_household_hold($1, true, 'did: level 2 alone', 'admin:did', 'admin')", [l2]);
const r2 = await auth(l2, { t: 3 });
check(!r2.allowed && r2.reason === 'household_hold', 'LEVEL 2 alone stops spend: household hold refuses with budget available and no breaker');
check((await auth(base, { t: 3 })).allowed, 'LEVEL 2 is per household: other households unaffected');

// LEVEL 3 alone: budget available, no hold — global breaker / kill switch / exposure cap.
await q("update public.fc_global_state set breaker_open = true, breaker_reason = 'did', breaker_opened_at = now() where id = 1");
const r3 = await auth(base, { t: 4 });
check(!r3.allowed && r3.reason === 'breaker_open', 'LEVEL 3 alone stops spend: latched breaker refuses a funded, un-held household');
await q("select public.fc_reset_breaker('did: reset after level 3 check', 'admin:did')");
await q("select public.fc_set_kill_switch(true, 'did: kill switch alone', 'admin:did')");
const r3b = await auth(base, { t: 5 });
check(!r3b.allowed && r3b.reason === 'kill_switch', 'LEVEL 3 alone stops spend: kill switch');
await q("select public.fc_set_kill_switch(false, 'did: kill switch off', 'admin:did')");
await q(`select public.fc_set_policy($1::jsonb, 'did: tiny exposure cap', 'tester')`, [JSON.stringify({ global_exposure_floor_gbp: 0.01, global_exposure_per_household_gbp: 0 })]);
const r3c = await auth(base, { t: 6 });
check(!r3c.allowed && /global_(exposure|worst_case)_cap/.test(r3c.reason), 'LEVEL 3 alone stops spend: business-wide exposure cap');

console.log('  LEVEL 4 (provider hard ceiling): not testable in code — UNPROVEN until provider evidence exists.');
await db.close();
console.log(failures === 0 ? '\nDefence-in-depth: each HCG level independently stops spend.' : `\n${failures} check(s) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
