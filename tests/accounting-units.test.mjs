// Accounting automation — unit tests for the pure parts: normalisers, policy,
// Xero mapping, the Xero HTTP adapter (fake fetch — no network), capture
// hook, admin route, and SQL ↔ JS vocabulary parity.
//
// Run with: node tests/accounting-units.test.mjs
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { invoicePaid, chargeRefunded, dispute, stripeEvent, topupSession, rc, H1, defaultDirectory, directoryResolver, TEST_ACCOUNT_CODES } from './helpers/accountingFixtures.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const C = require('../services/accounting/constants.js');
const { normalizeStripeEvent } = require('../services/accounting/normalizeStripe.js');
const { normalizeRevenueCatEvent, estimateAmounts } = require('../services/accounting/normalizeRevenueCat.js');
const { parseConfirmedDecisions, parseAccountCodes, checkStripeVat, postingBlockers, loadAccountingPolicy } = require('../services/accounting/accountingPolicy.js');
const { planForTransaction, planForSettlement, idempotencyKey } = require('../services/accounting/xero/mapping.js');
const { createXeroHttpClient, loadXeroConfig, xeroConnectionStatus, TOKEN_URL } = require('../services/accounting/xero/xeroClient.js');
const { classifyHttpStatus } = require('../services/accounting/xero/errors.js');
const { backoffSeconds } = require('../services/accounting/postingQueue.js');
const { createAccountingCapture } = require('../services/accounting/capture.js');
const { createMemoryAccountingStore } = require('../services/accounting/memoryStore.js');
const { projectToFinancialEntries } = require('../services/accounting/financialEntriesProjection.js');

let failures = 0;
function check(condition, message) {
  if (condition) console.log(`✓ ${message}`);
  else { console.error(`✗ ${message}`); failures++; }
}

// ── Stripe normaliser ───────────────────────────────────────────────────────
{
  const n = normalizeStripeEvent(invoicePaid({ eventId: 'evt_1', invoice: 'in_1' }));
  const f = n.facts[0];
  check(n.environment === 'production' && f.economicKey === 'stripe:sale:invoice:in_1' && f.grossMinor === 499 && f.taxMinor === 83, 'invoice.paid → sale keyed by invoice id');
  check(f.providerRefs.charge === 'ch_in_1' && f.providerRefs.payment_intent === 'pi_in_1' && f.householdHint === H1, 'refs and household hint captured');
  check(f.servicePeriodStart === '2026-10-01T10:00:00.000Z' && f.servicePeriodEnd === '2026-11-01T10:00:00.000Z', 'service period from the invoice line');
  check(normalizeStripeEvent({ ...invoicePaid({ eventId: 'e', invoice: 'i' }), livemode: undefined }).environment === 'sandbox', 'missing livemode is sandbox (only livemode:true is production)');
  check(normalizeStripeEvent(invoicePaid({ eventId: 'e', invoice: 'i', taxShape: 'none' })).facts[0].taxMinor === null, 'no tax field → null (unknown), never 0');
  const newApi = invoicePaid({ eventId: 'e', invoice: 'i', taxShape: 'none' });
  newApi.data.object.total_taxes = [{ amount: 50 }, { amount: 33 }];
  check(normalizeStripeEvent(newApi).facts[0].taxMinor === 83, 'newer API total_taxes summed');
  const r = normalizeStripeEvent(chargeRefunded({ eventId: 'e', invoice: 'in_1', refunds: [{ id: 're_a', amount: 100 }, { id: 're_b', amount: 50, status: 'failed' }] }));
  check(r.facts.length === 1 && r.facts[0].economicKey === 'stripe:refund:re_a' && r.facts[0].originalRefs.invoice === 'in_1', 'charge.refunded → one fact per succeeded refund');
  const refundObj = normalizeStripeEvent(stripeEvent('refund.created', 'e', { id: 're_c', object: 'refund', amount: 100, currency: 'gbp', charge: 'ch_x', payment_intent: 'pi_x', status: 'succeeded' }));
  check(refundObj.facts[0].economicKey === 'stripe:refund:re_c', 'bare refund object normalised to the same key shape');
  const d = normalizeStripeEvent(dispute({ eventId: 'e', id: 'dp_1', invoice: 'in_1' }));
  check(d.facts[0].kind === 'chargeback' && d.facts[0].feeMinor === 1500 && d.facts[0].grossMinor === 499, 'funds_withdrawn → chargeback with dispute fee');
  check(normalizeStripeEvent(stripeEvent('charge.dispute.closed', 'e', {})).facts.length === 0, 'dispute.closed is non-economic (funds events carry the money)');
  for (const t of ['invoice.payment_failed', 'customer.subscription.deleted', 'charge.succeeded', 'payment_intent.succeeded', 'invoice.payment_succeeded']) {
    const x = normalizeStripeEvent(stripeEvent(t, 'e', {}));
    check(x.facts.length === 0 && x.nonEconomicReason, `${t} is non-economic (${x.nonEconomicReason})`);
  }
  check(normalizeStripeEvent(stripeEvent('some.new_event', 'e', {})).nonEconomicReason === 'unhandled_event_type', 'unknown types are recorded, not guessed');
  check(normalizeStripeEvent(topupSession({ eventId: 'e', session: 'cs', pi: 'pi_t' })).facts[0].economicKey === 'stripe:sale:pi:pi_t', 'top-up session keyed by PaymentIntent');
  let threw = false; try { normalizeStripeEvent({}); } catch { threw = true; }
  check(threw, 'malformed event rejected');
}

