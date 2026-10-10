// Financial Control Centre v1 (WS4, 2026-10-10): admin, READ-ONLY.
//
// Fixture-driven: the page's own inline script is executed (node:vm) against
// a minimal DOM, with fixtures for the ASSUMED WS2 profitability contract
// ("ws2-profitability-v1") and the existing admin APIs it reuses. Proves:
//   1. the view model computes per-customer revenue/cost/margin rows, heavy
//      users, provider-vs-ledger reconciliation, merged risk signals, new
//      customers and app problems from the fixtures;
//   2. it tolerates missing / malformed / unavailable sources (shows "—" or
//      "unavailable", never zero, never throws);
//   3. everything is rendered with textContent (hostile strings stay text,
//      no element is created from data), and recommendations are advisory
//      text only;
//   4. the page makes GET requests to same-origin admin APIs only;
//   5. the route requires auth + admin, sends no-store + a strict CSP, and
//      is not mounted by WS4.
//
// Run with: node tests/admin-financial-control.test.mjs
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
Object.assign(process.env, { SUPABASE_URL: 'http://127.0.0.1:9', SUPABASE_ANON_KEY: 'x', SUPABASE_SERVICE_ROLE_KEY: 'x' });

let failures = 0;
const check = (c, m) => { if (c) console.log(`✓ ${m}`); else { console.error(`✗ ${m}`); failures++; } };

