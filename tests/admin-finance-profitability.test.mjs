// WS2 (2026-10-10) — per-household profitability read model + admin router
// factory (WS4 contract, report §B). Pure maths, router auth/validation, the
// paginated loader, and an end-to-end run over REAL Fortress accounts (PGlite,
// every migration) through a minimal query-builder adapter.
import { createRequire } from 'node:module';
import { PGlite } from '@electric-sql/pglite';
import { applyAll, rpcs } from './financial-containment-harness.mjs';

const require = createRequire(import.meta.url);
const express = require('express');
const P = require('../services/finance/profitability.js');
const { createAdminFinanceRouter } = require('../routes/adminFinance.js');
const { assembleInputs, loadProfitabilityInputs, selectAll } = require('../database/profitability.js');

let failures = 0;
const check = (c, m) => { if (c) console.log(`✓ ${m}`); else { console.error(`✗ ${m}`); failures++; } };
const near = (a, b, eps = 0.011) => Math.abs(Number(a) - Number(b)) < eps;

const ENV = { FINANCE_STRIPE_LIVE_PRICES: JSON.stringify({ price_live599: 5.99, price_live499: 4.99 }) };
const cfg = P.resolveProfitabilityConfig(ENV);
const NOW = new Date('2026-10-16T00:00:00Z');
const period = P.resolvePeriod('2026-10', NOW);
const KEYS = ['householdId', 'accountNumber', 'profile', 'channel', 'pricePoint', 'revenue', 'cost', 'contribution', 'projection', 'allowance', 'flags'];

// ── period ───────────────────────────────────────────────────────────────
check(period.start === '2026-10-01T00:00:00.000Z' && period.end === '2026-11-01T00:00:00.000Z' && near(period.elapsedFraction, 15 / 31, 0.001), 'UTC calendar month + elapsed fraction');
check(P.resolvePeriod('2026-13', NOW) === null && P.resolvePeriod('x', NOW) === null, 'invalid period → null');

// ── revenue ──────────────────────────────────────────────────────────────
const ent = (o = {}) => ({ household_id: 'h', entitlement_type: 'paid_subscription', status: 'active', source: 'stripe', starts_at: '2026-09-01T00:00:00Z', ends_at: null, ...o });
const s599 = P.subscriptionRevenue({ entitlement: ent(), subscription: { stripe_price_id: 'price_live599', status: 'active' } }, cfg);
const stripeFee = 5.99 * (0.015 + 0.007 + 0.005) + 0.20;
check(s599.counted && s599.pricePoint === 'standard_599' && near(s599.netExVatGbp, 4.99) && near(s599.vatGbp, 1.0) && near(s599.platformFeeGbp, stripeFee, 0.02),
  `£5.99 Stripe live: VAT £1.00 removed, net £4.99, fee £${s599.platformFeeGbp}`);
const s499 = P.subscriptionRevenue({ entitlement: ent(), subscription: { stripe_price_id: 'price_live499', status: 'active' } }, cfg);
check(s499.pricePoint === 'grandfathered_499' && near(s499.netExVatGbp, 4.16), 'grandfathered £4.99 recognised (net £4.16)');
check(P.subscriptionRevenue({ entitlement: ent(), subscription: { stripe_price_id: 'price_testmode', status: 'active' } }, cfg).reasonNotCounted === 'unknown_price',
  'a Stripe price not in the LIVE map (e.g. test mode) counts £0');
