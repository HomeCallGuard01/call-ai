// Historical backfill of the financial ledger (migration 051) from a
// telephony provider's own records. READ-ONLY BY DEFAULT: it reads the HCG
// calls/households tables and the provider's call and daily-usage records,
// builds the ledger rows it would write (services/ledger/backfillPlan.js)
// and prints a reconciliation report. It writes nothing unless ALL of these
// are true:
//   --apply --target=staging
//   SUPABASE_URL is the STAGING project
//   LEDGER_BACKFILL_CONFIRM=write-staging
// Production is refused unconditionally in code; writing historical
// production records needs a code change and explicit approval.
//
// Run with (dry run):
//   node scripts/ledger-backfill.js [--from=2026-07-01] [--to=2026-09-28] [--json=/path/report.json]
'use strict';

require('dotenv').config();

const PRODUCTION_PROJECT_REF = 'psbzynxplxfbyrbdidmn';
const STAGING_PROJECT_REF = 'tigwgmayeuisrxjjykqd';
const DEFAULT_MEDIA_STREAM_RATE_GBP_PER_MIN = 0.00333; // HCG estimate, only where no daily total exists

function parseArgs(argv) {
  const args = { apply: false, target: null, from: null, to: null, json: null };
  for (const a of argv) {
    if (a === '--apply') args.apply = true;
    else if (a.startsWith('--target=')) args.target = a.slice(9);
    else if (a.startsWith('--from=')) args.from = a.slice(7);
    else if (a.startsWith('--to=')) args.to = a.slice(5);
    else if (a.startsWith('--json=')) args.json = a.slice(7);
    else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

// Throws unless a write is explicitly and safely targeted at staging.
function assertSafeApplyTarget({ supabaseUrl, target, confirm }) {
  const url = String(supabaseUrl || '');
  if (url.includes(PRODUCTION_PROJECT_REF)) {
    throw new Error('REFUSED: SUPABASE_URL is the PRODUCTION project. Historical production writes are not permitted by this script.');
  }
  if (target !== 'staging') throw new Error('REFUSED: --apply requires --target=staging');
  if (!url.includes(STAGING_PROJECT_REF)) throw new Error('REFUSED: --target=staging but SUPABASE_URL is not the staging project');
  if (confirm !== 'write-staging') throw new Error('REFUSED: set LEDGER_BACKFILL_CONFIRM=write-staging to write');
}

function isoDay(d) {
  return new Date(d).toISOString().slice(0, 10);
}

async function readHcgData(admin) {
  const [calls, households] = await Promise.all([
    admin.from('calls').select('id, call_sid, household_id, status, created_at, monitored_duration_seconds'),
    admin.from('households').select('id, twilio_number'),
  ]);
  if (calls.error) throw calls.error;
  if (households.error) throw households.error;
  return { hcgCalls: calls.data || [], households: households.data || [] };
}

/**
 * @param {object} deps - { admin, source, adapter, now, apply, repo }
 */
async function runBackfill({ admin, source, adapter, now = new Date(), from, to, apply = false, repo = null, mediaStreamRatePerMinute = DEFAULT_MEDIA_STREAM_RATE_GBP_PER_MIN }) {
  const { buildBackfillPlan } = require('../services/ledger/backfillPlan');
  const { hcgCalls, households } = await readHcgData(admin);

  const earliest = hcgCalls.reduce((min, c) => (c.created_at && c.created_at < min ? c.created_at : min), now.toISOString());
  const start = from ? new Date(`${from}T00:00:00Z`) : new Date(new Date(earliest).getTime() - 24 * 60 * 60 * 1000);
  const end = to ? new Date(`${to}T23:59:59Z`) : now;

  const providerCalls = await source.listCalls({ startTimeAfter: start, startTimeBefore: end });
  const usageRecords = await source.listDailyUsage({ startDate: isoDay(start), endDate: isoDay(end) });
  const providerMessages = source.listMessages ? await source.listMessages({ dateSentAfter: start, dateSentBefore: end }) : [];
  const ownedNumbers = source.listOwnedNumbers ? await source.listOwnedNumbers() : [];

  const plan = buildBackfillPlan({ adapter, hcgCalls, households, providerCalls, usageRecords, now, mediaStreamRatePerMinute, providerMessages, ownedNumbers });
  plan.report.range = { from: start.toISOString(), to: end.toISOString() };

  if (!apply) return plan;

  const { recordCall, recordEntry } = require('../services/ledger/ledgerWriter');
  const byCallSid = new Map(plan.entries.filter((e) => e.provenance === 'provider_actual').map((e) => [e.native_reference, e]));
  let written = 0;
  for (const leg of plan.legs) {
    const result = await recordCall({ leg, entry: byCallSid.get(leg.provider_call_id) }, repo);
    if (result.written) written += 1;
  }
  for (const e of plan.entries.filter((x) => x.provenance !== 'provider_actual')) {
    const result = await recordEntry(e, repo);
    if (result.written) written += 1;
  }
  plan.report.mode = 'APPLIED to staging';
  plan.report.written = written;
  return plan;
}

function printReport(r) {
  const lines = [
    `Ledger backfill report — ${r.mode}`,
    `Range: ${r.range.from} → ${r.range.to}`,
    '',
    `HCG calls found: ${r.hcgCalls.total} (with CallSid ${r.hcgCalls.withCallSid}; no provider record ${r.hcgCalls.withoutProviderRecord})`,
    `Provider legs found: ${r.providerLegs.total} (parents ${r.providerLegs.parents}, children ${r.providerLegs.children}) ${JSON.stringify(r.providerLegs.byLegType)}`,
    `Exact call-ID matches (parents): ${r.exactCallIdMatches}`,
    `Household matches (all legs): ${JSON.stringify(r.householdMatches)}`,
    `Unmatched legs: ${r.unmatched.count}`,
    `Ambiguous legs: ${r.ambiguous.count}`,
    `Charge observations: ${JSON.stringify(r.chargeObservations)}`,
    `Media Streams: ${JSON.stringify(r.mediaStreams)} | Polly shares: ${r.tts.allocatedShares} | rental shares: ${r.numberRental.allocatedShares} | SMS: ${JSON.stringify(r.sms)}`,
    `Transcription: ${r.transcription.estimatedCalls} monitored calls, ≈ $${r.transcription.estimatedUsd} USD (${r.transcription.status})`,
    `UNALLOCATED (real supplier charges with no evidence-based customer): ${r.unallocated.total} ${r.totals.currency} ${JSON.stringify(r.unallocated.byCategory)}; whole days ${r.unallocated.wholeDaysUnallocated}; residuals ${r.unallocated.residuals.length}`,
    `Ledger exceeds supplier (needs review): ${r.ledgerExceedsSupplier.length}`,
    `Planned: ${r.legsPlanned} legs, ${r.entriesPlanned} entries; invalid records: ${r.invalidRecords.length}`,
    '',
    `Supplier total (reconstructable categories): ${r.totals.supplierTotalReconstructableCategories} ${r.totals.currency}`,
    `Reconstructed ledger total:                  ${r.totals.ledgerReconstructedTotal} ${r.totals.currency}`,
    `Discrepancy:                                 ${r.totals.discrepancy} ${r.totals.currency}`,
    ...r.totals.byCategory.map((c) => `  ${c.category.padEnd(15)} supplier ${c.supplierTotal}  ledger ${c.ledgerTotal}  diff ${c.discrepancy}`),
    `Supplier categories not reconstructed per call: ${JSON.stringify(r.totals.supplierCategoriesNotReconstructedPerCall)}`,
    `Unmapped supplier categories: ${JSON.stringify(r.totals.unmappedSupplierCategories)}`,
    `Daily rows needing attention: ${r.dailyMismatches.length}`,
    ...r.dailyMismatches.map((d) => `  ${d.date} ${d.category}: supplier ${d.supplierTotal} ledger ${d.ledgerTotal} (${d.status}) ${d.flags.join(',')}`),
  ];
  console.log(lines.join('\n'));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.apply) {
    assertSafeApplyTarget({ supabaseUrl: process.env.SUPABASE_URL, target: args.target, confirm: process.env.LEDGER_BACKFILL_CONFIRM });
  }
  const { supabaseAdmin } = require('../services/supabaseClients');
  const { twilioRestClient } = require('../services/twilioClient');
  if (!supabaseAdmin || !twilioRestClient) throw new Error('Supabase admin and Twilio credentials are both required');
  const adapter = require('../services/telephony/twilio/billingRecords');
  const repo = args.apply ? require('../database/financialLedger') : null;

  const plan = await runBackfill({
    admin: supabaseAdmin,
    source: adapter.createTwilioBillingSource(twilioRestClient),
    adapter,
    from: args.from,
    to: args.to,
    apply: args.apply,
    repo: repo && {
      getLeg: (p, id) => repo.getLeg(p, id),
      upsertLeg: (l) => repo.upsertLeg(l),
      getEntry: (s, k) => repo.getEntry(s, k),
      upsertEntry: (e) => repo.upsertEntry(e),
    },
  });
  printReport(plan.report);
  if (args.json) {
    require('fs').writeFileSync(args.json, JSON.stringify(plan.report, null, 2));
    console.log(`\nJSON report written to ${args.json}`);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, assertSafeApplyTarget, runBackfill, PRODUCTION_PROJECT_REF, STAGING_PROJECT_REF };