// ── RevenueCat normaliser ───────────────────────────────────────────────────
{
  const n = normalizeRevenueCatEvent(rc({ id: 'r1', type: 'RENEWAL', transaction_id: 'atx' }));
  check(n.facts[0].economicKey === 'app_store:sale:atx' && n.facts[0].amountQuality === 'estimated', 'Apple renewal keyed by store transaction id; estimated');
  check(normalizeRevenueCatEvent(rc({ id: 'r', store: 'PLAY_STORE', transaction_id: 'gpa' })).facts[0].economicKey === 'play_store:sale:gpa', 'Play Store channel supported');
  check(normalizeRevenueCatEvent(rc({ id: 'r', store: 'STRIPE', transaction_id: 'x' })).supersededBy === 'stripe_webhook', 'store STRIPE superseded');
  check(normalizeRevenueCatEvent(rc({ id: 'r', store: 'PROMOTIONAL', transaction_id: 'x' })).complimentary === true, 'PROMOTIONAL is complimentary');
  check(normalizeRevenueCatEvent(rc({ id: 'r', store: 'AMAZON', transaction_id: 'x' })).nonEconomicReason === 'unsupported_store:AMAZON', 'unknown store not guessed');
  check(normalizeRevenueCatEvent(rc({ id: 'r', transaction_id: null })).nonEconomicReason === 'missing_store_transaction_id', 'no store transaction id → not recorded as money');
  check(normalizeRevenueCatEvent(rc({ id: 'r', type: 'NON_RENEWING_PURCHASE', transaction_id: 't', price: 2.99 })).facts[0].product === 'one_off', 'non-renewing purchase = one-off (top-up)');
  check(normalizeRevenueCatEvent(rc({ id: 'r', environment: 'sandbox', transaction_id: 't' })).environment === 'sandbox', 'lower-case sandbox environment is sandbox');
  const e = estimateAmounts({ price_in_purchased_currency: 4.99, tax_percentage: 0.1667, commission_percentage: 0.15 });
  check(e.grossMinor === 499 && e.taxMinor === 83 && e.feeMinor === 75 && e.proceedsMinor === 341, 'estimate: 4.99 − VAT 0.83 − commission 0.75 = 3.41');
  check(estimateAmounts({ price_in_purchased_currency: 4.99 }).proceedsMinor === null, 'missing percentages → proceeds unknown (not invented)');
}

