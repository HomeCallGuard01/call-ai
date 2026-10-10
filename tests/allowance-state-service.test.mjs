// WS2 (2026-10-10) — customer allowance STATE service + route handler +
// containment transition hook. The WS3 contract (report §A) is checked
// against the REAL database adapter on PGlite with migration 076.
import { createRequire } from 'node:module';
import { PGlite } from '@electric-sql/pglite';
import { applyAll, rpcClient } from './financial-containment-harness.mjs';

const require = createRequire(import.meta.url);
const { toCustomerAllowanceState, getCustomerAllowanceState, createAllowanceStateHandler } = require('../services/allowance/allowanceState.js');
const { createContainment } = require('../services/containment/containment.js');
const fcDb = require('../database/financialContainment.js');

let failures = 0;
const check = (c, m) => { if (c) console.log(`✓ ${m}`); else { console.error(`✗ ${m}`); failures++; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const KEYS = ['version', 'state', 'percentUsed', 'screeningActive', 'unknownCallersDelivered', 'trustedCallersDelivered', 'reserveRemaining',
  'serviceLimited', 'periodStart', 'resetsAt', 'since', 'thresholds', 'lastRefusal'];
const noPounds = (o) => !/Gbp|gbp|£/.test(JSON.stringify(o));

// ── mapper ───────────────────────────────────────────────────────────────
const dbState = {
  state: 'screening_low', percentUsed: 83, screeningActive: true, unknownCallersDelivered: true, trustedCallersDelivered: true,
  serviceLimited: false, deliveryReserveScope: 'trusted_only', trustedReserveGbp: 0.5, trustedReserveRemainingGbp: 0.25,
  unknownReserveGbp: 0, unknownReserveRemainingGbp: 0, periodStart: '2026-10-01T00:00:00Z', periodEnd: '2026-11-01T00:00:00Z',
  since: '2026-10-09T08:00:00Z', thresholds: { screeningLowRatio: 0.8, continuityLowRatio: 0.8 }, lastDenialReason: null, budgetGbp: 3, usedGbp: 2.5,
};
const c = toCustomerAllowanceState(dbState);
check(JSON.stringify(Object.keys(c)) === JSON.stringify(KEYS), 'customer object has exactly the published contract keys, in order');
check(c.state === 'screening_low' && c.percentUsed === 83 && c.reserveRemaining.trustedPercent === 50 && c.reserveRemaining.unknownPercent === null,
  'percentages: trusted reserve 50%, unknown reserve null when the profile has none');
check(c.thresholds.screeningLowPercent === 80 && c.resetsAt === '2026-11-01T00:00:00.000Z', 'thresholds and reset date mapped');
check(noPounds(c), 'no £ figure reaches the customer');
check(toCustomerAllowanceState({ ...dbState, deliveryReserveScope: 'none' }).reserveRemaining.trustedPercent === null, 'scope none → trustedPercent null');
const u = toCustomerAllowanceState({ state: 'bogus' });
check(u.state === 'unavailable' && u.screeningActive === null && u.trustedCallersDelivered === null && JSON.stringify(Object.keys(u)) === JSON.stringify(KEYS),
  'unknown state → unavailable with null booleans (never "protected")');
check(toCustomerAllowanceState(null).state === 'unavailable', 'null → unavailable');
check(toCustomerAllowanceState({ ...dbState, state: 'held', lastDenialReason: 'household_hold', lastDenialAt: '2026-10-10T00:00:00Z' }).lastRefusal.reason === 'household_hold',
  'last refusal is a machine code + time');

// ── read with timeout / failure ──────────────────────────────────────────
check((await getCustomerAllowanceState({ householdId: 'h', deps: { householdAllowanceState: async () => { throw new Error('076 missing'); } } })).state === 'unavailable',
  'database error → unavailable');
check((await getCustomerAllowanceState({ householdId: 'h', timeoutMs: 30, deps: { householdAllowanceState: () => new Promise(() => {}) } })).state === 'unavailable',
  'slow database → unavailable within the timeout');
check((await getCustomerAllowanceState({ householdId: null, deps: { householdAllowanceState: async () => dbState } })).state === 'unavailable', 'no household → unavailable');

// ── handler: household from the session only ─────────────────────────────
let askedFor = null;
const handler = createAllowanceStateHandler({ deps: { householdAllowanceState: async ({ householdId }) => { askedFor = householdId; return dbState; } } });
const res = { headers: {}, body: null, set(k, v) { this.headers[k] = v; return this; }, json(b) { this.body = b; return this; } };
await handler({ household: { id: 'session-hh' }, query: { householdId: 'other-hh' }, body: { householdId: 'other-hh' } }, res);
check(askedFor === 'session-hh' && res.body.allowanceState.state === 'screening_low', 'handler reads the SESSION household; query/body ids are ignored');
check(res.headers['Cache-Control'] === 'no-store', 'response is not cached');

// ── containment hook ─────────────────────────────────────────────────────
const mkDb = (over = {}) => ({
  authorizeCall: async () => ({ allowed: true, timeLimitSeconds: 600, leaseExpiresAt: new Date(Date.now() + 300e3).toISOString(), funding: 'budget' }),
  settleCall: async () => ({ ok: true }),
  recordAllowanceState: async () => ({ changed: true, from: 'normal', state: 'screening_low', periodStart: '2026-10-01T00:00:00Z' }),
  ...over,
});
const transitions = [];
const ct = createContainment({ db: mkDb(), env: {}, onAllowanceStateChange: async (t) => transitions.push(t) });
const dec = await ct.authorizeCall({ household: { id: 'hh1' }, callSid: 'CA1', from: '+447700900001', isKnown: false, wantsMonitoring: false, signatureValid: true });
await sleep(20);
check(dec.allowed && transitions.length === 1 && transitions[0].householdId === 'hh1' && transitions[0].to === 'screening_low', 'a transition after authorisation reaches onAllowanceStateChange');
await ct.settleCall({ callSid: 'CA1', durationSeconds: 30, source: 'test' });
await sleep(20);
check(transitions.length === 2, 'settlement also records the state (household from the instance lease)');
const events = [];
const broken = createContainment({ db: mkDb({ recordAllowanceState: async () => { throw new Error('function fortress_record_allowance_state does not exist'); } }), env: {},
  recordEvent: async (e) => events.push(e) });
const d2 = await broken.authorizeCall({ household: { id: 'hh2' }, callSid: 'CA2', from: '+447700900002', isKnown: true, wantsMonitoring: false, signatureValid: true });
await sleep(20);
check(d2.allowed === true && d2.source === 'database', 'a failing state recorder never changes the call decision');
check(events.some((e) => e.rule === 'allowance_state_record_failed') && !events.some((e) => e.rule === 'containment_authority_unavailable'),
  'a failing state recorder is a warning, never an authority outage');
let calls = 0;
const off = createContainment({ db: mkDb({ recordAllowanceState: async () => { calls++; return { changed: false }; } }), env: { FC_ALLOWANCE_STATE_EVENTS: 'false' } });
await off.authorizeCall({ household: { id: 'hh3' }, callSid: 'CA3', from: '+447700900003', isKnown: true, wantsMonitoring: false, signatureValid: true });
await sleep(20);
check(calls === 0, 'FC_ALLOWANCE_STATE_EVENTS=false disables recording');
const refused = createContainment({ db: mkDb({ authorizeCall: async () => ({ allowed: false, reason: 'household_budget_exhausted' }) }), env: {}, onAllowanceStateChange: async (t) => transitions.push(t) });
const before = transitions.length;
await refused.authorizeCall({ household: { id: 'hh4' }, callSid: 'CA4', from: '+447700900004', isKnown: false, wantsMonitoring: false, signatureValid: true });
await sleep(20);
check(transitions.length === before + 1, 'a refusal also records the state (e.g. the move to hard_ceiling)');

// ── real adapter on PGlite: the contract end to end ──────────────────────
const db = new PGlite();
await applyAll(db);
const q = async (sql, p = []) => (await db.query(sql, p)).rows;
const client = rpcClient(q);
const hh = (await q("insert into public.households (email) values ('ws2-state@example.com') returning id"))[0].id;
await q("insert into public.entitlements (household_id, entitlement_type, status, source, starts_at) values ($1, 'paid_subscription', 'active', 'stripe', now() - interval '1 day')", [hh]);
const real = await getCustomerAllowanceState({ householdId: hh, deps: { householdAllowanceState: (a) => fcDb.householdAllowanceState(a, client) } });
check(real.state === 'normal' && real.screeningActive === true && real.trustedCallersDelivered === true && real.percentUsed === 0 && noPounds(real),
  `real database adapter → contract (state ${real.state}, trusted reserve ${real.reserveRemaining.trustedPercent}%)`);
const rec = await fcDb.recordAllowanceState({ householdId: hh, now: new Date() }, client);
check(rec.state === 'normal' && rec.changed === false, 'real recorder: first normal observation is not an event');

if (failures) { console.error(`\n${failures} check(s) FAILED`); process.exit(1); }
console.log('\nAll allowance-state service checks passed.');
