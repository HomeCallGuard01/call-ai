// Allowance ↔ Financial Fortress economic bridge — integration 2026-10-03
// (migration 068; launch-fortress scenarios 41 top-up replay, 42 top-up
// while exhausted, 43 top-up margin guard).
//
// Real SQL on PGlite (every migration in order, incl. 056, 063, 067, 068).
// Periods are computed from the real clock (credit_allowance uses now()), so
// these checks never become a time bomb. PGlite is one connection: the
// concurrent-duplicate check proves idempotency under interleaving, not
// multi-server races (see tests/financial-containment-realpg.test.mjs).
import { PGlite } from '@electric-sql/pglite';
import { createRequire } from 'node:module';
import { applyAll, pinTestProfiles } from './financial-containment-harness.mjs';
const require = createRequire(import.meta.url);
const { resolveTopUpProducts, maxBudgetForPrice, resolveEconomics } = require('../services/allowance/productCatalog.js');
const { applyTopUpEvent } = require('../services/allowance/topUpCredit.js');

let failures = 0;
const check = (c, m) => { if (c) console.log(`✓ ${m}`); else { console.error(`✗ ${m}`); failures++; } };
const near = (a, b, e = 1e-6) => Math.abs(Number(a) - Number(b)) < e;

const NOW = Date.now();
const PERIOD = [new Date(NOW - 86400e3).toISOString(), new Date(NOW + 29 * 86400e3).toISOString()];
const iso = (offsetSec = 0) => new Date(NOW + offsetSec * 1000).toISOString();