check(P.subscriptionRevenue({ entitlement: ent({ source: 'apple_revenuecat', revenuecat_environment: 'sandbox' }) }, cfg).reasonNotCounted === 'sandbox', 'Apple sandbox counts £0');
const apple = P.subscriptionRevenue({ entitlement: ent({ source: 'apple_revenuecat', revenuecat_environment: 'production' }) }, cfg);
check(apple.counted && near(apple.platformFeeGbp, (4.99 / 1.2) * 0.30) && apple.channel === 'apple', 'Apple production £4.99 with the 30% fee model (SBP unconfirmed)');
check(P.subscriptionRevenue({ entitlement: ent({ entitlement_type: 'complimentary' }) }, cfg).reasonNotCounted === 'complimentary', 'complimentary counts £0');
check(P.subscriptionRevenue({ entitlement: ent({ entitlement_type: 'free_trial' }) }, cfg).reasonNotCounted === 'trial', 'trial counts £0');
check(P.subscriptionRevenue({ entitlement: null }, cfg).reasonNotCounted === 'no_entitlement', 'no entitlement counts £0');
const tu = P.topUpRevenue([
  { kind: 'topup', source: 'stripe', environment: 'production', provider_transaction_id: 'pi1', amount_minor: 299, currency: 'gbp', applied_budget_gbp: 1.0 },
  { kind: 'topup', source: 'stripe', environment: 'sandbox', provider_transaction_id: 'pi2', amount_minor: 299, currency: 'gbp', applied_budget_gbp: 1.0 },
  { kind: 'topup', source: 'stripe', environment: 'production', provider_transaction_id: 'pi3', amount_minor: 299, currency: 'gbp', applied_budget_gbp: 1.0 },
  { kind: 'topup_reversal', source: 'stripe', environment: 'production', provider_transaction_id: 'pi3', applied_budget_gbp: -1.0 },
], cfg);
check(near(tu.topUpNetGbp, 2 * (2.99 / 1.2 - (2.99 * 0.027 + 0.2)), 0.02) && near(tu.refundsGbp, tu.topUpNetGbp / 2, 0.01) && near(tu.topUpCreditGbp, 1.0),
  'top-ups: production only, net of VAT and fee; refunds subtract; credited £ net of reversals');

// ── household row ────────────────────────────────────────────────────────
const acct = (o = {}) => ({ profile: 'standard', period_start: '2026-10-01T00:00:00Z', period_end: '2026-11-01T00:00:00Z', base_budget_gbp: 3, adjustments_gbp: 0,
  delivery_reserve_gbp: 0.5, essential_reserve_gbp: 0.1, consumed_gbp: 1.0, reserved_gbp: 0.07, actual_gbp: 0.7, essential_consumed_gbp: 0, essential_reserved_gbp: 0,
  unscreened_reserve_gbp: 0, unscreened_consumed_gbp: 0, unscreened_reserved_gbp: 0, delivery_reserve_scope: 'trusted_only', ...o });
const row = P.computeHouseholdProfitability({ household: { id: 'h1', account_number: 'HCG-1' }, entitlement: ent(), subscription: { stripe_price_id: 'price_live599', status: 'active' },
  accounts: [acct()], credits: [], held: false, numbersHeld: 1 }, period, cfg);
check(JSON.stringify(Object.keys(row)) === JSON.stringify(KEYS), 'row has exactly the published contract keys');
const expNet = 4.99 - stripeFee - 4.99 * 0.02;
check(near(row.revenue.netRevenueGbp, expNet, 0.02) && near(row.cost.attributableUsageGbp, 1.0) && near(row.cost.numberRentalGbp, 0.87) && near(row.cost.fixedAllocationGbp, 0.25),
  `revenue £${row.revenue.netRevenueGbp} net; usage £1.00 (Fortress committed, conservative), rental £0.87, fixed £0.25`);
check(near(row.contribution.gbp, expNet - 2.12, 0.02) && row.contribution.marginPct !== null, `contribution £${row.contribution.gbp} (${row.contribution.marginPct}%)`);
check(near(row.projection.projectedUsageGbp, 1.0 / (15 / 31), 0.02), `projection scales usage by elapsed time (£${row.projection.projectedUsageGbp})`);
const heavy = P.computeHouseholdProfitability({ household: { id: 'h2' }, entitlement: ent(), subscription: { stripe_price_id: 'price_live599', status: 'active' },
  accounts: [acct({ consumed_gbp: 3.4, reserved_gbp: 0 })], numbersHeld: 1 }, P.resolvePeriod('2026-10', new Date('2026-10-05T00:00:00Z')), cfg);
check(heavy.projection.projectedUsageGbp <= 3 + 0.5 + 0.1 + 1e-9 && heavy.flags.includes('heavy_user'),
  `projection is bounded by the Fortress authorisation (£${heavy.projection.projectedUsageGbp} ≤ £3.60) and flags heavy_user`);
check(['continuity', 'continuity_low'].includes(heavy.allowance.state), `snapshot state for a spent budget: ${heavy.allowance.state}`);
const comp = P.computeHouseholdProfitability({ household: { id: 'h3' }, entitlement: ent({ entitlement_type: 'complimentary' }), accounts: [acct()], numbersHeld: 1, held: true }, period, cfg);
check(comp.flags.includes('loss_making') && comp.flags.includes('revenue_not_counted') && comp.flags.includes('held') && comp.channel === 'complimentary',
  'complimentary household: loss_making + revenue_not_counted + held');
