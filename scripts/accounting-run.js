// Accounting automation worker — run MANUALLY; not scheduled anywhere.
//
// Default (no flags): READ-ONLY status report from the 071 tables.
//   --reevaluate     re-check blocked transactions (account backfills, newly
//                    confirmed accountant decisions, late originals) — writes
//                    only to the accounting_* tables
//   --entitlements   run money↔entitlement reconciliation (reads entitlements
//                    and account_classifications; raises/auto-resolves exceptions)
//   --post           process the Xero posting queue. Refuses unless
//                    ACCOUNTING_XERO_POSTING_ENABLED=true AND Xero custom-connection
//                    credentials are configured (none exist today).
//
// Requires migration 071 (DRAFT, not applied) and the service-role key.
//   node scripts/accounting-run.js [--reevaluate] [--entitlements] [--post] [--json]
'use strict';

require('dotenv').config();

async function main() {
  const flags = new Set(process.argv.slice(2));
  const { supabaseAdmin } = require('../services/supabaseClients');
  if (!supabaseAdmin) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required');
  const { createRpcAccountingStore } = require('../services/accounting/rpcStore');
  const { createSupabaseResolver } = require('../services/accounting/resolver');
  const { createAccountingEngine } = require('../services/accounting/engine');
  const { loadAccountingPolicy } = require('../services/accounting/accountingPolicy');
  const { runEntitlementReconciliation } = require('../services/accounting/reconciliation');
  const { createPostingQueue } = require('../services/accounting/postingQueue');
  const { buildAccountingStatus } = require('../services/accounting/status');
  const { loadXeroConfig, xeroConnectionStatus, createXeroHttpClient } = require('../services/accounting/xero/xeroClient');

  const store = createRpcAccountingStore(supabaseAdmin);
  const policy = loadAccountingPolicy(process.env);
  const xeroConfig = loadXeroConfig(process.env);
  const out = {};

  if (flags.has('--reevaluate')) {
    const engine = createAccountingEngine({ store, resolver: createSupabaseResolver(supabaseAdmin), policy });
    out.reevaluate = await engine.reevaluate();
  }
  if (flags.has('--entitlements')) {
    const read = async (table, cols) => {
      const { data, error } = await supabaseAdmin.from(table).select(cols);
      if (error) throw new Error(`${table}: ${error.message}`);
      return data || [];
    };
    out.entitlements = await runEntitlementReconciliation({
      store,
      loadEntitlements: () => read('entitlements', 'id, household_id, entitlement_type, status, source, starts_at, ends_at, revenuecat_environment'),
      loadClassifications: async () => Object.fromEntries((await read('account_classifications', 'household_id, classification')).map((r) => [r.household_id, r.classification])),
      now: new Date(),
    });
  }
  if (flags.has('--post')) {
    const status = xeroConnectionStatus(xeroConfig);
    if (status.connected === false) throw new Error(`refusing to post: ${status.reason}`);
    const xero = createXeroHttpClient({ config: xeroConfig, fetchImpl: globalThis.fetch });
    const queue = createPostingQueue({ store, xero, policy, storeRevenueBasis: process.env.ACCOUNTING_STORE_REVENUE_BASIS || null });
    out.posted = await queue.processDue({ limit: 20 });
  }
  out.status = await buildAccountingStatus({ store, policy, xeroStatus: xeroConnectionStatus(xeroConfig) });
  console.log(flags.has('--json') ? JSON.stringify(out, null, 2) : JSON.stringify({ ...out, status: { transactions: out.status.transactions.by_status, exceptions: out.status.exceptions.by_type, postings: out.status.postings.by_status, xero: out.status.xero } }, null, 2));
}

main().catch((err) => { console.error('ACCOUNTING RUN FAILED:', err.message); process.exitCode = 1; });
