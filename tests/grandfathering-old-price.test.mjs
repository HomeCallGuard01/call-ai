// Grandfathering at the £5.99 cutover (WS4, 2026-10-10).
//
// Scenario: existing subscribers are on the OLD Stripe Price (£4.99).
// At cutover STRIPE_PRICE_ID is pointed at a NEW Price (£5.99) and the old
// Price is archived. Existing subscribers are grandfathered (Andrew), so
// they must keep a valid entitlement through every renewal, and nothing in
// HCG may move them, revoke them or re-plan them because their Price is not
// STRIPE_PRICE_ID.
//
// Proves:
//   A. through the REAL /billing/webhook route (genuine Stripe signatures,
//      database layer stubbed): renewals of an old-Price subscription are
//      processed with the subscription's OWN Price id, keep provisioning
//      "active", are unaffected by the acquisition gate (paused / allowlist),
//      and price/invoice events (e.g. the old Price being archived) change
//      nothing;
//   B. real SQL (PGlite, every migration in order, so 070's
//      process_stripe_webhook_event): the old-Price entitlement survives
//      creation + 3 renewals + a past_due retry, is never duplicated, and
//      the subscriptions row keeps the old Price id; only a terminal status
//      (canceled) ends it — exactly as for a new-Price subscriber;
//   C. plan sync: with PLAN_PRODUCT_MAP unset nothing changes; with it set
//      to only the new Price, the old Price resolves to Standard (the plan
//      every subscriber is on), never a smaller allowance or "no plan";
//   D. static: no server code compares a subscription's Price with
//      STRIPE_PRICE_ID; STRIPE_PRICE_ID is read only to create NEW checkouts,
//      describe the offer, label metadata, check configuration and (admin)
//      estimate MRR; the entitlement RPC (070) only stores the Price id;
//      no code updates a subscription's items/Price, and Billing Portal
//      sessions are created with only {customer, return_url} (no flow that
//      switches plans).
//   E. the old Price still describes itself on the Membership card (the
//      customer sees their own price, not the new one) and an old-Price
//      subscriber can't be sold a second subscription.
//
// Run with: node tests/grandfathering-old-price.test.mjs
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { applyAll } from './financial-containment-harness.mjs';

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => readFileSync(path.join(root, ...p), 'utf8');

const OLD_PRICE = 'price_old_499_archived';
const NEW_PRICE = 'price_new_599';

Object.assign(process.env, {
  SUPABASE_URL: 'http://127.0.0.1:9', SUPABASE_ANON_KEY: 'test', SUPABASE_SERVICE_ROLE_KEY: 'test',
  // Local signing only (constructEvent is offline); no Stripe API call is made.
  STRIPE_SECRET_KEY: 'sk_test_ws4_grandfathering_fake', STRIPE_WEBHOOK_SECRET: 'whsec_ws4_grandfathering', Resend_API_Key: '',
  STRIPE_PRICE_ID: NEW_PRICE,
  NEW_SUBSCRIPTIONS_PAUSED: 'true',
  NEW_SUBSCRIPTIONS_ALLOWLIST: 'someone-else@example.com',
});
delete process.env.ACCOUNTING_CAPTURE_ENABLED;
delete process.env.ALLOWANCE_TOPUPS_ENABLED;
delete process.env.PLAN_PRODUCT_MAP;

let failures = 0;
const check = (c, m) => { if (c) console.log(`✓ ${m}`); else { console.error(`✗ ${m}`); failures++; } };
const stub = (rel, exports) => { const id = require.resolve(rel); require.cache[id] = { id, filename: id, loaded: true, exports }; };
const DAY = 86400;

// ── A. the real webhook route ─────────────────────────────────────────────
const HH = 'aaaaaaaa-0000-0000-0000-00000000f499';
const household = { id: HH, status: 'active', email: 'grandfathered@example.com', auth_user_id: 'auth-gf', stripe_customer_id: 'cus_gf' };
const events = new Map();
const rpcCalls = []; const provisioning = []; const planSyncs = []; const alerts = [];

