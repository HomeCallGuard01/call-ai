// WS2 (2026-10-10) — top-ups can never create exposure beyond top-up revenue.
// Adversarial, real SQL (every migration incl. 077, PGlite) + the real
// app interpreter/applier (services/allowance/topUpCredit.js) over the real
// database adapter (database/customerAllowance.js).
//
// Proves: credit only after a settled LIVE payment (never at checkout start,
// never test mode / sandbox / unpaid); credited £ ≤ net revenue × factor even
// when the caller lies; per-period caps; refunds (full or partial) and
// disputes reverse the credit once; a refund of already-spent credit holds
// the household; idempotency under replay/bursts; a randomised property:
// Σ credited £ never exceeds Σ net revenue kept × factor.
import { createRequire } from 'node:module';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { applyAll, rpcClient, ROOT, BOOTSTRAP_SQL } from './financial-containment-harness.mjs';

const require = createRequire(import.meta.url);
const topUp = require('../services/allowance/topUpCredit.js');
const allowanceDb = require('../database/customerAllowance.js');

let failures = 0;
const check = (c, m) => { if (c) console.log(`✓ ${m}`); else { console.error(`✗ ${m}`); failures++; } };
const throws = async (fn, re) => { try { await fn(); return false; } catch (e) { return re ? re.test(e.message) : true; } };
const near = (a, b, eps = 1e-6) => Math.abs(Number(a) - Number(b)) < eps;

const NOW = Date.now();
const P = [new Date(NOW - 86400e3).toISOString(), new Date(NOW + 29 * 86400e3).toISOString()];
const iso = (s = 0) => new Date(NOW + s * 1000).toISOString();
const NET_FACTOR = 0.6; const VAT = 0.2;
const revenueCap = (minor) => Math.trunc((minor / 100 / (1 + VAT)) * NET_FACTOR * 1e4) / 1e4;

