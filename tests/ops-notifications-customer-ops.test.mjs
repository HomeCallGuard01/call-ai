// Customer-operations notification coverage for the first cohort (WS4,
// 2026-10-10). Each launch notification the first-five runbook relies on is
// produced, exactly once, with no contact details:
//
//   new genuine customer        → NEW_GENUINE_CUSTOMER          (ops event)
//   app unreachable (was fine)  → NEEDS_ATTENTION protection_lost_app_unreachable
//   app never registered        → NEEDS_ATTENTION not_protected_within_onboarding_window (blocker appReachable)
//   number provisioning failed  → NEEDS_ATTENTION number_provisioning_failed
//   forwarding not proven       → NEEDS_ATTENTION forwarding_not_proven
//   payment failed (NEW)        → NEEDS_ATTENTION payment_failed (ops event, once per failed period)
//                                 + real-time alert on invoice.payment_failed (webhook)
//   refund / dispute (NEW)      → real-time alert on charge.refunded,
//                                 charge.dispute.created / .closed (webhook)
//
// Run with: node tests/ops-notifications-customer-ops.test.mjs
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
Object.assign(process.env, { SUPABASE_URL: 'http://127.0.0.1:9', SUPABASE_ANON_KEY: 'x', SUPABASE_SERVICE_ROLE_KEY: 'x', Resend_API_Key: '' });
delete process.env.STRIPE_SECRET_KEY; // the classifier must not treat these as Stripe test customers
delete process.env.ACCOUNTING_CAPTURE_ENABLED;
delete process.env.ALLOWANCE_TOPUPS_ENABLED;

let failures = 0;
const check = (c, m) => { if (c) console.log(`✓ ${m}`); else { console.error(`✗ ${m}`); failures++; } };

const { detectOpsEvents, PAYMENT_FAILED_STATUSES } = require('../services/opsEvents/detector');
const { runOpsEventScan } = require('../services/opsEvents/runner');
const { createMemoryOpsEventStore } = require('../services/opsEvents/store');
const { TYPES, renderMessage, assertSafe } = require('../services/opsEvents/events');

const NOW = new Date('2026-10-10T12:00:00Z');
const iso = (h) => new Date(NOW.getTime() - h * 3600e3).toISOString();
const ent = (o = {}) => ({ id: 'e', entitlement_type: 'paid_subscription', status: 'active', source: 'stripe', starts_at: iso(72), ends_at: null, ...o });
const household = (n, o = {}) => ({ id: `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`, account_number: `HCG-${String(n).padStart(8, '0')}`, email: `c${n}@example.com`, created_at: iso(72), status: 'active', auth_user_id: `a${n}`, twilio_number: `+4410000${String(n).padStart(5, '0')}`, twilio_provisioning_status: 'active', twilio_provisioning_updated_at: iso(70), activation_verified_at: null, delivery_verified_at: null, voice_client_registered_at: null, forwarding_proven_at: null, ...o });
const snap = (n, { h = {}, sub = null, e = ent() } = {}) => ({ household: household(n, h), entitlements: [e], subscription: sub, quarantineRows: [], financialHold: null, currentNumberAssignedAt: null, failedStripeEvents: [], classification: null });
const reasons = (r) => r.events.filter((e) => e.event_type === TYPES.CUSTOMER_NEEDS_ATTENTION).map((e) => e.payload.reason);

