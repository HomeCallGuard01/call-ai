// Accounting policy: which accountant decisions are confirmed, the VAT split
// for each channel, and whether a transaction may be posted to Xero.
//
// Rule: HCG never invents tax or revenue treatment. A transaction whose
// posting depends on an unconfirmed decision is BLOCKED (never posted with a
// guess). Confirmations come only from configuration an operator sets after
// the accountant signs off — ACCOUNTING_CONFIRMED_DECISIONS="AD-1,AD-2,…" —
// and account codes only from ACCOUNTING_XERO_ACCOUNT_CODES (JSON). There are
// deliberately no default account codes.

'use strict';

const { ACCOUNTANT_DECISIONS, CHANNELS, KINDS } = require('./constants');

const STANDARD_VAT_RATE_BPS = 2000; // UK standard rate 20% — used only to CHECK provider-computed VAT, never to post it

// Decisions that must be confirmed before a transaction of this channel/kind
// can be posted individually to Xero. Store sales are never posted
// individually (they post as settlement summaries — see settlementPolicy).
const REQUIRED_DECISIONS = Object.freeze({
  [`${CHANNELS.STRIPE}:${KINDS.SALE}`]: ['AD-1', 'AD-2', 'AD-5', 'AD-6', 'AD-7', 'AD-10'],
  [`${CHANNELS.STRIPE}:${KINDS.REFUND}`]: ['AD-1', 'AD-2', 'AD-6', 'AD-7', 'AD-9', 'AD-10'],
  [`${CHANNELS.STRIPE}:${KINDS.CHARGEBACK}`]: ['AD-1', 'AD-6', 'AD-7', 'AD-8', 'AD-10'],
  [`${CHANNELS.STRIPE}:${KINDS.CHARGEBACK_REVERSAL}`]: ['AD-1', 'AD-6', 'AD-7', 'AD-8', 'AD-10'],
});
const SETTLEMENT_REQUIRED_DECISIONS = Object.freeze({
  [CHANNELS.STRIPE]: ['AD-6', 'AD-7'],                 // fee/payout summary
  [CHANNELS.APP_STORE]: ['AD-3', 'AD-4', 'AD-6', 'AD-7', 'AD-11'],
  [CHANNELS.PLAY_STORE]: ['AD-3', 'AD-4', 'AD-6', 'AD-7', 'AD-11'],
});

const KNOWN_IDS = new Set(ACCOUNTANT_DECISIONS.map((d) => d.id));

function parseConfirmedDecisions(value) {
  if (!value || typeof value !== 'string') return new Set();
  return new Set(value.split(',').map((s) => s.trim().toUpperCase()).filter((id) => KNOWN_IDS.has(id)));
}

function parseAccountCodes(value) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function loadAccountingPolicy(env = process.env) {
  return {
    confirmed: parseConfirmedDecisions(env.ACCOUNTING_CONFIRMED_DECISIONS),
    accountCodes: parseAccountCodes(env.ACCOUNTING_XERO_ACCOUNT_CODES),
  };
}

function missingDecisions(required, policy) {
  return required.filter((id) => !policy.confirmed.has(id));
}

// Which decisions still block posting this transaction individually.
function postingBlockers(tx, policy) {
  const required = REQUIRED_DECISIONS[`${tx.channel}:${tx.kind}`];
  if (!required) return ['not_individually_posted'];
  return missingDecisions(required, policy);
}

function settlementBlockers(channel, policy) {
  return missingDecisions(SETTLEMENT_REQUIRED_DECISIONS[channel] || ['AD-6'], policy);
}

// VAT check for a Stripe charge. Stripe Tax computes the VAT actually charged;
// that provider figure is what is recorded. HCG only CHECKS it against the
// VAT-inclusive 1/6 split and flags a discrepancy — it never substitutes its
// own number.
function checkStripeVat({ grossMinor, taxMinor, customerCountry }) {
  const issues = [];
  if (taxMinor === null || taxMinor === undefined) {
    issues.push({ code: 'vat_not_reported', detail: 'Stripe reported no tax amount for this charge' });
    return { taxSource: 'missing', issues };
  }
  if (taxMinor === 0 && (!customerCountry || customerCountry === 'GB') && grossMinor > 0) {
    issues.push({ code: 'vat_not_calculated', detail: 'Stripe calculated zero VAT on a UK (or unknown-country) charge (see AD-2)' });
    return { taxSource: 'provider', issues };
  }
  if (customerCountry === 'GB' || !customerCountry) {
    const expected = Math.round((grossMinor * STANDARD_VAT_RATE_BPS) / (10000 + STANDARD_VAT_RATE_BPS));
    if (Math.abs(expected - taxMinor) > 1) {
      issues.push({ code: 'vat_unexpected_amount', detail: `Stripe VAT ${taxMinor} differs from the 20% inclusive split ${expected}` });
    }
  }
  return { taxSource: 'provider', issues };
}

module.exports = {
  STANDARD_VAT_RATE_BPS, REQUIRED_DECISIONS, SETTLEMENT_REQUIRED_DECISIONS,
  parseConfirmedDecisions, parseAccountCodes, loadAccountingPolicy,
  postingBlockers, settlementBlockers, checkStripeVat,
};
