// Customer allowance workstream (2026-10-03): canonical entitlement state,
// the customer allowance read model, warning delivery, top-up economics,
// verified-payment top-up crediting (Stripe + RevenueCat), admin
// adjustments, and forge resistance. Pure / fake-dependency tests; the
// database guarantees are in tests/customer-allowance-migration.pglite.test.mjs.
// Run with: node tests/customer-allowance.test.mjs

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

const { resolveEntitlementState } = require('../services/allowance/entitlementState.js');
const { getCustomerAllowance } = require('../services/allowance/customerAllowance.js');
const { resolveEntitlementPeriod } = require('../services/usage/billingPeriod.js');
const { notifyUsageThresholds } = require('../services/usage/usageNotifier.js');
const catalog = require('../services/allowance/productCatalog.js');
const topUp = require('../services/allowance/topUpCredit.js');
const notices = require('../services/allowance/allowanceNotices.js');
const { validateAdjustment, applyAdminAdjustment } = require('../services/allowance/allowanceAdjustments.js');

let failures = 0;
const check = (c, m) => { if (c) console.log(`✓ ${m}`); else { console.error(`✗ ${m}`); failures++; } };

const NOW = new Date('2026-10-03T12:00:00Z');
const HH = { id: 'hh-1', email: 'customer@example.com' };
const stripeEnt = { status: 'active', entitlement_type: 'paid_subscription', source: 'stripe', starts_at: '2026-09-12T09:00:00Z', ends_at: null, plan_code: 'standard' };
const appleEnt = { status: 'active', entitlement_type: 'paid_subscription', source: 'apple_revenuecat', starts_at: '2026-09-20T08:00:00Z', ends_at: '2026-10-20T08:00:00Z', plan_code: 'standard' };
const compEnt = { status: 'active', entitlement_type: 'complimentary', source: 'admin_manual', starts_at: '2026-08-01T00:00:00Z', ends_at: '2027-02-01T00:00:00Z', plan_code: 'standard' };
const sub = (o = {}) => ({ status: 'active', cancel_at_period_end: false, current_period_end: '2026-10-12T09:00:00Z', price_id: 'price_std', ...o });

// ---------------------------------------------------------------------------
// 1. Canonical entitlement state
// ---------------------------------------------------------------------------
{
  const s = (entitlement, subscription = null, now = NOW) => resolveEntitlementState({ entitlement, subscription, now });
  check(s(stripeEnt, sub()).state === 'active' && s(stripeEnt, sub()).renews && s(stripeEnt, sub()).channel === 'stripe', 'first Stripe subscription → active, renews, channel stripe');
  check(s(stripeEnt, sub({ cancel_at_period_end: true })).state === 'cancelling' && s(stripeEnt, sub({ cancel_at_period_end: true })).periodEndsAt === '2026-10-12T09:00:00.000Z', 'cancelled but active until period end → cancelling, with the end date');
  check(s(stripeEnt, sub({ status: 'past_due' })).state === 'payment_issue', 'Stripe payment failure (past_due) → payment_issue');
  check(['unpaid', 'canceled', 'incomplete_expired'].every((st) => s(stripeEnt, sub({ status: st })).state === 'expired'), 'Stripe unpaid / canceled / incomplete_expired → expired');
  check(s(appleEnt).state === 'active' && s(appleEnt).channel === 'apple' && s(appleEnt).periodEndsAt === '2026-10-20T08:00:00.000Z', 'Apple (RevenueCat) active → active, channel apple, ends at store expiry');
  check(s(appleEnt, null, new Date('2026-10-21T00:00:00Z')).state === 'expired', 'Apple row past ends_at with no EXPIRATION yet → reported expired (truthful), not active');
  check(s(compEnt).state === 'complimentary' && s(compEnt).channel === 'complimentary' && !s(compEnt).renews, 'complimentary grant → complimentary, never "renews"');
  check(s({ ...stripeEnt, entitlement_type: 'free_trial' }, sub()).state === 'trial', 'free_trial → trial');
  check(s({ ...stripeEnt, status: 'expired' }).state === 'expired' && s(null).state === 'none', 'expired row → expired; no row → none');
  check(s({ ...appleEnt, revenuecat_environment: 'sandbox' }).testPurchase === true, 'RevenueCat sandbox entitlement is flagged as a test purchase');
}

// ---------------------------------------------------------------------------
// 2. Billing period / reset (Fortress billingPeriod.js, exercised here)
// ---------------------------------------------------------------------------
{
  const p = resolveEntitlementPeriod({ entitlement: stripeEnt, subscription: sub(), now: NOW });
  check(p.periodEnd.toISOString() === '2026-10-12T09:00:00.000Z' && p.periodStart.toISOString() === '2026-09-12T09:00:00.000Z' && p.basis === 'stripe_period', 'Stripe period = [period_end − 1 month, period_end)');
  const renewed = resolveEntitlementPeriod({ entitlement: stripeEnt, subscription: sub({ current_period_end: '2026-11-12T09:00:00Z' }), now: new Date('2026-10-12T09:00:01Z') });
  check(renewed.periodStart.toISOString() === '2026-10-12T09:00:00.000Z', 'renewal moves the period: a new period (new usage row, used = 0) starts at the old period end');
  const before = resolveEntitlementPeriod({ entitlement: stripeEnt, subscription: sub(), now: new Date('2026-10-12T08:59:59.999Z') });
  check(before.periodStart.toISOString() === '2026-09-12T09:00:00.000Z', 'one millisecond before the boundary is still the old period');
  // Europe/London is UTC+1 in October: a renewal at 00:30 BST is 23:30 UTC the previous day.
  const bst = resolveEntitlementPeriod({ entitlement: appleEnt, now: new Date('2026-10-19T23:29:00Z') });
  const bstEnt = { ...appleEnt, ends_at: '2026-10-19T23:30:00Z' };
  const bstP = resolveEntitlementPeriod({ entitlement: bstEnt, now: new Date('2026-10-19T23:29:00Z') });
  check(bst.basis === 'store_expiry' && bstP.periodEnd.toISOString() === '2026-10-19T23:30:00.000Z', 'periods are exact instants (UTC), so a UK-local midnight renewal resets at the right moment regardless of BST');
  const comp = resolveEntitlementPeriod({ entitlement: { ...compEnt, starts_at: '2026-01-31T10:00:00Z' }, now: new Date('2026-02-28T12:00:00Z') });
  check(comp.periodStart.toISOString() === '2026-02-28T10:00:00.000Z', 'complimentary anniversary on the 31st clamps to the end of a short month');
}