const html = readFileSync(path.join(root, 'admin-financial-control.html'), 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
check(scripts.length === 1 && !/<script\s+src=/i.test(html), 'one inline script, no external script');
const script = scripts[0];

// ── static safety ─────────────────────────────────────────────────────────
check(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|setAttribute\(\s*['"]on/i.test(script), 'no innerHTML / outerHTML / insertAdjacentHTML / document.write / eval / inline handlers');
check(!/https?:\/\//.test(script) && !/<link\b|@import|https?:\/\//i.test(html.replace(script, '')), 'no external URL anywhere (no CDN, fonts or third-party calls)');
check(!/method\s*:|['"]POST['"]|['"]PUT['"]|['"]DELETE['"]|['"]PATCH['"]/i.test(script), 'the page never sends a write request (GET only)');
check(!/<form\b|<input\b|<textarea\b/i.test(html), 'no forms or inputs: nothing to submit');
check(/AI may recommend, never\s+enforce/.test(html) && /advisory only/.test(script), 'recommendations are labelled advisory (AI may recommend, never enforce)');

// ── run the page script against a tiny DOM ────────────────────────────────
function makeDoc() {
  const created = [];
  const mk = (tag) => {
    const node = {
      tagName: tag.toUpperCase(), children: [], className: '', _text: '',
      get firstChild() { return this.children[0] || null; },
      appendChild(c) { this.children.push(c); return c; },
      removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; },
      set textContent(v) { this._text = String(v); this.children = []; },
      get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); },
    };
    created.push(tag.toLowerCase());
    return node;
  };
  return { created, createElement: mk, createTextNode: (t) => ({ nodeType: 3, textContent: String(t) }) };
}
const ctx = vm.createContext({ console, Promise, Date, Math, Number, String, Object, Array, JSON, Boolean });
vm.runInContext(script, ctx);
const FC = ctx.HCGFinancialControl;
check(FC && typeof FC.buildViewModel === 'function' && typeof FC.render === 'function' && Object.isFrozen(FC), 'page exposes buildViewModel/render/load (frozen); auto-start skipped without a browser');
check(Object.values(FC.SOURCES).every((u) => u.startsWith('/admin/api/')) && FC.SOURCES.profitability === '/admin/api/financial/customer-profitability' && FC.EXPECTED_CONTRACT === 'ws2-profitability-v1', 'data sources are same-origin admin APIs; WS2 endpoint + contract version as documented');

const ok = (body) => ({ ok: true, status: 200, body });
const HOSTILE = '<img src=x onerror=alert(1)>';
const profitability = {
  contractVersion: 'ws2-profitability-v1', generatedAt: '2026-10-10T09:00:00Z', period: { label: '2026-10' }, currency: 'GBP', basis: 'estimated from Fortress ledger',
  totals: { customers: 3, revenueNetGbp: 13.97, attributableCostGbp: 6.1, marginGbp: 7.87, marginPct: 56.3, projectedMarginPct: 31 },
  customers: [
    { householdId: 'h1', accountNumber: 'HCG-00000001', segment: 'genuine_paying', channel: 'stripe', priceLabel: '£4.99 per month including VAT', grandfathered: true,
      revenue: { netGbp: 3.8, basis: 'actual' }, cost: { attributableGbp: 0.9, basis: 'ledger' }, margin: { actualGbp: 2.9, actualPct: 76.3, projectedGbp: 2.1, projectedPct: 55 },
      allowance: { usedPercent: 25, remainingGbp: 2.7, budgetGbp: 3.6, topUpsGbp: 0, resetsAt: '2026-11-01T00:00:00Z' }, flags: [], joinedAt: '2026-09-01T10:00:00Z' },
    { householdId: 'h2', accountNumber: 'HCG-00000002', segment: 'genuine_paying', channel: 'stripe', priceLabel: HOSTILE,
      revenue: { netGbp: '4.63' }, cost: { attributableGbp: 5.0 }, margin: { actualGbp: -0.37, actualPct: -8, projectedGbp: -1.2, projectedPct: -26 },
      allowance: { usedPercent: 97, remainingGbp: 0.1, topUpsGbp: 0 }, flags: ['heavy_user', 'loop_suspected', 42] },
    { householdId: 'h3', accountNumber: 'HCG-00000003', channel: 'stripe', revenue: null, cost: { attributableGbp: 'NaN' }, margin: {}, allowance: { usedPercent: 85 }, flags: 'not-an-array' },
  ],
  providerReconciliation: { available: true, rows: [
    { provider: 'twilio', providerSpendGbp: 6.4, ledgerGbp: 6.1, differenceGbp: 0.3, differencePct: 4.9, status: 'ok', basis: 'usage records (last month)' },
    { provider: 'openai', providerSpendGbp: 2.0, ledgerGbp: 1.2, differenceGbp: 0.8, differencePct: 66.7, status: 'mismatch' },
  ] },
  signals: [{ severity: 'red', title: 'Unusual destination', detail: 'calls to +882 range', accountNumber: 'HCG-00000002' }],
  recommendations: [{ title: 'Review HCG-00000002 allowance', detail: 'Loss-making at current usage; consider contacting the customer.', confidence: 'medium' }],
};
const fortress = { global: { available: true, killSwitch: false, breakerOpen: true, breakerReason: 'daily_cap', enforcementMode: 'enforce' }, households: [{ accountNumber: 'HCG-00000002', profile: 'standard', usedPercent: 97, estimatedCommittedGbp: 3.5, budgetGbp: 3.6, lastRefusal: { reason: 'budget_exhausted' } }], recentEvents: [{ created_at: '2026-10-10T08:00:00Z', level: 'critical', rule: 'global_daily_cap' }, { level: 'info', rule: 'noise' }] };
const usage = { available: true, signals: [{ id: 's1', severity: 'amber', title: 'Repeated calls from one number', count: 3 }, { id: 's2', severity: 'green', title: 'quiet' }] };
const ops = { unseenCount: 2, events: [
  { event_type: 'new_genuine_customer', account_number: 'HCG-00000003', occurred_at: '2026-10-09T12:00:00Z', payload: { channelLabel: 'Web (Stripe)' }, seen_at: null },
  { event_type: 'customer_needs_attention', account_number: 'HCG-00000002', occurred_at: '2026-10-10T07:00:00Z', payload: { reason: 'protection_lost_app_unreachable' }, seen_at: null },
  { event_type: 'customer_needs_attention', account_number: 'HCG-00000003', payload: { reason: 'not_protected_within_onboarding_window' }, seen_at: '2026-10-10T08:00:00Z' },
] };
const centre = { headline: { genuineCustomers: 3, genuineProtected: 1, genuineSettingUp: 1, genuineNeedingAttention: 1 }, attention: [{ genuine: true, severity: 'action', title: 'App not registered', accountNumber: 'HCG-00000003', since: '2026-10-08T00:00:00Z' }, { genuine: false, severity: 'action', title: 'reviewer thing' }] };

const vmFull = FC.buildViewModel({ profitability: ok(profitability), fortress: ok(fortress), usage: ok(usage), ops: ok(ops), centre: ok(centre) });
check(vmFull.sources.every((s) => s.state === 'ok') && vmFull.contractMismatch === false, 'all five sources ok; contract version recognised');
check(vmFull.totals.revenueNet === '£13.97' && vmFull.totals.cost === '£6.10' && vmFull.totals.margin === '£7.87' && vmFull.totals.marginPct === '56.3%' && vmFull.totals.projectedMarginPct === '31%' && vmFull.totals.customers === '3', 'totals formatted from the WS2 totals');
const [c1, c2, c3] = vmFull.customers;
check(c1.account === 'HCG-00000001' && c1.revenueNet === '£3.80' && c1.cost === '£0.90' && c1.marginActual === '£2.90' && c1.marginActualPct === '76.3%' && c1.grandfathered === true && c1.priceLabel.includes('4.99'), 'customer row: revenue, cost, actual margin; a grandfathered £4.99 customer is marked');
check(c2.revenueNet === '£4.63' && c2.marginActual === '−£0.37' && c2.lossMaking === true && JSON.stringify(c2.flags) === JSON.stringify(['heavy_user', 'loop_suspected']), 'numeric strings accepted; negative margin shown as loss-making; non-string flags dropped');
check(c3.revenueNet === '—' && c3.cost === '—' && c3.marginActual === '—' && c3.marginProjected === '—' && c3.flags.length === 0 && c3.segment === '—' && c3.priceLabel === '—', 'missing/NaN/non-array fields render as "—", not 0');
check(vmFull.heavy.map((h) => h.account).join() === 'HCG-00000002,HCG-00000003', 'heavy users: flagged/loss-making/≥80% allowance, sorted by cost (HCG-1 at 25% excluded)');
check(vmFull.reconciliation.available && vmFull.reconciliation.rows[1].tone === 'bad' && vmFull.reconciliation.rows[1].differencePct === '66.7%' && vmFull.reconciliation.rows[0].tone === 'ok', 'provider spend vs Fortress ledger rows, mismatch highlighted');
const sigTitles = vmFull.signals.map((s) => `${s.source}:${s.title}`);
check(sigTitles.includes('profitability:Unusual destination') && sigTitles.includes('profitability:Loop suspected') && sigTitles.includes('usage-safety:Repeated calls from one number') && sigTitles.includes('fortress:global_daily_cap'), 'signals merged: WS2 signals + risk flags + usage-safety red/amber + non-info Fortress events');
check(!sigTitles.some((t) => /quiet|noise/.test(t)), 'green usage signals and info Fortress events are not shown as risks');
check(vmFull.fortress.breaker === 'OPEN (daily_cap)' && vmFull.fortress.killSwitch === 'off' && vmFull.fortress.households[0].lastRefusal === 'budget_exhausted', 'Fortress state: breaker open with reason, kill switch off, household refusal');
check(vmFull.newCustomers.length === 1 && vmFull.newCustomers[0].account === 'HCG-00000003' && vmFull.newCustomers[0].seen === 'unseen', 'new genuine customers from ops events');
check(vmFull.appProblems.some((p) => p.problem === 'App unreachable (was working)') && vmFull.appProblems.some((p) => /app never registered/.test(p.problem)) && vmFull.appProblems.some((p) => p.source === 'control centre' && p.problem === 'App not registered') && !vmFull.appProblems.some((p) => p.problem === 'reviewer thing'), 'failed registrations / unreachable apps from ops events + genuine control-centre attention (non-genuine excluded)');
check(vmFull.recommendations.length === 1 && vmFull.recommendations[0].confidence === 'medium', 'recommendations passed through as text');

// render
const doc = makeDoc();
const rootNode = doc.createElement('div');
FC.render(doc, rootNode, vmFull);
const out = rootNode.textContent;
check(out.includes(HOSTILE) && !doc.created.includes('img') && !doc.created.includes('script'), 'a hostile price label is rendered as literal text; no element is ever created from data');
check(['Per customer: revenue vs attributable cost', 'Heavy users', 'Provider spend vs Fortress ledger', 'Fraud, loop and unusual-destination signals', 'New genuine customers', 'Failed registrations, unreachable apps', 'Recommendations (advisory only — nothing is applied)'].every((h) => out.includes(h)), 'every required panel renders');
check(out.includes('grandfathered') && out.includes('−£0.37 (-8%)') && out.includes('Kill switch: off · Breaker: OPEN (daily_cap)'), 'rendered values include the grandfathered tag, loss and Fortress state');
check(out.includes('This page cannot change budgets, holds, prices or anything else.'), 'advisory disclaimer rendered under recommendations');
const created = new Set(doc.created);
check(!['button', 'form', 'input', 'a'].some((t) => created.has(t)), 'rendered content has no buttons, links, forms or inputs (read-only)');

// tolerance: everything missing / failing
const vmDown = FC.buildViewModel({ profitability: { ok: false, status: 404, body: { error: 'not found' } }, fortress: { ok: false, status: 0, body: null }, usage: ok({ available: false, reason: 'not loaded' }), ops: { ok: false, status: 503, body: { error: 'operational events not deployed (migration 072)' } } });
check(vmDown.sources.every((s) => s.state === 'unavailable') && vmDown.sources.find((s) => s.name === 'profitability').detail === 'HTTP 404 — not found', 'every unavailable source is reported as unavailable with its reason');
check(vmDown.totals.customers === '—' && vmDown.totals.revenueNet === '—' && vmDown.customers.length === 0 && vmDown.reconciliation.available === false && vmDown.fortress.available === false && vmDown.headline === null, 'unavailable data shows "—"/unavailable, never zero');
const doc2 = makeDoc(); const root2 = doc2.createElement('div');
FC.render(doc2, root2, vmDown);
check(root2.textContent.includes('Unavailable: the profitability source did not load (not zero customers).'), 'empty customer table explains it is unavailable, not zero customers');
let threw = null;
try { FC.render(makeDoc(), makeDoc().createElement('div'), FC.buildViewModel(undefined)); FC.buildViewModel({ profitability: ok(null) }); FC.buildViewModel({ profitability: ok({ customers: [null, 7, 'x'], totals: 'bad', providerReconciliation: [] }) }); } catch (err) { threw = err; }
check(threw === null, `garbage input never throws (${threw && threw.message})`);
const vmOld = FC.buildViewModel({ profitability: ok({ contractVersion: 'ws2-profitability-v0', customers: [] }) });
check(vmOld.contractMismatch === true && vmOld.totals.customers === '0', 'an unexpected WS2 contract version is flagged on the page');

// load(): GET, same-origin, failure tolerant
const calls = [];
const fakeFetch = (url, opts) => { calls.push({ url, opts }); if (url.includes('fortress')) return Promise.reject(new Error('network')); return Promise.resolve({ ok: true, status: 200, json: () => (url.includes('ops') ? Promise.reject(new Error('bad json')) : Promise.resolve({ available: true })) }); };
const loaded = await FC.load(fakeFetch);
check(calls.length === 5 && calls.every((c) => c.opts.credentials === 'same-origin' && !c.opts.method), 'load(): five same-origin GETs');
check(loaded.fortress.ok === false && loaded.fortress.status === 0 && loaded.ops.ok === false && loaded.profitability.ok === true, 'load(): a network failure or bad JSON becomes "unavailable", never an exception');

// ── route ─────────────────────────────────────────────────────────────────
const { createAdminFinancialControlRoutes, CONTENT_SECURITY_POLICY } = require('../routes/adminFinancialControl.js');
const express = require('express');
let role = null;
const fakeAuth = (req, res, next) => (role ? next() : res.status(401).send('login'));
const fakeAdmin = (req, res, next) => (role === 'admin' ? next() : res.status(403).send('forbidden'));
const app = express();
app.use(createAdminFinancialControlRoutes({ requireAuth: fakeAuth, requireAdmin: fakeAdmin }));
const server = http.createServer(app);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/admin/financial-control`;
try {
  check((await fetch(url)).status === 401, 'signed out → 401 (requireAuth)');
  role = 'customer';
  check((await fetch(url)).status === 403, 'signed in, not admin → 403 (requireAdmin)');
  role = 'admin';
  const res = await fetch(url);
  const body = await res.text();
  check(res.status === 200 && body.includes('<title>Financial Control Centre') && res.headers.get('cache-control') === 'no-store', 'admin → the page, not cached');
  check(res.headers.get('content-security-policy') === CONTENT_SECURITY_POLICY && /default-src 'none'/.test(CONTENT_SECURITY_POLICY) && /connect-src 'self'/.test(CONTENT_SECURITY_POLICY) && /frame-ancestors 'none'/.test(CONTENT_SECURITY_POLICY) && res.headers.get('x-frame-options') === 'DENY', 'strict CSP (no third-party script/connect/frame), not frameable');
} finally {
  server.close();
}
const routeSrc = readFileSync(path.join(root, 'routes', 'adminFinancialControl.js'), 'utf8');
check(routeSrc.includes('require("../middleware/requireAuth").requireAuth') && routeSrc.includes('require("../middleware/requireAdmin").requireAdmin') && routeSrc.includes('router.get("/admin/financial-control", requireAuth, requireAdmin,'), 'default wiring uses the real requireAuth + requireAdmin');
check(!/router\.(post|put|patch|delete)\(/.test(routeSrc) && !/supabase/i.test(routeSrc.replace(/^\s*\/\/.*$/gm, '')), 'the router has no write routes and no database access');
const serverSrc = readFileSync(path.join(root, 'server.js'), 'utf8');
check(!serverSrc.includes('adminFinancialControl') || serverSrc.includes('app.use(require("./routes/adminFinancialControl").createAdminFinancialControlRoutes());'), 'server.js either does not mount it yet, or mounts the factory with its real defaults');

console.log(failures === 0 ? '\nFinancial Control Centre: all checks hold.' : `\n${failures} check(s) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
