// Unit tests for the provider-neutral financial ledger: contract,
// allocation, reconciliation rules, the Twilio adapter, the ledger writer,
// the reconciliation worker, the backfill plan and the backfill write
// guard. No network, no database: every provider response and repository
// is a fixture or an in-memory fake.
//
// Run with: node tests/financial-ledger.test.mjs

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const contract = require('../services/ledger/contract.js');
const { apportion } = require('../services/ledger/allocation.js');
const { decideEntryWrite, reconcileDailyTotals } = require('../services/ledger/reconcile.js');
const twilio = require('../services/telephony/twilio/billingRecords.js');
const { recordCall, recordEntry } = require('../services/ledger/ledgerWriter.js');
const { reconcilePendingLegs, dailyReconciliation } = require('../services/ledger/reconciliationWorker.js');
const { buildBackfillPlan } = require('../services/ledger/backfillPlan.js');
const { assertSafeApplyTarget, parseArgs, runBackfill } = require('../scripts/ledger-backfill.js');

let failures = 0;
function check(condition, message) {
  if (condition) {
    console.log(`✓ ${message}`);
  } else {
    console.error(`✗ ${message}`);
    failures++;
  }
}
function throws(fn, message) {
  try {
    fn();
    check(false, message);
  } catch (err) {
    check(true, `${message} (${err.message.slice(0, 90)})`);
  }
}

const NOW = new Date('2026-09-27T12:00:00Z');

// Shapes as returned by Twilio's Calls API for the real trusted call traced
// on 2026-09-26 (CA43b447…): parent inbound 239 s, £-0.03023; child client
// leg 235 s, price null. Phone numbers replaced with obviously fake ones.
const trustedParent = {
  sid: 'CA43b4477617567d59553d82fe3bdd8e02', parentCallSid: null, accountSid: 'AC_fixture',
  direction: 'inbound', status: 'completed', duration: '239', price: '-0.03023', priceUnit: 'GBP',
  startTime: new Date('2026-09-12T08:54:36Z'), endTime: new Date('2026-09-12T08:58:35Z'),
  from: '+447700900001', to: '+441234000533',
};
const trustedChild = {
  sid: 'CAd7aa5b971ef50bc610749570c043db3a', parentCallSid: trustedParent.sid, accountSid: 'AC_fixture',
  direction: 'outbound-dial', status: 'completed', duration: '235', price: null, priceUnit: 'GBP',
  startTime: new Date('2026-09-12T08:54:40Z'), endTime: new Date('2026-09-12T08:58:35Z'),
  from: '+447700900001', to: 'client:household_11111111-1111-1111-1111-111111111111',
};

// ---------------- contract ----------------
check(contract.billedQuantityForDuration('per_started_minute', 239, 60) === 4, 'per_started_minute: 239 s bills 4 minutes');
check(contract.billedQuantityForDuration('per_started_minute', 0, 60) === 0, 'per_started_minute: 0 s bills nothing');
check(contract.billedQuantityForDuration('per_second', 239) === 239, 'per_second: 239 s bills 239 units');
check(Math.abs(contract.billedQuantityForDuration('per_minute', 90) - 1.5) < 1e-9, 'per_minute: 90 s is 1.5 minutes (pro rata)');
check(contract.billedQuantityForDuration('per_channel', 300) === null, 'per_channel is not duration-based');
check(
  contract.problemsWithEntry({
    source_system: 'twilio', supplier: 'twilio', entry_key: 'x', entry_class: 'cost', category: 'app_leg', cost_class: 'variable_direct',
    provenance: 'provider_actual', charge_observation: 'not_observed', amount: 0, native_amount: 0, reconciliation_status: 'final', finalised_at: 'x',
  }).some((p) => p.includes('never £0')),
  'contract rejects a not_observed charge carrying £0'
);
check(
  contract.problemsWithEntry({
    source_system: 'hcg', supplier: 'twilio', entry_key: 'x', entry_class: 'cost', category: 'media_stream', cost_class: 'variable_direct',
    provenance: 'provider_allocated', amount: 0.01, native_currency: 'GBP', allocation_basis: 'b', reconciliation_status: 'provisional',
  }).some((p) => p.includes('source_reference')),
  'contract rejects an allocated charge that does not cite its supplier aggregate'
);
check(
  contract.problemsWithEntry({
    source_system: 'stripe', supplier: 'stripe', entry_key: 'x', entry_class: 'revenue', category: 'subscription', cost_class: 'variable_direct',
    provenance: 'provider_actual', charge_observation: 'reported_amount', amount: 4.99, native_amount: 4.99, native_currency: 'GBP', reconciliation_status: 'provisional',
  }).some((p) => p.includes('never carry a cost_class')),
  'contract rejects revenue with a cost class'
);
check(contract.money(0.1 + 0.2) === 0.3, 'money() removes float artefacts at 6 dp');