// ── Policy ──────────────────────────────────────────────────────────────────
{
  check([...parseConfirmedDecisions(' ad-1, AD-7 ,AD-99,')].join() === 'AD-1,AD-7', 'decision list parsed; unknown ids dropped');
  check(Object.keys(parseAccountCodes('{not json')).length === 0 && Object.keys(parseAccountCodes('[1]')).length === 0, 'malformed account codes → none (no defaults)');
  const p = loadAccountingPolicy({});
  check(p.confirmed.size === 0 && Object.keys(p.accountCodes).length === 0, 'empty environment → nothing confirmed, no codes');
  check(postingBlockers({ channel: 'stripe', kind: 'sale' }, p).join() === 'AD-1,AD-2,AD-5,AD-6,AD-7,AD-10', 'Stripe sale needs AD-1/2/5/6/7/10');
  check(postingBlockers({ channel: 'app_store', kind: 'sale' }, p)[0] === 'not_individually_posted', 'store sales are never individually posted');
  check(checkStripeVat({ grossMinor: 499, taxMinor: 83, customerCountry: 'GB' }).issues.length === 0, '83p VAT on £4.99 is consistent');
  check(checkStripeVat({ grossMinor: 499, taxMinor: 0, customerCountry: 'GB' }).issues[0].code === 'vat_not_calculated', 'zero UK VAT flagged');
  check(checkStripeVat({ grossMinor: 499, taxMinor: 0, customerCountry: 'US' }).issues.length === 0, 'zero VAT outside the UK not flagged as a UK error');
  check(checkStripeVat({ grossMinor: 499, taxMinor: null }).issues[0].code === 'vat_not_reported', 'missing VAT flagged');
  check(C.ACCOUNTANT_DECISIONS.length === 11 && C.ACCOUNTANT_DECISIONS.every((d) => /^AD-\d+$/.test(d.id) && d.question.length > 20), '11 accountant decisions, each with a question');
}

// ── Xero mapping ────────────────────────────────────────────────────────────
{
  const tx = { channel: 'stripe', kind: 'sale', product: 'subscription', account_number: 'HCG-00010017', economic_key: 'stripe:sale:invoice:in_1', provider_transaction_id: 'in_1', gross_minor: 499, tax_minor: 83, currency: 'GBP', occurred_at: '2026-10-01T10:00:00Z' };
  const plan = planForTransaction(tx, TEST_ACCOUNT_CODES, { postingKey: 'xero:k' });
  check(plan.steps.length === 2 && plan.steps[0].endpoint === 'Invoices' && plan.steps[1].bind.idField === 'InvoiceID', 'sale → Invoice then bound Payment');
  check(plan.steps[0].body.Date === '2026-10-01' && plan.steps[0].body.CurrencyCode === 'GBP', 'date and currency');
  check(planForTransaction(tx, {}, { postingKey: 'k' }).error === 'missing_account_codes', 'no codes → refused');
  check(planForTransaction({ ...tx, account_number: null }, TEST_ACCOUNT_CODES, { postingKey: 'k' }).error === 'missing_account', 'no HCG account → refused');
  check(planForTransaction({ ...tx, channel: 'app_store' }, TEST_ACCOUNT_CODES, { postingKey: 'k' }).error === 'not_individually_posted', 'store tx not individually posted');
  const k1 = idempotencyKey('xero:a', 'invoice'); const k2 = idempotencyKey('xero:a', 'invoice'); const k3 = idempotencyKey('xero:a', 'payment');
  check(k1 === k2 && k1 !== k3 && k1.length <= 128, 'Idempotency-Key deterministic per step and ≤128 chars');
  const s = { channel: 'app_store', settlement_ref: '2026-10', currency: 'GBP', period_end: '2026-11-01T00:00:00Z', totals: { proceeds_minor: 710, fee_minor: 124 } };
  check(planForSettlement(s, TEST_ACCOUNT_CODES, { postingKey: 'k', storeRevenueBasis: null }).error === 'store_revenue_basis_unconfirmed', 'store basis must be decided (AD-4)');
  const g = planForSettlement(s, TEST_ACCOUNT_CODES, { postingKey: 'k', storeRevenueBasis: 'gross_with_commission' });
  check(g.steps[0].body.LineItems.length === 2 && g.steps[0].body.LineItems[0].UnitAmount === 8.34 && g.steps[0].body.LineItems[1].UnitAmount === -1.24, 'gross basis: sales 8.34 and commission −1.24');
}

