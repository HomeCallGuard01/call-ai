// Apple / RevenueCat subscription lifecycle (migration 073, launch sprint
// 2026-10-05): CANCELLATION / BILLING_ISSUE / UNCANCELLATION / recovery are
// recorded on the right entitlement, never cut access early, never cross the
// sandbox/production boundary, and reach the membership read model.
//
// Run with: node tests/apple-store-lifecycle.test.mjs

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'x';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'x';

const { deriveStoreStatePatch, isNewerThanRecorded } = require('../services/storeSubscriptionState.js');
const { applyRevenueCatStoreState } = require('../database/billing.js');
const { deriveMembershipStatus } = require('../services/membershipStatus.js');
const { classifyHouseholdForBusiness } = require('../services/businessControl/definitions.js');

let failures = 0;
const check = (c, m) => { if (c) console.log(`✓ ${m}`); else { console.error(`✗ ${m}`); failures++; } };

const T0 = Date.parse('2026-10-05T09:00:00Z');
const ev = (type, o = {}) => ({ type, event_timestamp_ms: T0, original_transaction_id: 'tx_prod', environment: 'PRODUCTION', ...o });

// ── 1. Event → state (pure) ─────────────────────────────────────────────
{
  const c = deriveStoreStatePatch(ev('CANCELLATION', { cancel_reason: 'UNSUBSCRIBE' }));
  check(c.kind === 'cancellation' && c.patch.store_will_renew === false && c.patch.store_cancel_reason === 'UNSUBSCRIBE' && !('store_refunded_at' in c.patch), 'CANCELLATION → will not renew (+ reason), not a refund');
  const r = deriveStoreStatePatch(ev('CANCELLATION', { cancel_reason: 'CUSTOMER_SUPPORT' }));
  check(r.kind === 'refund' && r.patch.store_refunded_at === new Date(T0).toISOString() && r.patch.store_will_renew === false, 'CANCELLATION + CUSTOMER_SUPPORT → refund recorded');
  const b = deriveStoreStatePatch(ev('BILLING_ISSUE', { grace_period_expiration_at_ms: T0 + 16 * 864e5 }));
  check(b.kind === 'billing_issue' && b.patch.store_billing_issue_at === new Date(T0).toISOString() && b.patch.store_grace_period_expires_at === new Date(T0 + 16 * 864e5).toISOString(), 'BILLING_ISSUE → billing problem + grace period end');
  check(deriveStoreStatePatch(ev('BILLING_ISSUE')).patch.store_grace_period_expires_at === null, 'BILLING_ISSUE without a grace period → null, never guessed');
  const u = deriveStoreStatePatch(ev('UNCANCELLATION'));
  check(u.patch.store_will_renew === true && u.patch.store_cancel_reason === null, 'UNCANCELLATION → will renew again');
  for (const t of ['RENEWAL', 'INITIAL_PURCHASE']) {
    const x = deriveStoreStatePatch(ev(t));
    check(x.kind === 'recovery' && x.patch.store_billing_issue_at === null && x.patch.store_will_renew === true, `${t} → recovery (billing problem cleared)`);
  }
  for (const t of ['EXPIRATION', 'PRODUCT_CHANGE', 'TRANSFER', 'TEST', 'NON_RENEWING_PURCHASE', 'SOMETHING_NEW']) {
    check(deriveStoreStatePatch(ev(t)) === null, `${t} → nothing recorded`);
  }
  check(deriveStoreStatePatch(ev('CANCELLATION', { event_timestamp_ms: undefined })) === null, 'no event timestamp → nothing recorded (order never guessed)');
  check(deriveStoreStatePatch(ev('CANCELLATION', { cancel_reason: 'weird reason!' })).patch.store_cancel_reason === 'UNKNOWN', 'unrecognised cancel reason → UNKNOWN (fits the 073 CHECK)');
  const all = ['CANCELLATION', 'BILLING_ISSUE', 'UNCANCELLATION', 'RENEWAL', 'INITIAL_PURCHASE'].map((t) => deriveStoreStatePatch(ev(t, { cancel_reason: 'UNSUBSCRIBE' })).patch);
  check(all.every((p) => !('status' in p) && !('ends_at' in p) && !('entitlement_type' in p)), 'no lifecycle event can change status, ends_at or entitlement type (access is never cut here)');
  check(isNewerThanRecorded('2026-10-05T10:00:00Z', null) && isNewerThanRecorded('2026-10-05T10:00:00Z', '2026-10-05T09:00:00Z') && !isNewerThanRecorded('2026-10-05T09:00:00Z', '2026-10-05T09:00:00Z') && !isNewerThanRecorded('2026-10-05T08:00:00Z', '2026-10-05T09:00:00Z'), 'ordering guard: strictly newer only (replays and older events ignored)');
}

