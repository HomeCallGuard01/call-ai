// One canonical entitlement decision across Stripe / Apple (RevenueCat) /
// complimentary — integration 2026-10-03 (migration 070 + database/billing.js;
// launch-fortress scenarios 35 sandbox, 36 replay, 37 out-of-order, 38 Stripe
// duplicate, 39 Stripe cancel/refund path, 40 Apple + Stripe conflict).
//
// Part A: real SQL (PGlite, every migration in order) for the Stripe RPC.
// Part B: the RevenueCat rules against an in-memory entitlements table.
// Part C: Fortress treats a SANDBOX entitlement as unfunded (no monitoring).
import { PGlite } from '@electric-sql/pglite';
import { createRequire } from 'node:module';
import { applyAll } from './financial-containment-harness.mjs';
const require = createRequire(import.meta.url);
const { upsertActiveEntitlementFromRevenueCat, expireEntitlementFromRevenueCat } = require('../database/billing.js');

let failures = 0;
const check = (c, m) => { if (c) console.log(`✓ ${m}`); else { console.error(`✗ ${m}`); failures++; } };
const DAY = 86400e3;

async function partA() {
  const db = new PGlite();
  await applyAll(db);
  const q = async (sql, p = []) => (await db.query(sql, p)).rows;
  const hh = async (email, cus) => {
    const id = (await q('insert into public.households (auth_user_id, email) values (null, $1) returning id', [email]))[0].id;
    await q('update public.households set stripe_customer_id = $2 where id = $1', [id, cus]);
    return id;
  };
  let ev = 0;
  const stripe = async (householdId, cus, sub, status) => {
    const id = `evt_canon_${++ev}`;
    await q(`insert into public.stripe_webhook_events (stripe_event_id, event_type, payload, status) values ($1, 'customer.subscription.updated', '{}'::jsonb, 'received')`, [id]);
    await db.exec('set role service_role;');
    const r = (await q('select public.process_stripe_webhook_event($1,$2,$3,$4,$5,$6,$7,$8,$9) as r', [id, householdId, cus, sub, 'price_x', status, new Date(Date.now() + 30 * DAY).toISOString(), false, new Date().toISOString()]))[0].r;
    await db.exec('reset role;');
    return { id, r };
  };
  const active = async (h) => q("select source, entitlement_type, external_reference from public.entitlements where household_id = $1 and status = 'active'", [h]);

  // stale "active" row (ends_at passed) no longer blocks a paying customer
  const h1 = await hh('stale@example.com', 'cus_s1');
  await q(`insert into public.entitlements (household_id, entitlement_type, status, source, external_reference, starts_at, ends_at) values ($1, 'paid_subscription', 'active', 'apple_revenuecat', 'txn_old', now() - interval '60 days', now() - interval '1 day')`, [h1]);
  await stripe(h1, 'cus_s1', 'sub_s1', 'active');
  const a1 = await active(h1);
  check(a1.length === 1 && a1[0].source === 'stripe', 'a stale "active" Apple row (ends_at passed) no longer blocks the paying Stripe customer');

  // a paid Stripe subscription supersedes an in-effect complimentary grant
  const h2 = await hh('comp@example.com', 'cus_c2');
  await q(`insert into public.entitlements (household_id, entitlement_type, status, source, starts_at, ends_at) values ($1, 'complimentary', 'active', 'admin_manual', now() - interval '1 day', now() + interval '10 days')`, [h2]);
  await stripe(h2, 'cus_c2', 'sub_c2', 'active');
  const a2 = await active(h2);
  check(a2.length === 1 && a2[0].source === 'stripe' && a2[0].entitlement_type === 'paid_subscription', 'a paid Stripe subscription supersedes a complimentary grant (the paying customer keeps access when the free grant ends)');

  // an in-effect paid Apple entitlement is never revoked by Stripe events
  const h3 = await hh('both@example.com', 'cus_b3');
  await q(`insert into public.entitlements (household_id, entitlement_type, status, source, external_reference, starts_at, ends_at) values ($1, 'paid_subscription', 'active', 'apple_revenuecat', 'txn_live', now() - interval '1 day', now() + interval '20 days')`, [h3]);
  await stripe(h3, 'cus_b3', 'sub_b3', 'active');
  await stripe(h3, 'cus_b3', 'sub_b3', 'canceled');
  const a3 = await active(h3);
  check(a3.length === 1 && a3[0].source === 'apple_revenuecat', 'S40: Stripe subscribe + cancel events never revoke the in-effect paid Apple entitlement');

  // duplicate delivery of one Stripe event is processed once
  const h4 = await hh('dup@example.com', 'cus_d4');
  const first = await stripe(h4, 'cus_d4', 'sub_d4', 'active');
  await db.exec('set role service_role;');
  const replay = (await q('select public.process_stripe_webhook_event($1,$2,$3,$4,$5,$6,$7,$8,$9) as r', [first.id, h4, 'cus_d4', 'sub_d4', 'price_x', 'active', new Date(Date.now() + 30 * DAY).toISOString(), false, new Date().toISOString()]))[0].r;
  await db.exec('reset role;');
  const rows4 = await q("select count(*)::int n from public.entitlements where household_id = $1", [h4]);
  // De-duplication is at the CLAIM layer (database/billing.js claimWebhookEvent
  // inserts the event id under a unique key before the RPC runs); the RPC's
  // effect is itself idempotent.
  let claimRefused = false;
  try { await q(`insert into public.stripe_webhook_events (stripe_event_id, event_type, payload, status) values ($1, 'customer.subscription.updated', '{}'::jsonb, 'received')`, [first.id]); } catch { claimRefused = true; }
  check(first.r === 'processed' && claimRefused && rows4[0].n === 1, `S38: a duplicate Stripe event cannot be claimed twice, and even a re-run of the RPC (${replay}) leaves exactly one entitlement`);

  // cancellation expires only THIS subscription's entitlement
  await stripe(h4, 'cus_d4', 'sub_d4', 'canceled');
  check((await active(h4)).length === 0, 'S39: a cancelled/refunded Stripe subscription expires its own entitlement');

  // Part C: Fortress profile for a SANDBOX Apple entitlement
  const h5 = await hh('sandbox@example.com', 'cus_x5');
  await q(`insert into public.entitlements (household_id, entitlement_type, status, source, external_reference, starts_at, ends_at, revenuecat_environment) values ($1, 'paid_subscription', 'active', 'apple_revenuecat', 'txn_sbx', now() - interval '1 day', now() + interval '20 days', 'sandbox')`, [h5]);
  const h6 = await hh('legacy@example.com', 'cus_x6');
  await q(`insert into public.entitlements (household_id, entitlement_type, status, source, external_reference, starts_at, ends_at) values ($1, 'paid_subscription', 'active', 'apple_revenuecat', 'txn_legacy', now() - interval '1 day', now() + interval '20 days')`, [h6]);
  const p5 = (await q('select public.fc_resolve_profile($1, now()) as p', [h5]))[0].p;
  const p6 = (await q('select public.fc_resolve_profile($1, now()) as p', [h6]))[0].p;
  const prof = (await q("select period_budget_gbp::float b, monitoring_allowed m from public.fc_budget_profiles where profile = 'sandbox'"))[0];
  check(p5 === 'sandbox' && prof.b === 0 && prof.m === false, 'S35: a SANDBOX (TestFlight) entitlement resolves to the unfunded sandbox profile — no paid monitoring, no £ budget');
  check(p6 === 'standard', 'a legacy Apple row with no recorded environment is NOT treated as sandbox');
  await q(`insert into public.account_classifications (household_id, classification) values ($1, 'internal_test') on conflict (household_id) do update set classification = 'internal_test'`, [h5]);
  check((await q('select public.fc_resolve_profile($1, now()) as p', [h5]))[0].p === 'internal_test', 'an account classified internal_test keeps its test profile even with sandbox purchases');
  await db.close();
}

