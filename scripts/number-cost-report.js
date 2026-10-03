// READ-ONLY number-cost reconciliation report (services/ledger/numberCostReport.js).
// Reads the provider's number inventory and price, HCG households,
// entitlements, classifications and quarantine rows, optional staging
// households (to recognise staging numbers billed on this account) and
// recent inbound activity. Writes nothing and releases nothing: anomalies
// are for the number-lifecycle process / a person to act on.
//
// Run with:
//   node scripts/number-cost-report.js [--json=/path/report.json]
// Optional staging recognition: STAGING_SUPABASE_URL + STAGING_SUPABASE_SERVICE_ROLE_KEY.
'use strict';

require('dotenv').config();

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
  const { createClient } = require('@supabase/supabase-js');
  const { supabaseAdmin } = require('../services/supabaseClients');
  const { twilioRestClient: tw } = require('../services/twilioClient');
  const { buildNumberCostReport } = require('../services/ledger/numberCostReport');
  if (!supabaseAdmin || !tw) throw new Error('Supabase admin and Twilio credentials are both required');

  const read = async (client, table, cols) => {
    const { data, error } = await client.from(table).select(cols);
    if (error) throw new Error(`${table}: ${error.message}`);
    return data || [];
  };
  const [prodHouseholds, entitlements, classifications, quarantine] = await Promise.all([
    read(supabaseAdmin, 'households', 'id, twilio_number, twilio_number_pending_release_at'),
    read(supabaseAdmin, 'entitlements', 'household_id, status, starts_at, ends_at'),
    read(supabaseAdmin, 'account_classifications', 'household_id, classification'),
    read(supabaseAdmin, 'twilio_number_quarantine', 'twilio_number, household_id, quarantined_at, released_at, deactivation_confirmed'),
  ]);
  let stagingHouseholds = [];
  if (process.env.STAGING_SUPABASE_URL && process.env.STAGING_SUPABASE_SERVICE_ROLE_KEY) {
    if (process.env.STAGING_SUPABASE_URL === process.env.SUPABASE_URL) throw new Error('STAGING_SUPABASE_URL must differ from SUPABASE_URL');
    const staging = createClient(process.env.STAGING_SUPABASE_URL, process.env.STAGING_SUPABASE_SERVICE_ROLE_KEY);
    stagingHouseholds = await read(staging, 'households', 'id, twilio_number');
  }

  const owned = await tw.incomingPhoneNumbers.list();
  const pricing = await tw.pricing.v1.phoneNumbers.countries('GB').fetch();
  const local = (pricing.phoneNumberPrices || []).find((p) => (p.number_type || p.numberType) === 'local');
  const monthlyRate = Number(local.current_price || local.currentPrice);

  const since = new Date(Date.now() - 90 * 86400000);
  const calls = await tw.calls.list({ startTimeAfter: since });
  const norm = (n) => String(n || '').replace(/[^\d+]/g, '');
  const lastInboundByNumber = {};
  for (const c of calls) {
    if (c.direction !== 'inbound') continue;
    const k = norm(c.to);
    const t = c.startTime.toISOString();
    if (!lastInboundByNumber[k] || t > lastInboundByNumber[k]) lastInboundByNumber[k] = t;
  }

  const report = buildNumberCostReport({
    ownedNumbers: owned.map((n) => ({ sid: n.sid, phoneNumber: n.phoneNumber, dateCreated: n.dateCreated })),
    monthlyRate,
    currency: String(pricing.priceUnit || 'GBP').toUpperCase(),
    households: [
      ...prodHouseholds.map((h) => ({ ...h, environment: 'production' })),
      ...stagingHouseholds.map((h) => ({ ...h, environment: 'staging' })),
    ],
    entitlements, classifications, quarantine, lastInboundByNumber, now: new Date(),
  });

  const k = report.kpis;
  console.log(`Numbers billed: ${k.totalNumbers} = ${k.monthlyCost} ${k.currency}/month (rate ${monthlyRate})`);
  for (const [a, v] of Object.entries(k.byAssessment)) console.log(`  ${a.padEnd(24)} ${String(v.numbers).padStart(3)}  ${v.monthlyCost}`);
  console.log(`Expected (customer + retained internal): ${k.expectedMonthlyCost}/month; staging numbers on account: ${k.stagingNumbersOnAccount}; orphans: ${k.orphanNumbers}; entitled households without number: ${k.entitledHouseholdsWithoutNumber}`);
  console.log(`Potential saving/month — lifecycle completes: ${k.potentialMonthlySaving.whenLifecycleCompletes}; apparently unnecessary resolved: ${k.potentialMonthlySaving.ifApparentlyUnnecessaryResolved}; orphans after investigation: ${k.potentialMonthlySaving.orphansAfterInvestigation}; blocked by recent inbound: ${k.potentialMonthlySaving.blockedByRecentInboundActivity}`);
  console.log(`Anomalies: ${k.anomalies.critical} CRITICAL, ${k.anomalies.warning} WARNING`);
  for (const a of report.anomalies) console.log(`  [${a.level}] ${a.type} ${a.sid ? a.sid.slice(0, 8) + '… ' + a.number : 'household ' + a.household + ' (' + a.classification + ')'} — ${a.detail}`);
  console.log('\nsid        number env         household class          entitlement lifecycle        last inbound  assessment');
  for (const r of report.rows) console.log(`${r.sid.slice(0, 8)}… ${r.number} ${r.environment.padEnd(11)} ${String(r.household || '-').padEnd(9)} ${String(r.classification || '-').padEnd(14)} ${String(r.entitlement || '-').padEnd(11)} ${r.lifecycle.padEnd(16)} ${String(r.lastInboundAt || '-').slice(0, 10).padEnd(13)} ${r.assessment}`);
  if (args.json) require('fs').writeFileSync(args.json, JSON.stringify(report, null, 2));
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exitCode = 1; });