// ---------------------------------------------------------------------------
// 3. Read model
// ---------------------------------------------------------------------------
const PERIOD_START = '2026-09-12T09:00:00.000Z';
function fakeDeps({ used = 0, bonus = 0, claims = [], credits = [], live = 0, fail = false, safety = null } = {}) {
  return {
    getUsagePeriod: async () => { if (fail) throw new Error('db down'); return { monitored_seconds: used, bonus_monitored_seconds: bonus, monitoring_cost_gbp: 0 }; },
    getHouseholdDayUsage: async () => ({ monitoring_cost_gbp: 0 }),
    getSafetyState: async () => safety || { monitoring_suspended: false },
    getClaimedNotifications: async () => claims,
    listAllowanceCredits: async () => credits,
    countLiveMonitoringSessions: async () => live,
  };
}
const ENV = { PLAN_STANDARD_ALLOWANCE_MINUTES: '100' };
const read = (deps, o = {}) => getCustomerAllowance({ household: HH, entitlement: o.entitlement || stripeEnt, subscription: o.subscription === undefined ? sub() : o.subscription, platform: o.platform || 'web', deps, now: o.now || NOW, env: { ...ENV, ...(o.env || {}) } });

{
  const a = await read(fakeDeps({ used: 30 * 60 }));
  check(a.status === 'ok' && a.tone === 'good' && a.allowance.usedPercent === 30 && a.allowance.remainingPercent === 70 && a.allowance.remainingMinutes === 70, '30 of 100 min used → ok, 30% used / 70% remaining');
  check(a.allowance.resetsAt === '2026-10-12T09:00:00.000Z' && a.allowance.periodStartsAt === PERIOD_START, 'reset date is the Stripe renewal');
  check(a.membership.state === 'active' && a.membership.planName && a.monitoringActive === true && a.callsContinue === true, 'membership + monitoringActive come from server state');

  const low = await read(fakeDeps({ used: 76 * 60, claims: [{ kind: 'warn_75' }] }));
  check(low.status === 'low' && low.tone === 'caution' && low.warning.level === 75 && low.allowance.remainingPercent === 24, '≈25% remaining → low, warning level 75');
  const vlow = await read(fakeDeps({ used: 91 * 60, claims: [{ kind: 'warn_75' }, { kind: 'warn_90' }] }));
  check(vlow.status === 'very_low' && vlow.tone === 'critical' && vlow.warning.level === 90, '90% used → very_low, warning level 90');

  const notEnforced = await read(fakeDeps({ used: 120 * 60 }));
  check(notEnforced.status === 'used_up' && notEnforced.monitoringActive === true && notEnforced.allowance.remainingPercent === 0, 'allowance used, NOT enforced → used_up but monitoring honestly still active');
  const enforced = await read(fakeDeps({ used: 100 * 60 }), { env: { MONITORING_ALLOWANCE_ENFORCED: 'true' } });
  check(enforced.status === 'used_up' && enforced.monitoringActive === false && enforced.callsContinue === true && enforced.enforced, 'allowance used, enforced → used_up, monitoring off, calls continue');

  const withTopUp = await read(fakeDeps({ used: 100 * 60, bonus: 30 * 60, credits: [{ kind: 'topup', applied_seconds: 1800 }] }), { env: { MONITORING_ALLOWANCE_ENFORCED: 'true' } });
  check(withTopUp.status !== 'used_up' && withTopUp.allowance.totalMinutes === 130 && withTopUp.allowance.topUpMinutes === 30 && withTopUp.allowance.includedMinutes === 100 && withTopUp.monitoringActive === true, 'a confirmed top-up (Fortress bonus) lifts the total to 130 min and monitoring resumes');
  const adjusted = await read(fakeDeps({ bonus: 600, credits: [{ kind: 'admin_adjustment', applied_seconds: 600 }] }));
  check(adjusted.allowance.adjustmentMinutes === 10 && adjusted.allowance.topUpMinutes === 0, 'admin adjustments are shown separately from paid top-ups');

  const paused = await read(fakeDeps({ used: 10 * 60, safety: { monitoring_suspended: true } }));
  check(paused.status === 'paused' && paused.monitoringActive === false, 'a Fortress safety pause → paused, never "protected"');
  const unavailable = await read(fakeDeps({ fail: true }));
  check(unavailable.status === 'unavailable' && unavailable.monitoringActive === null && unavailable.allowance.usedPercent === null && unavailable.warning.level === null, 'unreadable usage → unavailable, monitoringActive null, no numbers guessed');

  const live = await read(fakeDeps({ used: 50 * 60, live: 2 }));
  check(live.allowance.inProgressMonitoredCalls === 2 && live.allowance.usedMinutes === 50, 'Fortress live monitoring sessions are reflected as in-progress calls; their metered seconds are already in "used"');
  const reads = [await read(fakeDeps({ used: 50 * 60 })), await read(fakeDeps({ used: 50 * 60 + 600 }))];
  check(reads[1].allowance.usedMinutes === reads[0].allowance.usedMinutes + 10, 'concurrent calls metering usage are reflected on the next read (server counters, not client state)');

  const cancelling = await read(fakeDeps({ used: 60 }), { subscription: sub({ cancel_at_period_end: true }) });
  check(cancelling.membership.state === 'cancelling' && cancelling.status === 'ok' && cancelling.monitoringActive === true, 'cancelled-but-active keeps its allowance until the period ends');
  const comp = await read(fakeDeps({ used: 60 }), { entitlement: compEnt, subscription: null });
  check(comp.membership.state === 'complimentary' && comp.allowance.includedMinutes === 100, 'complimentary households get the plan allowance and a monthly reset');
  const expired = await read(fakeDeps({ used: 60 }), { subscription: sub({ status: 'canceled' }) });
  check(expired.status === 'inactive' && expired.monitoringActive === false, 'expired membership → inactive, monitoringActive false');

  const plusEnv = { PLAN_PLUS_ALLOWANCE_MINUTES: '250' };
  const plus = await read(fakeDeps({ used: 60 * 60 }), { entitlement: { ...stripeEnt, plan_code: 'plus' }, env: plusEnv });
  check(plus.membership.planCode === 'plus' && plus.allowance.includedMinutes === 250 && plus.allowance.usedPercent === 24, 'a higher tier (plan_code plus) uses the same read model with its own allowance');
}

