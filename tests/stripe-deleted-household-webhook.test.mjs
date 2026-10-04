// Lifecycle F-03 (fixed 2026-10-04): Stripe subscription events after in-app
// account deletion. Through the REAL /billing/webhook route with genuine
// Stripe signatures; only the database layer is an in-memory model of the
// real RPCs (014 claim: received → processed/ignored terminal, failed and
// stale-received re-claimable; 070: raises on the stripe_customer_id mismatch
// an anonymised household always has → 'failed').
// Proves: deletion → subscription.deleted is acknowledged once and recorded
// 'ignored' (no retry loop, no alert storm); replay is idempotent; the event
// never reaches the entitlement RPC (no re-entitlement); a LIVE subscription
// for a deleted household is alerted + queued; DB unreadable → 500 (retry,
// never a guess); a normal household is processed exactly as before.
import { createRequire } from 'node:module';
import http from 'node:http';
const require = createRequire(import.meta.url);

Object.assign(process.env, {
  SUPABASE_URL: 'http://127.0.0.1:9', SUPABASE_ANON_KEY: 'test', SUPABASE_SERVICE_ROLE_KEY: 'test',
  STRIPE_SECRET_KEY: 'sk_test_f03_fake', STRIPE_WEBHOOK_SECRET: 'whsec_f03_test_secret', Resend_API_Key: '',
});
delete process.env.ACCOUNTING_CAPTURE_ENABLED;

let failures = 0;
const check = (c, m) => { if (c) console.log(`✓ ${m}`); else { console.error(`✗ ${m}`); failures++; } };
const stub = (rel, exports) => { const id = require.resolve(rel); require.cache[id] = { id, filename: id, loaded: true, exports }; };

// ── In-memory model of the real tables/RPCs ──────────────────────────────
const households = new Map();
const events = new Map(); // stripe_event_id → row
const rpcCalls = []; const alerts = []; const provisioning = [];
let householdReadFails = false;
const LIVE = 'aaaaaaaa-0000-0000-0000-000000000001';
const DELETED = 'dddddddd-0000-0000-0000-000000000002';
households.set(LIVE, { id: LIVE, status: 'active', email: 'a@example.com', auth_user_id: 'auth-a', stripe_customer_id: 'cus_live' });
// Exactly what migration 029 leaves behind.
households.set(DELETED, { id: DELETED, status: 'cancelled', email: `anonymized-${DELETED}@deleted.homecallguard.internal`, auth_user_id: null, stripe_customer_id: null });

const realBilling = require('../database/billing.js');
stub('../database/billing.js', {
  ...realBilling,
  getHouseholdByStripeCustomerId: async (cus) => [...households.values()].find((h) => h.stripe_customer_id === cus) || null,
  getHouseholdDeletionFacts: async (id) => { if (householdReadFails) throw new Error('households unreadable'); return households.get(id) || null; },
  claimWebhookEvent: async ({ stripeEventId, eventType, householdId }) => {
    const row = events.get(stripeEventId);
    if (!row) { events.set(stripeEventId, { stripe_event_id: stripeEventId, event_type: eventType, household_id: householdId, status: 'received', attempt_count: 1, error: null }); return true; }
    if (row.status === 'failed') { row.attempt_count++; row.status = 'received'; return true; }
    return false; // processed / ignored are terminal; fresh 'received' is owned by another attempt
  },
  markWebhookEventIgnored: async ({ stripeEventId, reason }) => {
    const row = events.get(stripeEventId);
    if (row && row.status === 'received') { row.status = 'ignored'; row.error = reason; }
  },
  processWebhookEvent: async (p) => {
    rpcCalls.push(p);
    const h = households.get(p.householdId);
    const row = events.get(p.stripeEventId);
    if (!h || !h.stripe_customer_id || h.stripe_customer_id !== p.stripeCustomerId) { row.status = 'failed'; row.error = 'customer mismatch'; return 'failed'; }
    row.status = 'processed'; return 'processed';
  },
});
stub('../services/alerting.js', { sendCriticalAlert: async (type) => { alerts.push(type); } });
const realProv = require('../services/twilioProvisioning.js');
stub('../services/twilioProvisioning.js', { ...realProv, handleProcessedWebhookEvent: async (r, ctx) => { provisioning.push(ctx); } });
stub('../services/allowance/planSync.js', { syncPlanCode: async () => {} });

