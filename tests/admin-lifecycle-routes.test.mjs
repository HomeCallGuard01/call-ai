// Admin customer-lifecycle routes (customer lifecycle automation,
// 2026-10-04). Behavioural, against the real router, real requireAdmin and
// the real snapshot loader over an in-memory database; requireAuth is a
// header-driven stand-in (as in tests/admin-fortress-controls.test.mjs).
// Proves: unauthenticated and non-admin callers get nothing; the queue and
// household view are correct over realistic rows; optional tables that are
// not deployed are reported, not fatal; a required table failing is a 500
// (never an empty "all fine" queue); and the routes never write.
//
// Run with: node tests/admin-lifecycle-routes.test.mjs
import { createRequire } from 'node:module';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
const check = (c, m) => { if (c) console.log(`✓ ${m}`); else { console.error(`✗ ${m}`); failures++; } };

const authPath = require.resolve(path.join(ROOT, 'middleware', 'requireAuth.js'));
require.cache[authPath] = { id: authPath, filename: authPath, loaded: true, exports: {
  requireAuth: (req, res, next) => {
    if (!req.get('x-test-user')) return res.status(401).json({ error: 'unauthenticated' });
    req.authUserId = req.get('x-test-user'); req.role = req.get('x-test-role') || 'customer'; return next();
  },
} };
const express = require('express');
const { createAdminLifecycleRoutes, policyFromEnv } = require(path.join(ROOT, 'routes', 'adminLifecycle.js'));

// Minimal PostgREST-like fake: select/eq/is/order/range, read-only. Any
// write method records itself so the test can prove none is called.
const writes = [];
function createDb(tables, { missing = [], broken = [] } = {}) {
  return {
    from(table) {
      const filters = [];
      const b = {
        select() { return b; },
        eq(c, v) { filters.push((r) => r[c] === v); return b; },
        is(c, v) { filters.push((r) => (r[c] ?? null) === v); return b; },
        order() { return b; },
        range(from, to) {
          if (missing.includes(table)) return Promise.resolve({ data: null, error: { code: 'PGRST205', message: `Could not find the table 'public.${table}'` } });
          if (broken.includes(table)) return Promise.resolve({ data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } });
          const rows = (tables[table] || []).filter((r) => filters.every((f) => f(r)));
          return Promise.resolve({ data: rows.slice(from, to + 1), error: null });
        },
        insert() { writes.push(table); return b; }, update() { writes.push(table); return b; },
        upsert() { writes.push(table); return b; }, delete() { writes.push(table); return b; },
      };
      return b;
    },
    rpc() { writes.push('rpc'); return Promise.resolve({ data: null, error: null }); },
  };
}

const NOW = new Date('2026-10-09T12:00:00Z');
const H1 = '11111111-2222-4333-8444-000000000001'; // protected
const H2 = '11111111-2222-4333-8444-000000000002'; // held
const H3 = '11111111-2222-4333-8444-000000000003'; // stalled setup
const hh = (id, extra) => ({ id, status: 'active', email: `${id}@example.com`, auth_user_id: `a-${id}`, account_number: null, twilio_number: null, twilio_provisioning_status: 'pending', twilio_number_pending_release_at: null, activation_verified_at: null, voice_client_registered_at: null, delivery_verified_at: null, ...extra });
const done = { twilio_number: '+441632960001', twilio_provisioning_status: 'active', twilio_provisioning_updated_at: '2026-10-01T09:05:00Z', activation_verified_at: '2026-10-02T10:00:00Z', forwarding_proven_at: '2026-10-02T10:00:00Z', voice_client_registered_at: '2026-10-08T10:00:00Z', delivery_verified_at: '2026-10-02T10:05:00Z' };
const ent = (hid) => ({ id: `e-${hid}`, household_id: hid, entitlement_type: 'paid_subscription', status: 'active', source: 'stripe', starts_at: '2026-10-01T09:00:00Z', ends_at: null });
const tables = {
  households: [hh(H1, done), hh(H2, { ...done, twilio_number: '+441632960002' }), hh(H3, { twilio_number: '+441632960003', twilio_provisioning_status: 'active', twilio_provisioning_updated_at: '2026-10-01T09:05:00Z' })],
  entitlements: [ent(H1), ent(H2), ent(H3)],
  twilio_number_quarantine: [{ id: 'q-orphan', household_id: null, twilio_number: '+441632960099', release_reason: 'account_deletion', quarantined_at: '2026-08-01T00:00:00Z', released_at: null, deactivation_confirmed: false }],
  subscriptions: [],
  fc_household_holds: [{ household_id: H2, source: 'financial', reason: 'automatic 24h spend hold', held_at: '2026-10-09T08:00:00Z' }],
  routing_assignments: [],
  stripe_webhook_events: [],
};

async function serve(db, opts = {}) {
  const app = express();
  app.use(createAdminLifecycleRoutes({ supabaseAdmin: db, now: () => NOW, env: { LIFECYCLE_MONTHLY_NUMBER_COST_GBP: '0.87' }, ...opts }));
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const get = (p, headers = {}) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: server.address().port, path: p, headers }, (res) => {
      let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => resolve({ status: res.statusCode, body: t, json: (() => { try { return JSON.parse(t); } catch { return null; } })() }));
    }).on('error', reject);
  });
  return { server, get };
}
const ADMIN = { 'x-test-user': 'admin-1', 'x-test-role': 'admin' };