// ── Xero HTTP adapter (fake fetch) ──────────────────────────────────────────
{
  let fetchCalls = 0;
  const disabled = createXeroHttpClient({ config: loadXeroConfig({}), fetchImpl: async () => { fetchCalls += 1; } });
  let err = null; try { await disabled.createDocument({ endpoint: 'Invoices', body: {} }); } catch (e) { err = e; }
  check(err && err.errorClass === 'unavailable' && fetchCalls === 0, 'unconfigured Xero: unavailable, no network call');
  check(xeroConnectionStatus(loadXeroConfig({ ACCOUNTING_XERO_POSTING_ENABLED: 'true' })).reason === 'credentials_not_configured', 'enabled without credentials is still not connected');

  const env = { ACCOUNTING_XERO_POSTING_ENABLED: 'true', XERO_CLIENT_ID: 'cid', XERO_CLIENT_SECRET: 'sec', XERO_SCOPES: 'scope.a scope.b', XERO_TENANT_ID: 'tenant-1' };
  const seen = [];
  let mode = 'ok';
  const fakeFetch = async (url, opts) => {
    seen.push({ url, opts });
    const resp = (status, json, headers = {}) => ({ ok: status < 300, status, json: async () => json, headers: { get: (h) => headers[h.toLowerCase()] || null } });
    if (url === TOKEN_URL) return resp(200, { access_token: 'tok', expires_in: 1800 });
    if (mode === 'network') throw new Error('ECONNRESET');
    if (mode === '429') return resp(429, {}, { 'retry-after': '42' });
    if (mode === '500') return resp(500, {});
    if (mode === '400') return resp(400, {});
    if (mode === '401') return resp(401, {});
    if (opts.method === 'GET') return resp(200, { Invoices: [{ InvoiceID: 'void-1', Reference: 'R "1"', Status: 'VOIDED' }, { InvoiceID: 'inv-1', Reference: 'R "1"', Status: 'AUTHORISED' }] });
    return resp(200, { Invoices: [{ InvoiceID: 'inv-new' }] });
  };
  const client = createXeroHttpClient({ config: loadXeroConfig(env), fetchImpl: fakeFetch, now: () => 1_000_000 });
  const created = await client.createDocument({ endpoint: 'Invoices', body: { Reference: 'R' }, idempotencyKey: 'hcg-abc' });
  const tokenCall = seen[0]; const put = seen[1];
  check(created.id === 'inv-new', 'create returns the Xero id');
  check(tokenCall.opts.headers.Authorization === `Basic ${Buffer.from('cid:sec').toString('base64')}` && tokenCall.opts.body.includes('grant_type=client_credentials') && tokenCall.opts.body.includes('scope=scope.a+scope.b'), 'custom-connection client_credentials token request');
  check(put.opts.method === 'PUT' && put.url.endsWith('/api.xro/2.0/Invoices') && put.opts.headers['Idempotency-Key'] === 'hcg-abc' && put.opts.headers['xero-tenant-id'] === 'tenant-1', 'PUT (create-only) with Idempotency-Key and tenant header');
  check(JSON.parse(put.opts.body).Invoices[0].Reference === 'R', 'body wrapped as { Invoices: [...] }');
  await client.createDocument({ endpoint: 'Invoices', body: {} });
  check(seen.filter((s) => s.url === TOKEN_URL).length === 1, 'access token cached');
  const found = await client.findByReference({ endpoint: 'Invoices', reference: 'R "1"' });
  check(found.id === 'inv-1' && decodeURIComponent(seen.at(-1).url).includes('where=Reference=="R \\"1\\""'), 'find by Reference (escaped), VOIDED documents ignored');
  for (const [m, cls] of [['network', 'unknown_outcome'], ['429', 'rate_limited'], ['500', 'unknown_outcome'], ['400', 'rejected'], ['401', 'unavailable']]) {
    mode = m; let e2 = null;
    try { await client.createDocument({ endpoint: 'Invoices', body: {} }); } catch (x) { e2 = x; }
    check(e2 && e2.errorClass === cls, `${m} → ${cls}${m === '429' ? ` (retry after ${e2 && e2.retryAfterSeconds}s)` : ''}`);
  }
  check(classifyHttpStatus(503) === 'unknown_outcome' && classifyHttpStatus(422) === 'rejected', 'status classification');
  check(backoffSeconds(1) === 60 && backoffSeconds(3) === 240 && backoffSeconds(20) === 21600 && backoffSeconds(1, 900) === 900, 'exponential backoff, capped at 6h, honours Retry-After');
}