// ---------------- Twilio adapter ----------------
const parent = twilio.normaliseCall(trustedParent, { callId: 'call-1', householdId: 'hh-1', householdMatch: 'via_call' }, { now: NOW });
check(parent.leg.leg_type === 'inbound_pstn' && parent.entry.category === 'inbound_voice', 'real trusted parent → inbound_pstn leg, inbound_voice charge');
check(parent.leg.provider_duration_seconds === 239 && parent.leg.billed_quantity === 4 && parent.leg.billing_model === 'per_started_minute',
  'native duration 239 s preserved; 4 started minutes billed');
check(parent.entry.charge_observation === 'reported_amount' && parent.entry.native_amount === -0.03023 && parent.entry.amount === 0.03023 && parent.entry.native_currency === 'GBP',
  'Twilio price kept verbatim (−0.03023 GBP) with sign-normalised amount 0.03023');
check(parent.entry.reconciliation_status === 'final' && parent.entry.provenance === 'provider_actual', 'a priced, completed leg is final provider_actual');
check(parent.entry.entry_key === `${trustedParent.sid}:inbound_voice`, 'entry key is deterministic (CallSid:category)');
check(contract.problemsWithEntry(parent.entry).length === 0 && contract.problemsWithLeg(parent.leg).length === 0, 'normalised parent passes the contract');
const evidenceText = JSON.stringify([parent.leg.provider_evidence, parent.entry.evidence]);
check(!evidenceText.includes('+44') && !evidenceText.includes('7700900001'), 'no phone numbers are copied into ledger evidence');

const childSoon = twilio.normaliseCall(trustedChild, { householdMatch: 'via_parent' }, { now: new Date('2026-09-12T10:00:00Z') });
check(childSoon.leg.leg_type === 'app_client' && childSoon.entry.category === 'app_leg', 'client: child → app_client leg, app_leg charge');
check(childSoon.entry.charge_observation === 'pending' && childSoon.entry.amount === null, 'unpriced app leg inside the window is PENDING, with no amount');
check(childSoon.leg.reconciliation_status === 'pending' && childSoon.leg.finalised_at === null,
  'a completed leg whose price is still pending stays in the reconciliation queue (not final)');
const childLater = twilio.normaliseCall(trustedChild, { householdMatch: 'via_parent' }, { now: NOW });
check(childLater.entry.charge_observation === 'not_observed' && childLater.entry.amount === null && childLater.entry.native_amount === null,
  'unpriced app leg after the window is NOT_OBSERVED — never recorded as £0');
check(childLater.leg.provider_evidence.client_identity === trustedChild.to, 'the app-leg target (an HCG identifier) is kept as evidence');
const zero = twilio.normaliseCall({ ...trustedChild, sid: 'CA_zero', price: '0' }, {}, { now: NOW });
check(zero.entry.charge_observation === 'reported_zero' && zero.entry.amount === 0 && zero.entry.native_amount === 0,
  'an explicit Twilio price of 0 is recorded as reported_zero');
const ringing = twilio.normaliseCall({ ...trustedParent, sid: 'CA_ringing', status: 'ringing', price: null, endTime: null }, {}, { now: NOW });
check(ringing.entry.charge_observation === 'pending' && ringing.leg.reconciliation_status === 'pending', 'a still-ringing call is pending (leg and charge)');
const noAnswer = twilio.normaliseCall({ ...trustedParent, sid: 'CA_noanswer', status: 'no-answer', duration: '0', price: null }, {}, { now: NOW });
check(noAnswer.entry.charge_observation === 'not_observed' && noAnswer.leg.billed_quantity === 0, 'an unanswered 0 s call with no price is not_observed, 0 billed minutes');
check(twilio.legTypeFor({ direction: 'outbound-dial', to: 'sip:x@y' }) === 'sip', 'sip: target → sip leg');
check(twilio.legTypeFor({ direction: 'outbound-api', to: '+441' }) === 'outbound_pstn', 'outbound to a number → outbound_pstn');