const realBilling = require('../database/billing.js');
stub('../database/billing.js', {
  ...realBilling,
  getHouseholdByStripeCustomerId: async (cus) => (cus === household.stripe_customer_id ? household : null),
  getHouseholdDeletionFacts: async (id) => (id === HH ? household : null),
  claimWebhookEvent: async ({ stripeEventId }) => { if (events.has(stripeEventId)) return false; events.set(stripeEventId, 'received'); return true; },
  markWebhookEventIgnored: async ({ stripeEventId }) => { events.set(stripeEventId, 'ignored'); },
  processWebhookEvent: async (p) => { rpcCalls.push(p); events.set(p.stripeEventId, 'processed'); return 'processed'; },
});
stub('../services/alerting.js', { sendCriticalAlert: async (type) => { alerts.push(type); } });
const realProv = require('../services/twilioProvisioning.js');
stub('../services/twilioProvisioning.js', { ...realProv, handleProcessedWebhookEvent: async (r, ctx) => { provisioning.push({ r, ...ctx }); } });
stub('../services/acquisitionAnalytics.js', { recordAcquisitionEvent: async () => {} });
stub('../services/allowance/planSync.js', { syncPlanCode: async (args) => { planSyncs.push(args); return { changed: false }; } });

const express = require('express');
const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const app = express();
app.use(require('../routes/billing.js'));
const server = http.createServer(app);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const send = async (event) => {
  const payload = JSON.stringify(event);
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET });
  const res = await fetch(`${base}/billing/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': header }, body: payload });
  return res.status;
};
const t0 = Math.floor(Date.now() / 1000) - 90 * DAY;
const subEvent = (id, type, { status = 'active', periodEnd, created, price = OLD_PRICE }) => ({
  id, object: 'event', type, livemode: false, created,
  data: { object: { id: 'sub_gf', object: 'subscription', customer: 'cus_gf', status, metadata: { household_id: HH }, cancel_at_period_end: false, current_period_end: periodEnd, items: { data: [{ price: { id: price, active: price !== OLD_PRICE, unit_amount: price === OLD_PRICE ? 499 : 599 } }] } } },
});

try {
  check((await send(subEvent('evt_gf_created', 'customer.subscription.created', { periodEnd: t0 + 30 * DAY, created: t0 }))) === 200, 'old-Price subscription.created → 200');
  // The old Price is archived at cutover (Stripe sends price.updated active:false).
  check((await send({ id: 'evt_gf_price_archived', object: 'event', type: 'price.updated', livemode: false, created: t0 + 20 * DAY, data: { object: { id: OLD_PRICE, object: 'price', active: false } } })) === 200, 'old Price archived (price.updated active:false) → acknowledged 200');
  for (let n = 1; n <= 3; n++) {
    const at = t0 + n * 30 * DAY;
    check((await send({ id: `evt_gf_invoice_${n}`, object: 'event', type: 'invoice.paid', livemode: false, created: at, data: { object: { id: `in_gf_${n}`, object: 'invoice', customer: 'cus_gf', subscription: 'sub_gf', lines: { data: [{ price: { id: OLD_PRICE } }] } } } })) === 200, `renewal ${n}: invoice.paid on the archived Price → acknowledged 200`);
    check((await send(subEvent(`evt_gf_renew_${n}`, 'customer.subscription.updated', { periodEnd: at + 30 * DAY, created: at + 1 }))) === 200, `renewal ${n}: subscription.updated (still the old Price) → 200`);
  }
  check((await send(subEvent('evt_gf_past_due', 'customer.subscription.updated', { status: 'past_due', periodEnd: t0 + 120 * DAY, created: t0 + 119 * DAY }))) === 200, 'a failed renewal (past_due) → 200');

  check(rpcCalls.length === 5, `5 subscription events reached the entitlement RPC (created, 3 renewals, past_due): ${rpcCalls.length}`);
  check(rpcCalls.every((c) => c.stripePriceId === OLD_PRICE), 'every RPC call carries the subscription\'s OWN (old, archived) Price id — never STRIPE_PRICE_ID');
  check(rpcCalls.every((c) => c.householdId === HH && c.stripeSubscriptionId === 'sub_gf'), '… for the same household and subscription');
  check(rpcCalls.filter((c) => c.subscriptionStatus === 'active').length === 4, 'creation + 3 renewals are processed as active');
  check(provisioning.length === 5 && provisioning.every((p) => p.r === 'processed') && provisioning.filter((p) => p.subscriptionStatus === 'active').length === 4, 'Twilio provisioning is told "active" on every renewal (the number is kept)');
  check(!provisioning.some((p) => /cancel|deleted|unpaid|incomplete_expired/.test(p.subscriptionStatus)), 'nothing ever tells provisioning to release the number');
  check(planSyncs.length === 5 && planSyncs.every((p) => p.providerProductId === OLD_PRICE && p.source === 'stripe'), 'plan sync sees the subscription\'s own Price (resolved in C below)');
  check(alerts.length === 0, 'no critical alert for a normal grandfathered renewal');
  check(['evt_gf_price_archived', 'evt_gf_invoice_1'].every((id) => !events.has(id)), 'price/invoice events are acknowledged without touching the entitlement path');
  check(process.env.NEW_SUBSCRIPTIONS_PAUSED === 'true' && rpcCalls.length === 5, 'renewals are processed even while NEW_SUBSCRIPTIONS_PAUSED=true and the customer is not on the allowlist (the gate is new checkouts only)');
} finally {
  server.close();
}

// ── B. real SQL: 070's process_stripe_webhook_event ──────────────────────
{
  const db = new PGlite();
  await applyAll(db);
  const q = async (sql, p = []) => (await db.query(sql, p)).rows;
  const hh = async (email, cus) => {
    const id = (await q('insert into public.households (auth_user_id, email) values (null, $1) returning id', [email]))[0].id;
    await q('update public.households set stripe_customer_id = $2 where id = $1', [id, cus]);
    return id;
  };
  let ev = 0;
  const now = Date.now();
  const rpc = async (h, cus, sub, price, status, periodEndMs, createdMs) => {
    const id = `evt_gf_sql_${++ev}`;
    await q(`insert into public.stripe_webhook_events (stripe_event_id, event_type, payload, status) values ($1, 'customer.subscription.updated', '{}'::jsonb, 'received')`, [id]);
    await db.exec('set role service_role;');
    const r = (await q('select public.process_stripe_webhook_event($1,$2,$3,$4,$5,$6,$7,$8,$9) as r', [id, h, cus, sub, price, status, new Date(periodEndMs).toISOString(), false, new Date(createdMs).toISOString()]))[0].r;
    await db.exec('reset role;');
    return r;
  };
  const activeEnt = async (h) => q("select id, source, entitlement_type, external_reference from public.entitlements where household_id = $1 and status = 'active'", [h]);
  const subRow = async (sub) => (await q('select stripe_price_id, status from public.subscriptions where stripe_subscription_id = $1', [sub]))[0];

  const old = await hh('old@example.com', 'cus_old');
  const fresh = await hh('new@example.com', 'cus_new');
  const results = [];
  results.push(await rpc(old, 'cus_old', 'sub_old', OLD_PRICE, 'active', now - 60 * DAY * 1000, now - 90 * DAY * 1000));
  const firstEnt = (await activeEnt(old))[0];
  for (let n = 1; n <= 3; n++) results.push(await rpc(old, 'cus_old', 'sub_old', OLD_PRICE, 'active', now + (n * 30 - 60) * DAY * 1000, now - (90 - n * 30) * DAY * 1000 + 1000));
  const afterRenewals = await activeEnt(old);
  check(results.every((r) => r === 'processed'), `SQL: creation + 3 renewals on the old Price all processed (${results.join(',')})`);
  check(afterRenewals.length === 1 && afterRenewals[0].id === firstEnt.id && afterRenewals[0].source === 'stripe' && afterRenewals[0].entitlement_type === 'paid_subscription' && afterRenewals[0].external_reference === 'sub_old',
    'SQL: the SAME single paid Stripe entitlement stays active through every renewal (not re-created, not duplicated)');
  check((await subRow('sub_old')).stripe_price_id === OLD_PRICE, 'SQL: subscriptions.stripe_price_id keeps the old Price (the household\'s own price, used for its Membership label)');
  check(await rpc(old, 'cus_old', 'sub_old', OLD_PRICE, 'past_due', now + 30 * DAY * 1000, now + 1000) === 'processed' && (await activeEnt(old)).length === 1, 'SQL: a past_due retry keeps access (same rule as every subscriber)');
  check(await rpc(old, 'cus_old', 'sub_old', OLD_PRICE, 'active', now + 30 * DAY * 1000, now + 2000) === 'processed' && (await activeEnt(old))[0].id === firstEnt.id, 'SQL: recovery from past_due → still the same entitlement');

  // Control: a new-Price subscriber behaves identically.
  await rpc(fresh, 'cus_new', 'sub_new', NEW_PRICE, 'active', now + 30 * DAY * 1000, now);
  await rpc(fresh, 'cus_new', 'sub_new', NEW_PRICE, 'active', now + 60 * DAY * 1000, now + 1000);
  check((await activeEnt(fresh)).length === 1 && (await subRow('sub_new')).stripe_price_id === NEW_PRICE, 'SQL control: a new-Price subscriber is handled by exactly the same rule');

  // Only a terminal status ends access — never the Price.
  await rpc(old, 'cus_old', 'sub_old', OLD_PRICE, 'canceled', now + 30 * DAY * 1000, now + 3000);
  check((await activeEnt(old)).length === 0 && (await activeEnt(fresh)).length === 1, 'SQL: only a terminal status (canceled) ends the old-Price entitlement; the other household is untouched');

  const fn = (await q("select pg_get_functiondef('public.process_stripe_webhook_event(text,uuid,text,text,text,text,timestamptz,boolean,timestamptz)'::regprocedure) as d"))[0].d;
  const priceRefs = (fn.match(/p_stripe_price_id/g) || []).length;
  check(priceRefs === 2 && /values \(\s*p_household_id, p_stripe_subscription_id, p_stripe_price_id/.test(fn), `SQL: the live function definition references p_stripe_price_id only in its signature and the subscriptions insert (${priceRefs} refs) — it never decides access on the Price`);
  await db.close();
}

// ── C. plan sync: an unmapped (old) Price is Standard ─────────────────────
{
  const { syncPlanCode } = (() => { delete require.cache[require.resolve('../services/allowance/planSync.js')]; return require('../services/allowance/planSync.js'); })();
  const { DEFAULT_PLAN_CODE } = require('../services/usage/plans.js');
  const writes = [];
  const setPlanCode = async (a) => { writes.push(a); return true; };
  const off = await syncPlanCode({ householdId: HH, source: 'stripe', providerProductId: OLD_PRICE, setPlanCode, env: {}, log: { log() {}, error() {} } });
  check(off.reason === 'not_configured' && writes.length === 0, 'PLAN_PRODUCT_MAP unset (today): plan sync changes nothing for the old Price');
  const on = await syncPlanCode({ householdId: HH, source: 'stripe', providerProductId: OLD_PRICE, setPlanCode, env: { PLAN_PRODUCT_MAP: JSON.stringify({ [NEW_PRICE]: 'standard' }) }, log: { log() {}, error() {} } });
  check(DEFAULT_PLAN_CODE === 'standard' && on.planCode === 'standard' && writes[0].planCode === 'standard', 'PLAN_PRODUCT_MAP listing only the new Price: the old Price resolves to Standard (the same plan), never a smaller allowance');
}

// ── D. static: nothing grants/revokes on STRIPE_PRICE_ID ──────────────────
{
  const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const jsFiles = [];
  const walk = (dir) => { for (const e of readdirSync(path.join(root, dir), { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.js')) jsFiles.push(p); } };
  for (const d of ['routes', 'services', 'database', 'middleware']) walk(d);
  jsFiles.push('server.js');
  const uses = [];
  for (const f of jsFiles) code(read(f)).split('\n').forEach((line, i) => { if (line.includes('STRIPE_PRICE_ID')) uses.push({ f, line: line.trim(), n: i + 1 }); });
  const allowedUse = (u) =>
    /priceId: process\.env\.STRIPE_PRICE_ID,?$/.test(u.line) || // NEW checkout line item
    /stripe_price_id: process\.env\.STRIPE_PRICE_ID \|\| "unknown",?$/.test(u.line) || // descriptive metadata
    /if \(!process\.env\.STRIPE_PRICE_ID\)/.test(u.line) || // configuration presence
    /^console\.error\("[A-Z ]*CHECKOUT SESSION ERROR: STRIPE_PRICE_ID not configured"\);$/.test(u.line) || // its log line
    /priceId = process\.env\.STRIPE_PRICE_ID\)/.test(u.line) || // getCurrentStripeOffer default (offer text)
    /if \(!stripe \|\| !process\.env\.STRIPE_PRICE_ID\) return null;/.test(u.line) || // admin MRR estimate
    /stripe\.prices\.retrieve\(process\.env\.STRIPE_PRICE_ID\)/.test(u.line) || // admin MRR estimate
    /^"STRIPE_PRICE_ID",?$/.test(u.line) || /\['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_PRICE_ID'\]/.test(u.line) || /present\(e\.STRIPE_PRICE_ID\)/.test(u.line); // config lists
  const unexpected = uses.filter((u) => !allowedUse(u));
  check(uses.length >= 8 && unexpected.length === 0, `every STRIPE_PRICE_ID read is a new-checkout, offer, metadata, config or admin-estimate use (${uses.length} reads; unexpected: ${unexpected.map((u) => `${u.f}:${u.n} ${u.line}`).join(' | ') || 'none'})`);
  const comparisons = [];
  for (const f of jsFiles) code(read(f)).split('\n').forEach((line, i) => {
    if (/STRIPE_PRICE_ID/.test(line) && /(===|!==|==|!=|\.includes\(|\.has\()/.test(line)) comparisons.push(`${f}:${i + 1}`);
    if (/(stripe_price_id|price\??\.id|stripePriceId)\s*(===|!==|==|!=)/.test(line)) comparisons.push(`${f}:${i + 1}`);
  });
  check(comparisons.length === 0, `no server code compares a subscription's Price id with anything to grant or revoke (${comparisons.join(', ') || 'none'})`);
  const mutating = jsFiles.filter((f) => /stripe\.subscriptions\.update|subscriptionItems\.|stripe\.prices\.(update|create)|stripe\.subscriptionSchedules/.test(code(read(f))));
  check(mutating.length === 0, `no code changes a subscription's items/Price or creates/edits Prices (${mutating.join(', ') || 'none'})`);
  const portalCalls = [];
  for (const f of jsFiles) for (const m of code(read(f)).matchAll(/billingPortal\.sessions\.create\(\{([\s\S]*?)\}\)/g)) portalCalls.push({ f, body: m[1].replace(/\s+/g, ' ').trim() });
  check(portalCalls.length === 2 && portalCalls.every((p) => /^customer: req\.household\.stripe_customer_id, return_url: [^,]+,?$/.test(p.body)), `Billing Portal sessions pass only {customer, return_url} — no plan-switch flow, no configuration override (${portalCalls.map((p) => `${p.f}: ${p.body}`).join(' | ')})`);
  const mig070 = read('supabase', 'migrations', '070_stripe_entitlement_canonical_decision.sql');
  check((mig070.match(/p_stripe_price_id/g) || []).length === 2, 'migration 070 (the canonical entitlement decision) only accepts and stores the Price id');
}

// ── E. Membership label + no second subscription ──────────────────────────
{
  const { resolveMembershipPriceLabel, describeStripePrice } = require('../services/subscriptionPricing.js');
  const lookup = async (id) => describeStripePrice({ id, currency: 'gbp', unit_amount: id === OLD_PRICE ? 499 : 599, tax_behavior: 'inclusive', recurring: { interval: 'month', interval_count: 1 } });
  const label = await resolveMembershipPriceLabel({ entitlement: { entitlement_type: 'paid_subscription', source: 'stripe' }, subscription: { stripe_price_id: OLD_PRICE }, lookupStripePrice: lookup });
  check(label === '£4.99 per month including VAT', `the grandfathered customer's Membership card shows THEIR price (an archived Price is still retrievable from Stripe): "${label}"`);
  const { hasQualifyingStripeSubscription } = require('../routes/billing.js');
  check(hasQualifyingStripeSubscription([{ status: 'active', items: { data: [{ price: { id: OLD_PRICE } }] } }]) === true, 'an old-Price subscriber cannot start a second (new-Price) subscription: the duplicate-checkout guard is price-agnostic');
}

console.log(failures === 0 ? '\nGrandfathering: all checks hold.' : `\n${failures} check(s) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
