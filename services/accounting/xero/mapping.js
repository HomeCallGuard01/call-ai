// Accounting transaction / settlement → Xero document plan (pure).
//
// A plan is an ordered list of steps; each step is ONE Xero create call with
// its own deterministic Reference and Idempotency-Key, so a step can be
// retried or recovered (find-by-reference) without ever creating a second
// document. Later steps bind ids from earlier ones (a Payment needs the
// InvoiceID).
//
// Posting model (intended — accountant to confirm, see AD-6/AD-7):
//   Stripe sale            ACCREC Invoice (contact = HCG account number, VAT-inclusive line)
//                          + Payment into the "Stripe clearing" account
//   Stripe refund          ACCRECCREDIT CreditNote + refund Payment out of Stripe clearing
//   Stripe chargeback      ACCRECCREDIT CreditNote to the chargeback account + Payment out of clearing
//   Stripe chargeback won  ACCREC Invoice to the chargeback account + Payment into clearing
//   Stripe payout          SPEND BankTransaction (fees) in Stripe clearing; the payout itself is
//                          matched by the Xero bank feed (transfer clearing → bank)
//   App Store / Play month ACCREC Invoice to the store contact for the settlement (net proceeds,
//                          or gross with a negative commission line — AD-4); paid by the bank feed
//
// There are NO default account codes or tax types: every one comes from
// ACCOUNTING_XERO_ACCOUNT_CODES. A missing code makes the plan fail with
// `missing_account_codes` and the transaction stays blocked.

'use strict';

const { createHash } = require('node:crypto');
const { KINDS, CHANNELS } = require('../constants');

const amount = (minor) => Number((minor / 100).toFixed(2));
const day = (isoString) => String(isoString || '').slice(0, 10);

// Idempotency-Key: deterministic per (posting, step), ≤128 chars (Xero limit).
function idempotencyKey(postingKey, stepName) {
  return `hcg-${createHash('sha256').update(`${postingKey}|${stepName}|v1`).digest('hex').slice(0, 48)}`;
}

function require_(codes, names) {
  const missing = names.filter((n) => typeof codes[n] !== 'string' || !codes[n].trim());
  return missing;
}

function referenceFor(tx) {
  // Xero Reference: HCG account number first (the business reference), then the
  // provider economic key (unique), so the document is findable either way.
  return `${tx.account_number || 'NO-ACCOUNT'} ${tx.economic_key}`.slice(0, 255);
}

function revenueCodeName(tx) {
  return tx.product === 'subscription' ? 'subscription_revenue' : 'topup_revenue';
}

function planForTransaction(tx, codes, { postingKey }) {
  if (tx.channel !== CHANNELS.STRIPE) return { error: 'not_individually_posted' };
  if (!tx.account_number) return { error: 'missing_account' };
  const reference = referenceFor(tx);
  const contact = { Name: tx.account_number, AccountNumber: tx.account_number };
  const date = day(tx.occurred_at);
  const lineDescription = `Home Call Guard ${tx.product === 'subscription' ? 'subscription' : 'top-up'} — ${tx.provider_transaction_id}`;
  const step = (name, endpoint, body, extra = {}) => ({
    name, endpoint, reference, idempotency_key: idempotencyKey(postingKey, name), body: { ...body, Reference: reference }, ...extra,
  });

  if (tx.kind === KINDS.SALE || tx.kind === KINDS.REFUND) {
    const revenueCode = revenueCodeName(tx);
    const missing = require_(codes, [revenueCode, 'stripe_clearing', 'vat_output_tax_type']);
    if (missing.length) return { error: 'missing_account_codes', missing };
    const line = {
      Description: lineDescription, Quantity: 1, UnitAmount: amount(tx.gross_minor),
      AccountCode: codes[revenueCode], TaxType: codes.vat_output_tax_type,
      ...(Number.isSafeInteger(tx.tax_minor) ? { TaxAmount: amount(tx.tax_minor) } : {}),
    };
    if (tx.kind === KINDS.SALE) {
      return { steps: [
        step('invoice', 'Invoices', { Type: 'ACCREC', Contact: contact, Date: date, DueDate: date, Status: 'AUTHORISED', LineAmountTypes: 'Inclusive', CurrencyCode: tx.currency, LineItems: [line] }),
        step('payment', 'Payments', { Account: { Code: codes.stripe_clearing }, Date: date, Amount: amount(tx.gross_minor) }, { bind: { from: 'invoice', as: 'Invoice', idField: 'InvoiceID' } }),
      ] };
    }
    return { steps: [
      step('credit_note', 'CreditNotes', { Type: 'ACCRECCREDIT', Contact: contact, Date: date, Status: 'AUTHORISED', LineAmountTypes: 'Inclusive', CurrencyCode: tx.currency, LineItems: [line] }),
      step('refund_payment', 'Payments', { Account: { Code: codes.stripe_clearing }, Date: date, Amount: amount(tx.gross_minor) }, { bind: { from: 'credit_note', as: 'CreditNote', idField: 'CreditNoteID' } }),
    ] };
  }

  if (tx.kind === KINDS.CHARGEBACK || tx.kind === KINDS.CHARGEBACK_REVERSAL) {
    const missing = require_(codes, ['chargebacks', 'stripe_clearing', 'chargeback_tax_type']);
    if (missing.length) return { error: 'missing_account_codes', missing };
    const line = { Description: `Card dispute ${tx.provider_transaction_id}`, Quantity: 1, UnitAmount: amount(tx.gross_minor), AccountCode: codes.chargebacks, TaxType: codes.chargeback_tax_type };
    const lost = tx.kind === KINDS.CHARGEBACK;
    const doc = lost
      ? step('credit_note', 'CreditNotes', { Type: 'ACCRECCREDIT', Contact: contact, Date: date, Status: 'AUTHORISED', LineAmountTypes: 'Inclusive', CurrencyCode: tx.currency, LineItems: [line] })
      : step('invoice', 'Invoices', { Type: 'ACCREC', Contact: contact, Date: date, DueDate: date, Status: 'AUTHORISED', LineAmountTypes: 'Inclusive', CurrencyCode: tx.currency, LineItems: [line] });
    return { steps: [
      doc,
      step(lost ? 'refund_payment' : 'payment', 'Payments', { Account: { Code: codes.stripe_clearing }, Date: date, Amount: amount(tx.gross_minor) },
        { bind: lost ? { from: 'credit_note', as: 'CreditNote', idField: 'CreditNoteID' } : { from: 'invoice', as: 'Invoice', idField: 'InvoiceID' } }),
    ] };
  }
  return { error: 'unsupported_kind' };
}