// ── 2. Applying state to the right row (fake PostgREST honouring filters) ─
function fakeClient(rows, { missingColumns = false } = {}) {
  const updates = [];
  const client = {
    updates,
    from(table) {
      const filters = [];
      let mode = 'select';
      let patch = null;
      const q = {
        select() { if (missingColumns) { q._err = { code: '42703', message: 'column entitlements.store_state_event_at does not exist' }; } return q; },
        update(p) { mode = 'update'; patch = p; return q; },
        eq(col, val) { filters.push([col, val]); return q; },
        order() { return q; },
        limit() { return q; },
        then(resolve) {
          if (q._err) return resolve({ data: null, error: q._err });
          const match = rows.filter((r) => filters.every(([c, v]) => r[c] === v));
          if (mode === 'update') { for (const r of match) { Object.assign(r, patch); updates.push({ id: r.id, patch }); } return resolve({ data: null, error: null }); }
          return resolve({ data: match.map((r) => ({ ...r })), error: null });
        },
      };
      return q;
    },
  };
  return client;
}
const HH = 'hh-1';
const baseRows = () => [
  { id: 'prod', household_id: HH, source: 'apple_revenuecat', external_reference: 'tx_prod', revenuecat_environment: 'production', status: 'active', ends_at: '2026-11-01T00:00:00Z', store_state_event_at: null },
  { id: 'sbx', household_id: HH, source: 'apple_revenuecat', external_reference: 'tx_prod', revenuecat_environment: 'sandbox', status: 'expired', ends_at: '2026-09-01T00:00:00Z', store_state_event_at: null },
  { id: 'stripe', household_id: HH, source: 'stripe', external_reference: 'tx_prod', revenuecat_environment: null, status: 'active', ends_at: null, store_state_event_at: null },
];
{
  const rows = baseRows();
  const client = fakeClient(rows);
  const cancel = deriveStoreStatePatch(ev('CANCELLATION', { cancel_reason: 'UNSUBSCRIBE' }));
  const r1 = await applyRevenueCatStoreState(HH, { originalTransactionId: 'tx_prod', environment: 'production', eventAt: cancel.eventAt, patch: cancel.patch }, { client });
  const prod = rows.find((r) => r.id === 'prod');
  check(r1.applied && prod.store_will_renew === false && prod.store_state_event_at === cancel.eventAt, 'production CANCELLATION recorded on the production Apple row');
  check(prod.status === 'active' && prod.ends_at === '2026-11-01T00:00:00Z', 'access unchanged: still active to the paid-through date');
  check(rows.find((r) => r.id === 'sbx').store_will_renew === undefined && rows.find((r) => r.id === 'stripe').store_will_renew === undefined, 'sandbox row and Stripe row untouched');

  const sbxEvent = deriveStoreStatePatch(ev('BILLING_ISSUE', { event_timestamp_ms: T0 + 1000 }));
  await applyRevenueCatStoreState(HH, { originalTransactionId: 'tx_prod', environment: 'sandbox', eventAt: sbxEvent.eventAt, patch: sbxEvent.patch }, { client });
  check(!prod.store_billing_issue_at, 'a SANDBOX event never alters the production entitlement');

  const older = deriveStoreStatePatch(ev('UNCANCELLATION', { event_timestamp_ms: T0 - 60000 }));
  const r2 = await applyRevenueCatStoreState(HH, { originalTransactionId: 'tx_prod', environment: 'production', eventAt: older.eventAt, patch: older.patch }, { client });
  check(!r2.applied && r2.reason === 'older_or_replayed_event' && prod.store_will_renew === false, 'an older (out-of-order) UNCANCELLATION is ignored');
  const replay = await applyRevenueCatStoreState(HH, { originalTransactionId: 'tx_prod', environment: 'production', eventAt: cancel.eventAt, patch: cancel.patch }, { client });
  check(!replay.applied && replay.reason === 'older_or_replayed_event', 'a replayed event is ignored (idempotent)');

  const bill = deriveStoreStatePatch(ev('BILLING_ISSUE', { event_timestamp_ms: T0 + 5000 }));
  await applyRevenueCatStoreState(HH, { originalTransactionId: 'tx_prod', environment: 'production', eventAt: bill.eventAt, patch: bill.patch }, { client });
  const rec = deriveStoreStatePatch(ev('RENEWAL', { event_timestamp_ms: T0 + 9000 }));
  await applyRevenueCatStoreState(HH, { originalTransactionId: 'tx_prod', environment: 'production', eventAt: rec.eventAt, patch: rec.patch }, { client });
  check(prod.store_billing_issue_at === null && prod.store_will_renew === true, 'BILLING_ISSUE then RENEWAL → problem cleared, will renew');

  const none = await applyRevenueCatStoreState(HH, { originalTransactionId: 'tx_other', environment: 'production', eventAt: rec.eventAt, patch: rec.patch }, { client });
  check(!none.applied && none.reason === 'no_matching_entitlement', 'unknown transaction → nothing written');
  check(client.updates.every((u) => !('status' in u.patch) && !('ends_at' in u.patch)), 'no write ever touched status or ends_at');

  const pre073 = await applyRevenueCatStoreState(HH, { originalTransactionId: 'tx_prod', environment: 'production', eventAt: rec.eventAt, patch: rec.patch }, { client: fakeClient(baseRows(), { missingColumns: true }) });
  check(!pre073.applied && pre073.reason === 'store_state_columns_missing', 'before 073 is applied: nothing written, no error (webhook behaves as before)');
}

