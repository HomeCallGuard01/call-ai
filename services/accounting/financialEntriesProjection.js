// Accounting transaction → rows for the 051 management ledger
// (public.financial_entries), so the admin P&L views
// (finance_monthly_contribution) show revenue, VAT, refunds and fees from the
// SAME records that go to Xero — never a second calculation.
//
// Rules (051 contract): entry_key unique per source_system; revenue positive,
// tax/fee/refund negative via entry_class; UNKNOWN amounts are never zero;
// store amounts from RevenueCat are 'estimated' until a settlement
// reconciles them. Sandbox transactions produce nothing.
//
// Not wired to a writer yet (docs/finance/ACCOUNTING_AUTOMATION.md §8).

'use strict';

const { CHANNELS, KINDS } = require('./constants');

const SUPPLIER = { [CHANNELS.STRIPE]: 'stripe', [CHANNELS.APP_STORE]: 'apple', [CHANNELS.PLAY_STORE]: 'google' };
const major = (minor) => (minor === null || minor === undefined ? null : Number((minor / 100).toFixed(6)));

function projectToFinancialEntries(tx) {
  if (tx.environment !== 'production') return [];
  const supplier = SUPPLIER[tx.channel];
  if (!supplier) return [];
  const estimated = tx.amount_quality === 'estimated';
  const base = {
    source_system: 'hcg_accounting',
    supplier,
    native_reference: tx.provider_transaction_id,
    native_currency: tx.currency,
    occurred_at: tx.occurred_at,
    period_start: tx.service_period_start,
    period_end: tx.service_period_end,
    household_id: tx.household_id,
    subscription_ref: tx.provider_refs ? tx.provider_refs.subscription || tx.provider_refs.original_transaction || null : null,
    provenance: estimated ? 'estimated' : 'provider_actual',
    reconciliation_status: estimated ? 'provisional' : 'pending',
    evidence: { economic_key: tx.economic_key, account_number: tx.account_number, accounting_status: tx.status },
  };
  const row = (suffix, entryClass, category, amountMinor, extra = {}) => {
    const known = Number.isSafeInteger(amountMinor);
    return {
      ...base, ...extra,
      entry_key: `${tx.economic_key}:${suffix}`,
      entry_class: entryClass,
      category,
      amount: known ? major(Math.abs(amountMinor)) : null,
      native_amount: known ? major(amountMinor) : null,
      ...(estimated
        ? { charge_observation: null, allocation_basis: 'revenuecat_estimate (tax_percentage/commission_percentage)' }
        : { charge_observation: known ? (amountMinor === 0 ? 'reported_zero' : 'reported_amount') : 'pending' }),
    };
  };
  const rows = [];
  const isReversal = tx.kind === KINDS.REFUND || tx.kind === KINDS.CHARGEBACK;
  const revenueClass = isReversal ? 'refund' : 'revenue';
  const revenueCategory = isReversal ? 'refund' : 'subscription';
  // Store customer price includes the store's VAT, which is not HCG money
  // (AD-3): HCG's store revenue line is price ex store VAT (= proceeds + commission).
  // A Stripe refund/chargeback is projected EX VAT: 051 signs every 'tax'
  // row negative, so it cannot hold a VAT reversal; recording the reversal
  // net of VAT keeps contribution (revenue − tax − fees) correct. The gross
  // is kept in evidence. (Xero, not 051, is the VAT record.)
  const exVat = Number.isSafeInteger(tx.gross_minor) && Number.isSafeInteger(tx.tax_minor) ? tx.gross_minor - tx.tax_minor : null;
  const revenueMinor = tx.channel === CHANNELS.STRIPE ? (isReversal ? exVat : tx.gross_minor) : exVat;
  rows.push(row('gross', revenueClass, revenueCategory, revenueMinor, { evidence: { ...base.evidence, gross_minor: tx.gross_minor, tax_minor: tx.tax_minor } }));
  // VAT: only when this is HCG's output VAT (Stripe). Store VAT is the
  // store's (deemed supplier — AD-3), so it is not HCG tax.
  if (tx.channel === CHANNELS.STRIPE && tx.kind === KINDS.SALE) rows.push(row('vat', 'tax', 'vat_output', tx.tax_minor));
  // The fee row is always emitted: an unknown Stripe fee (learnt later from
  // the payout) shows as a pending observation — 051 rule: UNKNOWN is not zero.
  {
    const feeCategory = tx.channel === CHANNELS.STRIPE ? 'payment_processing_fee' : 'store_commission';
    rows.push(row('fee', 'fee', feeCategory, tx.fee_minor, { cost_class: 'variable_direct', billing_model: tx.channel === CHANNELS.STRIPE ? 'per_transaction' : 'percentage' }));
  }
  // Rows without an amount are pending observations — legal only for provider_actual.
  return rows.filter((r) => r.amount !== null || r.provenance === 'provider_actual');
}

module.exports = { projectToFinancialEntries };
