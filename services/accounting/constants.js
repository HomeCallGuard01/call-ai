// Accounting automation — shared vocabulary (feature/accounting-automation, 2026-10-04).
//
// One place for every channel, transaction kind, status and exception type so
// the engine, the in-memory store, the SQL migration (071, DRAFT) and the
// admin status agree. tests/accounting-*.test.mjs pin the SQL check
// constraints to these lists.
//
// Nothing here decides tax or revenue-recognition treatment. Those are listed
// in ACCOUNTANT_DECISIONS and stay "unconfirmed" until an accountant signs off.

'use strict';

// Payment channel = who collected the customer's money.
const CHANNELS = Object.freeze({
  STRIPE: 'stripe',            // HCG is merchant of record (web + Android in-app Stripe today)
  APP_STORE: 'app_store',      // Apple collected; HCG paid in arrears by Apple
  PLAY_STORE: 'play_store',    // Google collected (no Play Billing product exists yet)
  COMPLIMENTARY: 'complimentary', // no money moves, ever
});

// Where an accounting fact came from. RevenueCat is a SOURCE (an event feed),
// never a channel: it reports Apple/Google/Stripe transactions, it does not
// collect money.
const SOURCES = Object.freeze({
  STRIPE_WEBHOOK: 'stripe_webhook',
  REVENUECAT_WEBHOOK: 'revenuecat_webhook',
  SETTLEMENT_REPORT: 'settlement_report', // Stripe payout / Apple proceeds / Google earnings import
  MANUAL: 'manual',
});

// Economic transaction kinds. Anything that is not money moving (cancellation,
// billing issue, expiration, trial start, product change without a charge) is
// NOT a transaction — it is a recorded non-economic source event.
const KINDS = Object.freeze({
  SALE: 'sale',                         // initial purchase or renewal that was paid
  REFUND: 'refund',
  CHARGEBACK: 'chargeback',             // dispute funds withdrawn
  CHARGEBACK_REVERSAL: 'chargeback_reversal', // dispute won, funds returned
});
const KIND_SIGN = Object.freeze({ sale: 1, refund: -1, chargeback: -1, chargeback_reversal: 1 });

// Accounting status of a transaction (its life towards Xero).
const TX_STATUS = Object.freeze({
  EXCLUDED_SANDBOX: 'excluded_sandbox',       // test/sandbox money — never posted, never revenue
  SUBLEDGER_ONLY: 'subledger_only',           // store transaction: kept for reconciliation, posted via settlement summary
  BLOCKED: 'blocked',                         // cannot post until an exception is resolved (see blocked_reason)
  READY: 'ready',                             // eligible for the Xero posting queue
  POSTING: 'posting',
  POSTED: 'posted',
  FAILED: 'failed',                           // Xero posting exhausted retries — exception raised
});

const EXCEPTION_TYPES = Object.freeze({
  UNMATCHED_PAYMENT: 'unmatched_payment',         // money with no HCG household/subscription we recognise
  DUPLICATE: 'duplicate',                         // same economic transaction reported with different content
  MISSING_ACCOUNT: 'missing_account',             // household has no HCG account number
  CONFLICTING_ENTITLEMENT: 'conflicting_entitlement', // money and entitlement disagree
  REFUND_MISMATCH: 'refund_mismatch',             // refund with no original, or refunds exceed the original
  FAILED_XERO_POSTING: 'failed_xero_posting',
  AMOUNT_DISCREPANCY: 'amount_discrepancy',       // provider amounts disagree (e.g. RevenueCat estimate vs Apple settlement, VAT mismatch)
  TAX_TREATMENT_UNCONFIRMED: 'tax_treatment_unconfirmed', // posting blocked pending accountant decision
  UNSUPPORTED_CURRENCY: 'unsupported_currency',
});

const EXCEPTION_SEVERITY = Object.freeze({
  unmatched_payment: 'high',
  duplicate: 'high',
  missing_account: 'medium',
  conflicting_entitlement: 'high',
  refund_mismatch: 'high',
  failed_xero_posting: 'high',
  amount_discrepancy: 'medium',
  tax_treatment_unconfirmed: 'medium',
  unsupported_currency: 'medium',
});