// ── 3. Membership read model ────────────────────────────────────────────
{
  const legacy = ({ entitlement, subscription }) => {
    let status = 'active';
    if (entitlement.entitlement_type === 'free_trial') status = 'trial';
    else if (subscription && subscription.status === 'past_due') status = 'payment_issue';
    else if (subscription && subscription.cancel_at_period_end) status = 'cancelled';
    return { status, nextBillingDate: subscription && !subscription.cancel_at_period_end ? subscription.current_period_end : null, accessUntil: subscription ? subscription.current_period_end : null };
  };
  const ents = [{ entitlement_type: 'paid_subscription', source: 'stripe' }, { entitlement_type: 'free_trial', source: 'stripe' }, { entitlement_type: 'complimentary', source: 'admin_manual' }];
  const subs = [null, { status: 'active', cancel_at_period_end: false, current_period_end: 'P' }, { status: 'active', cancel_at_period_end: true, current_period_end: 'P' }, { status: 'past_due', cancel_at_period_end: false, current_period_end: 'P' }, { status: 'past_due', cancel_at_period_end: true, current_period_end: 'P' }];
  let same = true;
  for (const e of ents) for (const s of subs) { if (JSON.stringify(deriveMembershipStatus({ entitlement: e, subscription: s })) !== JSON.stringify(legacy({ entitlement: e, subscription: s }))) same = false; }
  check(same, 'Stripe/complimentary/trial: identical to the previous inline derivation (15 combinations)');

  const apple = (o = {}) => ({ entitlement_type: 'paid_subscription', source: 'apple_revenuecat', ends_at: '2026-11-01T00:00:00Z', ...o });
  check(deriveMembershipStatus({ entitlement: apple(), subscription: null }).status === 'active' && deriveMembershipStatus({ entitlement: apple(), subscription: null }).nextBillingDate === null, 'Apple, no store state (or 073 not applied) → active, no invented billing date');
  const cancelled = deriveMembershipStatus({ entitlement: apple({ store_will_renew: false }), subscription: null });
  check(cancelled.status === 'cancelled' && cancelled.accessUntil === '2026-11-01T00:00:00Z', 'Apple auto-renew off → "cancelled", protection continues until ends_at');
  check(deriveMembershipStatus({ entitlement: apple({ store_billing_issue_at: '2026-10-05T09:00:00Z' }), subscription: null }).status === 'payment_issue', 'Apple billing problem → "payment_issue"');
  check(deriveMembershipStatus({ entitlement: apple({ store_billing_issue_at: '2026-10-05T09:00:00Z', store_will_renew: false }), subscription: null }).status === 'payment_issue', 'billing problem outranks cancellation (the actionable state is shown)');
  check(deriveMembershipStatus({ entitlement: apple({ store_will_renew: false }), subscription: { status: 'active', cancel_at_period_end: false, current_period_end: 'P' } }).status === 'cancelled', 'Apple membership ignores a stale Stripe subscription row');
}