// Real category list from the HCG account (read-only listing 2026-09-27).
const { totals, unmapped } = twilio.supplierDailyTotals([
  { category: 'calls', startDate: '2026-09-19', price: '0.08465', priceUnit: 'gbp' },
  { category: 'calls-inbound', startDate: '2026-09-19', price: '0.06802', priceUnit: 'gbp' },
  { category: 'calls-inbound-local', startDate: '2026-09-19', price: '0.06802', priceUnit: 'gbp' },
  { category: 'calls-media-stream-minutes', startDate: '2026-09-19', price: '0.01663', priceUnit: 'gbp' },
  { category: 'amazon-polly', startDate: '2026-09-19', price: '0.0012', priceUnit: 'gbp' },
  { category: 'calls-text-to-speech', startDate: '2026-09-19', price: '0.0012', priceUnit: 'gbp' },
  { category: 'totalprice', startDate: '2026-09-19', price: '1.9', priceUnit: 'gbp' },
  { category: 'phonenumbers', startDate: '2026-09-19', price: '1.73834', priceUnit: 'gbp' },
  { category: 'phonenumbers-local', startDate: '2026-09-19', price: '1.73834', priceUnit: 'gbp' },
  { category: 'brand-new-category', startDate: '2026-09-19', price: '0.5', priceUnit: 'gbp' },
  { category: 'functions', startDate: '2026-09-19', price: '0', priceUnit: 'gbp' },
]);
const cat = (c) => totals.filter((t) => t.category === c).reduce((s, t) => s + t.amount, 0);
check(cat('inbound_voice') === 0.06802 && cat('media_stream') === 0.01663 && cat('tts') === 0.0012 && cat('number_rental') === 1.73834,
  'usage records map to ledger categories exactly once (roll-ups and duplicates ignored)');
check(totals.every((t) => t.currency === 'GBP'), 'usage currency normalised to upper-case ISO code, not converted');
check(unmapped.length === 1 && unmapped[0].sourceCategory === 'brand-new-category', 'an unknown chargeable category is reported, never silently dropped');

// ---------------- allocation ----------------
const shares = apportion(0.01663, [{ key: 'a', weight: 295 }, { key: 'b', weight: 10 }, { key: 'c', weight: 7 }, { key: 'd', weight: 0 }]);
const shareSum = contract.money(shares.reduce((s, x) => s + x.amount, 0));
check(shareSum === 0.01663, 'allocated shares sum to exactly the supplier total');
check(shares[0].amount > shares[1].amount && shares[1].amount > shares[2].amount && shares[3].amount === 0, 'shares are proportional to weight; zero weight gets nothing');
check(JSON.stringify(apportion(1, [{ key: 'x', weight: 1 }, { key: 'y', weight: 1 }, { key: 'z', weight: 1 }]).map((s) => s.amount)) === JSON.stringify([0.333334, 0.333333, 0.333333]),
  'largest-remainder rounding is deterministic and exact (1.000000 across three equal shares)');

const estimate = twilio.mediaStreamEstimate({ callSid: 'CA1', streamSeconds: 295, ratePerMinute: 0.00333, occurredAt: NOW, callId: 'c1', householdId: 'h1' });
check(estimate.provenance === 'estimated' && estimate.native_quantity === 5 && estimate.amount === 0.01665 && contract.problemsWithEntry(estimate).length === 0,
  'Media Stream estimate: ceil(295/60)=5 min × rate, labelled estimated with its basis');
const [allocated] = twilio.allocateDailyMediaStreams({ date: '2026-09-19', usageTotal: 0.01663, currency: 'GBP', calls: [{ callSid: 'CA1', streamSeconds: 295, occurredAt: NOW }], now: NOW });
check(allocated.provenance === 'provider_allocated' && allocated.charge_observation === null && allocated.source_reference.includes('calls-media-stream-minutes 2026-09-19'),
  'daily Media Stream share is provider_allocated, cites the usage record, and carries no provider observation');
check(allocated.source_system === estimate.source_system && allocated.entry_key === estimate.entry_key,
  'estimate and allocation share one ledger key, so a call never carries both');

// ---------------- write rules ----------------
const up = decideEntryWrite(estimate, allocated);
check(up.write && up.flags.includes('provenance_upgraded') && up.entry.evidence.superseded.provenance === 'estimated',
  'an allocation upgrades an estimate in place, keeping the superseded figure');
