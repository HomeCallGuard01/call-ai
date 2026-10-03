// Launch-gate financial contract (FC-1…FC-8) bound to the REAL Financial
// Fortress — integration 2026-10-03.
//
// Binding: the production app-layer service (services/containment/containment.js,
// incl. its fail-closed / degraded behaviour) → the production adapter
// (database/financialContainment.js) → the real SQL of every migration
// (056, 067, 068 …) on PGlite. One fresh database per subject.
//
// Unit translation (the contract speaks "allowance seconds" and pence; the
// Fortress enforces £):
//   setAllowance(h, s)  → the household's £ budget = s/60 × connected £/min × uplift,
//                         via the audited fc_admin_adjust on a £0 profile
//   remaining(h)        → floor(remaining £ / (connected £/min × uplift)) × 60 s
//   authorizeCall       → containment.authorizeCall; grantedSeconds = the
//                         provider-enforced <Dial timeLimit> it returns
//   recordUsage         → settle THAT call with the reported duration
//                         (idempotent per CallSid) + fc_record_actual for the
//                         cost (idempotent per provider reference = eventId).
//                         A usage event with no numeric duration is refused
//                         here: the real system never accepts a client-supplied
//                         duration (settlement derives it from the provider or
//                         the clock), so such an event is not representable.
//   setStoreAvailable   → every database call fails; the APP LAYER decides
//                         (FC_DEGRADED_MODE: 'bounded' (decision D3, default)
//                         admits a small bounded envelope; 'reject' admits none)
//   setGlobalCeiling / addGlobalSpend → the hourly spend breaker (fc_policy) and
//                         real unattributed one-shot spend counted in its window
//   setRateLimit(n)     → the £ rate-of-spend breaker set to exactly n first
//                         leases' worth of reservation in the rolling hour
//
// PGlite is one connection: FC-2/FC-8 "simultaneous" calls interleave through
// one session. Multi-connection races: tests/*realpg*.test.mjs.
import { PGlite } from '@electric-sql/pglite';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { applyAll, rpcClient } from '../../financial-containment-harness.mjs';

const require = createRequire(import.meta.url);
const fcDb = require('../../../database/financialContainment.js');
const { createContainment } = require('../../../services/containment/containment.js');

export const CAPABILITIES_DECLARED = ['global-ceiling', 'store-outage', 'rate-breaker'];