// ── Capture hook ────────────────────────────────────────────────────────────
{
  const off = createAccountingCapture({ env: {}, deps: { supabase: null } });
  check((await off.captureStripeEvent(invoicePaid({ eventId: 'e', invoice: 'i' }))).reason === 'disabled', 'capture is OFF by default (no DB touched)');
  const store = createMemoryAccountingStore();
  const on = createAccountingCapture({ env: { ACCOUNTING_CAPTURE_ENABLED: 'true' }, deps: { supabase: {}, store, resolver: directoryResolver(defaultDirectory()) } });
  const r = await on.captureStripeEvent(invoicePaid({ eventId: 'e1', invoice: 'i1' }));
  check(r.captured && r.outcome === 'recorded' && (await store.listTransactions({})).length === 1, 'enabled capture records into the sub-ledger');
  check((await store.listTransactions({}))[0].status === 'blocked', 'with no accountant decisions configured it is captured but blocked (never posted)');
  const alerts = [];
  const broken = createAccountingCapture({ env: { ACCOUNTING_CAPTURE_ENABLED: 'true' }, deps: {
    supabase: {}, resolver: directoryResolver(defaultDirectory()), sendCriticalAlert: async (...a) => { alerts.push(a); },
    store: { claimSourceEvent: async () => { throw new Error('function public.acc_claim_source_event does not exist'); } },
  } });
  const b = await broken.captureRevenueCatEvent(rc({ id: 'r', transaction_id: 't' }));
  check(b.captured === false && b.reason === 'error' && alerts.length === 1 && alerts[0][0] === 'accounting_capture_failed', 'capture failure never throws; it alerts');
  const billing = readFileSync(path.join(ROOT, 'routes', 'billing.js'), 'utf8');
  const hook = billing.indexOf('await accountingCapture.captureStripeEvent(event);');
  check(hook > billing.indexOf('constructEvent(') && hook < billing.indexOf('interpretStripeTopUpEvent(event)'), 'Stripe hook runs only after signature verification, before any branch');
  const mobile = readFileSync(path.join(ROOT, 'routes', 'mobileApi.js'), 'utf8');
  const rcHook = mobile.indexOf('await accountingCapture.captureRevenueCatEvent(req.body);');
  check(rcHook > mobile.indexOf('req.headers.authorization !== expectedAuth') && rcHook < mobile.indexOf('resolveEventAppUserId(event)'), 'RevenueCat hook runs only after authorization, before entitlement handling');
}