const { server, get } = await serve(createDb(tables), { getDeliveryHealth: async () => ({ state: 'HEALTHY' }) });
try {
  check((await get('/admin/api/lifecycle/exceptions')).status === 401, 'unauthenticated → 401');
  const cust = await get('/admin/api/lifecycle/exceptions', { 'x-test-user': 'c-1', 'x-test-role': 'customer' });
  check(cust.status === 302 && !cust.json, 'authenticated non-admin → redirected by requireAdmin, no data');
  check((await get(`/admin/api/lifecycle/households/${H1}`, { 'x-test-user': 'c-1' })).status === 302, 'non-admin cannot read a household lifecycle');

  const q = await get('/admin/api/lifecycle/exceptions', ADMIN);
  check(q.status === 200 && q.json && /read-only/.test(q.json.label), 'admin → 200, labelled read-only');
  const c = q.json.items.map((i) => i.code);
  check(c.includes('HOUSEHOLD_ON_HOLD') && c.includes('SETUP_STALLED') && c.includes('QUARANTINE_WITHOUT_HOUSEHOLD'), 'queue raises the hold, the stalled setup and the household-less quarantine row');
  check(!q.json.items.some((i) => i.householdId === H1), 'the protected household raises nothing');
  check(q.json.summary.protected === 1 && q.json.summary.stages.on_hold === 1 && q.json.summary.stages.awaiting_forwarding === 1, 'summary counts stages');
  check(q.json.numberRetirement.awaitingConfirmation === 1 && q.json.numberRetirement.monthlyCostOfWaitingGbp === 0.87, 'number retirement summary shows the monthly cost of waiting');
  check(q.json.sources.financialHolds === 'ok' && q.json.sources.deliveryHealth === 'not_loaded_in_bulk', 'sources are reported honestly');

  const one = await get(`/admin/api/lifecycle/households/${H1}`, ADMIN);
  check(one.status === 200 && one.json.activation.protected === true && one.json.activation.stage === 'protected', 'household view: protected household');
  check(one.json.sources.deliveryHealth === 'loaded' && one.json.activation.evidence.deliveryHealthChecked === true, 'household view loads delivery health');
  check(one.json.communicationsDue.every((m) => m.deliverable === false), 'household view lists due messages, none deliverable');
  const held = await get(`/admin/api/lifecycle/households/${H2}`, ADMIN);
  check(held.json.activation.protected === false && held.json.activation.stage === 'on_hold', 'household view: a held household is NOT protected');
  check((await get('/admin/api/lifecycle/households/not-a-uuid', ADMIN)).status === 400, 'invalid id → 400');
  check((await get('/admin/api/lifecycle/households/11111111-2222-4333-8444-000000000999', ADMIN)).status === 404, 'unknown household → 404');
  check(writes.length === 0, 'no route wrote anything or called an RPC');
} finally { server.close(); }

// Optional tables not deployed (062/067 unapplied): still works, says so.
{
  const { server: s2, get: g2 } = await serve(createDb(tables, { missing: ['fc_household_holds', 'routing_assignments', 'subscriptions'] }));
  try {
    const r = await g2('/admin/api/lifecycle/exceptions', ADMIN);
    check(r.status === 200 && r.json.sources.financialHolds === 'absent' && r.json.sources.routingAssignments === 'absent', 'unapplied migrations ⇒ 200 with sources marked absent');
    check(!r.json.items.some((i) => i.code === 'HOUSEHOLD_ON_HOLD'), 'hold table absent ⇒ no hold raised (and the household view reports hold_not_checked)');
    const one = await g2(`/admin/api/lifecycle/households/${H1}`, ADMIN);
    check(one.json.activation.attention.includes('hold_not_checked'), 'household view: hold_not_checked');
  } finally { s2.close(); }
}
// Hold table present but unreadable ⇒ fail closed.
{
  const { server: s3, get: g3 } = await serve(createDb(tables, { broken: ['fc_household_holds'] }));
  try {
    const r = await g3('/admin/api/lifecycle/exceptions', ADMIN);
    check(r.json.items.filter((i) => i.code === 'LIFECYCLE_STATE_AMBIGUOUS').length === 3 && r.json.summary.protected === 0, 'hold table unreadable ⇒ every household ambiguous, none protected');
  } finally { s3.close(); }
}
// A required table failing ⇒ 500, never an empty "nothing wrong" queue.
{
  const { server: s4, get: g4 } = await serve(createDb(tables, { broken: ['entitlements'] }));
  try {
    const r = await g4('/admin/api/lifecycle/exceptions', ADMIN);
    check(r.status === 500 && !(r.json && r.json.items), 'entitlements unreadable ⇒ 500, no partial queue');
  } finally { s4.close(); }
}
check(policyFromEnv({}).monthlyNumberCostGbp === 0.86917 && policyFromEnv({}).monthlyNumberCostSource.startsWith('register') && policyFromEnv({ LIFECYCLE_MONTHLY_NUMBER_COST_GBP: 'abc' }).monthlyNumberCostGbp === 0.86917 && policyFromEnv({ LIFECYCLE_MONTHLY_NUMBER_COST_GBP: '1.10' }).monthlyNumberCostGbp === 1.1 && policyFromEnv({}).autoConfirmAfterDays === null,
  'number cost defaults to the register KNOWN rental (2026-10-04) so billed quarantines always show £ exposure; env overrides; auto-confirm stays null (never auto-release)');

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll admin lifecycle route checks passed');