// ── 4. Admin vocabulary ─────────────────────────────────────────────────
{
  const NOW = new Date('2026-10-05T12:00:00Z');
  const ent = (o) => ({ entitlement_type: 'paid_subscription', source: 'apple_revenuecat', revenuecat_environment: 'production', status: 'active', starts_at: '2026-10-01T00:00:00Z', ends_at: '2026-11-01T00:00:00Z', updated_at: '2026-10-05T09:00:00Z', ...o });
  const run = (o) => classifyHouseholdForBusiness({ household: { id: 'h', email: 'h@x' }, entitlements: [ent(o)], subscriptions: [], classification: null }, NOW);
  check(run({ store_will_renew: false }).cancellingAtPeriodEnd === true && run({ store_will_renew: false }).membership === 'current', 'admin: Apple cancelled → "cancelling at period end", still a current member');
  check(run({ store_billing_issue_at: '2026-10-05T09:00:00Z' }).paymentIssue === true, 'admin: Apple billing problem → payment issue');
  check(run({ store_refunded_at: '2026-10-05T09:00:00Z', store_will_renew: false }).storeRefunded === true, 'admin: Apple refund flagged');
  check(run({}).cancellingAtPeriodEnd === false && run({}).paymentIssue === false, 'admin: Apple with no store state → neither flag (as before 073)');
}

// ── 5. Webhook wiring (source) ──────────────────────────────────────────
{
  const src = readFileSync(path.join(__dirname, '..', 'routes', 'mobileApi.js'), 'utf8');
  const tail = src.slice(src.indexOf('// CANCELLATION, BILLING_ISSUE, TEST, and anything else RevenueCat'));
  check(/const storeState = deriveStoreStatePatch\(event\);/.test(tail) && /applyRevenueCatStoreState\(household\.id/.test(tail), 'webhook: CANCELLATION / BILLING_ISSUE are recorded via applyRevenueCatStoreState');
  check(/resolveEventIsSandbox\(event\) \? "sandbox" : "production"/.test(tail), 'webhook: the environment is derived with the fail-closed sandbox resolver');
  check(!/expireEntitlementFromRevenueCat|updateTwilioNumberForEntitlementChange/.test(tail.slice(0, tail.indexOf('return res.json({ ok: true, action: "acknowledged_no_change" });'))), 'webhook: the lifecycle branch never revokes access or touches Twilio provisioning');
  check(/revenuecat_refund_recorded/.test(tail), 'webhook: an Apple refund raises a support alert (no automatic cut-off)');
  const grant = src.slice(src.indexOf('const recoveryState = deriveStoreStatePatch(event);'));
  check(/\.catch\(err => console\.error\("REVENUECAT WEBHOOK: store state \(recovery\) not recorded:"/.test(grant), 'webhook: recovery recording after a grant is best-effort and cannot change the grant result');
}

console.log(failures === 0 ? '\nApple store lifecycle (073): all checks hold.' : `\n${failures} check(s) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