// ---------------------------------------------------------------------------
// 4. Warning thresholds (Fortress claim + this workstream's delivery)
// ---------------------------------------------------------------------------
{
  const claimedSet = new Set();
  const claim = async ({ householdId, periodStart, kind }) => { const k = `${householdId}|${periodStart}|${kind}`; if (claimedSet.has(k)) return false; claimedSet.add(k); return true; };
  const delivered = [];
  const deliver = async (d) => { delivered.push(d); };
  const args = { householdId: 'h', periodStart: PERIOD_START, allowanceSeconds: 6000, warningPoints: [0.75, 0.9], claim, deliver };
  await notifyUsageThresholds({ ...args, usedSeconds: 4600 });
  await notifyUsageThresholds({ ...args, usedSeconds: 4700 });
  await notifyUsageThresholds({ ...args, usedSeconds: 4800 });
  check(delivered.length === 1 && delivered[0].kind === 'warn_75' && delivered[0].periodStart === PERIOD_START, 'crossing 75% delivers one warning (with its period) — repeated progress reports never duplicate it');
  await notifyUsageThresholds({ ...args, usedSeconds: 6000 });
  check(delivered.length === 2 && delivered[1].kind === 'exhausted_100', 'jumping past 90% and 100% at once delivers only the highest (100%)');
  await notifyUsageThresholds({ ...args, periodStart: '2026-10-12T09:00:00.000Z', usedSeconds: 4600 });
  check(delivered.length === 3, 'a new billing period can warn again (idempotent per period + threshold)');

  check(notices.enabledChannels({}).length === 0 && notices.enabledChannels({ ALLOWANCE_NOTICE_CHANNELS: 'email,push,sms' }).join() === 'email,push', 'email/push delivery is OFF by default; unknown channels are ignored');
  const enq = [];
  const deliverOff = notices.createNoticeEnqueuer({ enqueue: async (rows) => enq.push(...rows), env: {} });
  await deliverOff({ householdId: 'h', periodStart: PERIOD_START, kind: 'warn_75' });
  const deliverOn = notices.createNoticeEnqueuer({ enqueue: async (rows) => enq.push(...rows), env: { ALLOWANCE_NOTICE_CHANNELS: 'email' } });
  await deliverOn({ householdId: 'h', periodStart: PERIOD_START, kind: 'warn_75' });
  check(enq.length === 1 && enq[0].channel === 'email', 'with email enabled, one delivery row per claimed point');
  const failing = notices.createNoticeEnqueuer({ enqueue: async () => { throw new Error('db'); }, env: { ALLOWANCE_NOTICE_CHANNELS: 'email' }, log: { error() {} } });
  check((await failing({ householdId: 'h', periodStart: PERIOD_START, kind: 'warn_75' })).enqueued === 0, 'an enqueue failure never throws into the call path');

  // Sender pass.
  const env = { ALLOWANCE_NOTICE_CHANNELS: 'email,push' };
  const rowsOf = (...r) => r.map((x) => ({ household_id: 'h', period_start: PERIOD_START, attempts: 1, created_at: NOW.toISOString(), ...x }));
  const run = async (rows, current, sendResult = { ok: true }) => {
    const done = []; const sent = [];
    const results = await notices.processAllowanceNotices({
      deps: {
        claimNoticeBatch: async () => rows,
        completeNoticeDelivery: async (d) => done.push(d),
        getHouseholdById: async () => HH,
        getCurrentAllowance: async () => current,
        sendEmail: async (m) => { sent.push(m); return sendResult; },
      }, now: NOW, env,
    });
    return { done, sent, results };
  };
  const cur = (o = {}) => ({ warning: { level: 75 }, allowance: { periodStartsAt: PERIOD_START, usedPercent: 78, remainingPercent: 22, resetsAt: '2026-10-12T09:00:00Z' }, ...o });
  const ok = await run(rowsOf({ kind: 'warn_75', channel: 'email' }, { kind: 'warn_75', channel: 'push' }), cur());
  check(ok.sent.length === 1 && ok.done.find((d) => d.channel === 'email').status === 'sent' && ok.done.find((d) => d.channel === 'push').status === 'suppressed', 'email sent once; push recorded as suppressed (no push pipeline exists)');
  check(/22%/.test(ok.sent[0].subject) && !/disconnect|cut off|stop working/i.test(ok.sent[0].text), 'warning email states the remaining % and never implies the phone service stops');
  const exhaustedMail = notices.noticeEmail('exhausted_100', { resetsAt: '2026-10-12T09:00:00Z' });
  check(/still works normally/.test(exhaustedMail.text) && /trusted contacts are not affected/.test(exhaustedMail.text), 'exhaustion email: phone and trusted calls unaffected; only unknown-caller checking pauses until reset');
  const reset = await run(rowsOf({ kind: 'warn_75', channel: 'email' }), cur({ allowance: { periodStartsAt: '2026-10-12T09:00:00.000Z', usedPercent: 1 } }));
  check(reset.sent.length === 0 && reset.done[0].status === 'suppressed', 'a warning for a period that has already reset is suppressed, not sent');
  const sup = await run(rowsOf({ kind: 'warn_75', channel: 'email' }), cur({ warning: { level: 90 } }));
  check(sup.sent.length === 0 && sup.done[0].error === 'superseded', 'a pending 75% warning is suppressed once 90% has been reached (no stacked emails)');
  const toppedUp = await run(rowsOf({ kind: 'warn_75', channel: 'email' }), cur({ allowance: { periodStartsAt: PERIOD_START, usedPercent: 50 } }));
  check(toppedUp.sent.length === 0 && toppedUp.done[0].error === 'no_longer_applicable', 'a top-up that lands before the warning is sent suppresses it');
  const failed = await run(rowsOf({ kind: 'warn_75', channel: 'email' }), cur(), { ok: false, error: 'http_500' });
  check(failed.done[0].status === 'failed' && failed.done[0].nextAttemptAt > NOW, 'a send failure is retried later with backoff');
  const gaveUp = await run(rowsOf({ kind: 'warn_75', channel: 'email', attempts: notices.MAX_ATTEMPTS }), cur(), { ok: false, error: 'http_500' });
  check(gaveUp.done[0].status === 'suppressed' && /gave_up/.test(gaveUp.done[0].error), 'after the maximum attempts it gives up (no endless retries)');
}

