// estimates.js — HCG's own cost estimates for suppliers that don't give HCG
// per-item billing today. Every row is provenance 'estimated', states its
// basis, stays in the supplier's native currency, and is 'unreconciled'
// until a supplier figure exists to check it against.
'use strict';

const { money } = require('./contract');

// OpenAI's published whisper-1 price (USD per audio minute, billed per
// second). ESTIMATED: the configured project key cannot read organisation
// costs, so this is not reconciled against OpenAI billing.
const DEFAULT_TRANSCRIPTION_USD_PER_MINUTE = 0.006;

/**
 * One monitored call's transcription cost estimate. Since the no-overlap
 * fix each second of monitored audio is sent once, so audio minutes ≈
 * monitored seconds / 60 (plus the hang-up tail, which is inside the
 * monitored duration).
 */
function transcriptionEstimate({ callSid, callId = null, householdId = null, monitoredSeconds, occurredAt, usdPerMinute = DEFAULT_TRANSCRIPTION_USD_PER_MINUTE, model = 'whisper-1' }) {
  const seconds = Math.max(0, Number(monitoredSeconds) || 0);
  const minutes = seconds / 60;
  return {
    source_system: 'hcg',
    supplier: 'openai',
    entry_key: `${callSid}:transcription`,
    native_reference: callSid,
    entry_class: 'cost',
    category: 'transcription',
    cost_class: 'variable_direct',
    billing_model: 'per_second',
    provenance: 'estimated',
    charge_observation: null,
    native_amount: null,
    native_currency: 'USD',
    native_quantity: Math.round(minutes * 10000) / 10000,
    native_unit: 'audio-minute',
    amount: money(minutes * usdPerMinute),
    occurred_at: occurredAt ? new Date(occurredAt).toISOString() : null,
    household_id: householdId,
    call_id: callId,
    allocation_basis: `HCG estimate: ${seconds}s monitored audio × OpenAI ${model} list price $${usdPerMinute}/min (audio sent once); not reconciled — no per-call OpenAI billing available`,
    evidence: { model, usd_per_minute: usdPerMinute, monitored_seconds: seconds },
    reconciliation_status: 'unreconciled',
  };
}

module.exports = { transcriptionEstimate, DEFAULT_TRANSCRIPTION_USD_PER_MINUTE };