function fakeEntitlements(rows) {
  const table = rows.map((r, i) => ({ id: `e${i}`, ...r }));
  let nextId = table.length;
  const api = {
    table,
    from() {
      let filters = []; let op = 'select'; let patch = null; let insertRow = null;
      const run = () => {
        const match = table.filter((r) => filters.every(([k, v]) => r[k] === v));
        if (op === 'update') { match.forEach((r) => Object.assign(r, patch)); return { data: match, error: null }; }
        if (op === 'insert') { const row = { id: `e${nextId++}`, ...insertRow }; table.push(row); return { data: row, error: null }; }
        return { data: match, error: null };
      };
      const q = {
        select() { return q; },
        eq(k, v) { filters.push([k, v]); return q; },
        update(p) { op = 'update'; patch = p; return q; },
        insert(r) { op = 'insert'; insertRow = r; return q; },
        maybeSingle() { const r = run(); return Promise.resolve({ data: Array.isArray(r.data) ? (r.data[0] || null) : r.data, error: null }); },
        single() { const r = run(); return Promise.resolve({ data: Array.isArray(r.data) ? r.data[0] : r.data, error: null }); },
        then(resolve) { resolve(run()); },
      };
      return q;
    },
  };
  return api;
}

async function partB() {
  const now = Date.parse('2026-10-03T12:00:00Z');
  const deps = (client) => ({ client, now: () => now });
  const future = (d) => now + d * DAY;
  const iso = (ms) => new Date(ms).toISOString();

  // 36/37: replay / out-of-order renewal can't roll ends_at back
  const c1 = fakeEntitlements([{ household_id: 'h', status: 'active', source: 'apple_revenuecat', entitlement_type: 'paid_subscription', external_reference: 'txn1', ends_at: iso(future(30)) }]);
  const older = await upsertActiveEntitlementFromRevenueCat('h', { originalTransactionId: 'txn1', expiresAtMs: future(1), environment: 'production' }, deps(c1));
  check(older.action === 'ignored_older_event' && c1.table[0].ends_at === iso(future(30)), 'S36/S37: a replayed/out-of-order older renewal never moves ends_at backwards');
  const newer = await upsertActiveEntitlementFromRevenueCat('h', { originalTransactionId: 'txn1', expiresAtMs: future(60), environment: 'production' }, deps(c1));
  check(newer.action === 'renewed' && c1.table[0].ends_at === iso(future(60)), 'a genuine later renewal extends ends_at');
  const exp = await expireEntitlementFromRevenueCat('h', 'txn1', { client: c1, expiresAtMs: future(30) });
  check(!exp.revoked && c1.table[0].status === 'active', 'S37: an EXPIRATION for a period that has since been renewed is ignored');
  const expNow = await expireEntitlementFromRevenueCat('h', 'txn1', { client: c1, expiresAtMs: future(60) });
  check(expNow.revoked && c1.table[0].status === 'expired', 'an EXPIRATION for the current period expires it');

  // 40: Apple purchase while Stripe is in effect
  const c2 = fakeEntitlements([{ household_id: 'h', status: 'active', source: 'stripe', entitlement_type: 'paid_subscription', external_reference: 'sub_1', ends_at: null }]);
  const par = await upsertActiveEntitlementFromRevenueCat('h', { originalTransactionId: 'txn2', expiresAtMs: future(30), environment: 'production' }, deps(c2));
  check(par.action === 'parallel_paid_kept_existing' && c2.table.filter((r) => r.status === 'active').map((r) => r.source).join() === 'stripe', 'S40: an Apple purchase never expires an in-effect paid Stripe entitlement (kept; support alerted by the route)');
  const exp2 = await expireEntitlementFromRevenueCat('h', 'txn2', { client: c2, expiresAtMs: future(30) });
  check(!exp2.revoked && c2.table[0].status === 'active', 'S40: the later Apple EXPIRATION leaves the Stripe customer\'s access untouched');

  // 35: sandbox purchase never supersedes complimentary / paid in effect
  const c3 = fakeEntitlements([{ household_id: 'h', status: 'active', source: 'admin_manual', entitlement_type: 'complimentary', ends_at: iso(future(10)) }]);
  const sbx = await upsertActiveEntitlementFromRevenueCat('h', { originalTransactionId: 'txn3', expiresAtMs: future(30), environment: 'sandbox' }, deps(c3));
  check(sbx.action === 'sandbox_kept_existing' && c3.table.length === 1 && c3.table[0].status === 'active', 'S35: a SANDBOX purchase never replaces an in-effect complimentary (App Review/reviewer) entitlement');
  const prod = await upsertActiveEntitlementFromRevenueCat('h', { originalTransactionId: 'txn4', expiresAtMs: future(30), environment: 'production' }, deps(c3));
  check(prod.action === 'granted' && c3.table.find((r) => r.status === 'active').source === 'apple_revenuecat', 'a PRODUCTION paid purchase supersedes complimentary');

  // stale active row is replaced
  const c4 = fakeEntitlements([{ household_id: 'h', status: 'active', source: 'stripe', entitlement_type: 'paid_subscription', external_reference: 'sub_old', ends_at: iso(now - DAY) }]);
  const st = await upsertActiveEntitlementFromRevenueCat('h', { originalTransactionId: 'txn5', expiresAtMs: future(30), environment: 'production' }, deps(c4));
  check(st.action === 'granted' && c4.table[0].status === 'expired', 'a stale "active" row (ends_at passed) is not in effect and is replaced');
}

await partA();
await partB();
console.log(failures === 0 ? '\nAll canonical entitlement checks passed.' : `\n${failures} canonical entitlement check(s) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