// ---------------------------------------------------------------------------
// 5. Top-up economics guard + catalogue
// ---------------------------------------------------------------------------
{
  const econ = { ...catalog.resolveEconomics({}), costPerMinuteGbp: 1, safetyReserve: 0, feeModel: { stripe: 'stripe', apple: 'apple30', google: 'store15' } };
  // The brief's rule, with fees switched off: £1 delivery cost at 40% margin needs ≥ £1.67 net ≈ £2.00 incl VAT.
  const noFee = { ...econ, feeModel: { stripe: 'none' } };
  const at200 = catalog.evaluateTopUpEconomics({ minutes: 1, priceGbpInclVat: 2.0, channel: 'stripe' }, noFee);
  check(at200.required === 1.6667 && at200.net === 1.6667, '£1 cost @40% → requires £1.67 net = £2.00 incl VAT (before fees/reserve)');
  const s = catalog.evaluateTopUpEconomics({ minutes: 1, priceGbpInclVat: 2.0, channel: 'stripe' }, econ);
  check(!s.viable, '…and once Stripe fees are included £2.00 is NOT enough — the guard refuses to sell it');
  const s3 = catalog.evaluateTopUpEconomics({ minutes: 1, priceGbpInclVat: 2.6, channel: 'stripe' }, econ);
  check(s3.viable, '£2.60 covers £1 cost + Stripe fees at 40% margin');
  const apple = catalog.evaluateTopUpEconomics({ minutes: 1, priceGbpInclVat: 2.6, channel: 'apple' }, econ);
  check(!apple.viable, 'the same price fails on Apple (30% commission assumed until SBP is confirmed)');

  check(catalog.resolveTopUpProducts({}).products.length === 0, 'nothing is on sale by default');
  const env = { ALLOWANCE_TOPUP_PRODUCTS: JSON.stringify([
    { code: 'topup_small', minutes: 30, priceGbpInclVat: 2.99, stripePriceId: 'price_t30', appleProductId: 'hcg.topup.30', googleProductId: 'hcg_topup_30' },
    { code: 'topup_loss', minutes: 500, priceGbpInclVat: 0.99, stripePriceId: 'price_t500' },
    { code: 'BAD CODE', minutes: -1, priceGbpInclVat: 1 },
  ]) };
  const r = catalog.resolveTopUpProducts(env);
  check(r.products.length === 2 && r.rejected.length === 1, 'malformed products are dropped, not guessed at');
  check(r.products.find((p) => p.code === 'topup_loss').channels.stripe.viable === false, 'a loss-making product is never viable');
  check(r.economics.costPerMinuteIsAssumption === true, 'the per-minute delivery cost is flagged as an ASSUMPTION until configured');
  check(catalog.findTopUpByProviderProduct({ channel: 'apple', providerProductId: 'hcg.topup.30' }, env).minutes === 30 && catalog.findTopUpByProviderProduct({ channel: 'google', providerProductId: 'hcg.topup.30' }, env) === null, 'store products resolve per channel only');
  check(catalog.planCodeForProduct('hcg.plus.monthly', { PLAN_PRODUCT_MAP: '{"hcg.plus.monthly":"plus","x":"unlimited"}' }) === 'plus'
    && catalog.planCodeForProduct('x', { PLAN_PRODUCT_MAP: '{"x":"unlimited"}' }) === null
    && catalog.planCodeForProduct('price_std', {}) === null, 'higher-tier mapping: only configured products map, only to known plans (never "unlimited")');

  // Offer gating through the read model.
  const on = { ...env, ALLOWANCE_TOPUPS_ENABLED: 'true' };
  const offer = (await read(fakeDeps({ used: 80 * 60 }), { env: on })).topUp;
  check(offer.available && offer.products.length === 1 && offer.products[0].code === 'topup_small' && offer.products[0].channel === 'stripe' && offer.expiresAtReset, 'web offers only viable Stripe top-ups, labelled as expiring at reset');
  check((await read(fakeDeps({}), { env })).topUp.reason === 'not_enabled', 'top-ups are off unless ALLOWANCE_TOPUPS_ENABLED=true');
  check((await read(fakeDeps({}), { env: on, subscription: sub({ status: 'past_due' }) })).topUp.reason === 'payment_issue', 'no top-up sale while the subscription payment is failing');
  check((await read(fakeDeps({}), { env: on, now: new Date('2026-10-12T00:00:00Z') })).topUp.reason === 'reset_soon', 'no top-up sale in the last 24 h before reset (minutes would expire)');
  check((await read(fakeDeps({}), { env: on, entitlement: { ...appleEnt, revenuecat_environment: 'sandbox' }, subscription: null, platform: 'ios' })).topUp.reason === 'test_membership', 'sandbox/test memberships are never offered paid top-ups');
  check((await read(fakeDeps({}), { env: on, platform: 'unknown' })).topUp.available === false, 'an unrecognised platform is offered nothing (never the wrong store)');
}