// ── SQL vocabulary == JS vocabulary ─────────────────────────────────────────
{
  const sql = readFileSync(path.join(ROOT, 'supabase', 'migrations', '071_accounting_transactions.sql'), 'utf8');
  const listAfter = (marker) => {
    const i = sql.indexOf(marker);
    const m = sql.slice(i).match(/in \(([^)]*)\)/);
    return m ? m[1].split(',').map((s) => s.trim().replace(/'/g, '')).filter(Boolean).sort() : [];
  };
  const eq = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
  check(eq(listAfter('channel text not null check'), Object.values(C.CHANNELS)), 'SQL channels = constants');
  check(eq(listAfter("kind text not null check (kind"), Object.values(C.KINDS)), 'SQL kinds = constants');
  check(eq(listAfter("status text not null check (status in ('excluded_sandbox'"), Object.values(C.TX_STATUS)), 'SQL transaction statuses = constants');
  check(eq(listAfter("type text not null check (type"), Object.values(C.EXCEPTION_TYPES)), 'SQL exception types = constants');
  check(eq(listAfter('outcome text check'), Object.values(C.EVENT_OUTCOMES)), 'SQL event outcomes = constants');
  check(eq(listAfter('source text not null check'), Object.values(C.SOURCES)), 'SQL sources = constants');
  check(Object.keys(C.EXCEPTION_SEVERITY).length === Object.values(C.EXCEPTION_TYPES).length, 'every exception type has a severity');
  check(/STATUS: DRAFT — NOT APPLIED ANYWHERE/.test(sql), '071 is marked DRAFT — NOT APPLIED');
}

// ── 051 projection (shape; constraint acceptance is proven on PGlite) ───────
{
  const tx = { environment: 'production', channel: 'stripe', kind: 'sale', economic_key: 'stripe:sale:invoice:i', provider_transaction_id: 'i', currency: 'GBP', gross_minor: 499, tax_minor: 83, fee_minor: null, amount_quality: 'provider_actual', status: 'ready', provider_refs: {} };
  const rows = projectToFinancialEntries(tx);
  check(rows.length === 3 && rows.map((r) => r.category).join() === 'subscription,vat_output,payment_processing_fee', 'Stripe sale → revenue, VAT, fee (pending)');
  check(rows[2].amount === null && rows[2].charge_observation === 'pending', 'unknown fee is pending, never £0');
  check(projectToFinancialEntries({ ...tx, environment: 'sandbox' }).length === 0, 'sandbox projects nothing');
  const store = projectToFinancialEntries({ ...tx, channel: 'app_store', economic_key: 'app_store:sale:a', amount_quality: 'estimated', fee_minor: 62, gross_minor: 499, tax_minor: 83 });
  check(store[0].amount === 4.16 && store.every((r) => r.provenance === 'estimated') && !store.some((r) => r.category === 'vat_output'), 'store revenue ex store VAT (4.16), estimated, no HCG output VAT');
}

// ── Admin route ─────────────────────────────────────────────────────────────
{
  const authPath = require.resolve(path.join(ROOT, 'middleware', 'requireAuth.js'));
  require.cache[authPath] = { id: authPath, filename: authPath, loaded: true, exports: {
    requireAuth: (req, res, next) => {
      if (!req.get('x-test-user')) return res.status(401).json({ error: 'unauthenticated' });
      req.authUserId = req.get('x-test-user'); req.role = req.get('x-test-role') || 'customer'; return next();
    },
  } };
  const express = require('express');
  const { createAdminAccountingRoutes } = require('../routes/adminAccounting.js');
  const memory = createMemoryAccountingStore();
  await memory.raiseException({ exception_key: 'unmatched_payment:x', type: 'unmatched_payment', severity: 'high', account_number: 'HCG-00010017', detail: {} });
  const app = express();
  app.use('/a', createAdminAccountingRoutes({ supabaseAdmin: null, store: memory, env: {} }));
  app.use('/b', createAdminAccountingRoutes({ supabaseAdmin: null, store: { listTransactions: async () => { throw new Error('Could not find the function public.acc_list_transactions in the schema cache'); }, listExceptions: async () => [], listPostings: async () => [], listSourceEvents: async () => [], listSettlements: async () => [] }, env: {} }));
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const get = (p, headers = {}) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: server.address().port, path: p, headers }, (res) => {
      let body = ''; res.on('data', (c) => { body += c; }); res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    }).on('error', reject);
  });
  check((await get('/a/admin/api/accounting/status')).status === 401, 'unauthenticated → 401');
  check((await get('/a/admin/api/accounting/status', { 'x-test-user': 'u1' })).status === 302, 'non-admin → redirected away');
  const ok = await get('/a/admin/api/accounting/status', { 'x-test-user': 'u1', 'x-test-role': 'admin' });
  const json = JSON.parse(ok.body);
  check(ok.status === 200 && json.exceptions.open === 1 && json.xero.connected === false && json.capture_enabled === false, 'admin gets status: 1 open exception, Xero not connected, capture off');
  check(json.accountant_decisions.length === 11 && json.accountant_decisions.every((d) => d.confirmed === false), 'every accountant decision shown as unconfirmed');
  check(ok.headers['cache-control'] === 'no-store', 'not cached');
  const ex = await get('/a/admin/api/accounting/exceptions?status=bogus', { 'x-test-user': 'u1', 'x-test-role': 'admin' });
  check(ex.status === 200 && JSON.parse(ex.body).status === 'open' && JSON.parse(ex.body).count === 1, 'exceptions list (invalid filter falls back to open)');
  const na = await get('/b/admin/api/accounting/status', { 'x-test-user': 'u1', 'x-test-role': 'admin' });
  check(na.status === 503 && /071 not applied/.test(na.body), 'migration not applied → 503 with reason');
  const routeSrc = readFileSync(path.join(ROOT, 'routes', 'adminAccounting.js'), 'utf8');
  check(!/router\.(post|put|patch|delete)\(/.test(routeSrc), 'admin accounting routes are read-only (GET only)');
  server.close();
}

console.log(failures === 0 ? '\nAll accounting unit checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