const express = require('express');
const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const app = express();
app.use(require('../routes/billing.js'));
const server = http.createServer(app);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const send = async (event, { forge = false } = {}) => {
  const payload = JSON.stringify(event);
  const header = forge ? 't=1,v1=deadbeef' : stripe.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET });
  const res = await fetch(`${base}/billing/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': header }, body: payload });
  return res.status;
};
const subEvent = (id, type, { householdId, customer, status }) => ({
  id, object: 'event', type, livemode: false, created: Math.floor(Date.now() / 1000),
  data: { object: { id: `sub_${id}`, object: 'subscription', customer, status, metadata: householdId ? { household_id: householdId } : {}, cancel_at_period_end: false, current_period_end: Math.floor(Date.now() / 1000) + 86400, items: { data: [{ price: { id: 'price_x' } }] } } },
});

try {
  // 1. Deletion followed by subscription.deleted (the F-03 loop).
  const del = subEvent('evt_del_1', 'customer.subscription.deleted', { householdId: DELETED, customer: 'cus_old', status: 'canceled' });
  const s1 = await send(del);
  check(s1 === 200, `deleted household: subscription.deleted acknowledged 200 (was 500 → retry loop): ${s1}`);
  check(events.get('evt_del_1').status === 'ignored' && events.get('evt_del_1').error === 'ignored:deleted_household', 'recorded as terminal ignored with the reason');
  check(rpcCalls.length === 0, 'never reached the entitlement RPC (cannot re-entitle a deleted account)');
  check(alerts.length === 0, 'no critical alert for the expected post-deletion event (no alert storm)');
  for (let i = 0; i < 5; i++) await send(del);
  check(events.get('evt_del_1').attempt_count === 1 && rpcCalls.length === 0 && alerts.length === 0, 'Stripe redelivers 5× → idempotent: still one attempt, no RPC, no alert');

  // 2. A LIVE subscription for a deleted household (customer may still pay).
  const live = subEvent('evt_del_live', 'customer.subscription.updated', { householdId: DELETED, customer: 'cus_old', status: 'active' });
  check((await send(live)) === 200 && events.get('evt_del_live').error === 'ignored:deleted_household_subscription_live', 'live subscription for a deleted household → 200, recorded with the LIVE reason');
  check(alerts.includes('stripe_event_for_deleted_household_live_subscription') && rpcCalls.length === 0, '… raises a critical alert and still never re-entitles');
  await send(live);
  check(alerts.filter((a) => a === 'stripe_event_for_deleted_household_live_subscription').length === 1, '… replay does not alert twice');

  // 3. Database unreadable → 500 so Stripe retries; nothing recorded or guessed.
  householdReadFails = true;
  const s3 = await send(subEvent('evt_del_dbdown', 'customer.subscription.deleted', { householdId: DELETED, customer: 'cus_old', status: 'canceled' }));
  householdReadFails = false;
  check(s3 === 500 && !events.has('evt_del_dbdown') && rpcCalls.length === 0, 'household facts unreadable → 500 (Stripe retries), nothing claimed, no RPC');
  check((await send(subEvent('evt_del_dbdown', 'customer.subscription.deleted', { householdId: DELETED, customer: 'cus_old', status: 'canceled' }))) === 200 && events.get('evt_del_dbdown').status === 'ignored', '… and the retry then succeeds');

  // 4. Forged event → rejected before anything.
  check((await send(subEvent('evt_forged', 'customer.subscription.deleted', { householdId: DELETED, customer: 'cus_old', status: 'canceled' }), { forge: true })) === 400 && !events.has('evt_forged'), 'forged signature → 400, nothing recorded');

  // 5. Normal household: unchanged behaviour (processed, entitlement path runs once).
  const ok = subEvent('evt_live_1', 'customer.subscription.deleted', { householdId: LIVE, customer: 'cus_live', status: 'canceled' });
  check((await send(ok)) === 200 && events.get('evt_live_1').status === 'processed' && rpcCalls.length === 1 && provisioning.length === 1, 'normal household: processed through the entitlement RPC exactly as before');
  await send(ok);
  check(rpcCalls.length === 1, 'normal household replay: idempotent (no second RPC)');

  // 6. A genuine customer mismatch on a NON-deleted household still fails loudly (unchanged).
  households.set(LIVE, { ...households.get(LIVE), stripe_customer_id: 'cus_other' });
  check((await send(subEvent('evt_mismatch', 'customer.subscription.updated', { householdId: LIVE, customer: 'cus_live', status: 'active' }))) === 500 && alerts.includes('stripe_webhook_processing_failed'), 'a real mismatch on a live account still fails + alerts (not swallowed by the fix)');

  // 7. Exception queue: the live-subscription case is visible; the benign one is not.
  const { householdExceptions } = require('../services/lifecycle/exceptionQueue');
  const deletedSnap = (extra) => ({ household: households.get(DELETED), entitlements: [], quarantineRows: [], failedStripeEvents: [], ...extra });
  const codes = (r) => r.items.map((i) => i.code);
  const liveItems = householdExceptions(deletedSnap({ liveSubscriptionEventsAfterDeletion: [{ stripe_event_id: 'evt_del_live', event_type: 'customer.subscription.updated', processed_at: new Date().toISOString() }] }), new Date());
  check(codes(liveItems).includes('DELETED_HOUSEHOLD_SUBSCRIPTION_LIVE'), 'exception queue shows DELETED_HOUSEHOLD_SUBSCRIPTION_LIVE (ops action)');
  check(!codes(householdExceptions(deletedSnap({}), new Date())).some((c) => /STRIPE|SUBSCRIPTION_LIVE/.test(c)), 'a benign ignored post-deletion event creates no queue noise');
} finally {
  server.close();
}
console.log(failures === 0 ? '\nF-03 deletion loop: all checks hold.' : `\n${failures} check(s) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
