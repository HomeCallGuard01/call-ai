// Money ↔ entitlement ↔ classification reconciliation (report-only).
//
// Accounting never grants or revokes access. These checks raise
// conflicting_entitlement exceptions so a person can look:
//
//   paid_without_entitlement   production sale, no paid entitlement for that
//                              household from that channel while it was paid for
//   entitled_without_payment   active paid entitlement (production) with no sale
//                              on its channel inside the lookback window
//   parallel_paid_channels     the household paid on two channels for
//                              overlapping periods (customer double-billed)
//   internal_account_payment   internal_test/admin/reviewer/qa account paid real money
//   complimentary_with_payment complimentary/partner/staff entitlement still
//                              active although the household is paying
//
// Exception keys are deterministic, so running this daily never duplicates;
// a condition that disappears is auto-resolved.

'use strict';

const { CHANNELS, KINDS, EXCEPTION_TYPES, EXCEPTION_SEVERITY } = require('./constants');

const DAY = 86400000;
const ENTITLEMENT_SOURCE_CHANNEL = Object.freeze({ stripe: CHANNELS.STRIPE, apple_revenuecat: CHANNELS.APP_STORE });
const CHANNEL_ENTITLEMENT_SOURCE = Object.freeze({ [CHANNELS.STRIPE]: 'stripe', [CHANNELS.APP_STORE]: 'apple_revenuecat' });
const COMP_TYPES = new Set(['complimentary', 'partner', 'staff', 'promotion', 'founding_offer', 'free_trial']);
const INTERNAL = new Set(['internal_test', 'admin', 'reviewer', 'qa_automation', 'other_non_customer']);

const ms = (v) => (v ? Date.parse(v) : NaN);

function findConflicts({ transactions, entitlements, classifications = {}, now, lookbackDays = 35, graceDays = 3 }) {
  const t = now.getTime();
  const conflicts = [];
  const sales = transactions.filter((x) => x.environment === 'production' && x.kind === KINDS.SALE && x.product === 'subscription');
  const refundedIds = new Set(transactions.filter((x) => x.kind === KINDS.REFUND || x.kind === KINDS.CHARGEBACK).map((x) => x.original_transaction_id).filter(Boolean));
  const live = sales.filter((s) => !refundedIds.has(s.id));
  const prodEntitlements = entitlements.filter((e) => e.revenuecat_environment !== 'sandbox');

  for (const s of live) {
    if (!s.household_id) continue; // unmatched_payment already covers it
    const paidAt = ms(s.occurred_at);
    if (t - paidAt > lookbackDays * DAY) continue;
    const source = CHANNEL_ENTITLEMENT_SOURCE[s.channel];
    const covering = prodEntitlements.find((e) => e.household_id === s.household_id && e.entitlement_type === 'paid_subscription' && e.source === source
      && ms(e.starts_at) <= paidAt + graceDays * DAY && (!e.ends_at || ms(e.ends_at) >= paidAt));
    if (!covering) conflicts.push({ rule: 'paid_without_entitlement', subject: s.economic_key, transaction: s, detail: { channel: s.channel, paid_at: s.occurred_at } });
    const cls = classifications[s.household_id];
    if (cls && INTERNAL.has(cls)) conflicts.push({ rule: 'internal_account_payment', subject: s.economic_key, transaction: s, detail: { classification: cls } });
  }

  for (const e of prodEntitlements) {
    if (e.status !== 'active' || e.entitlement_type !== 'paid_subscription') continue;
    const channel = ENTITLEMENT_SOURCE_CHANNEL[e.source];
    if (!channel) continue;
    if (t - ms(e.starts_at) < graceDays * DAY) continue; // the first payment may still be in flight
    const recent = live.some((s) => s.household_id === e.household_id && s.channel === channel && t - ms(s.occurred_at) <= lookbackDays * DAY);
    if (!recent) conflicts.push({ rule: 'entitled_without_payment', subject: `${e.household_id}:${e.source}`, householdId: e.household_id, detail: { entitlement_id: e.id, source: e.source, starts_at: e.starts_at, ends_at: e.ends_at } });
  }

  const byHousehold = new Map();
  for (const s of live) {
    if (!s.household_id) continue;
    if (!byHousehold.has(s.household_id)) byHousehold.set(s.household_id, []);
    byHousehold.get(s.household_id).push(s);
  }
  for (const [householdId, list] of byHousehold) {
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const a = list[i]; const b = list[j];
        if (a.channel === b.channel) continue;
        const aEnd = ms(a.service_period_end) || ms(a.occurred_at) + 30 * DAY;
        const bEnd = ms(b.service_period_end) || ms(b.occurred_at) + 30 * DAY;
        const aStart = ms(a.service_period_start) || ms(a.occurred_at);
        const bStart = ms(b.service_period_start) || ms(b.occurred_at);
        if (aStart < bEnd && bStart < aEnd) {
          const [x, y] = [a.economic_key, b.economic_key].sort();
          conflicts.push({ rule: 'parallel_paid_channels', subject: `${x}|${y}`, householdId, detail: { transactions: [x, y] } });
        }
      }
    }
    const comp = prodEntitlements.find((e) => e.household_id === householdId && e.status === 'active' && COMP_TYPES.has(e.entitlement_type)
      && (!e.ends_at || ms(e.ends_at) > t));
    const recentPaid = list.some((s) => t - ms(s.occurred_at) <= lookbackDays * DAY);
    if (comp && recentPaid) conflicts.push({ rule: 'complimentary_with_payment', subject: `${householdId}:${comp.id}`, householdId, detail: { entitlement_id: comp.id, entitlement_type: comp.entitlement_type } });
  }
  return conflicts;
}

async function runEntitlementReconciliation({ store, loadEntitlements, loadClassifications = async () => ({}), now = new Date(), lookbackDays, graceDays }) {
  const transactions = await store.listTransactions({});
  const entitlements = await loadEntitlements();
  const classifications = await loadClassifications();
  const conflicts = findConflicts({ transactions, entitlements, classifications, now, lookbackDays, graceDays });
  const current = new Set();
  for (const c of conflicts) {
    const key = `${EXCEPTION_TYPES.CONFLICTING_ENTITLEMENT}:${c.rule}:${c.subject}`;
    current.add(key);
    await store.raiseException({
      exception_key: key, type: EXCEPTION_TYPES.CONFLICTING_ENTITLEMENT, severity: EXCEPTION_SEVERITY[EXCEPTION_TYPES.CONFLICTING_ENTITLEMENT],
      transaction_id: c.transaction ? c.transaction.id : null,
      household_id: c.transaction ? c.transaction.household_id : c.householdId,
      account_number: c.transaction ? c.transaction.account_number : null,
      detail: { rule: c.rule, ...c.detail },
    });
  }
  for (const ex of await store.listExceptions({ type: EXCEPTION_TYPES.CONFLICTING_ENTITLEMENT, status: 'open' })) {
    if (!current.has(ex.exception_key)) {
      await store.resolveException(ex.exception_key, { status: 'auto_resolved', resolved_by: 'system:accounting', resolution_note: 'condition no longer present' });
    }
  }
  return { conflicts: conflicts.length, rules: conflicts.reduce((m, c) => ({ ...m, [c.rule]: (m[c.rule] || 0) + 1 }), {}) };
}

module.exports = { findConflicts, runEntitlementReconciliation };