// ── coverage matrix (detector) ───────────────────────────────────────────
{
  const fresh = detectOpsEvents(snap(1, { h: { created_at: iso(1) }, e: ent({ starts_at: iso(1) }) }), NOW);
  check(fresh.events.some((e) => e.event_type === TYPES.NEW_GENUINE_CUSTOMER), 'new genuine customer → NEW_GENUINE_CUSTOMER');

  // Was protected (delivery + forwarding proven), app no longer registered.
  const lost = detectOpsEvents(snap(2, { h: { forwarding_proven_at: iso(48), activation_verified_at: iso(48), delivery_verified_at: iso(48), voice_client_registered_at: null } }), NOW);
  check(lost.activation.stage === 'reconnect_needed' && reasons(lost).includes('protection_lost_app_unreachable'), `app unreachable after working → NEEDS_ATTENTION protection_lost_app_unreachable (stage ${lost.activation.stage})`);

  // Paid 72 h ago, forwarding + calls arriving, app never registered.
  const neverApp = detectOpsEvents(snap(3, { h: { activation_verified_at: iso(60), forwarding_proven_at: iso(60) } }), NOW);
  const neverEv = neverApp.events.find((e) => e.payload.reason === 'not_protected_within_onboarding_window');
  check(neverApp.activation.stage === 'awaiting_app' && !!neverEv && neverEv.payload.blockers.includes('appReachable'), `app never registered → NEEDS_ATTENTION not_protected_within_onboarding_window with blocker appReachable (stage ${neverApp.activation.stage})`);

  const numFail = detectOpsEvents(snap(4, { h: { twilio_number: null, twilio_provisioning_status: 'failed' } }), NOW);
  check(reasons(numFail).includes('number_provisioning_failed'), 'number provisioning failed → NEEDS_ATTENTION number_provisioning_failed');

  // ── NEW: payment failed ──
  check(PAYMENT_FAILED_STATUSES.has('past_due') && PAYMENT_FAILED_STATUSES.has('unpaid') && !PAYMENT_FAILED_STATUSES.has('active'), 'payment-failed statuses are past_due and unpaid');
  const pd = detectOpsEvents(snap(5, { sub: { status: 'past_due', current_period_end: '2026-10-09T00:00:00Z', updated_at: iso(2) } }), NOW);
  const pdEv = pd.events.find((e) => e.payload.reason === 'payment_failed');
  check(!!pdEv && pdEv.event_type === TYPES.CUSTOMER_NEEDS_ATTENTION && pdEv.severity === 'action', 'past_due (Stripe retrying) → NEEDS_ATTENTION payment_failed (action)');
  check(pdEv && pdEv.event_key === `customer_needs_attention:${household(5).id}:payment_failed:2026-10-09T00:00:00Z`, 'one event per failed billing period (episode = that period end)');
  const ok = detectOpsEvents(snap(6, { sub: { status: 'active', current_period_end: '2026-11-09T00:00:00Z' } }), NOW);
  check(!reasons(ok).includes('payment_failed'), 'an active subscription produces no payment_failed');
  const sandbox = detectOpsEvents(snap(7, { sub: { status: 'past_due', current_period_end: '2026-10-09T00:00:00Z' }, e: ent({ entitlement_type: 'complimentary', source: 'admin_manual' }) }), NOW);
  check(sandbox.events.length === 0, 'a non-genuine (complimentary) household never produces a customer event, even with a past_due row');
  const msg = renderMessage(assertSafe(pdEv));
  check(/Customer needs attention/.test(msg.subject) && /Reason: payment_failed/.test(msg.text) && !/@|\+44|cus_|sub_|in_/.test(msg.subject + msg.text), 'rendered payment_failed message names the reason, with no email, phone or payment id');
}

// ── once only, across scans ──────────────────────────────────────────────
{
  const store = createMemoryOpsEventStore();
  let period = '2026-10-09T00:00:00Z';
  const load = async () => ({ snapshots: [snap(8, { sub: { status: 'past_due', current_period_end: period } })] });
  await runOpsEventScan({ loadSnapshots: load, store, env: {}, now: NOW, log: () => {} });
  await runOpsEventScan({ loadSnapshots: load, store, env: {}, now: NOW, log: () => {} });
  const pf = () => [...store.events.values()].filter((e) => e.payload.reason === 'payment_failed');
  check(pf().length === 1, 're-scanning the same failed period records payment_failed once');
  period = '2026-11-09T00:00:00Z';
  await runOpsEventScan({ loadSnapshots: load, store, env: {}, now: NOW, log: () => {} });
  check(pf().length === 2, 'a later failed period is a new event');
}

