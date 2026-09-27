// STAGING-ONLY end-to-end validation of the financial ledger (migration 048)
// through the real application path: supabase-js with the service role, the
// ledger writer, the Twilio adapter and the reporting views. Uses synthetic
// data only (SIDs prefixed LEDGERVAL, household emails @example.invalid) and
// deletes everything it created at the end, even on failure.
//
// Synthetic households/calls are created by the caller through SQL (the
// service role has no INSERT on households by design) and passed in via
// LEDGERVAL_HOUSEHOLD_ID / LEDGERVAL_CALL_ID.
//
// Refuses to run unless SUPABASE_URL is the staging project.
//
// Run with: node scripts/ledger-staging-validation.js   (env: staging URL + service-role key + anon key)
'use strict';

const STAGING_REF = 'tigwgmayeuisrxjjykqd';

let failures = 0;
const results = [];
function check(ok, message) {
  results.push(`${ok ? '✓' : '✗'} ${message}`);
  if (!ok) failures++;
}

async function main() {
  const url = process.env.SUPABASE_URL || '';
  if (!url.includes(STAGING_REF)) throw new Error('REFUSED: SUPABASE_URL is not the staging project');
  const householdId = process.env.LEDGERVAL_HOUSEHOLD_ID;
  const callId = process.env.LEDGERVAL_CALL_ID;
  if (!householdId || !callId) throw new Error('LEDGERVAL_HOUSEHOLD_ID and LEDGERVAL_CALL_ID are required');

  const { createClient } = require('@supabase/supabase-js');
  const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const anon = createClient(url, process.env.SUPABASE_ANON_KEY);
  const repoModule = require('../database/financialLedger');
  const repo = {
    getLeg: (p, id) => repoModule.getLeg(p, id, { admin }),
    upsertLeg: (l) => repoModule.upsertLeg(l, { admin }),
    getEntry: (s, k) => repoModule.getEntry(s, k, { admin }),
    upsertEntry: (e) => repoModule.upsertEntry(e, { admin }),
    listLegsAwaitingReconciliation: (a) => repoModule.listLegsAwaitingReconciliation(a, { admin }),
    recordLegAttemptFailure: (id, m) => repoModule.recordLegAttemptFailure(id, m, { admin }),
    markLegUnavailable: (id) => repoModule.markLegUnavailable(id, { admin }),
  };
  const twilio = require('../services/telephony/twilio/billingRecords');
  const { recordCall, recordEntry } = require('../services/ledger/ledgerWriter');
  const { reconcilePendingLegs } = require('../services/ledger/reconciliationWorker');
  const { transcriptionEstimate } = require('../services/ledger/estimates');

  const now = new Date();
  const earlier = new Date(now.getTime() - 3 * 86400000);
  const link = { callId, householdId, householdMatch: 'via_call' };
  const parent = { sid: 'CA_LEDGERVAL_PARENT', parentCallSid: null, accountSid: 'AC_LEDGERVAL', direction: 'inbound', status: 'completed',
    duration: '239', price: '-0.03023', priceUnit: 'GBP', startTime: earlier, endTime: new Date(earlier.getTime() + 239000), to: '+440000000000', from: '+440000000001' };
  const child = { sid: 'CA_LEDGERVAL_CHILD', parentCallSid: parent.sid, accountSid: 'AC_LEDGERVAL', direction: 'outbound-dial', status: 'completed',
    duration: '235', price: null, priceUnit: 'GBP', startTime: new Date(now.getTime() - 60000), endTime: now, to: 'client:household_ledgerval' };

  try {
    // 1. Idempotent ingestion of a priced leg.
    const a = await recordCall(twilio.normaliseCall(parent, link, { now }), repo);
    const b = await recordCall(twilio.normaliseCall(parent, link, { now }), repo);
    const { data: legs } = await admin.from('telephony_call_legs').select('id, billed_quantity, reconciliation_status').eq('provider_call_id', parent.sid);
    const { data: pe } = await admin.from('financial_entries').select('*').eq('entry_key', `${parent.sid}:inbound_voice`);
    check(a.written && !b.written && legs.length === 1 && pe.length === 1, 'duplicate provider record ingested twice → one leg, one entry');
    check(Number(pe[0].native_amount) === -0.03023 && Number(pe[0].amount) === 0.03023 && pe[0].native_currency === 'GBP' && Number(legs[0].billed_quantity) === 4,
      'priced leg stored with native signed amount, currency and 4 started minutes');

    // 2. Missing pricing → pending (no amount) → price appears via the worker (transition flagged).
    await recordCall(twilio.normaliseCall(child, { ...link, householdMatch: 'via_parent' }, { now }), repo);
    const { data: ce1 } = await admin.from('financial_entries').select('charge_observation, amount').eq('entry_key', `${child.sid}:app_leg`).single();
    check(ce1.charge_observation === 'pending' && ce1.amount === null, 'unpriced app leg stored as pending with no amount (never £0)');
    await admin.from('telephony_call_legs').update({ updated_at: new Date(now.getTime() - 3600000).toISOString() }).eq('provider_call_id', child.sid);
    const worker = await reconcilePendingLegs({ adapter: twilio, source: { fetchCall: async () => ({ ...child, price: '-0.0132' }) }, repo, now, minAgeMs: 60000 });
    const { data: ce2 } = await admin.from('financial_entries').select('charge_observation, amount, reconciliation_status').eq('entry_key', `${child.sid}:app_leg`).single();
    check(worker.recorded === 1 && ce2.charge_observation === 'reported_amount' && Number(ce2.amount) === 0.0132 && ce2.reconciliation_status === 'final',
      'reconciliation worker: pending → reported_amount / final when the provider prices the leg');
    const nobs = twilio.normaliseCall({ ...child, sid: 'CA_LEDGERVAL_NOPRICE', price: null, startTime: earlier, endTime: earlier }, { ...link, householdMatch: 'via_parent' }, { now });
    await recordCall(nobs, repo);
    const { data: ne } = await admin.from('financial_entries').select('charge_observation, amount').eq('entry_key', 'CA_LEDGERVAL_NOPRICE:app_leg').single();
    check(ne.charge_observation === 'not_observed' && ne.amount === null, 'no price after the window → not_observed, no amount');
    const flip = await recordEntry({ ...nobs.entry, telephony_leg_id: null, charge_observation: 'reported_amount', native_amount: -0.01, amount: 0.01, native_currency: 'GBP' }, repo);
    check(flip.written && flip.flags.includes('charge_appeared_after_not_observed'), 'a price appearing after not_observed is written and flagged (app-leg billing detection)');
    const changed = await recordEntry({ ...twilio.normaliseCall(parent, link, { now }).entry, telephony_leg_id: pe[0].telephony_leg_id, native_amount: -0.04, amount: 0.04 }, repo);
    const { data: pe2 } = await admin.from('financial_entries').select('reconciliation_status, evidence').eq('entry_key', `${parent.sid}:inbound_voice`).single();
    check(changed.flags.includes('provider_amount_changed_after_final') && pe2.reconciliation_status === 'mismatch' && Number(pe2.evidence.previous.amount) === 0.03023,
      'a changed provider price after final → mismatch, previous value preserved');

    // 3. Media Streams estimate → allocation upgrade (one row), TTS, SMS, rental, transcription, unallocated.
    await recordEntry(twilio.mediaStreamEstimate({ callSid: parent.sid, streamSeconds: 295, ratePerMinute: 0.00333, occurredAt: earlier, householdId, callId }), repo);
    const up = await recordEntry(twilio.allocateDailyMediaStreams({ date: earlier.toISOString().slice(0, 10), usageTotal: 0.01663, currency: 'GBP', calls: [{ callSid: parent.sid, streamSeconds: 295, occurredAt: earlier, householdId, callId }], now })[0], repo);
    const { data: ms } = await admin.from('financial_entries').select('provenance, amount').eq('entry_key', `${parent.sid}:media_stream`);
    check(up.flags.includes('provenance_upgraded') && ms.length === 1 && ms[0].provenance === 'provider_allocated' && Number(ms[0].amount) === 0.01663,
      'Media Streams: estimate upgraded in place to the allocated share (single row)');
    for (const e of twilio.allocateDailyTts({ date: earlier.toISOString().slice(0, 10), usageTotal: 0.0006, currency: 'GBP', calls: [{ callSid: parent.sid, occurredAt: earlier, householdId, callId }], now })) await recordEntry(e, repo);
    await recordEntry(twilio.normaliseMessage({ sid: 'SM_LEDGERVAL_1', status: 'delivered', numSegments: '2', price: '-0.08465', priceUnit: 'GBP', dateCreated: earlier, dateSent: earlier }, { householdId, householdMatch: 'via_number' }, { now }), repo);
    for (const e of twilio.allocateDailyNumberRental({ date: earlier.toISOString().slice(0, 10), usageTotal: 0.86917, usageCount: 1, currency: 'GBP',
      numbers: [{ sid: 'PN_LEDGERVAL', dateCreated: new Date(Date.UTC(earlier.getUTCFullYear(), earlier.getUTCMonth() - 1, earlier.getUTCDate())).toISOString(), householdId }], now })) await recordEntry(e, repo);
    await recordEntry(transcriptionEstimate({ callSid: parent.sid, callId, householdId, monitoredSeconds: 295, occurredAt: earlier }), repo);
    await recordEntry(twilio.unallocatedDailyCharge({ date: earlier.toISOString().slice(0, 10), category: 'sms', sourceCategory: 'ledgerval-fee', amount: 0.00076, currency: 'GBP', reason: 'synthetic unallocated fee', now }), repo);

    // 4. Reporting views through the service role.
    const { data: rep } = await admin.from('finance_entries_reporting').select('entry_key, category, dashboard_bucket, amount_quality, is_unallocated')
      .or('entry_key.like.%LEDGERVAL%,entry_key.like.%ledgerval%');
    const q = (k) => rep.find((r) => r.entry_key === k) || {};
    const cats = new Set(rep.map((r) => r.category));
    check(['inbound_voice', 'app_leg', 'media_stream', 'tts', 'sms', 'number_rental', 'transcription'].every((c) => cats.has(c)),
      'all telephony categories plus transcription are present through the reporting view');
    check(q(`${parent.sid}:inbound_voice`).amount_quality === 'ACTUAL' && q(`${parent.sid}:media_stream`).amount_quality === 'ALLOCATED'
      && q(`${parent.sid}:transcription`).amount_quality === 'ESTIMATED' && q(`${parent.sid}:transcription`).dashboard_bucket === 'ai_transcription'
      && q('CA_LEDGERVAL_NOPRICE:app_leg').amount_quality === 'ACTUAL',
      'reporting view keeps ACTUAL / ALLOCATED / ESTIMATED distinct');
    const unalloc = rep.find((r) => r.entry_key.includes('ledgerval-fee'));
    check(unalloc && unalloc.is_unallocated === true, 'unallocated account-level charge is marked is_unallocated');
    const { data: contrib, error: contribErr } = await admin.from('finance_monthly_contribution').select('native_currency, direct_service_costs');
    check(!contribErr && contrib.some((r) => r.native_currency === 'USD') && contrib.some((r) => r.native_currency === 'GBP'), 'contribution view returns separate GBP and USD rows');

    // 5. Access control through PostgREST.
    for (const t of ['financial_entries', 'telephony_call_legs', 'finance_entries_reporting', 'finance_monthly_contribution']) {
      const { data, error } = await anon.from(t).select('*').limit(1);
      check(error !== null || (Array.isArray(data) && data.length === 0), `anon key cannot read ${t} (${error ? error.code || error.message : 'no rows'})`);
    }
    const { error: anonWrite } = await anon.from('financial_entries').insert({ source_system: 'hcg', supplier: 'hcg', entry_key: 'LEDGERVAL_anon', entry_class: 'cost', category: 'other', cost_class: 'variable_direct', provenance: 'manual', amount: 1, native_currency: 'GBP', allocation_basis: 'x', reconciliation_status: 'pending' });
    check(anonWrite !== null, 'anon key cannot write financial_entries');
  } finally {
    // Cleanup of everything this script created (households/calls are removed by the caller).
    await admin.from('financial_entries').delete().or('entry_key.like.%LEDGERVAL%,entry_key.like.%ledgerval%,native_reference.like.%LEDGERVAL%');
    await admin.from('telephony_call_legs').delete().like('provider_call_id', '%LEDGERVAL%');
    const { count: e } = await admin.from('financial_entries').select('*', { count: 'exact', head: true }).or('entry_key.like.%LEDGERVAL%,entry_key.like.%ledgerval%');
    const { count: l } = await admin.from('telephony_call_legs').select('*', { count: 'exact', head: true }).like('provider_call_id', '%LEDGERVAL%');
    check(e === 0 && l === 0, `cleanup: synthetic ledger rows removed (entries ${e}, legs ${l})`);
  }
  console.log(results.join('\n'));
  console.log(failures === 0 ? '\nAll staging checks passed.' : `\n${failures} staging check(s) failed.`);
  process.exitCode = failures === 0 ? 0 : 1;
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exitCode = 1; });
