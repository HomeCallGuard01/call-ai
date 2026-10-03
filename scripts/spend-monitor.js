// Runs one financial-safety evaluation (services/finance/spendMonitor.js)
// and prints the protection level, alerts and per-household economics.
// READ-ONLY: it never writes to any database, never changes a provider
// setting and never sends an alert unless --send-alerts is given.
//
// Sources:
//   --source=ledger            read financial_entries / telephony_call_legs (migration 051 must exist)
//   --source=provider-dry-run  build the ledger rows in memory from the provider's own records
//                              (scripts/ledger-backfill.js dry run) — works before 051 is applied
//
// Run with:
//   node scripts/spend-monitor.js --source=provider-dry-run [--from=2026-09-01] [--json=/path/out.json] [--at=ISO]
'use strict';

require('dotenv').config();

function parseArgs(argv) {
  const args = { source: 'ledger', from: null, json: null, sendAlerts: false, at: null, fxUsd: 0.79 };
  for (const a of argv) {
    if (a.startsWith('--source=')) args.source = a.slice(9);
    else if (a.startsWith('--from=')) args.from = a.slice(7);
    else if (a.startsWith('--json=')) args.json = a.slice(7);
    else if (a.startsWith('--at=')) args.at = a.slice(5);
    else if (a.startsWith('--fx-usd=')) args.fxUsd = Number(a.slice(9));
    else if (a === '--send-alerts') args.sendAlerts = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!['ledger', 'provider-dry-run'].includes(args.source)) throw new Error('--source must be ledger or provider-dry-run');
  return args;
}

function defaultSince(now) {
  // The month so far plus a 15-day anomaly baseline.
  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  return new Date(Math.min(monthStart, now.getTime() - 15 * 86400000)).toISOString();
}

async function activeEntitledHouseholds(admin) {
  const { data, error } = await admin.from('entitlements').select('household_id').eq('status', 'active');
  if (error) throw error;
  return new Set((data || []).map((e) => e.household_id)).size;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const now = args.at ? new Date(args.at) : new Date();
  const since = args.from ? `${args.from}T00:00:00Z` : defaultSince(now);
  const { supabaseAdmin } = require('../services/supabaseClients');
  if (!supabaseAdmin) throw new Error('Supabase admin credentials are required');
  const { runSpendMonitor } = require('../services/finance/spendMonitor');

  let load;
  if (args.source === 'ledger') {
    const { loadSpendMonitorData } = require('../database/financialLedger');
    load = () => loadSpendMonitorData({ since });
  } else {
    load = async () => {
      const { twilioRestClient } = require('../services/twilioClient');
      if (!twilioRestClient) throw new Error('Twilio credentials are required for --source=provider-dry-run');
      const adapter = require('../services/telephony/twilio/billingRecords');
      const { runBackfill } = require('./ledger-backfill');
      const plan = await runBackfill({ admin: supabaseAdmin, source: adapter.createTwilioBillingSource(twilioRestClient), adapter,
        from: since.slice(0, 10), to: now.toISOString().slice(0, 10), now, apply: false });
      const { data: calls, error } = await supabaseAdmin.from('calls').select('id, household_id, status, monitored_duration_seconds').gte('created_at', since);
      if (error) throw error;
      const owned = await adapter.createTwilioBillingSource(twilioRestClient).listOwnedNumbers();
      return {
        entries: plan.entries, legs: plan.legs, calls: calls || [],
        entitledHouseholds: await activeEntitledHouseholds(supabaseAdmin),
        ownedNumbers: owned.length,
        lastIngestedAt: now.toISOString(), // built from the provider just now
      };
    };
  }

  const sendCriticalAlert = args.sendAlerts ? require('../services/alerting').sendCriticalAlert : null;
  const result = await runSpendMonitor({ load, sendCriticalAlert, now, config: { fx: { USD: args.fxUsd } } });
  print(result, args);
  if (args.json) {
    require('fs').writeFileSync(args.json, JSON.stringify(result, null, 2));
    console.log(`\nJSON written to ${args.json}`);
  }
}

function print(r, args) {
  const f = (n) => `£${Number(n).toFixed(2)}`;
  console.log(`Spend monitor — source ${args.source}, as of ${r.asOf} (READ-ONLY${args.sendAlerts ? ', alerts ENABLED' : ', alerts not sent'})`);
  console.log(`Protection level: ${r.protection.name}`);
  for (const reason of r.protection.reasons) console.log(`  · ${reason}`);
  if (!r.ok) return;
  const c = r.metrics.company;
  console.log(`\nToday ${f(c.todaySpendGbp)} · month-to-date ${f(c.monthToDateGbp)} (households ${f(c.householdAttributedGbp)}, unallocated ${f(c.unallocatedGbp)}) · unknown items ${c.unknownItems} · unconverted ${JSON.stringify(c.unconverted)}`);
  console.log(`Entitled households ${c.entitledHouseholds} · households with cost ${c.householdsWithCost} · projected loss-making ${c.projectedLossMakingHouseholds}`);
  console.log('\nAlerts:');
  for (const a of r.alerts) console.log(`  ${a.severity.padEnd(8)} ${a.code}${a.subject ? ` [${String(a.subject).slice(0, 8)}]` : ''}: ${a.detail}`);
  if (!r.alerts.length) console.log('  none');
  console.log('\nTop households (projected month):');
  console.log('  household  mtd     projected  contrib   trusted  unknown  monitored  peak  longest');
  for (const h of r.metrics.households.slice(0, 15)) {
    console.log(`  ${String(h.householdId).slice(0, 8)}  ${f(h.monthToDateGbp).padStart(6)}  ${f(h.projectedMonthGbp).padStart(8)}  ${f(h.projectedContributionGbp).padStart(7)}  ${String(h.trustedMinutes).padStart(7)}  ${String(h.unknownMinutes).padStart(7)}  ${String(h.monitoredMinutes).padStart(9)}  ${String(h.peakConcurrentInbound).padStart(4)}  ${String(h.longestCallMinutes).padStart(7)}`);
  }
  console.log('\nRecommended actions (nothing executed):');
  for (const a of r.protection.actions) console.log(`  - ${a.id} [${a.status}]`);
  if (!r.protection.actions.length) console.log('  none');
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, defaultSince };