// Settlement summary (one per Stripe payout / store month).
function planForSettlement(settlement, codes, { postingKey, storeRevenueBasis }) {
  const reference = `HCG settlement ${settlement.channel}:${settlement.settlement_ref}`.slice(0, 255);
  const step = (name, endpoint, body) => ({ name, endpoint, reference, idempotency_key: idempotencyKey(postingKey, name), body: { ...body, Reference: reference } });
  const date = day(settlement.period_end || settlement.paid_at);
  const t = settlement.totals || {};

  if (settlement.channel === CHANNELS.STRIPE) {
    const missing = require_(codes, ['stripe_clearing', 'stripe_fees', 'stripe_fee_tax_type']);
    if (missing.length) return { error: 'missing_account_codes', missing };
    if (!Number.isSafeInteger(t.fee_minor) || t.fee_minor === 0) return { steps: [] };
    return { steps: [step('fees', 'BankTransactions', {
      Type: 'SPEND', Contact: { Name: codes.stripe_contact_name || 'Stripe' }, BankAccount: { Code: codes.stripe_clearing }, Date: date,
      LineAmountTypes: 'Inclusive', CurrencyCode: settlement.currency,
      LineItems: [{ Description: `Stripe fees, payout ${settlement.settlement_ref}`, Quantity: 1, UnitAmount: amount(t.fee_minor), AccountCode: codes.stripe_fees, TaxType: codes.stripe_fee_tax_type }],
    })] };
  }

  // Store settlement: revenue basis is an accountant decision (AD-4) — no default.
  if (storeRevenueBasis !== 'net_proceeds' && storeRevenueBasis !== 'gross_with_commission') return { error: 'store_revenue_basis_unconfirmed' };
  const contactName = settlement.channel === CHANNELS.APP_STORE ? codes.apple_contact_name : codes.google_contact_name;
  const missing = require_({ ...codes, contact_name: contactName }, ['store_revenue', 'store_tax_type', 'contact_name',
    ...(storeRevenueBasis === 'gross_with_commission' ? ['store_commission'] : [])]);
  if (missing.length) return { error: 'missing_account_codes', missing };
  const lines = storeRevenueBasis === 'net_proceeds'
    ? [{ Description: `${settlement.channel} proceeds ${settlement.settlement_ref}`, Quantity: 1, UnitAmount: amount(t.proceeds_minor), AccountCode: codes.store_revenue, TaxType: codes.store_tax_type }]
    : [
      { Description: `${settlement.channel} sales (ex customer VAT) ${settlement.settlement_ref}`, Quantity: 1, UnitAmount: amount(t.proceeds_minor + t.fee_minor), AccountCode: codes.store_revenue, TaxType: codes.store_tax_type },
      { Description: `${settlement.channel} commission ${settlement.settlement_ref}`, Quantity: 1, UnitAmount: -amount(t.fee_minor), AccountCode: codes.store_commission, TaxType: codes.store_tax_type },
    ];
  return { steps: [step('invoice', 'Invoices', {
    Type: 'ACCREC', Contact: { Name: contactName }, Date: date, DueDate: day(settlement.paid_at || settlement.period_end),
    Status: 'AUTHORISED', LineAmountTypes: 'Exclusive', CurrencyCode: settlement.currency, LineItems: lines,
  })] };
}

module.exports = { planForTransaction, planForSettlement, idempotencyKey, referenceFor, amount };