// ---------------------------------------------------------------------------
// 6. Verified-payment crediting
// ---------------------------------------------------------------------------
{
  const session = (o = {}) => ({ mode: 'payment', payment_status: 'paid', payment_intent: 'pi_123', amount_total: 299, currency: 'gbp', client_reference_id: 'hh-1',
    metadata: { hcg_purpose: 'allowance_topup', household_id: 'hh-1', product_code: 'topup_small', topup_minutes: '30', topup_budget_gbp: '0.5637' }, ...o });
  const ev = (type, obj, livemode = true) => ({ id: `evt_${type}`, type, livemode, data: { object: obj } });

  const paid = topUp.interpretStripeTopUpEvent(ev('checkout.session.completed', session()));
  check(paid.action === 'credit' && paid.minutes === 30 && paid.transactionId === 'pi_123' && paid.environment === 'production', 'Stripe paid checkout → credit 30 min keyed by PaymentIntent');
  const delayed = topUp.interpretStripeTopUpEvent(ev('checkout.session.completed', session({ payment_status: 'unpaid' })));
  check(delayed.action === 'ignore' && delayed.reason === 'payment_pending', 'delayed payment method: completed-but-unpaid credits nothing yet');
  check(topUp.interpretStripeTopUpEvent(ev('checkout.session.async_payment_succeeded', session({ payment_status: 'paid' }))).action === 'credit', '…and credits when async_payment_succeeded arrives');
  check(topUp.interpretStripeTopUpEvent(ev('checkout.session.async_payment_failed', session())).reason === 'payment_failed', 'failed top-up payment credits nothing');
  check(topUp.interpretStripeTopUpEvent(ev('checkout.session.completed', session(), false)).environment === 'sandbox', 'Stripe test-mode (livemode false) is non-production');
  check(topUp.interpretStripeTopUpEvent(ev('checkout.session.completed', session({ mode: 'subscription' }))) === null
    && topUp.interpretStripeTopUpEvent(ev('customer.subscription.updated', { id: 'sub_1' })) === null, 'subscription events are not top-ups (existing handling unchanged)');
  check(topUp.interpretStripeTopUpEvent(ev('checkout.session.completed', session({ metadata: { household_id: 'hh-1', topup_minutes: '9999' } }))) === null, 'a payment session without HCG\'s top-up marker is never treated as a top-up');
  const refund = topUp.interpretStripeTopUpEvent(ev('charge.refunded', { payment_intent: 'pi_123', amount: 299, amount_refunded: 299, refunded: true }));
  const partial = topUp.interpretStripeTopUpEvent(ev('charge.refunded', { payment_intent: 'pi_123', amount: 299, amount_refunded: 100, refunded: false }));
  check(refund.action === 'reverse' && partial.action === 'ignore', 'full refund reverses; partial refund is left for a manual decision');

  const rcEnv = { ALLOWANCE_TOPUP_PRODUCTS: JSON.stringify([{ code: 'topup_small', minutes: 30, priceGbpInclVat: 2.99, appleProductId: 'hcg.topup.30', googleProductId: 'hcg_topup_30' }]) };
  const rc = (o = {}) => ({ id: 'rc_evt_1', type: 'NON_RENEWING_PURCHASE', store: 'APP_STORE', environment: 'PRODUCTION', product_id: 'hcg.topup.30', transaction_id: '2000000123', price_in_purchased_currency: 2.99, currency: 'GBP', ...o });
  const rcPaid = topUp.interpretRevenueCatTopUpEvent(rc(), rcEnv);
  check(rcPaid.action === 'credit' && rcPaid.source === 'apple' && rcPaid.minutes === 30 && rcPaid.amountMinor === 299, 'Apple consumable top-up → credit catalogue minutes');
  check(topUp.interpretRevenueCatTopUpEvent(rc({ store: 'PLAY_STORE', product_id: 'hcg_topup_30' }), rcEnv).source === 'google', 'Google Play consumable → source google');
  check(topUp.interpretRevenueCatTopUpEvent(rc({ environment: 'SANDBOX' }), rcEnv).environment === 'sandbox'
    && topUp.interpretRevenueCatTopUpEvent(rc({ environment: undefined }), rcEnv).environment === 'sandbox', 'RevenueCat SANDBOX or missing environment → non-production (fail closed)');
  check(topUp.interpretRevenueCatTopUpEvent(rc({ product_id: 'hcg.monthly' }), rcEnv) === null && topUp.interpretRevenueCatTopUpEvent(rc({ type: 'RENEWAL' }), rcEnv) === null, 'subscription products/events are not top-ups');
  check(topUp.interpretRevenueCatTopUpEvent(rc({ type: 'CANCELLATION' }), rcEnv).action === 'reverse', 'a refunded consumable (CANCELLATION) reverses the credit');

  // applyTopUpEvent with a fake idempotent store.
  const store = new Map();
  const alerts = [];
  const deps = {
    getActiveEntitlement: async (h) => (h === 'hh-none' ? null : stripeEnt),
    getSubscriptionByHouseholdId: async () => sub(),
    findTopUpCredit: async ({ source, transactionId }) => store.get(`${source}|${transactionId}|topup`) || null,
    creditAllowance: async (a) => {
      const k = `${a.source}|${a.transactionId}|${a.kind}`;
      if (store.has(k)) return { credited: false, duplicate: true, sameHousehold: store.get(k).household_id === a.householdId };
      if (a.environment !== 'production' && !a.allowNonProduction) return { credited: false, reason: 'non_production_purchase' };
      store.set(k, { household_id: a.householdId, period_start: a.periodStart, period_end: a.periodEnd, product_code: a.productCode, seconds: a.seconds });
      return { credited: true, appliedSeconds: a.seconds };
    },
    alert: async (m) => alerts.push(m),
  };
  const r1 = await topUp.applyTopUpEvent(paid, { deps, now: NOW, env: {} });
  const r2 = await topUp.applyTopUpEvent(paid, { deps, now: NOW, env: {} });
  check(r1.outcome === 'credited' && r2.outcome === 'duplicate' && store.size === 1, 'top-up success credits once; the duplicate webhook is a no-op');
  const stored = store.get('stripe|pi_123|topup');
  check(stored.seconds === 1800 && new Date(stored.period_start).toISOString() === PERIOD_START, 'credited to the period current at payment confirmation');
  const sbx = await topUp.applyTopUpEvent({ ...paid, environment: 'sandbox', transactionId: 'pi_sbx' }, { deps, now: NOW, env: {} });
  const sbxStaging = await topUp.applyTopUpEvent({ ...paid, environment: 'sandbox', transactionId: 'pi_sbx' }, { deps, now: NOW, env: { APP_ENV: 'staging', ALLOWANCE_ALLOW_SANDBOX_CREDITS: 'true' } });
  const sbxProdFlag = await topUp.applyTopUpEvent({ ...paid, environment: 'sandbox', transactionId: 'pi_sbx2' }, { deps, now: NOW, env: { ALLOWANCE_ALLOW_SANDBOX_CREDITS: 'true' } });
  check(sbx.outcome === 'rejected' && sbx.reason === 'non_production_purchase' && sbxStaging.outcome === 'credited' && sbxProdFlag.outcome === 'rejected', 'sandbox purchases never credit in production — only on staging with an explicit flag');
  check((await topUp.applyTopUpEvent(delayed, { deps, now: NOW, env: {} })).outcome === 'ignored', 'pending payment → ignored (no credit before payment is authoritative)');
  const orphan = await topUp.applyTopUpEvent({ ...paid, householdId: null, transactionId: 'pi_orphan' }, { deps, now: NOW, env: {} });
  check(orphan.outcome === 'rejected' && alerts.some((a) => /UNMATCHED/.test(a)), 'a paid top-up with no household is alerted, never silently dropped');
  const bad = await topUp.applyTopUpEvent({ ...paid, minutes: 0, transactionId: 'pi_bad' }, { deps, now: NOW, env: {} });
  check(bad.outcome === 'rejected' && bad.reason === 'invalid_quantity', 'an invalid quantity is refused and alerted');
  await topUp.applyTopUpEvent({ ...paid, householdId: 'hh-none', transactionId: 'pi_noent' }, { deps, now: NOW, env: {} });
  check(store.has('stripe|pi_noent|topup') && alerts.some((a) => /WITHOUT ENTITLEMENT/.test(a)), 'paid but no current entitlement → recorded (customer paid) and alerted for a refund decision');
  const reused = await topUp.applyTopUpEvent({ ...paid, householdId: 'hh-other' }, { deps, now: NOW, env: {} });
  check(reused.outcome === 'duplicate' && alerts.some((a) => /REUSED/.test(a)), 'the same payment presented for another household credits nothing and is alerted');
  const rev = await topUp.applyTopUpEvent(refund, { deps, now: NOW, env: {} });
  check(rev.outcome === 'reversed' && store.has('stripe|pi_123|topup_reversal'), 'refund → reversal recorded against the original credit');
  check((await topUp.applyTopUpEvent({ ...refund, transactionId: 'pi_subscription_invoice' }, { deps, now: NOW, env: {} })).outcome === 'ignored', 'refund of a non-top-up payment (e.g. a subscription invoice) changes nothing');

  const params = topUp.buildTopUpCheckoutParams({ householdId: 'hh-1', stripeCustomerId: 'cus_1', product: { code: 'topup_small', minutes: 30, channels: { stripe: { providerProductId: 'price_t30' } } }, appUrl: 'https://homecallguard.co.uk' });
  check(params.mode === 'payment' && params.metadata.topup_minutes === '30' && params.payment_intent_data.metadata.household_id === 'hh-1' && params.line_items[0].price === 'price_t30' && params.automatic_tax.enabled, 'top-up Checkout: one-off payment, server-stamped household/minutes, Stripe Tax on');
}

