// economicsRegister.js — loads and validates THE authoritative register of
// HCG unit-economics inputs (services/finance/assumptions/hcg-unit-economics.v1.json).
//
// Every runtime financial DEFAULT (costModel rates, economicPolicy inputs,
// payment/store fee models, top-up economics, scenario assumptions) reads
// from here, so a rate exists in exactly one place. The database policy
// (fc_policy / fc_budget_profiles) remains authoritative for enforcement;
// tests/economics-register.test.mjs fails if its SQL defaults drift from
// this register. Pure, synchronous, no I/O beyond the one require.
'use strict';

const RAW = require('./assumptions/hcg-unit-economics.v1.json');

const STATUSES = Object.freeze(['KNOWN', 'CONFIGURED', 'ESTIMATED', 'UNKNOWN', 'PROVIDER_CONFIRMATION_REQUIRED']);
const KINDS = Object.freeze(['fact', 'policy', 'modelling']);

// Derived values are rounded to 6 dp (the precision of fc_policy rates) so
// that, e.g., $0.006 × 0.79 is exactly the £0.00474 every consumer uses.
const r6 = (n) => Math.round(n * 1e6) / 1e6;

function validateRegister(reg) {
  const errors = [];
  if (!reg || typeof reg !== 'object' || !reg.assumptions) return ['register has no assumptions'];
  for (const [key, a] of Object.entries(reg.assumptions)) {
    if (!a || typeof a !== 'object') { errors.push(`${key}: not an object`); continue; }
    if (!STATUSES.includes(a.status)) errors.push(`${key}: status "${a.status}" not one of ${STATUSES.join('/')}`);
    if (!KINDS.includes(a.kind)) errors.push(`${key}: kind "${a.kind}" not one of ${KINDS.join('/')}`);
    if (typeof a.source !== 'string' || a.source.length < 3) errors.push(`${key}: missing source`);
    if (typeof a.unit !== 'string') errors.push(`${key}: missing unit`);
    if (!('value' in a)) errors.push(`${key}: missing value`);
    if (a.value === null && a.status !== 'UNKNOWN') errors.push(`${key}: null value is only allowed for UNKNOWN`);
    if (typeof a.value === 'number' && (!Number.isFinite(a.value) || a.value < 0)) errors.push(`${key}: value must be finite and ≥ 0`);
  }
  for (const k of ['vatRate', 'targetGrossMargin', 'planSafetyReserveRatio', 'topUpSafetyReserveRatio', 'stripeCardPct', 'appleStandardRate', 'appleSmallBusinessRate', 'googlePlayServiceFeeRate']) {
    const v = reg.assumptions[k] && reg.assumptions[k].value;
    if (!(typeof v === 'number' && v >= 0 && v < 1)) errors.push(`${k}: must be a ratio in [0, 1)`);
  }
  return errors;
}

const ERRORS = validateRegister(RAW);
if (ERRORS.length) throw new Error(`economicsRegister: invalid register — ${ERRORS.join('; ')}`);

const REGISTER = Object.freeze(RAW);
const A = REGISTER.assumptions;

/** Raw value of one assumption; throws on an unknown key (no silent undefined). */
function value(key) {
  if (!Object.prototype.hasOwnProperty.call(A, key)) throw new Error(`economicsRegister: unknown assumption "${key}"`);
  return A[key].value;
}

function entry(key) {
  value(key);
  return A[key];
}

const fx = () => value('usdToGbp');

/** Transcription £ per monitored minute (list × FX × audio multiplier). */
const transcriptionGbpPerMin = () => r6(value('transcriptionUsdPerMin') * fx() * value('transcriptionAudioMultiplier'));
/** Twilio app leg at list price, £/min (billed £0 today). */
const appLegListGbpPerMin = () => r6(value('twilioAppLegListUsdPerMin') * fx());

/**
 * Per-unit £ rates on two bases:
 *   expected     — what HCG is billed today (app leg £0)
 *   enforcement  — what containment charges against a budget: app leg at
 *                  list price; × uplift only where the database applies it.
 */
function rates({ basis = 'expected' } = {}) {
  const appLeg = basis === 'enforcement' ? appLegListGbpPerMin() : value('twilioAppLegBilledGbpPerMin');
  const inbound = value('twilioInboundGbpPerMin');
  const stream = value('twilioMediaStreamGbpPerMin');
  const transcription = transcriptionGbpPerMin();
  return {
    basis,
    numberMonthly: value('numberRentalGbpPerMonth'),
    inboundPerMin: inbound,
    appLegPerMin: appLeg,
    connectedPerMin: r6(inbound + appLeg),
    mediaStreamPerMin: stream,
    transcriptionPerMin: transcription,
    monitoringPerMin: r6(stream + transcription),
    greetingPerCall: value('twilioPollyGbpPerCall'),
    smsPerSegment: value('twilioSmsGbpPerSegment'),
    uplift: basis === 'enforcement' ? value('fortressEstimateUplift') : 1,
  };
}

/** Stripe fee model parts (card % + Billing % + Tax %, plus fixed per charge). */
function stripeFeeParts() {
  return { pct: r6(value('stripeCardPct') + value('stripeBillingPct') + value('stripeTaxPct')), fixedGbp: value('stripeCardFixedGbp') };
}

/** Assumptions grouped by status (for the doc and the admin view). */
function byStatus() {
  const out = Object.fromEntries(STATUSES.map((s) => [s, []]));
  for (const [key, a] of Object.entries(A)) out[a.status].push(key);
  return out;
}

module.exports = {
  REGISTER,
  STATUSES,
  KINDS,
  validateRegister,
  value,
  entry,
  rates,
  transcriptionGbpPerMin,
  appLegListGbpPerMin,
  stripeFeeParts,
  byStatus,
  r6,
};
