#!/usr/bin/env node
// READ-ONLY staging schema check (2026-10-04). Probes each migration's marker
// table/column with `select … limit 0` (no rows read, nothing written).
// Refuses to run against anything but the staging project.
//   node scripts/staging/verify-staging-schema.js [path/to/staging.env]
'use strict';
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { createClient } = require('@supabase/supabase-js');
const STAGING_REF = process.env.STAGING_SUPABASE_REF || 'tigwgmayeuisrxjjykqd';
const file = process.argv[2] || path.join(process.cwd(), '.env.staging.local');
const env = fs.existsSync(file) ? dotenv.parse(fs.readFileSync(file)) : process.env;
if (!String(env.SUPABASE_URL || '').includes(`${STAGING_REF}.supabase.co`)) { console.error(`REFUSED: SUPABASE_URL is not the staging project (${STAGING_REF})`); process.exit(2); }
const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
// [migration, table, column]; functions-only migrations (047, 065, 070) cannot be
// probed without executing them — verify those via schema_migrations.
const PROBES = [
  ['046', 'voice_client_registration_events', '*'], ['051', 'telephony_call_legs', '*'], ['052', 'entitlement_expiry_warnings_sent', '*'],
  ['053', 'entitlements', 'revenuecat_environment'], ['054', 'number_lifecycle_sweep_runs', '*'], ['055', 'calls', 'dial_call_sid'],
  ['056', 'household_usage_periods', '*'], ['057', 'terms_acceptances', 'id'], ['062', 'hcg_account_numbers', '*'],
  ['063', 'allowance_credits', '*'], ['064', 'call_delivery_events', '*'], ['066', 'number_provisioning_claims', '*'],
  ['067', 'fc_policy', '*'], ['068', 'allowance_credits', 'applied_budget_gbp'], ['069', 'account_classification_events', '*'],
  ['071', 'accounting_source_events', '*'], ['072', 'ops_events', '*'],
];
(async () => {
  let absent = 0;
  for (const [m, t, c] of PROBES) {
    const r = await sb.from(t).select(c).limit(0);
    if (r.error) absent++;
    console.log(`${m}  ${`${t}.${c}`.padEnd(44)} ${r.error ? `ABSENT (${r.error.code})` : 'present'}`);
  }
  console.log(`\n${PROBES.length - absent}/${PROBES.length} marker objects present. Functions-only: 047, 065, 070 — check supabase_migrations.schema_migrations.`);
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