// ---------------------------------------------------------------------------
// 7. Admin adjustments
// ---------------------------------------------------------------------------
{
  check(validateAdjustment({ minutes: 30, reason: 'goodwill', idempotencyKey: 'abcd-1234' }) === null, 'valid adjustment accepted');
  check(validateAdjustment({ minutes: 0, reason: 'x y z', idempotencyKey: 'abcd-1234' }) && validateAdjustment({ minutes: 5000, reason: 'big', idempotencyKey: 'abcd-1234' }) && validateAdjustment({ minutes: 10, reason: '', idempotencyKey: 'abcd-1234' }) && validateAdjustment({ minutes: 10, reason: 'ok ok', idempotencyKey: 'x' }), 'zero, oversized, reason-less or key-less adjustments are refused');
  const calls = [];
  const res = await applyAdminAdjustment({ householdId: 'hh-1', actor: 'admin-1', minutes: 15, reason: 'outage goodwill', idempotencyKey: 'key-00000001' }, {
    deps: { getActiveEntitlement: async () => stripeEnt, getSubscriptionByHouseholdId: async () => sub(), creditAllowance: async (a) => { calls.push(a); return { credited: true }; } }, now: NOW,
  });
  check(res.ok && calls[0].kind === 'admin_adjustment' && calls[0].seconds === 900 && calls[0].actor === 'admin-1' && calls[0].transactionId === 'admin:key-00000001' && calls[0].source === 'admin', 'admin adjustment is audited (actor, reason, idempotency key) and goes through credit_allowance');
}