check(!decideEntryWrite(allocated, estimate).write, 'an estimate never replaces an allocation');
check(!decideEntryWrite(parent.entry, { ...allocated, provenance: 'provider_allocated' }).write, 'nothing weaker replaces a provider_actual figure');
const appeared = decideEntryWrite(childLater.entry, { ...childLater.entry, charge_observation: 'reported_amount', native_amount: -0.01, amount: 0.01, native_currency: 'GBP' });
check(appeared.write && appeared.flags.includes('charge_appeared_after_not_observed'),
  'a price appearing on a leg previously not_observed is written AND flagged (Twilio starting to bill app legs)');
check(!decideEntryWrite(parent.entry, { ...parent.entry, charge_observation: 'pending', native_amount: null, amount: null }).write,
  'a later pending fetch never erases an observed price');
const corrected = decideEntryWrite(parent.entry, { ...parent.entry, native_amount: -0.04, amount: 0.04 });
check(corrected.write && corrected.entry.reconciliation_status === 'mismatch' && corrected.entry.evidence.previous.amount === 0.03023,
  'a changed supplier price after final is kept as a correction, marked mismatch, previous value preserved');
check(!decideEntryWrite(parent.entry, { ...parent.entry }).write, 'an identical re-fetch writes nothing (idempotent)');

// ---------------- daily reconciliation ----------------
const daily = reconcileDailyTotals({
  entries: [parent.entry, childLater.entry],
  supplierTotals: [
    { date: '2026-09-12', category: 'inbound_voice', amount: 0.03023, currency: 'GBP' },
    { date: '2026-09-12', category: 'app_leg', amount: 0.016, currency: 'GBP', sourceCategory: 'calls-client' },
  ],
});
const inboundRow = daily.find((r) => r.category === 'inbound_voice');
const appRow = daily.find((r) => r.category === 'app_leg');
check(inboundRow.status === 'match' && inboundRow.difference === 0, 'ledger inbound total matches Twilio usage total for the day');
check(appRow.status === 'mismatch' && appRow.flags.includes('supplier_charging_category_ledger_saw_as_uncharged'),
  'Twilio billing app legs on a day the ledger saw them as uncharged is a flagged mismatch');

// ---------------- writer + worker with in-memory repo ----------------
function memoryRepo() {
  const legs = new Map();
  const entries = new Map();
  let id = 0;
  return {
    legs, entries,
    getLeg: async (p, cid) => legs.get(`${p}|${cid}`) || null,
    upsertLeg: async (leg) => { const k = `${leg.provider}|${leg.provider_call_id}`; const row = { id: (legs.get(k) || {}).id || `leg-${++id}`, attempts: 0, ...legs.get(k), ...leg }; legs.set(k, row); return { id: row.id }; },
    getEntry: async (s, k) => entries.get(`${s}|${k}`) || null,
    upsertEntry: async (e) => { entries.set(`${e.source_system}|${e.entry_key}`, { ...e }); return { id: e.entry_key }; },
    listLegsAwaitingReconciliation: async () => [...legs.values()].filter((l) => ['pending', 'provisional', 'error'].includes(l.reconciliation_status)),
    recordLegAttemptFailure: async (legId) => { for (const l of legs.values()) if (l.id === legId) l.attempts += 1; },
    markLegUnavailable: async (legId) => { for (const l of legs.values()) if (l.id === legId) l.reconciliation_status = 'unavailable'; },
  };
}

const repo = memoryRepo();
const first = await recordCall(parent, repo);
const second = await recordCall(parent, repo);
check(first.written && !second.written && repo.entries.size === 1 && repo.legs.size === 1, 'recording the same call twice creates one leg and one entry');
check(repo.entries.get(`twilio|${trustedParent.sid}:inbound_voice`).telephony_leg_id === first.legId, 'the charge entry points at its leg');
await recordEntry(estimate, repo);
const upgrade = await recordEntry(allocated, repo);
check(upgrade.written && repo.entries.get('hcg|CA1:media_stream').provenance === 'provider_allocated' && repo.entries.size === 2,
  'writer upgrades estimate → allocation in place (still one Media Stream row for the call)');
let rejected = false;
try { await recordEntry({ ...childLater.entry, amount: 0, native_amount: 0 }, repo); } catch { rejected = true; }
check(rejected, 'writer refuses an entry that would turn "not observed" into £0');

const workerRepo = memoryRepo();
await recordCall(childSoon, workerRepo);
const worker = await reconcilePendingLegs({
  adapter: twilio,
  source: { fetchCall: async () => ({ ...trustedChild, price: '-0.0132' }) },
  repo: workerRepo,
  now: NOW,
});
const workerEntry = workerRepo.entries.get(`twilio|${trustedChild.sid}:app_leg`);
check(worker.recorded === 1 && workerEntry.charge_observation === 'reported_amount' && workerEntry.amount === 0.0132,
  'worker re-fetches a pending leg and records the price the provider now reports');
