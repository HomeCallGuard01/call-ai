// Shared accounting scenarios. Run against the in-memory reference store
// (tests/accounting-engine.test.mjs) AND the SQL store on PGlite
// (tests/accounting-store-parity.pglite.test.mjs) so both implement the same
// idempotency, replay and exception semantics.
import { createRequire } from 'node:module';
import {
  H1, H2, H3, HNOACCT, AUTH1, AUTH2, invoicePaid, chargeRefunded, dispute, stripeEvent, topupSession, rc,
  directoryResolver, defaultDirectory, policyWith, fixedClock,
} from './accountingFixtures.mjs';

const require = createRequire(import.meta.url);
const { createAccountingEngine } = require('../../services/accounting/engine.js');
const { createPostingQueue } = require('../../services/accounting/postingQueue.js');
const { createSettlementReconciler } = require('../../services/accounting/settlement.js');
const { runEntitlementReconciliation } = require('../../services/accounting/reconciliation.js');
const { createMockXero } = require('../../services/accounting/xero/mockXero.js');

export async function runAccountingScenarios({ newStore, check, only = null }) {
  const scenarios = [];
  const scenario = (name, fn) => scenarios.push({ name, fn });

  function setup(store, { policy = policyWith(), xeroOpts = {}, storeRevenueBasis = 'net_proceeds' } = {}) {
    const clock = fixedClock();
    const dir = defaultDirectory();
    const xero = createMockXero(xeroOpts);
    const engine = createAccountingEngine({ store, resolver: directoryResolver(dir), policy, now: clock });
    const queue = createPostingQueue({ store, xero, policy, now: clock, storeRevenueBasis });
    const settle = createSettlementReconciler({ store, now: clock });
    return { store, engine, queue, xero, clock, dir, policy, settle };
  }
  const openOf = async (store, type) => (await store.listExceptions({ status: 'open' })).filter((e) => !type || e.type === type);
  const drain = async (ctx, rounds = 12) => {
    for (let i = 0; i < rounds; i += 1) { await ctx.queue.processDue({ limit: 50 }); ctx.clock.advance(7 * 3600); }
  };

  // ── 1. Duplicate Stripe webhook ────────────────────────────────────────
  scenario('duplicate Stripe webhook', async (store) => {
    const c = setup(store);
    const ev = invoicePaid({ eventId: 'evt_1', invoice: 'in_1' });
    const a = await c.engine.ingestStripeEvent(ev);
    const b = await c.engine.ingestStripeEvent(ev);
    check(a.outcome === 'recorded', 'first delivery recorded');
    check(b.outcome === 'duplicate_event', 'redelivery of the same Stripe event is a no-op');
    const txs = await store.listTransactions({});
    check(txs.length === 1 && txs[0].status === 'ready', 'exactly one transaction, ready to post');
    check(txs[0].account_number === 'HCG-00010017', 'transaction carries the permanent HCG account number');
    check(txs[0].gross_minor === 499 && txs[0].tax_minor === 83 && txs[0].net_minor === 416, 'gross 4.99 / VAT 0.83 / net 4.16 from Stripe');
    await drain(c);
    check(c.xero.count('Invoices') === 1 && c.xero.count('Payments') === 1, 'one Xero invoice and one payment');
    const inv = c.xero.documents.find((d) => d.endpoint === 'Invoices');
    check(inv.body.Contact.Name === 'HCG-00010017' && inv.body.Reference.startsWith('HCG-00010017 '), 'Xero contact and reference are the HCG account number');
    check(inv.body.LineAmountTypes === 'Inclusive' && inv.body.LineItems[0].UnitAmount === 4.99 && inv.body.LineItems[0].TaxAmount === 0.83, 'invoice line is VAT-inclusive 4.99 with Stripe VAT 0.83');
    const pay = c.xero.documents.find((d) => d.endpoint === 'Payments');
    check(pay.body.Invoice.InvoiceID === inv.id, 'payment is bound to the invoice');
    const tx = (await store.listTransactions({}))[0];
    check(tx.status === 'posted' && tx.xero_document_ids.invoice === inv.id, 'transaction marked posted with Xero ids');
    await c.engine.ingestStripeEvent(ev);
    await drain(c);
    check(c.xero.count() === 2, 'a third delivery after posting creates nothing in Xero');
  });

  scenario('same Stripe money, different event id', async (store) => {
    const c = setup(store);
    await c.engine.ingestStripeEvent(invoicePaid({ eventId: 'evt_a', invoice: 'in_2' }));
    const r = await c.engine.ingestStripeEvent(invoicePaid({ eventId: 'evt_b', invoice: 'in_2' }));
    check(r.outcome === 'duplicate_economic', 'second event for the same invoice is duplicate_economic');
    check((await store.listTransactions({})).length === 1, 'still one transaction');
    check((await openOf(store, 'duplicate')).length === 0, 'identical content raises no duplicate exception');
  });

  scenario('conflicting duplicate is held for review', async (store) => {
    const c = setup(store);
    await c.engine.ingestStripeEvent(invoicePaid({ eventId: 'evt_c1', invoice: 'in_3' }));
    await c.engine.ingestStripeEvent(invoicePaid({ eventId: 'evt_c2', invoice: 'in_3', amount: 999, tax: 167 }));
    const ex = await openOf(store, 'duplicate');
    check(ex.length === 1 && ex[0].detail.kept_gross_minor === 499, 'duplicate exception raised; first record kept');
    const tx = (await store.listTransactions({}))[0];
    check(tx.status === 'blocked' && tx.gross_minor === 499, 'transaction blocked and unchanged');
    await drain(c);
    check(c.xero.count() === 0, 'nothing posted while the duplicate is unreviewed');
    await store.resolveException(ex[0].exception_key, { status: 'resolved', resolved_by: 'admin:test', resolution_note: 'second event was a test resend' });
    await c.engine.reevaluate();
    await drain(c);
    check(c.xero.count('Invoices') === 1, 'after human review it posts exactly once');
  });

  // ── 2. RevenueCat duplicates and Apple ↔ accounting ─────────────────────
  scenario('duplicate RevenueCat event', async (store) => {
    const c = setup(store);
    const e = rc({ id: 'rc_1', type: 'INITIAL_PURCHASE', transaction_id: 'atx_1' });
    const a = await c.engine.ingestRevenueCatEvent(e);
    const b = await c.engine.ingestRevenueCatEvent(e);
    const d = await c.engine.ingestRevenueCatEvent(rc({ id: 'rc_1_resent_with_new_id', type: 'INITIAL_PURCHASE', transaction_id: 'atx_1' }));
    check(a.outcome === 'recorded' && b.outcome === 'duplicate_event' && d.outcome === 'duplicate_economic', 'RC redelivery and replay-with-new-id are both no-ops');
    const txs = await store.listTransactions({});
    check(txs.length === 1 && txs[0].channel === 'app_store' && txs[0].status === 'subledger_only', 'one App Store sub-ledger transaction');
    check(txs[0].amount_quality === 'estimated' && txs[0].gross_minor === 499 && txs[0].tax_minor === 83 && txs[0].fee_minor === 62 && txs[0].proceeds_minor === 354, 'RevenueCat amounts kept as estimates (price, VAT, commission, proceeds)');
    check(txs[0].household_id === H1, 'RC app_user_id resolved to the household');
    await drain(c);
    check(c.xero.count() === 0, 'store transactions are never posted individually');
  });

  scenario('Apple/RevenueCat + Stripe: no double counting', async (store) => {
    const c = setup(store);
    await c.engine.ingestRevenueCatEvent(rc({ id: 'rc_s1', type: 'INITIAL_PURCHASE', transaction_id: 'atx_s1', app_user_id: AUTH2 }));
    const sup = await c.engine.ingestRevenueCatEvent(rc({ id: 'rc_stripe', type: 'RENEWAL', store: 'STRIPE', transaction_id: 'in_s1', app_user_id: AUTH1 }));
    await c.engine.ingestStripeEvent(invoicePaid({ eventId: 'evt_s1', invoice: 'in_s1' }));
    check(sup.outcome === 'superseded_by_primary', 'RevenueCat event for a Stripe purchase is superseded (Stripe webhook is authoritative)');
    const txs = await store.listTransactions({});
    check(txs.length === 2, 'two real payments → exactly two accounting transactions');
    check(txs.filter((t) => t.channel === 'stripe').length === 1 && txs.filter((t) => t.channel === 'app_store').length === 1, 'one per channel');
  });

  // ── 3. Refunds, out-of-order, chargebacks ───────────────────────────────
  scenario('Stripe refund (full, partial, over-refund)', async (store) => {
    const c = setup(store);
    await c.engine.ingestStripeEvent(invoicePaid({ eventId: 'evt_r0', invoice: 'in_r' }));
    await c.engine.ingestStripeEvent(chargeRefunded({ eventId: 'evt_r1', invoice: 'in_r', refunds: [{ id: 're_1', amount: 200 }] }));
    let refund = await store.findTransactionByKey('stripe:refund:re_1');
    const sale = await store.findTransactionByKey('stripe:sale:invoice:in_r');
    check(refund && refund.original_transaction_id === sale.id, 'refund linked to its original sale');
    check(refund.tax_minor === 33 && refund.tax_source === 'pro_rata_from_original', 'partial refund VAT pro rata from Stripe VAT (83 × 200/499 = 33)');
    check(refund.account_number === 'HCG-00010017' && refund.status === 'ready', 'refund inherits the account and is ready');
    // Stripe resends charge.refunded with the cumulative refund list.
    await c.engine.ingestStripeEvent(chargeRefunded({ eventId: 'evt_r2', invoice: 'in_r', refunds: [{ id: 're_1', amount: 200 }, { id: 're_2', amount: 299 }] }));
    check((await store.listTransactions({})).filter((t) => t.kind === 'refund').length === 2, 'cumulative refund list does not duplicate re_1');
    await c.engine.ingestStripeEvent(chargeRefunded({ eventId: 'evt_r3', invoice: 'in_r', refunds: [{ id: 're_3', amount: 100 }] }));
    const mism = (await openOf(store, 'refund_mismatch')).find((e) => e.detail.reason === 'refunds_exceed_original');
    check(!!mism, 'refunds exceeding the original raise refund_mismatch');
    check((await store.findTransactionByKey('stripe:refund:re_3')).status === 'blocked', 'the over-refund is blocked');
    await c.engine.ingestStripeEvent(chargeRefunded({ eventId: 'evt_r4', invoice: 'in_r', refunds: [{ id: 're_pending', amount: 50, status: 'pending' }] }));
    check(!(await store.findTransactionByKey('stripe:refund:re_pending')), 'a pending refund moves no money and is not recorded');
    await drain(c);
    check(c.xero.count('CreditNotes') === 2 && c.xero.count('Invoices') === 1, 'two credit notes + one invoice in Xero');
    refund = await store.findTransactionByKey('stripe:refund:re_1');
    const cn = c.xero.documents.find((d) => d.endpoint === 'CreditNotes' && d.body.Reference.includes('re_1'));
    check(cn.body.Type === 'ACCRECCREDIT' && cn.body.LineItems[0].UnitAmount === 2 && refund.status === 'posted', 'refund posted as ACCRECCREDIT credit note £2.00');
  });

  scenario('refund before sale (out of order)', async (store) => {
    const c = setup(store);
    await c.engine.ingestStripeEvent(chargeRefunded({ eventId: 'evt_o1', invoice: 'in_o', refunds: [{ id: 're_o', amount: 499 }] }));
    let refund = await store.findTransactionByKey('stripe:refund:re_o');
    check(refund.status === 'blocked' && refund.blocked_reasons.includes('original_not_found'), 'orphan refund blocked');
    check((await openOf(store, 'refund_mismatch')).length === 1, 'refund_mismatch exception open');
    await c.engine.ingestStripeEvent(invoicePaid({ eventId: 'evt_o0', invoice: 'in_o' }));
    refund = await store.findTransactionByKey('stripe:refund:re_o');
    check(refund.status === 'ready' && !!refund.original_transaction_id, 'sale arrival relinks the refund');
    check((await openOf(store, 'refund_mismatch')).length === 0, 'refund_mismatch auto-resolved');
    check(refund.tax_minor === 83, 'full refund VAT equals the original VAT');
  });

  scenario('RevenueCat (Apple) refund', async (store) => {
    const c = setup(store);
    await c.engine.ingestRevenueCatEvent(rc({ id: 'rc_p', type: 'INITIAL_PURCHASE', transaction_id: 'atx_r' }));
    const r = await c.engine.ingestRevenueCatEvent(rc({ id: 'rc_ref', type: 'CANCELLATION', cancel_reason: 'CUSTOMER_SUPPORT', transaction_id: 'atx_r', price: -4.99 }));
    const refund = await store.findTransactionByKey('app_store:refund:atx_r');
    check(r.outcome === 'recorded' && refund && refund.gross_minor === 499, 'Apple refund recorded (magnitude 4.99)');
    check(refund.original_transaction_id === (await store.findTransactionByKey('app_store:sale:atx_r')).id && refund.status === 'subledger_only', 'linked to the Apple sale, sub-ledger only');
  });

  scenario('chargeback and chargeback reversal', async (store) => {
    const c = setup(store);
    await c.engine.ingestStripeEvent(invoicePaid({ eventId: 'evt_d0', invoice: 'in_d' }));
    await c.engine.ingestStripeEvent(dispute({ eventId: 'evt_d1', id: 'dp_1', invoice: 'in_d' }));
    await c.engine.ingestStripeEvent(stripeEvent('charge.dispute.created', 'evt_d_created', { id: 'dp_1' }));
    const cb = await store.findTransactionByKey('stripe:chargeback:dp_1');
    check(cb && cb.kind === 'chargeback' && cb.fee_minor === 1500 && cb.status === 'ready', 'funds_withdrawn → chargeback with £15 dispute fee; dispute.created is non-economic');
    await c.engine.ingestStripeEvent(dispute({ eventId: 'evt_d2', id: 'dp_1', invoice: 'in_d', reinstated: true }));
    const rev = await store.findTransactionByKey('stripe:chargeback_reversal:dp_1');
    check(rev && rev.original_transaction_id === cb.id && rev.status === 'ready', 'funds_reinstated → reversal linked to the chargeback');
    await drain(c);
    check(c.xero.count('CreditNotes') === 1 && c.xero.count('Invoices') === 2, 'chargeback = credit note, reversal = invoice');
  });

  // ── 4. Non-economic events ──────────────────────────────────────────────
  scenario('cancellation and payment failure are non-economic', async (store) => {
    const c = setup(store);
    const outcomes = [];
    outcomes.push(await c.engine.ingestStripeEvent(stripeEvent('customer.subscription.deleted', 'evt_x1', { id: 'sub_h1', status: 'canceled' })));
    outcomes.push(await c.engine.ingestStripeEvent(stripeEvent('invoice.payment_failed', 'evt_x2', { id: 'in_fail', amount_due: 499 })));
    outcomes.push(await c.engine.ingestStripeEvent(stripeEvent('charge.succeeded', 'evt_x3', { id: 'ch_x', amount: 499 })));
    outcomes.push(await c.engine.ingestRevenueCatEvent(rc({ id: 'rc_x1', type: 'CANCELLATION', cancel_reason: 'UNSUBSCRIBE', transaction_id: 'atx_x' })));
    outcomes.push(await c.engine.ingestRevenueCatEvent(rc({ id: 'rc_x2', type: 'BILLING_ISSUE', transaction_id: 'atx_x' })));
    outcomes.push(await c.engine.ingestRevenueCatEvent(rc({ id: 'rc_x3', type: 'EXPIRATION', transaction_id: 'atx_x' })));
    check(outcomes.every((o) => o.outcome === 'non_economic'), 'cancellations, payment failures, charge.succeeded, expiration: non_economic');
    check((await store.listTransactions({})).length === 0, 'no accounting transaction created');
    const events = await store.listSourceEvents();
    check(events.length === 6 && events.every((e) => e.outcome === 'non_economic'), 'every event still recorded with its outcome (audit trail)');
  });

  // ── 5. Complimentary, sandbox ───────────────────────────────────────────
  scenario('complimentary and zero-amount', async (store) => {
    const c = setup(store);
    const p = await c.engine.ingestRevenueCatEvent(rc({ id: 'rc_promo', type: 'INITIAL_PURCHASE', store: 'PROMOTIONAL', transaction_id: 'promo_1' }));
    const z = await c.engine.ingestStripeEvent(invoicePaid({ eventId: 'evt_zero', invoice: 'in_zero', amount: 0, tax: 0 }));
    const trial = await c.engine.ingestRevenueCatEvent(rc({ id: 'rc_trial', type: 'INITIAL_PURCHASE', transaction_id: 'atx_trial', price: 0, period_type: 'TRIAL' }));
    check(p.outcome === 'complimentary' && z.outcome === 'non_economic' && trial.outcome === 'non_economic', 'promotional grant, £0 invoice and free trial create no revenue');
    check((await store.listTransactions({})).length === 0, 'no transactions');
  });

  scenario('sandbox and test events never become revenue', async (store) => {
    const c = setup(store);
    const s1 = await c.engine.ingestStripeEvent(invoicePaid({ eventId: 'evt_test', invoice: 'in_test', livemode: false }));
    const s2 = await c.engine.ingestRevenueCatEvent(rc({ id: 'rc_sb', type: 'INITIAL_PURCHASE', environment: 'SANDBOX', transaction_id: 'atx_sb' }));
    const s3 = await c.engine.ingestRevenueCatEvent({ event: { id: 'rc_t', type: 'TEST', environment: 'PRODUCTION' } });
    const s4 = await c.engine.ingestRevenueCatEvent(rc({ id: 'rc_noenv', type: 'RENEWAL', environment: null, transaction_id: 'atx_noenv' }));
    check(s1.outcome === 'sandbox' && s2.outcome === 'sandbox' && s4.outcome === 'sandbox', 'Stripe livemode:false, RC SANDBOX and RC missing environment are sandbox');
    check(s3.outcome === 'ignored', 'RevenueCat TEST event ignored');
    check((await store.listTransactions({})).length === 0, 'no transactions');
    await drain(c);
    check(c.xero.count() === 0, 'nothing posted');
  });

  // ── 6. VAT and accountant decisions ─────────────────────────────────────
  scenario('VAT checks', async (store) => {
    const c = setup(store);
    await c.engine.ingestStripeEvent(invoicePaid({ eventId: 'evt_v1', invoice: 'in_v1', taxShape: 'total_tax_amounts', tax: 83 }));
    check((await store.findTransactionByKey('stripe:sale:invoice:in_v1')).status === 'ready', 'newer API total_tax_amounts read; consistent VAT is ready');
    await c.engine.ingestStripeEvent(invoicePaid({ eventId: 'evt_v2', invoice: 'in_v2', tax: 0 }));
    const v2 = await store.findTransactionByKey('stripe:sale:invoice:in_v2');
    const ex = (await openOf(store, 'amount_discrepancy')).find((e) => e.exception_key.includes('in_v2'));
    check(v2.status === 'blocked' && ex && ex.detail.issues[0].code === 'vat_not_calculated', 'zero VAT on a UK charge (pre-2026-09-20 pattern) is blocked for review');
    await c.engine.ingestStripeEvent(invoicePaid({ eventId: 'evt_v3', invoice: 'in_v3', taxShape: 'none' }));
    const v3 = await store.findTransactionByKey('stripe:sale:invoice:in_v3');
    check(v3.tax_minor === null && v3.tax_source === 'missing' && v3.status === 'blocked', 'no VAT reported is unknown (never zero) and blocked');
    await c.engine.ingestStripeEvent(invoicePaid({ eventId: 'evt_v4', invoice: 'in_v4', tax: 50 }));
    check((await store.findTransactionByKey('stripe:sale:invoice:in_v4')).blocked_reasons.includes('vat_check'), 'VAT inconsistent with the 20% inclusive split is flagged');
    await store.resolveException(ex.exception_key, { status: 'resolved', resolved_by: 'admin:test', resolution_note: 'accountant: AD-2 decision recorded' });
    await c.engine.reevaluate();
    check((await store.findTransactionByKey('stripe:sale:invoice:in_v2')).status === 'ready', 'accepted VAT discrepancy lets the provider figure post');
  });

  scenario('unconfirmed accountant decisions block posting', async (store) => {
    const c = setup(store, { policy: policyWith({ confirmed: [] }) });
    await c.engine.ingestStripeEvent(invoicePaid({ eventId: 'evt_u1', invoice: 'in_u1' }));
    await c.engine.ingestStripeEvent(invoicePaid({ eventId: 'evt_u2', invoice: 'in_u2' }));
    const txs = await store.listTransactions({});
    check(txs.every((t) => t.status === 'blocked' && t.blocked_reasons.includes('accountant_decision:AD-1')), 'blocked on AD-1 etc.');
    const ex = await openOf(store, 'tax_treatment_unconfirmed');
    check(ex.length === 6 && ex.every((e) => !e.transaction_id), 'one aggregated exception per decision (not per transaction)');
    await drain(c);
    check(c.xero.count() === 0, 'nothing posted with unconfirmed treatment');
    ['AD-1', 'AD-2', 'AD-5', 'AD-6', 'AD-7', 'AD-10'].forEach((d) => c.policy.confirmed.add(d));
    c.policy.accountCodes = {};
    await c.engine.reevaluate();
    check((await store.listTransactions({})).every((t) => t.blocked_reasons.includes('xero_mapping:missing_account_codes')), 'confirmed but no account codes → still blocked (no default codes)');
    check((await openOf(store, 'tax_treatment_unconfirmed')).map((e) => e.exception_key).join() === 'tax_treatment_unconfirmed:account_codes', 'decision exceptions auto-resolved; account-codes exception open');
    Object.assign(c.policy.accountCodes, policyWith().accountCodes);
    await c.engine.reevaluate();
    await drain(c);
    check(c.xero.count('Invoices') === 2 && (await openOf(store, 'tax_treatment_unconfirmed')).length === 0, 'after confirmation + codes both post; exceptions cleared');
  });

  // ── 7. Accounts ─────────────────────────────────────────────────────────
  scenario('missing account number and unmatched payment', async (store) => {
    const c = setup(store);
    await c.engine.ingestStripeEvent(invoicePaid({ eventId: 'evt_m1', invoice: 'in_m1', household: HNOACCT, customer: 'cus_noacct' }));
    await c.engine.ingestStripeEvent(invoicePaid({ eventId: 'evt_m2', invoice: 'in_m2', household: null, customer: 'cus_unknown' }));
    const m1 = await store.findTransactionByKey('stripe:sale:invoice:in_m1');
    const m2 = await store.findTransactionByKey('stripe:sale:invoice:in_m2');
    check(m1.status === 'blocked' && m1.blocked_reasons.includes('missing_account'), 'household without account number is blocked');
    check(m2.status === 'blocked' && m2.blocked_reasons.includes('unmatched_payment'), 'unknown customer → unmatched_payment');
    check((await openOf(store, 'missing_account')).length === 1 && (await openOf(store, 'unmatched_payment')).length === 1, 'one exception each');
    c.dir.households[HNOACCT].account = 'HCG-00010041';
    c.dir.stripe.cus_unknown = H3;
    await c.engine.reevaluate();
    check((await store.findTransactionByKey('stripe:sale:invoice:in_m1')).account_number === 'HCG-00010041', 'backfilled account number picked up on re-evaluation');
    check((await store.findTransactionByKey('stripe:sale:invoice:in_m2')).household_id === H3, 'later-linked Stripe customer resolves');
    check((await openOf(store, 'missing_account')).length === 0 && (await openOf(store, 'unmatched_payment')).length === 0, 'both exceptions auto-resolved');
    await drain(c);
    check(c.xero.count('Invoices') === 2, 'both post once resolved');
  });

  // ── 8. Multiple channels, entitlement conflicts ─────────────────────────
  scenario('entitlement reconciliation', async (store) => {
    const c = setup(store);
    await c.engine.ingestStripeEvent(invoicePaid({ eventId: 'evt_e1', invoice: 'in_e1', household: H1 }));
    await c.engine.ingestRevenueCatEvent(rc({ id: 'rc_e1', type: 'RENEWAL', transaction_id: 'atx_e1', app_user_id: AUTH1 }));
    await c.engine.ingestStripeEvent(invoicePaid({ eventId: 'evt_e2', invoice: 'in_e2', household: H2, customer: 'cus_h2' }));
    const entitlements = [
      { id: 'e1', household_id: H1, entitlement_type: 'paid_subscription', status: 'active', source: 'stripe', starts_at: '2026-09-01T00:00:00Z', ends_at: null },
      { id: 'e2', household_id: H2, entitlement_type: 'complimentary', status: 'active', source: 'admin_manual', starts_at: '2026-09-01T00:00:00Z', ends_at: '2026-12-01T00:00:00Z' },
      { id: 'e3', household_id: H3, entitlement_type: 'paid_subscription', status: 'active', source: 'stripe', starts_at: '2026-08-01T00:00:00Z', ends_at: null },
      { id: 'e4', household_id: H3, entitlement_type: 'paid_subscription', status: 'active', source: 'apple_revenuecat', revenuecat_environment: 'sandbox', starts_at: '2026-08-01T00:00:00Z', ends_at: null },
    ];
    const result = await runEntitlementReconciliation({ store, loadEntitlements: async () => entitlements, loadClassifications: async () => ({ [H2]: 'internal_test' }), now: c.clock() });
    const rules = (await openOf(store, 'conflicting_entitlement')).map((e) => e.detail.rule).sort();
    check(rules.includes('parallel_paid_channels'), 'H1 paid on Stripe AND Apple for overlapping periods → parallel_paid_channels');
    check(rules.includes('paid_without_entitlement'), 'H1 Apple payment without an Apple entitlement, H2 Stripe payment while complimentary → paid_without_entitlement');
    check(rules.includes('complimentary_with_payment'), 'H2 still complimentary while paying → complimentary_with_payment');
    check(rules.includes('internal_account_payment'), 'H2 is an internal_test account paying real money → flagged');
    check(rules.includes('entitled_without_payment'), 'H3 Stripe entitlement with no payment → entitled_without_payment');
    check(!(await openOf(store, 'conflicting_entitlement')).some((e) => e.detail.entitlement_id === 'e4'), 'sandbox RevenueCat entitlement ignored');
    const before = (await openOf(store, 'conflicting_entitlement')).length;
    await runEntitlementReconciliation({ store, loadEntitlements: async () => entitlements, loadClassifications: async () => ({ [H2]: 'internal_test' }), now: c.clock() });
    check((await openOf(store, 'conflicting_entitlement')).length === before && result.conflicts === before, 'second run raises no duplicate exceptions');
    await runEntitlementReconciliation({ store, loadEntitlements: async () => entitlements.filter((e) => e.id !== 'e3'), loadClassifications: async () => ({ [H2]: 'internal_test' }), now: c.clock() });
    check((await openOf(store, 'conflicting_entitlement')).length === before - 1, 'a cleared condition auto-resolves');
  });

  // ── 9. Xero unavailable / failures / retries ────────────────────────────
  scenario('Xero unavailable then available', async (store) => {
    const c = setup(store);
    await c.engine.ingestStripeEvent(invoicePaid({ eventId: 'evt_x', invoice: 'in_x' }));
    c.xero.setAvailable(false);
    const r = await c.queue.processDue();
    const p = (await store.listPostings({}))[0];
    check(r[0].result === 'xero_unavailable' && p.status === 'pending' && p.attempts === 0, 'unavailable: stays queued, no attempt consumed');
    check((await store.findTransactionByKey('stripe:sale:invoice:in_x')).status === 'ready', 'transaction remains ready');
    check((await openOf(store, 'failed_xero_posting')).length === 0, 'no failure exception for an unavailable connection');
    c.xero.setAvailable(true);
    await drain(c);
    check(c.xero.count('Invoices') === 1 && (await store.listPostings({}))[0].status === 'posted', 'posted once Xero is back');
  });

  scenario('retry after failure never duplicates (idempotency key honoured)', async (store) => {
    const c = setup(store);
    await c.engine.ingestStripeEvent(invoicePaid({ eventId: 'evt_f', invoice: 'in_f' }));
    c.xero.failNext('network');
    let r = await c.queue.processDue();
    check(r[0].result === 'retry' && r[0].attempts === 1, 'network error → retry scheduled');
    c.clock.advance(3600);
    c.xero.failNext('timeout_after_commit');
    r = await c.queue.processDue();
    check(r[0].result === 'retry' && c.xero.count('Invoices') === 1, 'Xero committed the invoice but the response was lost');
    c.clock.advance(3600);
    c.xero.failNext('rate_limit');
    await c.queue.processDue();
    c.clock.advance(3600);
    await drain(c);
    check(c.xero.count('Invoices') === 1 && c.xero.count('Payments') === 1, 'after 3 failures still exactly one invoice + one payment');
    check(c.xero.calls.some((x) => x.op === 'find'), 'retry looked the document up by Reference first');
  });

  scenario('retry after failure never duplicates (no idempotency key support)', async (store) => {
    const c = setup(store, { xeroOpts: { honourIdempotencyKey: false } });
    await c.engine.ingestStripeEvent(invoicePaid({ eventId: 'evt_f2', invoice: 'in_f2' }));
    c.xero.failNext('timeout_after_commit');
    await c.queue.processDue();
    c.clock.advance(3600);
    await drain(c);
    check(c.xero.count('Invoices') === 1, 'find-by-Reference alone prevents a second invoice');
  });

  scenario('rejected posting → exception → manual retry', async (store) => {
    const c = setup(store);
    await c.engine.ingestStripeEvent(invoicePaid({ eventId: 'evt_rej', invoice: 'in_rej' }));
    c.xero.failNext('validation');
    const r = await c.queue.processDue();
    const ex = await openOf(store, 'failed_xero_posting');
    check(r[0].result === 'failed' && ex.length === 1 && ex[0].account_number === 'HCG-00010017', 'validation error → failed + failed_xero_posting with account number');
    check((await store.findTransactionByKey('stripe:sale:invoice:in_rej')).status === 'failed', 'transaction failed');
    await drain(c);
    check(c.xero.count() === 0, 'a failed posting is not retried automatically');
    await c.queue.retryFailed('xero:stripe:sale:invoice:in_rej', { actor: 'admin:test' });
    await drain(c);
    check(c.xero.count('Invoices') === 1 && (await openOf(store, 'failed_xero_posting')).length === 0, 'manual retry posts once and auto-resolves the exception');
  });

  scenario('retries exhausted → failed', async (store) => {
    const c = setup(store);
    await c.engine.ingestStripeEvent(invoicePaid({ eventId: 'evt_ex', invoice: 'in_ex' }));
    c.xero.failNext('server_error', 20);
    await drain(c, 20);
    const p = (await store.listPostings({}))[0];
    check(p.status === 'failed' && p.attempts === 8, 'gives up after 8 attempts');
    check((await openOf(store, 'failed_xero_posting')).length === 1, 'failure exception raised');
  });

  scenario('crash mid-plan resumes without duplicating', async (store) => {
    const c = setup(store);
    await c.engine.ingestStripeEvent(invoicePaid({ eventId: 'evt_cr', invoice: 'in_cr' }));
    // Invoice succeeds, payment step fails: progress is persisted per step.
    const orig = c.xero.createDocument;
    let n = 0;
    c.xero.createDocument = async (args) => { n += 1; if (n === 2) throw Object.assign(new Error('worker crashed'), {}); return orig(args); };
    await c.queue.processDue();
    c.xero.createDocument = orig;
    const p = (await store.listPostings({}))[0];
    check(!!p.completed_steps.invoice && !p.completed_steps.payment, 'invoice step persisted, payment pending');
    c.clock.advance(3600);
    await drain(c);
    check(c.xero.count('Invoices') === 1 && c.xero.count('Payments') === 1, 'resume creates only the missing payment');
  });

  scenario('concurrent workers cannot double-post', async (store) => {
    const c = setup(store);
    await c.engine.ingestStripeEvent(invoicePaid({ eventId: 'evt_cc', invoice: 'in_cc' }));
    const q2 = createPostingQueue({ store, xero: c.xero, policy: c.policy, now: c.clock });
    await Promise.all([c.queue.processDue(), q2.processDue(), c.queue.processDue()]);
    check(c.xero.count('Invoices') === 1, 'leased claim: one invoice despite three concurrent workers');
  });

  // ── 10. Replay / out-of-order: whole event log ──────────────────────────
  scenario('full replay in a different order converges', async (store) => {
    const log = [
      invoicePaid({ eventId: 'evt_l1', invoice: 'in_l1' }),
      chargeRefunded({ eventId: 'evt_l2', invoice: 'in_l1', refunds: [{ id: 're_l1', amount: 499 }] }),
      invoicePaid({ eventId: 'evt_l3', invoice: 'in_l3', household: H2, customer: 'cus_h2' }),
      dispute({ eventId: 'evt_l4', id: 'dp_l', invoice: 'in_l3' }),
      dispute({ eventId: 'evt_l5', id: 'dp_l', invoice: 'in_l3', reinstated: true }),
      stripeEvent('invoice.payment_failed', 'evt_l6', { id: 'in_l9' }),
      topupSession({ eventId: 'evt_l7', session: 'cs_l7', pi: 'pi_l7' }),
    ];
    const rcLog = [
      rc({ id: 'rc_l1', type: 'INITIAL_PURCHASE', transaction_id: 'atx_l1' }),
      rc({ id: 'rc_l2', type: 'CANCELLATION', cancel_reason: 'CUSTOMER_SUPPORT', transaction_id: 'atx_l1' }),
    ];
    const summarise = async (s) => (await s.listTransactions({})).map((t) => [t.economic_key, t.kind, t.gross_minor, t.tax_minor, t.status, t.original_transaction_id ? 'linked' : 'none'].join('|')).sort();
    const c1 = setup(store);
    for (const e of log) await c1.engine.ingestStripeEvent(e);
    for (const e of rcLog) await c1.engine.ingestRevenueCatEvent(e);
    const inOrder = await summarise(store);
    const store2 = await newStore();
    const c2 = setup(store2);
    for (const e of [...rcLog].reverse()) await c2.engine.ingestRevenueCatEvent(e);
    for (const e of [...log].reverse()) await c2.engine.ingestStripeEvent(e);
    for (const e of log) await c2.engine.ingestStripeEvent(e); // and replay it all again
    await c2.engine.reevaluate();
    const reversed = await summarise(store2);
    check(JSON.stringify(inOrder) === JSON.stringify(reversed), 'reverse-order + full replay produces the identical ledger');
    check(inOrder.length === 8, 'eight economic transactions: 2 subscription sales, refund, chargeback, reversal, top-up, Apple sale + Apple refund');
    check((await openOf(store2, 'refund_mismatch')).length === 0, 'no lingering refund_mismatch after convergence');
  });

  // ── 11. Settlements ─────────────────────────────────────────────────────
  scenario('Stripe payout settlement', async (store) => {
    const c = setup(store);
    await c.engine.ingestStripeEvent(invoicePaid({ eventId: 'evt_p1', invoice: 'in_p1' }));
    await c.engine.ingestStripeEvent(invoicePaid({ eventId: 'evt_p2', invoice: 'in_p2', household: H2, customer: 'cus_h2' }));
    await drain(c);
    const s = await c.settle.importSettlement({
      channel: 'stripe', settlement_ref: 'po_1', currency: 'GBP', period_end: '2026-10-08T00:00:00Z', paid_at: '2026-10-08T00:00:00Z',
      totals: { fee_minor: 64, payout_minor: 934 },
      lines: [{ line_ref: 'txn_1', type: 'charge', source_ref: 'ch_in_p1', gross_minor: 499, fee_minor: 32 }, { line_ref: 'txn_2', type: 'charge', source_ref: 'ch_in_p2', gross_minor: 499, fee_minor: 32 }],
    });
    const again = await c.settle.importSettlement({ channel: 'stripe', settlement_ref: 'po_1', currency: 'GBP', totals: {} });
    check(again.id === s.id, 'importing the same payout twice is idempotent');
    const r = await c.settle.reconcile(s.id);
    check(r.status === 'reconciled', 'payout reconciles against its lines');
    const p1 = await store.findTransactionByKey('stripe:sale:invoice:in_p1');
    check(p1.fee_minor === 32 && p1.settlement_id === s.id, 'Stripe fee learnt from the payout (even after the sale was posted)');
    await drain(c);
    const fee = c.xero.documents.find((d) => d.endpoint === 'BankTransactions');
    check(fee && fee.body.Type === 'SPEND' && fee.body.LineItems[0].UnitAmount === 0.64, 'fees posted once as a SPEND of £0.64 from Stripe clearing');
    await c.settle.reconcile(s.id);
    await drain(c);
    check(c.xero.count('BankTransactions') === 1, 're-reconciling does not post fees twice');
    const bad = await c.settle.importSettlement({ channel: 'stripe', settlement_ref: 'po_2', currency: 'GBP', totals: { fee_minor: 10, payout_minor: 1000 },
      lines: [{ line_ref: 'txn_9', type: 'charge', source_ref: 'ch_unknown', gross_minor: 499, fee_minor: 10 }] });
    const rb = await c.settle.reconcile(bad.id);
    check(rb.status === 'discrepancy', 'unknown charge + wrong total → discrepancy');
    check((await openOf(store, 'unmatched_payment')).length === 1 && (await openOf(store, 'amount_discrepancy')).length === 1, 'unmatched payout line and total mismatch both raised');
  });

  scenario('App Store settlement (aggregate)', async (store) => {
    const c = setup(store);
    for (let i = 1; i <= 3; i += 1) await c.engine.ingestRevenueCatEvent(rc({ id: `rc_a${i}`, type: 'RENEWAL', transaction_id: `atx_a${i}`, purchased: `2026-10-0${i}T09:00:00Z` }));
    await c.engine.ingestRevenueCatEvent(rc({ id: 'rc_a1_ref', type: 'CANCELLATION', cancel_reason: 'CUSTOMER_SUPPORT', transaction_id: 'atx_a1', price: -4.99, purchased: '2026-10-01T09:00:00Z' }));
    const s = await c.settle.importSettlement({ channel: 'app_store', settlement_ref: '2026-10', currency: 'GBP', period_start: '2026-09-28T00:00:00Z', period_end: '2026-11-02T00:00:00Z', paid_at: '2026-12-05T00:00:00Z',
      totals: { units: 2, proceeds_minor: 710, fee_minor: 124 } });
    const r = await c.settle.reconcile(s.id);
    check(r.status === 'reconciled', 'Apple report (2 net units, £7.10 proceeds) agrees with the sub-ledger within tolerance');
    await drain(c);
    const inv = c.xero.documents.find((d) => d.endpoint === 'Invoices');
    check(inv && inv.body.Contact.Name === 'TEST Apple contact' && inv.body.LineItems.length === 1 && inv.body.LineItems[0].UnitAmount === 7.1, 'one summary invoice to Apple at net proceeds');
    check((await store.listTransactions({ channel: 'app_store' })).every((t) => t.settlement_id === s.id), 'sub-ledger transactions linked to the settlement');
    const s2 = await c.settle.importSettlement({ channel: 'app_store', settlement_ref: '2026-10-b', currency: 'GBP', period_start: '2026-09-28T00:00:00Z', period_end: '2026-11-02T00:00:00Z', totals: { units: 5, proceeds_minor: 1770, fee_minor: 310 } });
    const r2 = await c.settle.reconcile(s2.id);
    check(r2.status === 'discrepancy' && (await openOf(store, 'amount_discrepancy')).length === 1, 'report disagreeing with the sub-ledger → amount_discrepancy');
  });

  scenario('store revenue basis unconfirmed holds the settlement', async (store) => {
    const c = setup(store, { storeRevenueBasis: null });
    await c.engine.ingestRevenueCatEvent(rc({ id: 'rc_b1', type: 'RENEWAL', transaction_id: 'atx_b1' }));
    const s = await c.settle.importSettlement({ channel: 'app_store', settlement_ref: 'b', currency: 'GBP', period_start: '2026-09-28T00:00:00Z', period_end: '2026-11-02T00:00:00Z', totals: { units: 1, proceeds_minor: 354, fee_minor: 62 } });
    await c.settle.reconcile(s.id);
    await drain(c);
    check(c.xero.count() === 0 && (await store.listPostings({}))[0].status === 'held', 'no store revenue basis (AD-4) → posting held, nothing sent');
  });

  // ── 12. Posted is frozen; top-ups ───────────────────────────────────────
  scenario('posted transaction money is frozen', async (store) => {
    const c = setup(store);
    await c.engine.ingestStripeEvent(invoicePaid({ eventId: 'evt_fz', invoice: 'in_fz' }));
    await drain(c);
    const tx = await store.findTransactionByKey('stripe:sale:invoice:in_fz');
    let threw = false;
    try { await store.updateTransaction(tx.id, { tax_minor: 0 }); } catch { threw = true; }
    check(threw, 'changing VAT on a posted transaction is refused');
  });

  scenario('top-up checkout sessions', async (store) => {
    const c = setup(store);
    await c.engine.ingestStripeEvent(topupSession({ eventId: 'evt_tp1', session: 'cs_1', pi: 'pi_tp1' }));
    const sub = await c.engine.ingestStripeEvent(topupSession({ eventId: 'evt_tp2', session: 'cs_2', pi: null, mode: 'subscription' }));
    const unpaid = await c.engine.ingestStripeEvent(topupSession({ eventId: 'evt_tp3', session: 'cs_3', pi: 'pi_tp3', paymentStatus: 'unpaid' }));
    const tx = await store.findTransactionByKey('stripe:sale:pi:pi_tp1');
    check(tx && tx.product === 'allowance_topup' && tx.gross_minor === 300 && tx.tax_minor === 50, 'paid top-up recorded with Stripe VAT');
    check(sub.outcome === 'non_economic' && unpaid.outcome === 'non_economic', 'subscription-mode session and unpaid session are non-economic');
    await c.engine.ingestStripeEvent(stripeEvent('checkout.session.async_payment_succeeded', 'evt_tp1_async', {
      id: 'cs_1', mode: 'payment', payment_status: 'paid', amount_total: 300, currency: 'gbp', payment_intent: 'pi_tp1', customer: 'cus_h1', total_details: { amount_tax: 50 }, metadata: { hcg_purpose: 'allowance_topup', household_id: H1 } }));
    check((await store.listTransactions({})).length === 1, 'completed + async_payment_succeeded for the same PaymentIntent = one transaction');
    await drain(c);
    const inv = c.xero.documents.find((d) => d.endpoint === 'Invoices');
    check(inv.body.LineItems[0].AccountCode === 'T201', 'top-up posts to the top-up revenue code');
  });

  for (const s of scenarios) {
    if (only && !s.name.includes(only)) continue;
    console.log(`\n── ${s.name}`);
    try {
      await s.fn(await newStore());
    } catch (err) {
      check(false, `${s.name} threw: ${err.stack || err.message}`);
    }
  }
  return scenarios.length;
}