// ---------------------------------------------------------------------------
// 8. Forge resistance (structural): no route accepts allowance figures from a client
// ---------------------------------------------------------------------------
{
  const allowanceRoutes = readFileSync(path.join(root, 'routes/allowance.js'), 'utf8');
  const bodyFields = [...allowanceRoutes.matchAll(/req\.body(?:\s*&&\s*req\.body)?\.([a-zA-Z]+)/g)].map((m) => m[1]);
  check(bodyFields.every((f) => ['product'].includes(f)), 'customer routes read only a product choice from the body (never minutes, price, usage or remaining)');
  check(/model\.topUp\.products\.find/.test(allowanceRoutes) && /requireEntitlement/.test(allowanceRoutes), 'top-up checkout re-derives the offer server-side for the signed-in household');
  check(!/creditAllowance/.test(allowanceRoutes.split("router.post('/admin")[0]), 'no customer-facing route can credit an allowance (only verified webhooks and the admin route)');
  check(/requireAdmin/.test(allowanceRoutes.split("router.post('/admin")[1] || ''), 'the adjustment route requires an admin');
  const billing = readFileSync(path.join(root, 'routes/billing.js'), 'utf8');
  check(billing.indexOf('interpretStripeTopUpEvent(event)') > billing.indexOf('stripe.webhooks.constructEvent'), 'Stripe top-ups are only interpreted after signature verification');
  const mobile = readFileSync(path.join(root, 'routes/mobileApi.js'), 'utf8');
  const rcStart = mobile.indexOf('/api/v1/billing/apple/revenuecat-webhook');
  check(mobile.indexOf('interpretRevenueCatTopUpEvent(event)', rcStart) > mobile.indexOf('req.headers.authorization !== expectedAuth', rcStart), 'RevenueCat top-ups are only interpreted after the webhook Authorization check');
  const server = readFileSync(path.join(root, 'server.js'), 'utf8');
  check(/customerAllowance,\n/.test(server) && /customerAllowance,\n/.test(mobile), 'both dashboards return the server-computed customerAllowance');
}

// ---------------------------------------------------------------------------
// 9. Higher tier: plan_code follows the paid product (no-op until configured)
// ---------------------------------------------------------------------------
{
  const { syncPlanCode } = require('../services/allowance/planSync.js');
  const calls = [];
  const setPlanCode = async (a) => { calls.push(a); return true; };
  const quiet = { log() {}, error() {} };
  const off = await syncPlanCode({ householdId: 'h', source: 'stripe', providerProductId: 'price_plus', setPlanCode, env: {}, log: quiet });
  check(!off.changed && calls.length === 0, 'with no PLAN_PRODUCT_MAP nothing is written (today: Standard only)');
  const env = { PLAN_PRODUCT_MAP: '{"price_plus":"plus"}' };
  await syncPlanCode({ householdId: 'h', source: 'stripe', providerProductId: 'price_plus', setPlanCode, env, log: quiet });
  await syncPlanCode({ householdId: 'h', source: 'stripe', providerProductId: 'price_std', setPlanCode, env, log: quiet });
  check(calls[0].planCode === 'plus' && calls[0].source === 'stripe' && calls[1].planCode === 'standard', 'mapped product → plus; unmapped product (downgrade/unknown) → standard, scoped to the event source');
  const failing = await syncPlanCode({ householdId: 'h', source: 'stripe', providerProductId: 'price_plus', setPlanCode: async () => { throw new Error('db'); }, env, log: quiet });
  check(failing.changed === false && failing.error === 'db', 'a plan sync failure never throws into the webhook');
  const billingSrc = readFileSync(path.join(root, 'routes/billing.js'), 'utf8');
  check(/result === "processed" && householdId && QUALIFYING_SUBSCRIPTION_STATUSES\.has\(subscription\.status\)\) \{\s*await syncPlanCode/.test(billingSrc), 'Stripe: only a processed (non-stale) event for a live subscription can change the plan');
  const mobileSrc = readFileSync(path.join(root, 'routes/mobileApi.js'), 'utf8');
  check(/resolveEventEnvironment\(event\) === "production"\) \{\s*await syncPlanCode/.test(mobileSrc) && !/new_product_id/.test(mobileSrc.split('syncPlanCode({')[1].split(')')[0]), 'RevenueCat: only production events, using the currently billed product');
}