const failRepo = memoryRepo();
await recordCall({ ...childSoon, leg: { ...childSoon.leg, provider_call_id: 'CA_fail', attempts: 0 }, entry: { ...childSoon.entry, entry_key: 'CA_fail:app_leg' } }, failRepo);
const failed = await reconcilePendingLegs({ adapter: twilio, source: { fetchCall: async () => { throw new Error('twilio 503'); } }, repo: failRepo, now: NOW, maxAttempts: 1 });
check(failed.failures === 1 && failed.gaveUp === 1 && [...failRepo.legs.values()][0].reconciliation_status === 'unavailable',
  'repeated provider failures end as unavailable — never as a zero charge');
const dr = await dailyReconciliation({
  adapter: twilio,
  source: { listDailyUsage: async () => [{ category: 'calls-client', startDate: '2026-09-12', price: '0.02', priceUnit: 'GBP' }] },
  entries: [childLater.entry],
  startDate: '2026-09-12', endDate: '2026-09-12',
});
check(dr.alerts.some((a) => a.level === 'critical' && a.category === 'app_leg'), 'daily reconciliation raises a critical alert when Twilio starts billing app legs');

// ---------------- backfill plan ----------------
const monitoredParent = {
  sid: 'CAbeaf3895df3a70f1e2ae2d3e63048a23', parentCallSid: null, accountSid: 'AC_fixture', direction: 'inbound', status: 'completed',
  duration: '299', price: '-0.03779', priceUnit: 'GBP', startTime: new Date('2026-09-19T14:49:28Z'), endTime: new Date('2026-09-19T14:54:27Z'),
  from: '+447700900001', to: '+441234000533',
};
const monitoredChild = { ...trustedChild, sid: 'CA4817952f61f5f032e4af31b372bb5129', parentCallSid: monitoredParent.sid, duration: '288',
  startTime: new Date('2026-09-19T14:49:39Z'), endTime: new Date('2026-09-19T14:54:27Z') };
const orphanByNumber = { ...trustedParent, sid: 'CA_orphan_number', price: '-0.00756', duration: '20', startTime: new Date('2026-09-19T15:00:00Z'), endTime: new Date('2026-09-19T15:00:20Z') };
const orphanShared = { ...trustedParent, sid: 'CA_orphan_shared', to: '+441234000999', price: '-0.00756', duration: '5', startTime: new Date('2026-09-19T16:00:00Z'), endTime: new Date('2026-09-19T16:00:05Z') };
const orphanNone = { ...trustedParent, sid: 'CA_orphan_none', to: '+441234000777', price: '-0.00756', duration: '5', startTime: new Date('2026-09-19T17:00:00Z'), endTime: new Date('2026-09-19T17:00:05Z') };

const plan = buildBackfillPlan({
  adapter: twilio,
  now: NOW,
  mediaStreamRatePerMinute: 0.00333,
  hcgCalls: [
    { id: 'c-trusted', call_sid: trustedParent.sid, household_id: 'hh-1', status: 'Known', created_at: '2026-09-12T08:54:35Z', monitored_duration_seconds: null },
    { id: 'c-monitored', call_sid: monitoredParent.sid, household_id: 'hh-1', status: 'Unknown', created_at: '2026-09-19T14:49:28Z', monitored_duration_seconds: 295 },
    { id: 'c-missing', call_sid: 'CA_not_at_twilio', household_id: 'hh-1', status: 'Known', created_at: '2026-09-20T10:00:00Z', monitored_duration_seconds: null },
  ],
  households: [
    { id: 'hh-1', twilio_number: '+44 1234 000533' },
    { id: 'hh-2', twilio_number: '+441234000999' },
    { id: 'hh-3', twilio_number: '+441234000999' },
  ],
  providerCalls: [trustedParent, trustedChild, monitoredParent, monitoredChild, orphanByNumber, orphanShared, orphanNone],
  usageRecords: [
    { category: 'calls-inbound', startDate: '2026-09-12', price: '0.03023', priceUnit: 'gbp' },
    { category: 'calls-inbound', startDate: '2026-09-19', price: '0.06047', priceUnit: 'gbp' },
    { category: 'calls-media-stream-minutes', startDate: '2026-09-19', price: '0.01663', priceUnit: 'gbp' },
    { category: 'phonenumbers', startDate: '2026-09-19', price: '1.73834', priceUnit: 'gbp' },
  ],
});
const r = plan.report;
check(r.mode.startsWith('dry-run'), 'backfill plan is a dry run');
check(r.providerLegs.total === 7 && r.providerLegs.parents === 5 && r.providerLegs.children === 2, 'report counts provider legs (parents and children)');
check(r.exactCallIdMatches === 2, 'report counts exact CallSid matches to HCG calls');
check(r.householdMatches.via_call === 2 && r.householdMatches.via_parent === 2 && r.householdMatches.via_number === 1,
  'household matches: exact, via parent, and via a number owned by exactly one household');
