// Integration 2026-10-10: WS2's REAL profitability router (contract §B) serves
// the Financial Control Centre page (WS4) through
// GET /admin/api/financial/customer-profitability, adapted to the page's
// contract "ws2-profitability-v1". Proves: admin-only; the response carries
// every field the page reads, with the right contract version; grandfathered
// £4.99 is labelled; uncounted revenue is null (not £0 gross); unknown cost
// splits are null; reconciliation is honestly "unavailable"; flags become
// signals; and the page itself still expects this exact contract and URL.
//
// WS4 update 2026-10-10: + estimated vs actual cost (actual null +
// "not_available" when no provider actual is recorded — never £0), the 076
// continuity reserves, allowance state (incl. hard_ceiling / held / unknown),
// protection from the canonical activation state over the lifecycle snapshot
// loader (protected / forwarding_unconfirmed / on_hold / unknown), alerts from
// flags + UNSEEN ops events, top-ups reported disabled by default, and a
// lifecycle/ops load failure degrades to "unknown" (null), never "protected".
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
    { id: 'd', account_number: 'HCG-000004', twilio_number: null, twilio_provisioning_status: 'pending' },
  ],
  entitlements: [ent({ household_id: 'a' }), ent({ household_id: 'b' }), ent({ household_id: 'c', entitlement_type: 'complimentary' }), ent({ household_id: 'd' })],
  subscriptions: [{ household_id: 'a', stripe_price_id: 'price_live599', status: 'active' }, { household_id: 'b', stripe_price_id: 'price_live499', status: 'active' }],
  accounts: [acct({ household_id: 'a', unscreened_reserve_gbp: 0.4, unscreened_consumed_gbp: 0.1 }), acct({ household_id: 'b', consumed_gbp: 3.4, actual_gbp: 0 }), acct({ household_id: 'c' })],
  profiles: [{ profile: 'standard', delivery_reserve_scope: 'trusted_only' }], holds: [{ household_id: 'c' }], credits: [],
}, P);

// Lifecycle snapshots in the shape database/lifecycleSnapshot.js returns.
const hh = (id, acc, o = {}) => ({ id, status: 'active', email: `${id}@example.com`, auth_user_id: `auth-${id}`, account_number: acc, twilio_number: `+44${id}`,
  twilio_provisioning_status: 'active', activation_verified_at: '2026-10-02T10:00:00Z', forwarding_proven_at: '2026-10-02T10:00:00Z',
  voice_client_registered_at: '2026-10-04T08:00:00Z', delivery_verified_at: '2026-10-02T10:05:00Z', ...o });
const snap = (household, o = {}) => ({ household, entitlements: [{ id: `e-${household.id}`, household_id: household.id, entitlement_type: 'paid_subscription', status: 'active', source: 'stripe', starts_at: '2026-09-01T00:00:00Z', ends_at: null }],
  subscription: null, quarantineRows: [], financialHold: null, currentNumberAssignedAt: null, failedStripeEvents: [], liveSubscriptionEventsAfterDeletion: [], classification: null, deliveryHealth: null, ...o });
const SNAPSHOTS = [
  snap(hh('a', 'HCG-000001')),
  snap(hh('b', 'HCG-000002', { forwarding_proven_at: null })),
  snap(hh('c', 'HCG-000003'), { financialHold: { held: true, source: 'financial', reason: 'auto', heldAt: '2026-10-05T00:00:00Z' } }),
  // 'd' deliberately has no snapshot → protection unknown (null)
];
const OPS = [
  { id: 'o1', event_type: 'customer_needs_attention', household_id: 'b', account_number: 'HCG-000002', severity: 'critical', payload: { reason: 'protection_lost_app_unreachable' }, occurred_at: '2026-10-15T08:00:00Z', seen_at: null },
  { id: 'o2', event_type: 'customer_needs_attention', household_id: 'a', account_number: 'HCG-000001', severity: 'action', payload: { reason: 'payment_failed' }, occurred_at: '2026-10-14T08:00:00Z', seen_at: '2026-10-14T09:00:00Z' },
];
let snapshotLoader = async () => ({ snapshots: SNAPSHOTS, sources: { financialHolds: 'ok' }, truncated: false });
let opsLoader = async () => OPS;