async function main() {
  const db = new PGlite();
  await applyAll(db);
  const q = async (sql, p = []) => (await db.query(sql, p)).rows;
  await pinTestProfiles(q);
  // A tiny budget so exhaustion is easy to reach: one unmonitored lease fits.
  await q("select public.fc_set_budget_profile('standard', 0.10, 0, 'none', 0, true, 'bridge test profile', 'tester')");
  const hh = (await q("insert into public.households (auth_user_id, email) values (null, 'bridge@example.com') returning id"))[0].id;
  await q(`insert into public.entitlements (household_id, entitlement_type, status, source, starts_at) values ($1, 'paid_subscription', 'active', 'stripe', $2)`, [hh, PERIOD[0]]);
  await db.exec('set role service_role;');

  const credit = async ({ kind = 'topup', seconds = 1800, budget = 0.5636, txn, source = 'stripe', actor = null, reason = null }) =>
    (await q('select public.credit_allowance($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) as r',
      [hh, PERIOD[0], PERIOD[1], kind, seconds, source, 'production', txn, null, 'topup_small', 299, 'gbp', actor, reason, false, budget]))[0].r;
  const authorize = async (sid) => (await q('select public.fc_authorize_call($1,$2,$3,$4,$5,$6,$7,$8,$9) as r', [hh, sid, false, false, false, PERIOD[0], PERIOD[1], iso(), null]))[0].r;
  const adjustments = async () => Number((await q('select coalesce(sum(adjustments_gbp),0) s from public.fc_budget_accounts where household_id = $1', [hh]))[0].s);
  const bonus = async () => Number((await q('select coalesce(sum(bonus_monitored_seconds),0) s from public.household_usage_periods where household_id = $1', [hh]))[0].s);

  // ── 42: top-up while the household is exhausted ─────────────────────────
  const first = await authorize('CA' + '1'.repeat(32));
  const blocked = await authorize('CA' + '2'.repeat(32));
  check(first.allowed && !blocked.allowed && blocked.reason === 'household_budget_exhausted', 'precondition: the household budget is exhausted (2nd concurrent call refused)');
  const c1 = await credit({ txn: 'pi_bridge_1' });
  check(c1.credited && near(c1.appliedBudgetGbp, 0.5636) && c1.appliedSeconds === 1800, 'top-up credits £0.5636 AND 30 min in one call');
  check(near(await adjustments(), 0.5636) && (await bonus()) === 1800, 'the £ landed on the SAME Fortress budget account Fortress enforces (fc_budget_accounts.adjustments_gbp)');
  const after = await authorize('CA' + '3'.repeat(32));
  check(after.allowed, 'after the top-up, Fortress itself authorises the next call (the paid capacity is real)');

  // ── 41: top-up replay / concurrent duplicates ───────────────────────────
  const dup = await credit({ txn: 'pi_bridge_1' });
  check(!dup.credited && dup.duplicate && near(await adjustments(), 0.5636), 'a replayed top-up credits no more £ (idempotent on the provider transaction)');
  const burst = await Promise.all(Array.from({ length: 5 }, () => credit({ txn: 'pi_bridge_burst' })));
  check(burst.filter((r) => r.credited).length === 1 && near(await adjustments(), 0.5636 * 2), '5 interleaved deliveries of one payment → £ credited exactly once');
  const ledger = await q("select count(*)::int n from public.fc_ledger where idempotency_key like 'adjust:topup:allowance:topup:stripe:pi_bridge_%'");
  check(ledger[0].n === 2, 'the Fortress ledger has exactly one adjustment entry per paid transaction');

  // ── refund (reversal) claws back exactly the £ credited, in the current period ──
  const rev = await credit({ kind: 'topup_reversal', seconds: -1, budget: 0, txn: 'pi_bridge_1' });
  check(rev.credited && near(rev.appliedBudgetGbp, -0.5636) && near(await adjustments(), 0.5636), 'a full refund reverses exactly the £ that top-up added (current period)');
  const rev2 = await credit({ kind: 'topup_reversal', seconds: -1, budget: 0, txn: 'pi_bridge_1' });
  check(!rev2.credited && rev2.duplicate && near(await adjustments(), 0.5636), 'a replayed refund reverses nothing more');

  // ── admin adjustments move £ with minutes, sign-checked ─────────────────
  const adj = await credit({ kind: 'admin_adjustment', seconds: 600, budget: 0.1878, source: 'admin', txn: 'admin:bridge-0001', actor: 'admin-user', reason: 'goodwill after outage' });
  check(adj.credited && near(await adjustments(), 0.5636 + 0.1878), 'an admin goodwill credit adds the matching £ (audited, idempotent key)');
  let mismatch = null;
  try { await credit({ kind: 'admin_adjustment', seconds: 600, budget: -0.1, source: 'admin', txn: 'admin:bridge-0002', actor: 'admin-user', reason: 'bad sign' }); } catch (e) { mismatch = e.message; }
  check(/same way/.test(mismatch || ''), 'an adjustment whose £ moves opposite to its minutes is refused');

  // ── malformed £ fails safe, and atomically ──────────────────────────────
  const before = { adj: await adjustments(), bonus: await bonus(), rows: (await q('select count(*)::int n from public.allowance_credits'))[0].n };
  for (const [label, budget] of [['NaN', 'NaN'], ['negative', -0.5], ['zero', 0], ['over £50', 50.01], ['huge', 1e30]]) {
    let err = null;
    try { await credit({ txn: `pi_bad_${label}`, budget }); } catch (e) { err = e.message; }
    check(Boolean(err), `a top-up with a ${label} £ budget is refused`);
  }
  const afterBad = { adj: await adjustments(), bonus: await bonus(), rows: (await q('select count(*)::int n from public.allowance_credits'))[0].n };
  check(near(afterBad.adj, before.adj) && afterBad.bonus === before.bonus && afterBad.rows === before.rows, 'a refused credit leaves £, minutes and the audit trail unchanged (atomic)');

  // ── access ──────────────────────────────────────────────────────────────
  await db.exec('reset role; set role authenticated;');
  let denied = false;
  try { await credit({ txn: 'pi_customer_forge' }); } catch (e) { denied = /permission denied/.test(e.message); }
  check(denied, 'a signed-in customer cannot credit their own £ budget');
  await db.exec('reset role;');

  // ── 43: margin guard (JS, real catalogue maths) ─────────────────────────
  const env = { ALLOWANCE_TOPUP_PRODUCTS: JSON.stringify([
    { code: 'ok_small', budgetGbp: 0.5, priceGbpInclVat: 2.99, stripePriceId: 'price_ok', appleProductId: 'hcg.ok' },
    { code: 'too_generous', budgetGbp: 2.0, priceGbpInclVat: 2.99, stripePriceId: 'price_bad', appleProductId: 'hcg.bad' },
    { code: 'minutes_overpromise', budgetGbp: 0.3, minutes: 60, priceGbpInclVat: 2.99, stripePriceId: 'price_mins' },
  ]) };
  const { products, rejected, economics } = resolveTopUpProducts(env);
  const ok = products.find((p) => p.code === 'ok_small');
  const bad = products.find((p) => p.code === 'too_generous');
  check(ok.channels.stripe.viable && ok.channels.apple.viable, 'a top-up within its margin model is offered (Stripe and Apple)');
  check(bad && !bad.channels.stripe.viable && !bad.channels.apple.viable, 'a top-up granting more £ exposure than its price permits is NOT offered on any channel');
  check(rejected.includes('minutes_overpromise'), 'a product whose minutes promise more than its £ funds is rejected outright');
  const cap = maxBudgetForPrice({ priceGbpInclVat: 2.99, channel: 'stripe' }, economics);
  check(cap > 0 && cap < 2.0 && near(bad.channels.stripe.maxBudgetGbp, cap), `per-channel ceiling: £2.99 on Stripe may add at most £${cap} at a ${economics.targetMargin * 100}% margin + ${economics.safetyReserve * 100}% reserve`);
  // Credit-time cap: a sale arriving for the over-generous product (e.g. a
  // misconfigured store price) never credits more than the price permits.
  const credits = []; const alerts = [];
  const res = await applyTopUpEvent(
    { action: 'credit', source: 'stripe', channel: 'stripe', environment: 'production', householdId: 'hh-x', transactionId: 'pi_overgenerous', productCode: 'too_generous', minutes: 100, budgetGbp: 2.0, amountMinor: 299, currency: 'gbp' },
    { deps: { creditAllowance: async (a) => { credits.push(a); return { credited: true }; }, getActiveEntitlement: async () => ({ source: 'stripe', starts_at: PERIOD[0] }), getSubscriptionByHouseholdId: async () => null, alert: async (t) => alerts.push(t) }, env },
  );
  check(res.outcome === 'credited' && credits.length === 1 && credits[0].budgetGbp <= cap + 1e-9 && alerts.includes('ALLOWANCE TOP-UP CAPPED BY MARGIN GUARD'),
    `credit-time margin guard: £2.00 requested, £${credits[0] && credits[0].budgetGbp} credited (≤ £${cap}), alerted for a manual decision`);
  check(credits[0].seconds <= Math.floor(credits[0].budgetGbp / resolveEconomics(env).costPerMinuteGbp) * 60, 'the minute equivalent never exceeds what the credited £ funds');

  await db.close();
  console.log(failures === 0 ? '\nAll allowance economic bridge checks passed.' : `\n${failures} check(s) FAILED`);
  process.exitCode = failures === 0 ? 0 : 1;
}
main().catch((err) => { console.error(err); process.exitCode = 1; });