check(r.ambiguous.count === 1 && r.unmatched.count === 1, 'a number shared by two households is ambiguous; an unknown number is unmatched — neither is guessed');
check(r.hcgCalls.withoutProviderRecord === 1, 'HCG calls with no provider record are reported');
check(!JSON.stringify(r).includes('+44') && !JSON.stringify(r).includes('1234000'), 'the report contains no phone numbers');
check(r.mediaStreams.allocatedFromDailyTotals === 1 && r.mediaStreams.estimatedNoDailyTotal === 0, 'Media Streams allocated from the daily total where one exists');
const inboundCmp = r.totals.byCategory.find((c) => c.category === 'inbound_voice');
check(inboundCmp.supplierTotal === 0.0907 && inboundCmp.ledgerTotal === 0.0907 && inboundCmp.discrepancy === 0,
  'reconstructed inbound total equals the Twilio usage total (0.0907), discrepancy 0');
check(r.totals.byCategory.find((c) => c.category === 'media_stream').discrepancy === 0, 'allocated Media Streams reconcile exactly to the daily total');
check(r.totals.supplierCategoriesNotReconstructedPerCall.some((c) => c.category === 'number_rental'), 'number rental is shown as a supplier total not reconstructed per call');
check(r.invalidRecords.length === 0 && plan.entries.every((e) => contract.problemsWithEntry(e).length === 0), 'every planned entry passes the contract');
check(r.chargeObservations['app_leg:not_observed'] === 2, 'unpriced app legs appear as not_observed in the report');

// ---------------- backfill write guard ----------------
throws(() => assertSafeApplyTarget({ supabaseUrl: 'https://psbzynxplxfbyrbdidmn.supabase.co', target: 'staging', confirm: 'write-staging' }),
  'backfill --apply refuses the production project unconditionally');
throws(() => assertSafeApplyTarget({ supabaseUrl: 'https://tigwgmayeuisrxjjykqd.supabase.co', target: null, confirm: 'write-staging' }),
  'backfill --apply requires --target=staging');
throws(() => assertSafeApplyTarget({ supabaseUrl: 'https://tigwgmayeuisrxjjykqd.supabase.co', target: 'staging', confirm: undefined }),
  'backfill --apply requires the explicit confirmation value');
throws(() => assertSafeApplyTarget({ supabaseUrl: 'https://someother.supabase.co', target: 'staging', confirm: 'write-staging' }),
  'backfill --apply refuses anything that is not the staging project');
let stagingOk = true;
try { assertSafeApplyTarget({ supabaseUrl: 'https://tigwgmayeuisrxjjykqd.supabase.co', target: 'staging', confirm: 'write-staging' }); } catch { stagingOk = false; }
check(stagingOk, 'backfill --apply is permitted only for staging with target and confirmation');
check(parseArgs([]).apply === false, 'the backfill script defaults to dry run');
throws(() => parseArgs(['--aply']), 'a mistyped flag is rejected rather than ignored');

// Dry run performs only reads.
const writes = [];
const readOnlyAdmin = {
  from: (table) => ({
    select: async () => ({ data: table === 'calls' ? [] : [], error: null }),
    upsert: () => { writes.push(table); throw new Error('write attempted'); },
    insert: () => { writes.push(table); throw new Error('write attempted'); },
    update: () => { writes.push(table); throw new Error('write attempted'); },
  }),
};
const dry = await runBackfill({
  admin: readOnlyAdmin,
  source: { listCalls: async () => [trustedParent], listDailyUsage: async () => [] },
  adapter: twilio,
  now: NOW,
});
check(writes.length === 0 && dry.report.mode.startsWith('dry-run') && dry.legs.length === 1, 'a dry run reads data and plans records without a single write');

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