let admin = true;
const app = express();
app.use(createAdminFinanceRouter({
  loadProfitability: async () => inputs, env: ENV, now: () => NOW,
  loadSnapshots: () => snapshotLoader(), loadUnseenOpsEvents: () => opsLoader(),
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
  check(a && g && comp && b.customers.length === 4, 'one customer row per household');
  for (const k of ['householdId', 'accountNumber', 'segment', 'channel', 'priceLabel', 'grandfathered', 'joinedAt', 'revenue', 'cost', 'margin', 'allowance', 'flags']) check(k in a, `customer.${k} present`);
  check(a.priceLabel === '£5.99' && a.grandfathered === false && g.priceLabel === '£4.99 (grandfathered)' && g.grandfathered === true, '£5.99 vs grandfathered £4.99 labelled');
  check(Math.abs(a.revenue.grossGbp - 5.99) < 0.001 && a.revenue.basis === 'actual', 'counted revenue: gross £5.99, basis actual');
  check(comp.revenue.grossGbp === null && /^not_counted:/.test(comp.revenue.basis), 'complimentary revenue is NOT shown as a £ gross (null + not_counted reason)');
  check(a.cost.telephonyGbp === null && a.cost.aiGbp === null && a.cost.smsGbp === null && typeof a.cost.attributableGbp === 'number', 'unknown cost splits are null, total attributable present');
  check(typeof a.margin.actualGbp === 'number' && 'projectedPct' in a.margin && a.allowance.resetsAt === P.end, 'margin + allowance (resetsAt = period end)');
  check(b.providerReconciliation && b.providerReconciliation.available === false && b.providerReconciliation.reason, 'provider reconciliation honestly unavailable (no production feed)');
  check(Array.isArray(b.signals) && b.signals.some((s) => s.severity === 'red' && s.accountNumber === 'HCG-000003'), 'loss-making complimentary household raises a red signal');
  check(Array.isArray(b.recommendations) && b.recommendations.length === 0, 'no recommendations invented (advisory only)');
  // ── WS4 update: estimated vs actual, reserves, state, protection, alerts ──
  const d = byAcct['HCG-000004'];
  check(Math.abs(a.cost.estimatedGbp - 1.17) < 0.001 && a.cost.committedGbp !== null && a.cost.reservedGbp !== null, 'estimated cost = Fortress committed + reserved (1.10 + 0.07)');
  check(a.cost.actualGbp === 0.7 && a.cost.actualBasis === 'provider_actual', 'recorded provider actual → actualGbp + basis provider_actual');
  check(g.cost.actualGbp === null && g.cost.actualBasis === 'not_available', 'no provider actual recorded → actualGbp null + not_available (never £0)');
  check(a.allowance.trustedReserveRemainingGbp === 0.5 && Math.abs(a.allowance.unknownReserveRemainingGbp - 0.3) < 0.001 && a.allowance.state === 'normal', 'trusted + unknown reserves remaining, state normal');
  check(g.allowance.state === 'hard_ceiling', 'budget and reserves exhausted → allowance state hard_ceiling');
  check(comp.allowance.state === 'held', 'financial hold → allowance state held');
  check(d.allowance.state === null && d.allowance.budgetGbp === null && d.allowance.trustedReserveRemainingGbp === null, 'no budget account → allowance state/reserves null (unknown), not "normal"/£0');
  check(a.protection && a.protection.stage === 'protected' && a.protection.protected === true && a.protection.blockers.length === 0, 'fully set up → protected');
  check(g.protection && g.protection.stage === 'forwarding_unconfirmed' && g.protection.protected === false && g.protection.blockers.includes('Forwarding not proven'), 'forwarding unproven → not protected, blocker named');
  check(comp.protection && comp.protection.stage === 'on_hold' && comp.protection.protected === false && comp.protection.blockers.includes('On financial hold'), 'held household → stage on_hold, not protected');
  check(d.protection === null, 'household without a lifecycle snapshot → protection null (unknown), never protected');
  check(g.alerts.some((x) => x.severity === 'red' && /Reached the hard ceiling/.test(x.title)) && g.alerts.some((x) => x.severity === 'red' && /App unreachable/.test(x.title) && x.at === '2026-10-15T08:00:00Z') && g.alerts.some((x) => x.severity === 'amber' && x.title === 'Forwarding not confirmed'), 'alerts: flag + unseen ops event (with time) + protection stage');
  check(g.alerts[0].severity === 'red' && !a.alerts.some((x) => /Payment failed/.test(x.title)), 'alerts sorted red first; SEEN ops events are not alerts');
  check(comp.alerts.filter((x) => /hold/i.test(x.title)).length === 1, 'hold alert not duplicated (flag + stage)');
  check(b.totals.protectedCustomers === 1 && b.totals.notProtectedCustomers === 2 && b.totals.protectionUnknownCustomers === 1 && b.totals.heldCustomers === 1 && b.totals.hardCeilingCustomers === 1, 'portfolio totals: protected / not protected / unknown / held / hard ceiling');
  check(Math.abs(b.totals.actualCostGbp - 0.7 - 0.7) < 0.001 && b.totals.actualCostCoverage.customersWithActual === 2 && typeof b.totals.estimatedCostGbp === 'number', 'actual-cost total sums recorded actuals only, with coverage');
  check(b.topUps && b.topUps.enabled === false && b.topUps.status === 'disabled' && ENV.ALLOWANCE_TOPUPS_ENABLED === undefined, 'top-ups reported disabled (ALLOWANCE_TOPUPS_ENABLED unset = default off)');
  check(b.sources.lifecycle === 'ok' && b.sources.opsEvents === 'ok' && b.sources.deliveryHealth === 'not_loaded_in_bulk' && typeof b.costCaveat === 'string' && /delay/.test(b.costCaveat), 'sources reported; billing-delay caveat present');

  const json = JSON.stringify(b);
  check(!/NaN|undefined|Infinity/.test(json), 'no NaN/undefined/Infinity in the payload');

  // Loader failure: profitability still renders; protection/alerts unknown, never "protected".
  snapshotLoader = async () => { throw new Error('db down'); };
  opsLoader = async () => { throw new Error('072 absent'); };
  const origErr = console.error; console.error = () => {};
  const down = (await get('/admin/api/financial/customer-profitability?period=2026-10')).body || {};
  console.error = origErr;
  check(down.contractVersion === 'ws2-profitability-v1' && down.customers.length === 4 && down.customers.every((c) => c.protection === null), 'lifecycle load failure → 200, every protection null (unknown)');
  check(down.sources.lifecycle === 'unavailable' && down.sources.opsEvents === 'unavailable' && down.totals.protectedCustomers === null, 'failed sources reported unavailable; protected count null, not 0');
  check(down.customers.find((c) => c.accountNumber === 'HCG-000002').alerts.some((x) => /hard ceiling/.test(x.title)), 'flag alerts still shown when lifecycle/ops are down');

  const src = readFileSync(path.join(ROOT, 'routes', 'adminFinance.js'), 'utf8');
  check(!/\.(insert|update|upsert|delete|rpc)\(/.test(src) && src.includes('loadLifecycleSnapshots') && src.includes('selectAll'), 'route stays read-only; reuses the lifecycle snapshot loader and paginated selectAll');

  const page = readFileSync(path.join(ROOT, 'admin-financial-control.html'), 'utf8');
  check(page.includes("'ws2-profitability-v1'") && page.includes('/admin/api/financial/customer-profitability'), 'the page still expects exactly this contract and URL');
} finally {
  server.close();
}
console.log(failures === 0 ? '\nFinancial Control Centre contract: all checks hold.' : `\n${failures} check(s) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