async function main() {
  const db = new PGlite();
  await applyAll(db);
  const q = async (sql, p = []) => (await db.query(sql, p)).rows;
  const client = rpcClient(q);
  await q("select public.fc_set_budget_profile('standard', 0.20, 0, 'none', 0, true, 'top-up test profile', 'tester')");
  await q(`select public.fc_set_policy('{"household_auto_hold_daily_gbp": 100, "global_hourly_floor_gbp": 500, "global_daily_floor_gbp": 900}'::jsonb, 'top-up test caps', 'tester')`);
  const mk = async (email) => {
    const id = (await q('insert into public.households (email) values ($1) returning id', [email]))[0].id;
    await q(`insert into public.entitlements (household_id, entitlement_type, status, source, starts_at) values ($1, 'paid_subscription', 'active', 'stripe', $2)`, [id, P[0]]);
    return id;
  };
  const sql = async (hh, o) => (await q('select public.credit_allowance($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) as r',
    [hh, o.ps || P[0], o.pe || P[1], o.kind || 'topup', o.seconds ?? 600, o.source || 'stripe', o.env || 'production', o.txn, null, 'topup_small',
      o.minor === undefined ? 299 : o.minor, o.currency === undefined ? 'gbp' : o.currency, null, o.reason || null, o.allowNonProd || false, o.budget ?? 1.0]))[0].r;
  const adj = async (hh) => Number((await q('select coalesce(sum(adjustments_gbp),0) s from public.fc_budget_accounts where household_id = $1', [hh]))[0].s);
  const held = async (hh) => (await q('select count(*)::int n from public.fc_household_holds where household_id = $1', [hh]))[0].n === 1;
  let n = 0; const sid = () => `CA${String(++n).padStart(32, '0')}`;
  const call = async (hh, secs) => {
    const s = sid();
    const r = (await q('select public.fc_authorize_call($1,$2,false,false,false,$3,$4,$5,null) as r', [hh, s, P[0], P[1], iso(n)]))[0].r;
    if (r.allowed) await q('select public.fc_settle_call($1,$2,null,$3,$4)', [s, Math.min(secs, r.timeLimitSeconds + 60), 'test', iso(n + 1)]);
    return r;
  };
  const deps = (alerts) => ({
    creditAllowance: (a) => allowanceDb.creditAllowance(a, client),
    findTopUpCredit: async ({ source, transactionId }) => (await q("select id, household_id, period_start, period_end, product_code, applied_seconds from public.allowance_credits where source = $1 and provider_transaction_id = $2 and kind = 'topup'", [source, transactionId]))[0] || null,
    getActiveEntitlement: async () => ({ source: 'stripe', starts_at: P[0], status: 'active', entitlement_type: 'paid_subscription' }),
    getSubscriptionByHouseholdId: async () => ({ current_period_end: P[1], status: 'active' }),
    alert: async (m, c) => alerts.push({ m, c }),
  });
  const ENV = { ALLOWANCE_TOPUPS_ENABLED: 'true' };
  const stripeEv = (type, obj, live = true) => ({ id: `evt_${type}_${++n}`, type, livemode: live, data: { object: obj } });
  const session = (hh, pi, o = {}) => ({ mode: 'payment', payment_status: o.status || 'paid', payment_intent: pi, amount_total: o.minor ?? 299, currency: o.currency || 'gbp', client_reference_id: hh,
    metadata: { hcg_purpose: 'allowance_topup', household_id: hh, product_code: 'topup_small', topup_minutes: '20', topup_budget_gbp: String(o.budget ?? 0.5) } });

  // ── 1. Never at checkout start ─────────────────────────────────────────
  const route = await readFile(path.join(ROOT, 'routes', 'allowance.js'), 'utf8');
  const checkoutBlock = route.slice(route.indexOf("router.post('/billing/topup-checkout'"), route.indexOf("router.post('/admin/api/households"));
  check(!/creditAllowance|applyTopUpEvent|credit_allowance/.test(checkoutBlock) && /ALLOWANCE_TOPUPS_ENABLED !== 'true'/.test(checkoutBlock),
    'checkout start never credits (no credit path in the route) and is gated by ALLOWANCE_TOPUPS_ENABLED');
  check(process.env.ALLOWANCE_TOPUPS_ENABLED === undefined, 'ALLOWANCE_TOPUPS_ENABLED is unset in the test environment (default off)');

  // ── 2. Only settled, live payments ─────────────────────────────────────
  const h1 = await mk('t1@example.com');
  const alerts = [];
  const unpaid = topUp.interpretStripeTopUpEvent(stripeEv('checkout.session.completed', session(h1, 'pi_unpaid', { status: 'unpaid' })));
  check(unpaid.action === 'ignore' && (await topUp.applyTopUpEvent(unpaid, { deps: deps(alerts), env: ENV })).outcome === 'ignored', 'unpaid checkout completion credits nothing');
  const failed = topUp.interpretStripeTopUpEvent(stripeEv('checkout.session.async_payment_failed', session(h1, 'pi_fail')));
  check(failed.action === 'ignore', 'async payment failure credits nothing');
  const testMode = topUp.interpretStripeTopUpEvent(stripeEv('checkout.session.completed', session(h1, 'pi_test'), false));
  check((await topUp.applyTopUpEvent(testMode, { deps: deps(alerts), env: ENV })).reason === 'non_production_purchase', 'Stripe test mode never credits in production');
  check((await topUp.applyTopUpEvent(testMode, { deps: deps(alerts), env: { ...ENV, ALLOWANCE_ALLOW_SANDBOX_CREDITS: 'true' } })).reason === 'non_production_purchase',
    'sandbox credits need APP_ENV=staging as well (flag alone refused)');
  check((await sql(h1, { txn: 'pi_sandbox_sql', env: 'sandbox' })).reason === 'non_production_purchase', 'the database itself refuses a sandbox credit');
  check(near(await adj(h1), 0), 'no £ was added by any of the above');

  // ── 3. Revenue bound in the DATABASE (caller lies about the £) ─────────
  const lie = await sql(h1, { txn: 'pi_lie', budget: 40, minor: 299 });
  check(lie.credited && near(lie.appliedBudgetGbp, revenueCap(299)) && lie.cappedByRevenue === true,
    `a direct credit claiming £40 for a £2.99 payment is capped at £${revenueCap(299)} (= £2.99 ÷ 1.2 × 0.60)`);
  check((await sql(h1, { txn: 'pi_nomoney', minor: null })).reason === 'revenue_unverified', 'no payment amount → refused');
  check((await sql(h1, { txn: 'pi_usd', currency: 'usd' })).reason === 'revenue_unverified', 'non-GBP payment → refused (no FX guess)');
  check((await sql(h1, { txn: 'pi_zero', minor: 0 })).reason === 'revenue_unverified', 'zero payment → refused');
  check(await throws(() => sql(h1, { txn: 'pi_neg', budget: -1 })), 'a negative top-up is refused');

  // ── 4. Per-period caps ─────────────────────────────────────────────────
  const h2 = await mk('t2@example.com');
  const r = [];
  for (let i = 0; i < 4; i++) r.push(await sql(h2, { txn: `pi_cap_${i}`, budget: 1.0, minor: 299 }));
  check(r.slice(0, 3).every((x) => x.credited) && !r[3].credited && r[3].reason === 'topup_period_cap', '4th top-up in one period refused (max 3)');
  await q(`select public.fortress_set_topup_policy('{"max_credits_per_period": 10, "max_budget_gbp_per_period": 5}'::jsonb, 'ws2 test: £ cap', 'tester')`);
  const big = [];
  for (let i = 0; i < 6; i++) big.push(await sql(h2, { txn: `pi_big_${i}`, budget: 50, minor: 999 }));
  const credited2 = (await q("select coalesce(sum(applied_budget_gbp),0) s from public.allowance_credits where household_id = $1", [h2]))[0].s;
  check(Number(credited2) <= 5 + 1e-9 && big.some((x) => x.reason === 'topup_period_cap'), `net credited £ per period never exceeds the £ cap (£${Number(credited2).toFixed(4)} ≤ £5)`);
  check(await throws(() => q(`select public.fortress_set_topup_policy('{"max_budget_per_net_revenue": 1.5}'::jsonb, 'too generous factor', 'tester')`)), 'factor above 1.0 refused (CHECK)');
  check(await throws(() => q(`select public.fortress_set_topup_policy('{"nope": 1}'::jsonb, 'bad field test', 'tester')`), /not a policy field/), 'unknown policy field refused');
  check((await q("select count(*)::int n from public.fc_policy_audit where target = 'topup_policy'"))[0].n === 1, 'top-up policy change audited');
  await q(`select public.fortress_set_topup_policy('{"max_credits_per_period": 3, "max_budget_gbp_per_period": 10}'::jsonb, 'ws2 test: back to defaults', 'tester')`);

  // ── 5. Idempotency ─────────────────────────────────────────────────────
  const h3 = await mk('t3@example.com');
  const okEv = topUp.interpretStripeTopUpEvent(stripeEv('checkout.session.completed', session(h3, 'pi_ok', { budget: 0.5 })));
  const first = await topUp.applyTopUpEvent(okEv, { deps: deps(alerts), env: ENV });
  const replay = await Promise.all(Array.from({ length: 5 }, () => topUp.applyTopUpEvent(okEv, { deps: deps(alerts), env: ENV })));
  check(first.outcome === 'credited' && replay.every((x) => x.outcome === 'duplicate'), 'live paid top-up credited once; 5 replays are duplicates');
  const credited3 = await adj(h3);
  check(credited3 > 0 && credited3 <= revenueCap(299) + 1e-9, `credited £${credited3} ≤ revenue bound £${revenueCap(299)}`);

  // ── 6. Refund BEFORE use: reversed, no hold ────────────────────────────
  const refundEv = topUp.interpretStripeTopUpEvent(stripeEv('charge.refunded', { payment_intent: 'pi_ok', amount: 299, amount_refunded: 299, refunded: true }));
  const rev = await topUp.applyTopUpEvent(refundEv, { deps: deps(alerts), env: ENV });
  check(rev.outcome === 'reversed' && near(await adj(h3), 0) && !(await held(h3)), 'refund before use: £ fully reversed, no hold');
  const disputeSame = topUp.interpretStripeTopUpEvent(stripeEv('charge.dispute.created', { payment_intent: 'pi_ok', amount: 299 }));
  check(disputeSame.action === 'reverse' && (await topUp.applyTopUpEvent(disputeSame, { deps: deps(alerts), env: ENV })).outcome === 'duplicate' && near(await adj(h3), 0),
    'a dispute on an already-refunded payment reverses nothing more (one reversal per transaction)');

  // ── 7. Refund AFTER use: hold ──────────────────────────────────────────
  const h4 = await mk('t4@example.com');
  const ev4 = topUp.interpretStripeTopUpEvent(stripeEv('checkout.session.completed', session(h4, 'pi_used', { budget: 1.0 })));
  await topUp.applyTopUpEvent(ev4, { deps: deps(alerts), env: ENV });
  for (let i = 0; i < 12; i++) await call(h4, 600);   // spend base £0.20 + most of the top-up
  const partialEv = topUp.interpretStripeTopUpEvent(stripeEv('charge.refunded', { payment_intent: 'pi_used', amount: 299, amount_refunded: 100, refunded: false }));
  check(partialEv.action === 'reverse' && partialEv.reason === 'partial_refund_full_reversal', 'a PARTIAL refund reverses the whole credit');
  const alerts4 = [];
  const rev4 = await topUp.applyTopUpEvent(partialEv, { deps: deps(alerts4), env: ENV });
  check(rev4.outcome === 'reversed' && rev4.householdHeld === true && Number(rev4.consumedGbp) > 0, `refund after use: household HELD (consumed £${Number(rev4.consumedGbp).toFixed(4)} of the refunded credit)`);
  check(alerts4.some((a) => /HOUSEHOLD HELD/.test(a.m)), 'operators are alerted');
  const after4 = await call(h4, 60);
  check(!after4.allowed && after4.reason === 'household_hold', 'after the hold no further HCG-funded call is admitted');
  const row4 = (await q("select consumed_at_reversal_gbp from public.allowance_credits where household_id = $1 and kind = 'topup_reversal'", [h4]))[0];
  check(near(row4.consumed_at_reversal_gbp, rev4.consumedGbp, 1e-5), 'the reversal row records how much refunded credit was already spent');
  const lossBound = Number(rev4.consumedGbp);
  check(lossBound <= revenueCap(299) + 1e-9, `loss from a refunded top-up ≤ what it credited (£${lossBound.toFixed(4)} ≤ £${revenueCap(299)}), and stops there`);

  // ── 8. Dispute opened (no refund) reverses ─────────────────────────────
  const h5 = await mk('t5@example.com');
  await topUp.applyTopUpEvent(topUp.interpretStripeTopUpEvent(stripeEv('checkout.session.completed', session(h5, 'pi_disp', { budget: 0.5 }))), { deps: deps(alerts), env: ENV });
  const dEv = topUp.interpretStripeTopUpEvent(stripeEv('charge.dispute.created', { payment_intent: 'pi_disp', amount: 299 }));
  const dRes = await topUp.applyTopUpEvent(dEv, { deps: deps(alerts), env: ENV });
  check(dRes.outcome === 'reversed' && near(await adj(h5), 0), 'a dispute reverses the credit as soon as it is opened');
  check(topUp.interpretStripeTopUpEvent(stripeEv('charge.dispute.created', { amount: 299 })) === null, 'a dispute without a PaymentIntent is not matched to any credit');

  // ── 9. Refund after the period reset, credit already spent ─────────────
  const h6 = await mk('t6@example.com');
  const oldP = [new Date(NOW - 40 * 86400e3).toISOString(), new Date(NOW - 10 * 86400e3).toISOString()];
  await q(`insert into public.fc_budget_accounts (household_id, period_start, period_end, profile, base_budget_gbp, delivery_reserve_gbp, essential_reserve_gbp, adjustments_gbp, consumed_gbp)
           values ($1, $2, $3, 'standard', 0.20, 0, 0, 1.0, 1.10)`, [h6, oldP[0], oldP[1]]);
  await q(`insert into public.allowance_credits (household_id, kind, requested_seconds, applied_seconds, period_start, period_end, source, environment, provider_transaction_id, amount_minor, currency, applied_budget_gbp, created_at)
           values ($1, 'topup', 600, 600, $2, $3, 'stripe', 'production', 'pi_old', 299, 'gbp', 1.0, $4)`, [h6, oldP[0], oldP[1], new Date(NOW - 20 * 86400e3).toISOString()]);
  const old = await sql(h6, { kind: 'topup_reversal', txn: 'pi_old', seconds: -1 });
  check(old.credited && near(old.appliedBudgetGbp, 0) && near(old.consumedGbp, 0.9) && old.householdHeld === true,
    'refund after the period reset: no £ to claw back (expired), but £0.90 already spent ⇒ household held');

  // ── 10. Property: Σ credited ≤ Σ net revenue kept × factor ─────────────
  let seed = 20261010; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const hp = await mk('prop@example.com');
  const paid = new Map();
  const stats = { credited: 0, refused: 0, reversed: 0 };
  await q(`select public.fortress_set_topup_policy('{"max_credits_per_period": 20, "max_budget_gbp_per_period": 50}'::jsonb, 'ws2 property test: loosest allowed caps', 'tester')`);
  for (let i = 0; i < 60; i++) {
    const kind = rnd();
    const txn = `pi_prop_${Math.floor(rnd() * 15)}`;
    if (kind < 0.55) {
      const minor = [99, 299, 499, 999, 4999][Math.floor(rnd() * 5)];
      const res = await sql(hp, { txn, budget: Math.min(50, 0.01 + rnd() * 60), minor }).catch(() => null);
      if (res && res.credited) { paid.set(txn, minor); stats.credited++; } else stats.refused++;
    } else if (kind < 0.8) {
      const res = await sql(hp, { kind: 'topup_reversal', txn, seconds: -1 }).catch(() => null);
      if (res && res.credited) { paid.delete(txn); stats.reversed++; }
    } else {
      await call(hp, Math.floor(rnd() * 900));
    }
  }
  const kept = [...paid.values()].reduce((s, m) => s + revenueCap(m), 0);
  const credP = await adj(hp);
  check(stats.credited >= 3 && stats.reversed >= 1, `property run exercised credits (${stats.credited}), refusals (${stats.refused}) and reversals (${stats.reversed})`);
  check(credP <= kept + 1e-6, `randomised 60-event sequence: credited £${credP.toFixed(4)} ≤ Σ(net revenue kept × 0.6) £${kept.toFixed(4)}`);
  check(credP <= 50 + 1e-6, 'and never above the per-period £ cap');

  // ── 11. Access control ─────────────────────────────────────────────────
  await db.exec('set role authenticated;');
  check(await throws(() => sql(h1, { txn: 'pi_customer' }), /permission denied/), 'a signed-in customer cannot call credit_allowance');
  check(await throws(() => q(`select public.fortress_set_topup_policy('{"max_credits_per_period": 20}'::jsonb, 'customer raises cap', 'me')`), /permission denied/), 'nor change the top-up policy');
  await db.exec('reset role;');

  // ── 12. Rollback restores 068 verbatim ─────────────────────────────────
  const clean = new PGlite();
  await applyAll(clean);
  await clean.exec(await readFile(path.join(ROOT, 'supabase', 'migrations', '_rollbacks', '077_rollback_topup_exposure_bounds.sql'), 'utf8'));
  const ref = new PGlite();
  await ref.exec(BOOTSTRAP_SQL);
  const dir = path.join(ROOT, 'supabase', 'migrations');
  for (const f of (await readdir(dir)).filter((x) => x.endsWith('.sql') && !x.startsWith('077')).sort()) await ref.exec(await readFile(path.join(dir, f), 'utf8'));
  const body = async (d) => (await d.query("select prosrc from pg_proc where proname = 'credit_allowance' and pronargs = 16")).rows[0].prosrc;
  check((await body(clean)) === (await body(ref)), 'rollback restores 068\'s credit_allowance verbatim');
  const gone = (await clean.query("select to_regclass('public.fortress_topup_policy') t, (select count(*)::int from information_schema.columns where column_name = 'consumed_at_reversal_gbp') c")).rows[0];
  check(gone.t === null && gone.c === 0, 'rollback removes the 077 table and column');

  if (failures) { console.error(`\n${failures} check(s) FAILED`); process.exit(1); }
  console.log('\nAll top-up exposure checks passed.');
}

main().catch((err) => { console.error(err); process.exit(1); });