// ── real-time Stripe alerts (pure + through the real webhook) ───────────
{
  const { paymentOpsAlertFor } = require('../routes/billing.js');
  const ev = (type, object, extra = {}) => ({ id: `evt_${type}`, object: 'event', type, livemode: true, created: 1, data: { object }, ...extra });
  const refund = paymentOpsAlertFor(ev('charge.refunded', { id: 'ch_1', object: 'charge', amount: 599, amount_refunded: 599, refunded: true, currency: 'gbp', billing_details: { email: 'x@example.com', name: 'X' }, metadata: { household_id: 'hh-1' } }));
  check(refund && refund.type === 'stripe_charge_refunded' && refund.dedupeKey === 'ch_1' && refund.context.fullRefund === true && /cancel/i.test(refund.message), 'charge.refunded → refund alert ("refund + cancel together" reminder), deduped per charge');
  check(!JSON.stringify(refund).includes('x@example.com') && !JSON.stringify(refund).includes('"X"'), 'refund alert never carries the customer email or name');
  const partial = paymentOpsAlertFor(ev('charge.refunded', { id: 'ch_2', amount: 599, amount_refunded: 100, refunded: false }));
  check(partial.context.fullRefund === false && /partial/.test(partial.message), 'partial refund is labelled partial');
  const dispute = paymentOpsAlertFor(ev('charge.dispute.created', { id: 'dp_1', object: 'dispute', charge: 'ch_9', amount: 599, reason: 'fraudulent', status: 'needs_response' }));
  check(dispute.type === 'stripe_dispute_opened' && dispute.dedupeKey === 'dp_1' && dispute.context.chargeId === 'ch_9' && /deadline/.test(dispute.message), 'charge.dispute.created → dispute alert with the deadline warning');
  check(paymentOpsAlertFor(ev('charge.dispute.closed', { id: 'dp_1', status: 'lost' })).message.includes('lost'), 'charge.dispute.closed → outcome alert');
  const failed = paymentOpsAlertFor(ev('invoice.payment_failed', { id: 'in_1', subscription: 'sub_1', amount_due: 599, attempt_count: 1, customer_email: 'x@example.com' }));
  check(failed.type === 'stripe_invoice_payment_failed' && failed.context.attemptCount === 1 && !JSON.stringify(failed).includes('x@example.com'), 'invoice.payment_failed → payment-failed alert (no email)');
  check(['customer.subscription.updated', 'invoice.paid', 'checkout.session.completed', 'price.updated'].every((t) => paymentOpsAlertFor(ev(t, { id: 'x' })) === null) && paymentOpsAlertFor(null) === null && paymentOpsAlertFor({ type: 'charge.refunded' }) === null, 'every other event (and a malformed one) produces no alert');

  // Through the real route: alerts fire, responses unchanged, nothing else touched.
  process.env.STRIPE_SECRET_KEY = 'sk_test_ws4_ops_fake'; // local signing only; set AFTER the classifier checks above
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_ws4_ops';
  const stub = (rel, exports) => { const id = require.resolve(rel); require.cache[id] = { id, filename: id, loaded: true, exports }; };
  const sent = []; const rpc = [];
  stub('../services/alerting.js', { sendCriticalAlert: async (type, message, context, deps) => { sent.push({ type, deps, context }); return true; } });
  const realBilling = require('../database/billing.js');
  stub('../database/billing.js', { ...realBilling, claimWebhookEvent: async () => { rpc.push('claim'); return true; }, processWebhookEvent: async () => { rpc.push('process'); return 'processed'; } });
  for (const k of ['../routes/billing.js', '../services/stripeClient.js']) delete require.cache[require.resolve(k)];
  const express = require('express');
  const Stripe = require('stripe');
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const app = express();
  app.use(require('../routes/billing.js'));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const post = async (event) => {
    const payload = JSON.stringify(event);
    const header = stripe.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET });
    return (await fetch(`http://127.0.0.1:${server.address().port}/billing/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': header }, body: payload })).status;
  };
  try {
    const s1 = await post(ev('charge.refunded', { id: 'ch_r1', object: 'charge', payment_intent: 'pi_sub', amount: 599, amount_refunded: 599, refunded: true }));
    check(s1 === 200 && sent.length === 1 && sent[0].type === 'stripe_charge_refunded' && sent[0].deps.dedupeKey === 'ch_r1', 'webhook: a subscription refund (top-ups OFF) → 200 as before, plus one refund alert');
    const s2 = await post(ev('charge.dispute.created', { id: 'dp_r1', object: 'dispute', charge: 'ch_r1', amount: 599, reason: 'general', status: 'needs_response' }));
    const s3 = await post(ev('invoice.payment_failed', { id: 'in_r1', object: 'invoice', subscription: 'sub_r1', amount_due: 599, attempt_count: 2 }));
    check(s2 === 200 && s3 === 200 && sent.map((x) => x.type).join() === 'stripe_charge_refunded,stripe_dispute_opened,stripe_invoice_payment_failed', 'webhook: dispute and failed payment → 200 + their alerts');
    check(rpc.length === 0, 'webhook: these alerts never touch the subscription/entitlement path');
    const bad = await fetch(`http://127.0.0.1:${server.address().port}/billing/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=deadbeef' }, body: JSON.stringify(ev('charge.dispute.created', { id: 'dp_forged' })) });
    check(bad.status === 400 && sent.length === 3, 'webhook: a forged event is rejected before any alert');
  } finally {
    server.close();
  }
  const billingSrc = readFileSync(path.join(root, 'routes', 'billing.js'), 'utf8');
  check(billingSrc.indexOf('const paymentOpsAlert = paymentOpsAlertFor(event);') > billingSrc.indexOf('stripe.webhooks.constructEvent(') && billingSrc.indexOf('const paymentOpsAlert = paymentOpsAlertFor(event);') < billingSrc.indexOf('const topUpIntent = interpretStripeTopUpEvent(event);'), 'the alert runs after signature verification and before the top-up branch');
  check(!/opsEvents/.test(billingSrc), 'routes/billing.js still does not import the ops-event code (notifications never sit in a billing path)');
}

console.log(failures === 0 ? '\nCustomer-ops notifications: all checks hold.' : `\n${failures} check(s) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