// Outcome of ingesting one source event (recorded on the source-event row).
const EVENT_OUTCOMES = Object.freeze({
  RECORDED: 'recorded',                   // created/updated an accounting transaction
  NON_ECONOMIC: 'non_economic',            // cancellation, payment failure, billing issue, expiration…
  DUPLICATE_EVENT: 'duplicate_event',     // same source event id seen before — no-op (webhook retry/replay)
  DUPLICATE_ECONOMIC: 'duplicate_economic', // different event, same money (e.g. RevenueCat RENEWAL replayed with a new id)
  SUPERSEDED_BY_PRIMARY: 'superseded_by_primary', // e.g. RevenueCat event for a Stripe purchase: Stripe webhook is authoritative
  SANDBOX: 'sandbox',
  COMPLIMENTARY: 'complimentary',
  IGNORED: 'ignored',                     // event type with no accounting meaning (e.g. RevenueCat TEST)
});

// Every point where HCG must NOT invent treatment. Each is surfaced in the
// admin status and in docs/finance/ACCOUNTING_AUTOMATION.md §9.
const ACCOUNTANT_DECISIONS = Object.freeze([
  { id: 'AD-1', topic: 'VAT registration', question: 'Code/terms state AFMD Ltd is UK VAT-registered (GB379120684). Confirm the effective date, the VAT scheme (standard/flat-rate/cash accounting) and the VAT return periods before any VAT is posted to Xero.' },
  { id: 'AD-2', topic: 'Stripe VAT (incl. pre-2026-09-20 charges)', question: 'Prices are VAT-inclusive and Stripe Tax computes VAT since 2026-09-20. Before that Stripe charged the gross with NO VAT calculated (routes/billing.js comment). Is output VAT due on those earlier charges (1/6 of gross), and how is it corrected?' },
  { id: 'AD-3', topic: 'App Store VAT / principal', question: 'Confirm Apple (and Google) act as deemed supplier/commissionaire for UK VAT, so HCG has no output VAT on store sales and its supply is to Apple Distribution International.' },
  { id: 'AD-4', topic: 'Store revenue: gross or net', question: 'Recognise App Store revenue at net proceeds (Apple commission never HCG revenue) or at customer price with commission as an expense?' },
  { id: 'AD-5', topic: 'Revenue recognition timing', question: 'Recognise monthly subscriptions at payment date (cash-like) or defer across the service period? Annual plans would need deferral.' },
  { id: 'AD-6', topic: 'Xero posting granularity', question: 'Per-transaction invoices for Stripe (contact = HCG account number) vs daily/payout summaries; store sales as monthly settlement summaries.' },
  { id: 'AD-7', topic: 'Chart of accounts', question: 'Account codes for subscription revenue, store revenue, Stripe fees, store commission, chargebacks, Stripe/Apple clearing accounts, VAT rate codes.' },
  { id: 'AD-8', topic: 'Chargebacks and dispute fees', question: 'Treatment of dispute losses (reverse revenue vs bad-debt expense) and dispute fees.' },
  { id: 'AD-9', topic: 'Refund VAT', question: 'Credit-note VAT treatment for partial refunds and refunds across VAT periods.' },
  { id: 'AD-10', topic: 'Customer identity in Xero', question: 'Is the HCG account number (no name/email) an acceptable Xero contact for B2C simplified VAT invoices, given UK GDPR minimisation?' },
  { id: 'AD-11', topic: 'FX', question: 'Store proceeds in non-GBP currencies: which rate (Apple report rate vs Xero rate) and where FX differences post.' },
]);

const SUPPORTED_CURRENCIES = Object.freeze(['GBP']);

module.exports = {
  CHANNELS, SOURCES, KINDS, KIND_SIGN, TX_STATUS, EXCEPTION_TYPES, EXCEPTION_SEVERITY,
  EVENT_OUTCOMES, ACCOUNTANT_DECISIONS, SUPPORTED_CURRENCIES,
};
