// Integration 2026-10-10: WS2's REAL profitability router (contract §B) serves
// the Financial Control Centre page (WS4) through
// GET /admin/api/financial/customer-profitability, adapted to the page's
// contract "ws2-profitability-v1". Proves: admin-only; the response carries
// every field the page reads, with the right contract version; grandfathered
// £4.99 is labelled; uncounted revenue is null (not £0 gross); unknown cost
// splits are null; reconciliation is honestly "unavailable"; flags become
// signals; and the page itself still expects this exact contract and URL.
import { createRequire } from 'node:module';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const express = require('express');
const { createAdminFinanceRouter } = require('../routes/adminFinance.js');
const { assembleInputs } = require('../database/profitability.js');
let failures = 0;
const check = (c, m) => { if (c) console.log(`✓ ${m}`); else { console.error(`✗ ${m}`); failures++; } };

const ENV = { FINANCE_STRIPE_LIVE_PRICES: JSON.stringify({ price_live599: 5.99, price_live499: 4.99 }) };
const NOW = new Date('2026-10-16T00:00:00Z');
const P = { start: '2026-10-01T00:00:00.000Z', end: '2026-11-01T00:00:00.000Z' };
const ent = (o = {}) => ({ household_id: 'h', entitlement_type: 'paid_subscription', status: 'active', source: 'stripe', starts_at: '2026-09-01T00:00:00Z', ends_at: null, ...o });
const acct = (o = {}) => ({ profile: 'standard', period_start: '2026-10-01T00:00:00Z', period_end: '2026-11-01T00:00:00Z', base_budget_gbp: 3, adjustments_gbp: 0,
  delivery_reserve_gbp: 0.5, essential_reserve_gbp: 0.1, consumed_gbp: 1.0, reserved_gbp: 0.07, actual_gbp: 0.7, essential_consumed_gbp: 0, essential_reserved_gbp: 0,
  unscreened_reserve_gbp: 0, unscreened_consumed_gbp: 0, unscreened_reserved_gbp: 0, delivery_reserve_scope: 'trusted_only', ...o });
const inputs = assembleInputs({
  households: [
    { id: 'a', account_number: 'HCG-000001', twilio_number: '+441', twilio_provisioning_status: 'active' },
    { id: 'b', account_number: 'HCG-000002', twilio_number: '+442', twilio_provisioning_status: 'active' },
    { id: 'c', account_number: 'HCG-000003', twilio_number: '+443', twilio_provisioning_status: 'active' },
  ],
  entitlements: [ent({ household_id: 'a' }), ent({ household_id: 'b' }), ent({ household_id: 'c', entitlement_type: 'complimentary' })],
  subscriptions: [{ household_id: 'a', stripe_price_id: 'price_live599', status: 'active' }, { household_id: 'b', stripe_price_id: 'price_live499', status: 'active' }],
  accounts: [acct({ household_id: 'a' }), acct({ household_id: 'b', consumed_gbp: 3.4 }), acct({ household_id: 'c' })],
  profiles: [{ profile: 'standard', delivery_reserve_scope: 'trusted_only' }], holds: [], credits: [],
}, P);

let admin = true;
const app = express();
app.use(createAdminFinanceRouter({
  loadProfitability: async () => inputs, env: ENV, now: () => NOW,
  requireAuth: (req, res, next) => { req.authUserId = 'u1'; next(); },
  requireAdmin: (req, res, next) => (admin ? next() : res.status(403).json({ error: 'admin' })),
}));
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const get = (p) => new Promise((resolve) => http.get({ host: '127.0.0.1', port: server.address().port, path: p }, (res) => {
  let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(t); } catch {} resolve({ status: res.statusCode, body: j }); });
}));

try {
  admin = false;
  check((await get('/admin/api/financial/customer-profitability')).status === 403, 'non-admin → refused');
  admin = true;
  const r = await get('/admin/api/financial/customer-profitability?period=2026-10');
  const b = r.body || {};
  check(r.status === 200 && b.contractVersion === 'ws2-profitability-v1' && b.currency === 'GBP', 'admin → 200, contract ws2-profitability-v1, GBP');
  check(b.period && b.period.label === '2026-10' && b.period.start === P.start && b.period.end === P.end, 'period label/start/end');
  for (const k of ['customers', 'revenueNetGbp', 'attributableCostGbp', 'marginGbp', 'marginPct', 'projectedMarginPct']) check(k in (b.totals || {}), `totals.${k} present`);
  const byAcct = Object.fromEntries((b.customers || []).map((c) => [c.accountNumber, c]));
  const a = byAcct['HCG-000001']; const g = byAcct['HCG-000002']; const comp = byAcct['HCG-000003'];
  check(a && g && comp && b.customers.length === 3, 'one customer row per household');
  for (const k of ['householdId', 'accountNumber', 'segment', 'channel', 'priceLabel', 'grandfathered', 'joinedAt', 'revenue', 'cost', 'margin', 'allowance', 'flags']) check(k in a, `customer.${k} present`);
  check(a.priceLabel === '£5.99' && a.grandfathered === false && g.priceLabel === '£4.99 (grandfathered)' && g.grandfathered === true, '£5.99 vs grandfathered £4.99 labelled');
  check(Math.abs(a.revenue.grossGbp - 5.99) < 0.001 && a.revenue.basis === 'actual', 'counted revenue: gross £5.99, basis actual');
  check(comp.revenue.grossGbp === null && /^not_counted:/.test(comp.revenue.basis), 'complimentary revenue is NOT shown as a £ gross (null + not_counted reason)');
  check(a.cost.telephonyGbp === null && a.cost.aiGbp === null && a.cost.smsGbp === null && typeof a.cost.attributableGbp === 'number', 'unknown cost splits are null, total attributable present');
  check(typeof a.margin.actualGbp === 'number' && 'projectedPct' in a.margin && a.allowance.resetsAt === P.end, 'margin + allowance (resetsAt = period end)');
  check(b.providerReconciliation && b.providerReconciliation.available === false && b.providerReconciliation.reason, 'provider reconciliation honestly unavailable (no production feed)');
  check(Array.isArray(b.signals) && b.signals.some((s) => s.severity === 'red' && s.accountNumber === 'HCG-000003'), 'loss-making complimentary household raises a red signal');
  check(Array.isArray(b.recommendations) && b.recommendations.length === 0, 'no recommendations invented (advisory only)');
  const json = JSON.stringify(b);
  check(!/NaN|undefined|Infinity/.test(json), 'no NaN/undefined/Infinity in the payload');

  const page = readFileSync(path.join(ROOT, 'admin-financial-control.html'), 'utf8');
  check(page.includes("'ws2-profitability-v1'") && page.includes('/admin/api/financial/customer-profitability'), 'the page still expects exactly this contract and URL');
} finally {
  server.close();
}
console.log(failures === 0 ? '\nFinancial Control Centre contract: all checks hold.' : `\n${failures} check(s) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