const under = P.computeHouseholdProfitability({ household: { id: 'h4' }, entitlement: ent(), subscription: { stripe_price_id: 'price_live599' }, accounts: [acct({ actual_gbp: 1.5 })] }, period, cfg);
check(under.flags.includes('actual_exceeds_estimate') && near(under.cost.attributableUsageGbp, 1.5), 'actual above estimate: flagged, and usage = max(estimate, actual)');
const pf = P.buildPortfolio([row, heavy, comp, under], { period, config: cfg, now: NOW });
check(pf.version === 1 && pf.totals.households === 4 && pf.totals.flagCounts.loss_making >= 1 && pf.page.total === 4 && pf.assumptions.usageCostBasis === 'fortress_committed_conservative',
  'portfolio totals, flag counts, page and assumptions');
check(P.buildPortfolio([row, heavy, comp], { period, config: cfg, flag: 'held', now: NOW }).households.length === 1, 'flag filter');

// ── loader: pagination + assembly ────────────────────────────────────────
function fakeClient(tables) {
  return { from(table) {
    const b = { _r: null, select() { return b; }, eq() { return b; }, lt() { return b; }, gt() { return b; }, gte() { return b; },
      range(from, to) { return Promise.resolve({ data: (tables[table] || []).slice(from, to + 1), error: null }); } };
    return b;
  } };
}
const many = Array.from({ length: 2500 }, (_, i) => ({ id: `h${i}` }));
check((await selectAll(fakeClient({ households: many }), 'households', 'id')).length === 2500, 'selectAll pages past the 1,000-row cap (2,500 rows read)');
const failing = { from: () => ({ select() { return this; }, range: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) };
let threw = false; try { await selectAll(failing, 'households', 'id'); } catch { threw = true; }
check(threw, 'a read error throws (never a partial result)');
const asm = assembleInputs({
  households: [{ id: 'a', twilio_number: '+44', twilio_provisioning_status: 'active' }, { id: 'b' }],
  entitlements: [ent({ household_id: 'a' }), ent({ household_id: 'b', starts_at: '2026-11-05T00:00:00Z' })],
  subscriptions: [{ household_id: 'a', stripe_price_id: 'price_live599', status: 'active' }],
  accounts: [acct({ household_id: 'a' }), acct({ household_id: 'a', period_start: '2026-08-01T00:00:00Z', period_end: '2026-09-01T00:00:00Z' })],
  profiles: [{ profile: 'standard', delivery_reserve_scope: 'trusted_only' }], holds: [], credits: [],
}, { start: period.start, end: period.end });
check(asm[0].accounts.length === 1 && asm[0].numbersHeld === 1 && asm[0].entitlement && asm[1].entitlement === null,
  'assembly re-filters by period in JS (out-of-period account and future entitlement dropped)');

// ── router ───────────────────────────────────────────────────────────────
const loaderRows = asm;
const mkApp = ({ admin = true, authed = true, loader = async () => loaderRows } = {}) => {
  const app = express();
  app.use(createAdminFinanceRouter({
    loadProfitability: loader, env: ENV, now: () => NOW,
    requireAuth: (req, res, next) => (authed ? (req.authUserId = 'u1', next()) : res.status(401).json({ error: 'auth' })),
    requireAdmin: (req, res, next) => (admin ? next() : res.status(403).json({ error: 'admin' })),
  }));
  return app;
};
async function hit(app, method, url) {
  const srv = app.listen(0); await new Promise((r) => srv.once('listening', r));
  try {
    const res = await fetch(`http://127.0.0.1:${srv.address().port}${url}`, { method });
    let body = null; try { body = await res.json(); } catch {}
    return { status: res.status, body };
  } finally { srv.close(); }
}
check((await hit(mkApp({ authed: false }), 'GET', '/admin/api/finance/profitability')).status === 401, 'unauthenticated → 401');
check((await hit(mkApp({ admin: false }), 'GET', '/admin/api/finance/profitability')).status === 403, 'non-admin → 403');
const ok = await hit(mkApp(), 'GET', '/admin/api/finance/profitability?period=2026-10');
check(ok.status === 200 && ok.body.version === 1 && ok.body.households.length === 1 && ok.body.totals.households === 1,
  'admin GET → portfolio (households with no entitlement/accounts/credits in the period are omitted)');
check((await hit(mkApp(), 'POST', '/admin/api/finance/profitability')).status === 404, 'read-only: POST is not a route');
check((await hit(mkApp(), 'GET', '/admin/api/finance/profitability?period=2026-1')).status === 400, 'invalid period → 400');
check((await hit(mkApp(), 'GET', '/admin/api/finance/profitability?flag=nope')).status === 400, 'invalid flag → 400');
check((await hit(mkApp(), 'GET', '/admin/api/finance/profitability?limit=501')).status === 400, 'limit above 500 → 400');
const err = await hit(mkApp({ loader: async () => { throw new Error('db down'); } }), 'GET', '/admin/api/finance/profitability');
check(err.status === 500 && !err.body.households, 'loader failure → 500, no partial data');
check((await hit(mkApp(), 'GET', '/admin/api/finance/profitability/not-a-uuid')).status === 400, 'household route validates the id');
const noWarn = await hit(mkApp(), 'GET', '/admin/api/finance/profitability');
check(Array.isArray(noWarn.body.warnings) && noWarn.body.warnings.length === 0, 'no warning when the live price map is configured');

// ── end to end over real Fortress accounts ───────────────────────────────
const db = new PGlite();
await applyAll(db);
const q = async (sql, p = []) => (await db.query(sql, p)).rows;
await q("select public.fc_set_budget_profile('standard', 3.00, 0.50, 'trusted_only', 0.10, true, 'recommended profile', 'tester')");
const R = rpcs(q);
const hh = (await q("insert into public.households (email) values ('prof@example.com') returning id"))[0].id;
await q("insert into public.entitlements (household_id, entitlement_type, status, source, starts_at) values ($1, 'paid_subscription', 'active', 'stripe', '2026-09-01')", [hh]);
await q("insert into public.subscriptions (household_id, stripe_subscription_id, stripe_price_id, status) values ($1, 'sub_x', 'price_live599', 'active')", [hh]);
const PER = ['2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z'];
for (let i = 0; i < 5; i++) {
  const sid = `CA${String(9000 + i).padStart(32, '0')}`;
  await R.authorize(hh, sid, { known: true, period: PER, now: `2026-10-0${i + 2}T10:00:00Z` });
  await R.settle(sid, 600, `2026-10-0${i + 2}T10:10:00Z`);
}
function pgClient() {
  return { from(table) {
    const where = []; const params = [];
    const b = { select() { return b; },
      eq(c, v) { params.push(v); where.push(`${c} = $${params.length}`); return b; },
      lt(c, v) { params.push(v); where.push(`${c} < $${params.length}`); return b; },
      gt(c, v) { params.push(v); where.push(`${c} > $${params.length}`); return b; },
      gte(c, v) { params.push(v); where.push(`${c} >= $${params.length}`); return b; },
      async range(from, to) {
        try {
          const rows = await q(`select * from public.${table}${where.length ? ' where ' + where.join(' and ') : ''} offset ${from} limit ${to - from + 1}`, params);
          return { data: rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v instanceof Date ? v.toISOString() : v]))), error: null };
        } catch (e) { return { data: null, error: { message: e.message } }; }
      } };
    return b;
  } };
}
const inputs = await loadProfitabilityInputs({ periodStart: period.start, periodEnd: period.end }, pgClient());
const real = inputs.find((i) => i.household.id === hh);
const realRow = P.computeHouseholdProfitability(real, period, cfg);
const committed = Number((await q('select consumed_gbp from public.fc_budget_accounts where household_id = $1', [hh]))[0].consumed_gbp);
check(near(realRow.cost.fortressCommittedGbp, committed) && committed > 0 && realRow.revenue.counted && realRow.pricePoint === 'standard_599',
  `real Fortress account read end to end (committed £${committed.toFixed(4)}; revenue counted at £5.99)`);
check(realRow.allowance.budgetGbp === 3 && realRow.allowance.state === 'normal', 'allowance block from the real account');

if (failures) { console.error(`\n${failures} check(s) FAILED`); process.exit(1); }
console.log('\nAll profitability checks passed.');