export async function createSubject({ degradedMode = process.env.FC_DEGRADED_MODE || 'bounded' } = {}) {
  const db = new PGlite();
  await applyAll(db);
  const q = async (sql, p = []) => (await db.query(sql, p)).rows;
  // £0 profile: every household's capacity comes only from setAllowance.
  await q("select public.fc_set_budget_profile('standard', 0, 0, 'none', 0, false, 'contract binding: allowance set per test', 'launch-gate')");
  const pol = (await q('select connected_rate_gbp_per_min::float c, estimate_uplift::float u, call_fixed_fee_gbp::float f from public.fc_policy where id = 1'))[0];
  const perMin = pol.c * pol.u;

  let storeUp = true;
  const client = rpcClient(q);
  const gated = { rpc: (name, params) => (storeUp ? client.rpc(name, params) : Promise.resolve({ data: null, error: { message: 'database unavailable (simulated)' } })) };
  const bound = Object.fromEntries(Object.entries(fcDb).map(([k, fn]) => [k, typeof fn === 'function' ? (args) => fn(args, gated) : fn]));
  const containment = createContainment({ db: bound, env: { FC_DEGRADED_MODE: degradedMode, FC_REQUIRE_SIGNED_VOICE: 'true' } });

  const now = new Date();
  const period = { periodStart: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)), periodEnd: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)) };
  const ids = new Map();
  const sids = new Map();
  async function hh(name) {
    if (!ids.has(name)) {
      const id = (await q('insert into public.households (auth_user_id, email) values (null, $1) returning id', [`${name}-${randomUUID()}@contract.invalid`]))[0].id;
      await q(`insert into public.entitlements (household_id, entitlement_type, status, source, starts_at) values ($1, 'paid_subscription', 'active', 'test', $2)`, [id, period.periodStart.toISOString()]);
      ids.set(name, id);
    }
    return ids.get(name);
  }
  const sid = (s) => { if (!sids.has(s)) sids.set(s, 'CA' + randomUUID().replace(/-/g, '')); return sids.get(s); };
  let k = 0;

  return {
    _q: q, // evidence queries for tests/launch-fortress-contract.test.mjs (not used by the contract)
    _householdId: hh,
    _callSid: sid,
    capabilities: new Set(CAPABILITIES_DECLARED),
    async setAllowance(name, seconds) {
      const id = await hh(name);
      // Proportional: N seconds of allowance = the £ that buys N seconds at the
      // connected rate × uplift (no started-minute round-up, no fixed fee —
      // rounding up would credit MORE than N seconds).
      const gbp = Math.floor((seconds / 60) * perMin * 1e4) / 1e4;
      if (gbp > 0) await q('select public.fc_admin_adjust($1,$2,$3,$4,$5,$6,$7,$8,$9)', [id, gbp, 'contract allowance', 'launch-gate', `allow-${++k}`, 'test', period.periodStart.toISOString(), period.periodEnd.toISOString(), now.toISOString()]);
    },
    async remaining(name) {
      const s = (await q('select public.fc_household_status($1, $2) as r', [await hh(name), new Date().toISOString()]))[0].r;
      const rem = s && s.hasAccount ? Number(s.remainingBudgetGbp) : 0;
      return Math.max(0, Math.floor(rem / perMin + 1e-9) * 60);
    },
    async authorizeCall({ householdId, callSid }) {
      const id = await hh(householdId);
      const r = await containment.authorizeCall({ household: { id }, callSid: sid(callSid), from: '+447700900123', isKnown: false, wantsMonitoring: false, signatureValid: true, period });
      return { admitted: r.allowed, grantedSeconds: r.allowed ? r.timeLimitSeconds : 0, reason: r.reason };
    },
    async recordUsage({ householdId, callSid, eventId, seconds, costPence }) {
      if (typeof seconds !== 'number') throw new Error('usage without a numeric duration is not representable');
      if (typeof costPence !== 'number') throw new Error('cost must be a number');
      const id = await hh(householdId);
      const s = sid(callSid);
      // The call must have been authorised (a usage report for a call that
      // never got a reservation charges nothing).
      if (!(await q("select 1 from public.fc_reservations where call_sid = $1", [s])).length) {
        await containment.authorizeCall({ household: { id }, callSid: s, from: '+447700900123', isKnown: false, wantsMonitoring: false, signatureValid: true, period });
      }
      const settled = await fcDb.settleCall({ callSid: s, durationSeconds: seconds, source: 'contract', now: new Date() }, gated).then((r) => r, (e) => { throw e; });
      if (settled && settled.reason === 'unknown_call') return { applied: false };
      await fcDb.recordActual({ provider: 'twilio', providerRef: String(eventId), callSid: s, category: 'call', amountGbp: costPence / 100, now: new Date() }, gated);
      return { applied: !(settled && settled.alreadySettled) };
    },
    async setStoreAvailable(up) { storeUp = Boolean(up); },
    async setGlobalCeiling(pence) {
      await q(`select public.fc_set_policy($1::jsonb, 'contract: global ceiling', 'launch-gate')`, [JSON.stringify({ global_hourly_floor_gbp: pence / 100, global_hourly_per_household_gbp: 0, global_daily_floor_gbp: Math.max(pence / 100, 0.01), global_daily_per_household_gbp: 0 })]);
    },
    async addGlobalSpend(pence) {
      let left = pence / 100;
      for (let i = 0; left > 0 && i < 500; i++) {
        const r = (await q('select public.fc_authorize_spend($1,null,$2,20,null,null,$3,null) as r', [`contract-global-${i}`, 'sms', new Date().toISOString()]))[0].r;
        if (!r.allowed) break;
        left -= Number(r.reservedGbp || r.costGbp || 0.9311);
      }
    },
    async setRateLimit({ maxAdmissions }) {
      const one = (await q('select public.fc_call_cost(360, $1, 0, 1800, false, 60, $2, $3)::float as c', [pol.c, pol.u, pol.f]))[0].c;
      await q(`select public.fc_set_policy($1::jsonb, 'contract: rate breaker', 'launch-gate')`, [JSON.stringify({ global_hourly_floor_gbp: Math.round((maxAdmissions * one + 0.0001) * 1e4) / 1e4, global_hourly_per_household_gbp: 0, global_active_floor: 1000, global_exposure_floor_gbp: 1000, global_worst_case_floor_gbp: 1000 })]);
    },
  };
}
