// contract.js — the provider-neutral shape of financial ledger records
// (migration 048: public.financial_entries and public.telephony_call_legs).
//
// Every supplier adapter (services/telephony/<provider>/billingRecords.js
// today; Stripe, App Store, manual costs later) produces plain objects in
// exactly this shape. The validators mirror the database's own CHECK
// constraints so a bad record is rejected in code, with a readable reason,
// before it ever reaches Postgres — the database remains the final guard.
'use strict';

const BILLING_MODELS = ['per_second', 'per_minute', 'per_started_minute', 'per_channel', 'per_number', 'fixed_period', 'per_transaction', 'percentage', 'other'];
const PROVENANCE = ['provider_actual', 'provider_allocated', 'estimated', 'manual'];
const CHARGE_OBSERVATIONS = ['reported_amount', 'reported_zero', 'not_observed', 'unavailable', 'pending'];
const RECONCILIATION_STATUSES = ['pending', 'provisional', 'final', 'unreconciled', 'unavailable', 'mismatch', 'error'];
const ENTRY_CLASSES = ['revenue', 'refund', 'tax', 'fee', 'cost'];
const COST_CLASSES = ['variable_direct', 'semi_variable', 'fixed_overhead', 'customer_acquisition'];
const LEG_TYPES = ['inbound_pstn', 'app_client', 'outbound_pstn', 'sip', 'other'];
const HOUSEHOLD_MATCHES = ['via_call', 'via_parent', 'via_number', 'ambiguous', 'unmatched'];
const CATEGORIES = [
  'subscription', 'vat_output', 'store_commission', 'payment_processing_fee', 'refund',
  'number_rental', 'inbound_voice', 'app_leg', 'outbound_voice', 'media_stream', 'tts',
  'channel_capacity', 'platform_fee', 'sms', 'transcription', 'ai_inference', 'email',
  'hosting', 'database', 'domain', 'developer_program', 'saas', 'insurance', 'accountancy',
  'other_overhead', 'advertising', 'acquisition_other', 'other',
];

// Where a figure came from, strongest first. A weaker source never replaces
// a stronger one for the same entry (see services/ledger/reconcile.js).
const PROVENANCE_RANK = { provider_actual: 3, provider_allocated: 2, manual: 2, estimated: 1 };

const SLUG = /^[a-z][a-z0-9_]{1,31}$/;
const CURRENCY = /^[A-Z]{3}$/;

// Units a provider bills for a duration under a given model. Returns null
// when the model isn't duration-based (channel, number, fixed period…).
function billedQuantityForDuration(billingModel, durationSeconds, incrementSeconds) {
  if (!Number.isFinite(durationSeconds) || durationSeconds < 0) return null;
  switch (billingModel) {
    case 'per_second':
      return durationSeconds;
    case 'per_minute':
      return durationSeconds / 60;
    case 'per_started_minute': {
      const step = incrementSeconds || 60;
      return Math.ceil(durationSeconds / step) * (step / 60);
    }
    default:
      return null;
  }
}

function problemsWithLeg(leg) {
  const p = [];
  if (!leg || typeof leg !== 'object') return ['leg is not an object'];
  if (!SLUG.test(leg.provider || '')) p.push('provider must be a lower-case slug');
  if (!leg.provider_call_id) p.push('provider_call_id is required');
  if (!LEG_TYPES.includes(leg.leg_type)) p.push(`leg_type must be one of ${LEG_TYPES.join(', ')}`);
  if (leg.household_match && !HOUSEHOLD_MATCHES.includes(leg.household_match)) p.push('invalid household_match');
  if (leg.billing_model != null && !BILLING_MODELS.includes(leg.billing_model)) p.push('invalid billing_model');
  if (leg.provider_duration_seconds != null && !(leg.provider_duration_seconds >= 0)) p.push('provider_duration_seconds must be >= 0');
  if (!RECONCILIATION_STATUSES.includes(leg.reconciliation_status)) p.push('invalid reconciliation_status');
  if (leg.reconciliation_status === 'final' && !leg.finalised_at) p.push('a final leg needs finalised_at');
  return p;
}

