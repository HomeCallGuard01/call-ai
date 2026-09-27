// Regression tests for the admin dashboard financial-statement audit
// (docs/admin/DASHBOARD_FINANCIAL_STATEMENT_AUDIT.md, 2026-09-27), fixes
// A2–A6: complimentary access must never be counted as paid customers or
// recurring revenue; "has a number" must not be labelled "protected";
// derived MRR must not be labelled confirmed; the duration note must be
// true.
//
// Run with: node tests/admin-business-statements.test.mjs

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

let failures = 0;
function check(condition, message) {
  if (condition) console.log(`✓ ${message}`);
  else { console.error(`✗ ${message}`); failures++; }
}

// --- A2/A3: getBusinessOverview against a fake database shaped like
// production on 27 Sep 2026 (7 active complimentary entitlements, 0 paid).
function fakeSupabase(tables) {
  return {
    from(table) {
      let rows = (tables[table] || []).slice();
      let countMode = false;
      const q = {
        select(_cols, opts) { countMode = !!(opts && opts.count); return q; },
        eq(col, val) { rows = rows.filter((r) => r[col] === val); return q; },
        not(col, op, val) { rows = rows.filter((r) => !(op === 'is' && val === null && (r[col] === null || r[col] === undefined))); return q; },
        gte() { return q; },
        in(col, vals) { rows = rows.filter((r) => vals.includes(r[col])); return q; },
        then(resolve) { return Promise.resolve(countMode ? { count: rows.length, error: null } : { data: rows, error: null }).then(resolve); },
      };
      return q;
    },
  };
}

const complimentary = Array.from({ length: 7 }, (_, i) => ({ id: `e${i}`, status: 'active', entitlement_type: 'complimentary' }));
const clientsPath = require.resolve('../services/supabaseClients.js');
const stripePath = require.resolve('../services/stripeClient.js');
require.cache[stripePath] = { id: stripePath, filename: stripePath, loaded: true, exports: { stripe: { prices: { retrieve: async () => ({ unit_amount: 499, currency: 'gbp' }) } } } };
process.env.STRIPE_PRICE_ID = 'price_test';

require.cache[clientsPath] = { id: clientsPath, filename: clientsPath, loaded: true, exports: { supabaseAdmin: fakeSupabase({ households: [], entitlements: complimentary, subscriptions: [] }), supabase: null } };
let metrics = require('../database/adminMetrics.js');
const onlyComplimentary = await metrics.getBusinessOverview();
check(onlyComplimentary.activePaidCustomers === 0, 'A2: 7 complimentary accounts → "Active paid customers" is 0, not 7');
check(onlyComplimentary.mrr.available && onlyComplimentary.mrr.amount === 0, 'A3: complimentary accounts contribute £0 MRR (was £34.93)');

delete require.cache[require.resolve('../database/adminMetrics.js')];
require.cache[clientsPath].exports.supabaseAdmin = fakeSupabase({
  households: [],
  entitlements: [...complimentary, { id: 'p1', status: 'active', entitlement_type: 'paid_subscription' }, { id: 'p2', status: 'active', entitlement_type: 'paid_subscription' }, { id: 'p3', status: 'expired', entitlement_type: 'paid_subscription' }],
  subscriptions: [],
});
metrics = require('../database/adminMetrics.js');
const mixed = await metrics.getBusinessOverview();
check(mixed.activePaidCustomers === 2 && Math.abs(mixed.mrr.amount - 9.98) < 1e-9, 'A2/A3: 2 active paid + 7 complimentary + 1 expired → 2 paid customers, MRR £9.98');

// --- A4/A6: labels
const html = readFileSync(path.join(__dirname, '..', 'admin-business.html'), 'utf8');
check(!html.includes("'Active protected households'") && html.includes('Households with an active HCG number'), 'A4: "has a number" is no longer labelled "Active protected households"');
check(!html.includes("'Active protected (real)'") && html.includes('not the same as Protected'), 'A4: Business card says a number is not the same as Protected');
check(!/Real MRR ' \+ tag\('confirmed'\)/.test(html) && /Real MRR ' \+ tag\('derived'\)/.test(html), 'A6: Real MRR labelled derived (list price × count), not confirmed');
check(html.includes('complimentary accounts excluded'), 'A3: MRR caption states complimentary accounts are excluded');

// --- A5: known gaps
const route = readFileSync(path.join(__dirname, '..', 'routes', 'adminBusiness.js'), 'utf8');
check(!/duration_seconds (does not exist|still does not exist)/.test(route), 'A5: known gaps no longer claim calls.duration_seconds does not exist');

console.log('');
if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log('All admin business statement checks passed.');