// ---------------------------------------------------------------------------
// 10. Financial Fortress (£ budget, fc_household_status) as the source
// ---------------------------------------------------------------------------
{
  const { fromFortressHouseholdStatus } = require('../services/allowance/fortressAdapter.js');
  const { resolvePlan } = require('../services/usage/plans.js');
  const plan = resolvePlan('standard', {});
  // Shape copied from fc_household_status (security/financial-containment-p0, provisional).
  const fc = (o = {}) => ({ hasAccount: true, profile: 'standard', periodStart: '2026-09-12T09:00:00Z', periodEnd: '2026-10-12T09:00:00Z',
    budgetGbp: 1.0, adjustmentsGbp: 0, deliveryReserveGbp: 0.6, reservedGbp: 0, estimatedConsumedGbp: 0, remainingBudgetGbp: 1.0, remainingWithReserveGbp: 1.6, live: [], ...o });
  const a = fromFortressHouseholdStatus(fc({ estimatedConsumedGbp: 0.5, reservedGbp: 0.3, remainingBudgetGbp: 0.2, remainingWithReserveGbp: 0.8, live: [{ callSid: 'CA1' }] }), { plan });
  check(a.usedPercent === 80 && a.remainingPercent === 20 && a.reservedPercent === 30 && a.liveCalls === 1 && a.state === 'low' && a.lastWarningPoint === 75, 'Fortress reservations count as used: £0.50 consumed + £0.30 reserved of £1 → 80% used, 30% held by a live call');
  check(a.usedMinutes === null && a.allowanceMinutes === null && !('budgetGbp' in a), 'no £ or minutes are exposed from the £-budget source — percentages only');
  const topped = fromFortressHouseholdStatus(fc({ adjustmentsGbp: 1.0, estimatedConsumedGbp: 0.5, remainingBudgetGbp: 1.5, remainingWithReserveGbp: 2.1 }), { plan });
  check(topped.usedPercent === 25 && topped.state === 'available', 'a Fortress budget adjustment (top-up) enlarges the total');
  const reserveOnly = fromFortressHouseholdStatus(fc({ estimatedConsumedGbp: 1.0, remainingBudgetGbp: 0, remainingWithReserveGbp: 0.6 }), { plan });
  check(reserveOnly.state === 'exhausted' && reserveOnly.monitoringActive === false && reserveOnly.callsContinue === true, 'budget used, delivery reserve left → monitoring off, calls still delivered');
  const none = fromFortressHouseholdStatus(fc({ estimatedConsumedGbp: 1.0, remainingBudgetGbp: 0, remainingWithReserveGbp: 0 }), { plan });
  check(none.callsContinue === false, 'budget and reserve both used → callsContinue false (Fortress may refuse new calls)');
  check(fromFortressHouseholdStatus(null, { plan }).state === 'unavailable' && fromFortressHouseholdStatus({ hasAccount: false, live: [] }, { plan }).remainingPercent === 100, 'unreadable → unavailable; no account yet this period → full');

  const deps = { ...fakeDeps({ used: 99999 }), getFortressHouseholdStatus: async () => fc({ estimatedConsumedGbp: 1.0, remainingBudgetGbp: 0, remainingWithReserveGbp: 0 }) };
  const limited = await read(deps, { env: { ALLOWANCE_SOURCE: 'fortress' } });
  check(limited.source === 'fortress' && limited.status === 'calls_limited' && limited.callsContinue === false && limited.tone === 'critical' && limited.monitoringActive === false, 'read model on the Fortress source: calls_limited, callsContinue false — never "calls continue"');
  const def = await read(deps);
  check(def.source === 'monitoring_minutes' && def.callsContinue === true, 'without ALLOWANCE_SOURCE=fortress the 056 minutes source is used (today\'s default)');
  // DT-2 (real-device finding 2026-10-05): the payload says what the % measures.
  check(limited.basis === 'protection_spend' && limited.trustedCallsUseAllowance === true && limited.allowance.includedMinutes === null, 'Fortress source: basis protection_spend, trusted calls use it, and NO minute figure is offered');
  check(def.basis === 'monitored_minutes' && def.trustedCallsUseAllowance === false && def.allowance.includedMinutes === 100, '056 source: basis monitored_minutes, trusted calls do not use it, included minutes shown');
  const fcDown = await read({ ...fakeDeps({}), getFortressHouseholdStatus: async () => { throw new Error('down'); } }, { env: { ALLOWANCE_SOURCE: 'fortress' } });
  check(fcDown.status === 'unavailable' && fcDown.monitoringActive === null, 'Fortress status unreadable → unavailable, never "protected"');

  const html = readFileSync(path.join(root, 'upload.html'), 'utf8');
  const meterSrc = readFileSync(path.join(root, 'mobile/components/AllowanceMeter.tsx'), 'utf8');
  check(/case "calls_limited":[\s\S]{0,300}may not get through/.test(html) && /case "calls_limited":[\s\S]{0,300}may not get through/.test(meterSrc), 'calls_limited copy says forwarded calls may not get through (no false "calls continue")');
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