function problemsWithEntry(e) {
  const p = [];
  if (!e || typeof e !== 'object') return ['entry is not an object'];
  if (!SLUG.test(e.source_system || '')) p.push('source_system must be a lower-case slug');
  if (!SLUG.test(e.supplier || '')) p.push('supplier must be a lower-case slug');
  if (!e.entry_key) p.push('entry_key is required');
  if (!ENTRY_CLASSES.includes(e.entry_class)) p.push('invalid entry_class');
  if (!CATEGORIES.includes(e.category)) p.push('invalid category');
  if (e.billing_model != null && !BILLING_MODELS.includes(e.billing_model)) p.push('invalid billing_model');
  if (!PROVENANCE.includes(e.provenance)) p.push('invalid provenance');
  if (!RECONCILIATION_STATUSES.includes(e.reconciliation_status)) p.push('invalid reconciliation_status');
  if (e.native_currency != null && !CURRENCY.test(e.native_currency)) p.push('native_currency must be a 3-letter upper-case code');
  if (e.amount != null && !(e.amount >= 0)) p.push('amount must be >= 0 (direction comes from entry_class)');

  const isCostLike = e.entry_class === 'cost' || e.entry_class === 'fee';
  if (isCostLike && !COST_CLASSES.includes(e.cost_class)) p.push('costs and fees must carry a cost_class');
  if (!isCostLike && e.cost_class != null) p.push('revenue, refunds and tax never carry a cost_class');

  const isActual = e.provenance === 'provider_actual';
  if (isActual && !CHARGE_OBSERVATIONS.includes(e.charge_observation)) p.push('provider_actual entries must state a charge_observation');
  if (!isActual && e.charge_observation != null) p.push('only provider_actual entries carry a charge_observation');

  if (['not_observed', 'unavailable', 'pending'].includes(e.charge_observation) && (e.amount != null || e.native_amount != null)) {
    p.push(`a ${e.charge_observation} charge must not carry an amount (absence of a charge is never £0)`);
  }
  if (e.charge_observation === 'reported_zero' && !(e.amount === 0 && e.native_amount === 0 && e.native_currency)) {
    p.push('reported_zero requires amount 0, native_amount 0 and a currency');
  }
  if (e.charge_observation === 'reported_amount' && (e.amount == null || e.native_amount == null || !e.native_currency)) {
    p.push('reported_amount requires amount, native_amount and native_currency');
  }
  if (!isActual && (e.amount == null || !e.native_currency || !e.allocation_basis)) {
    p.push('allocated, estimated and manual entries need amount, native_currency and allocation_basis');
  }
  if (e.provenance === 'provider_allocated' && !e.source_reference) p.push('allocated entries must cite source_reference');
  if (e.period_start && e.period_end && new Date(e.period_end) <= new Date(e.period_start)) p.push('period_end must be after period_start');
  if (e.reconciliation_status === 'final' && !e.finalised_at) p.push('a final entry needs finalised_at');
  return p;
}

function assertValidEntry(e) {
  const p = problemsWithEntry(e);
  if (p.length) throw new Error(`invalid financial entry ${e && e.entry_key}: ${p.join('; ')}`);
  return e;
}

function assertValidLeg(leg) {
  const p = problemsWithLeg(leg);
  if (p.length) throw new Error(`invalid telephony leg ${leg && leg.provider_call_id}: ${p.join('; ')}`);
  return leg;
}

// Rounds a money value to the ledger's 6 decimal places, avoiding float
// artefacts like 0.030230000000000002.
function money(n) {
  return Math.round(n * 1e6) / 1e6;
}

module.exports = {
  BILLING_MODELS,
  PROVENANCE,
  PROVENANCE_RANK,
  CHARGE_OBSERVATIONS,
  RECONCILIATION_STATUSES,
  ENTRY_CLASSES,
  COST_CLASSES,
  LEG_TYPES,
  HOUSEHOLD_MATCHES,
  CATEGORIES,
  billedQuantityForDuration,
  problemsWithLeg,
  problemsWithEntry,
  assertValidEntry,
  assertValidLeg,
  money,
};
