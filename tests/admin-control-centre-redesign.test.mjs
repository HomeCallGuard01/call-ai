// Admin Control Centre redesign (2026-10-04).
//
// What must hold:
//   1. The founder summary composes the CANONICAL definitions only:
//      genuine = commercialStatus, protected = activationState, attention =
//      exceptionQueue. Test / reviewer / sandbox / unverified / complimentary
//      accounts never inflate genuine counts and never celebrate.
//   2. The September incident (paid, forwarding works, app never registered)
//      is a CRITICAL genuine-customer item immediately, not after 24 h.
//   3. Telephone numbers never appear in full; the HCG account number is
//      the identity.
//   4. The route is admin-only, read-only and fails closed (503, never
//      "0 customers").
//   5. The page renders hostile data as text, issues only GET requests from
//      the new block, carries the HCG brand, marks the staging number
//      reserved, and states service health in Healthy / Attention / Critical.
//   6. The preview harness is local-only and synthetic, and the server
//      never serves it.
//
// Run with: node tests/admin-control-centre-redesign.test.mjs
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

let failures = 0;
function check(condition, message) {
  if (condition) console.log(`✓ ${message}`);
  else { console.error(`✗ ${message}`); failures++; }
}

const { buildControlCentreSummary, maskNumbers } = require('../services/adminControlCentre/summary');
const { STAGES } = require('../services/lifecycle/activationState');

const NOW = new Date('2026-10-04T15:00:00Z');
const H = 3600e3;
const ago = (ms) => new Date(NOW.getTime() - ms).toISOString();
const ahead = (ms) => new Date(NOW.getTime() + ms).toISOString();
let n = 0;
function snap({ household = {}, entitlements = [], classification = null, subscription = null, quarantineRows = [], currentNumberAssignedAt } = {}) {
  n += 1;
  const id = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const h = { id, status: 'active', auth_user_id: 'u' + n, email: `t${n}@example.com`, created_at: ago(5 * 24 * H), account_number: `HCG-${String(n).padStart(8, '0')}`, twilio_number: null, twilio_provisioning_status: 'not_started', ...household };
  return {
    household: h,
    entitlements: entitlements.map((e, i) => ({ id: `${id}-e${i}`, household_id: id, status: 'active', starts_at: ago(3 * 24 * H), ends_at: ahead(20 * 24 * H), ...e })),
    subscription, quarantineRows, financialHold: null,
    currentNumberAssignedAt: currentNumberAssignedAt === undefined ? (h.twilio_provisioning_status === 'active' ? h.twilio_provisioning_updated_at : null) : currentNumberAssignedAt,
    failedStripeEvents: [], liveSubscriptionEventsAfterDeletion: [], classification, deliveryHealth: null,
  };
}
const stripePaid = { entitlement_type: 'paid_subscription', source: 'stripe' };
const numberActive = (at = ago(3 * 24 * H)) => ({ twilio_number: '+442079460123', twilio_provisioning_status: 'active', twilio_provisioning_updated_at: at });
const protectedFacts = { activation_verified_at: ago(2 * 24 * H), voice_client_registered_at: ago(H), delivery_verified_at: ago(2 * 24 * H) };

// --- 1. Canonical classification ------------------------------------------
{
  const s = buildControlCentreSummary({ snapshots: [
    snap({ household: { ...numberActive(), ...protectedFacts }, entitlements: [stripePaid] }), // genuine, protected
    snap({ household: { ...numberActive(), ...protectedFacts }, entitlements: [stripePaid], classification: 'internal_test' }),
    snap({ household: { ...numberActive(), ...protectedFacts }, entitlements: [{ ...stripePaid, source: 'apple_revenuecat', revenuecat_environment: 'sandbox' }], classification: 'reviewer' }),
    snap({ household: { ...numberActive() }, entitlements: [{ ...stripePaid, source: 'apple_revenuecat', revenuecat_environment: 'sandbox' }] }),
    snap({ entitlements: [{ ...stripePaid, source: 'apple_revenuecat', revenuecat_environment: null }] }),
    snap({ household: { ...numberActive(), ...protectedFacts }, entitlements: [{ entitlement_type: 'complimentary', source: 'admin' }] }),
    snap({ household: { ...numberActive(), ...protectedFacts }, entitlements: [{ ...stripePaid, source: 'apple_revenuecat', revenuecat_environment: 'production' }] }), // genuine Apple
    snap({ entitlements: [{ ...stripePaid, status: 'expired', ends_at: ago(2 * 24 * H) }] }), // former customer
    snap({ entitlements: [{ ...stripePaid, stripe_livemode: false }] }), // Stripe test mode
  ] }, NOW);
  const segs = s.customers.map((c) => c.segment);
  check(JSON.stringify(segs) === JSON.stringify(['genuine_paying', 'internal_test', 'reviewer', 'sandbox', 'payment_unverified', 'complimentary', 'genuine_paying', 'former_customer', 'sandbox']),
    'segments map the canonical commercial status: genuine, test, reviewer, sandbox, unverified, complimentary, Apple production, former, Stripe test');
  check(s.headline.genuineCustomers === 2, 'only Stripe-live and Apple-production paying accounts count as genuine customers (test, reviewer, sandbox, unverified, complimentary excluded)');
  check(s.headline.genuineProtected === 2 && s.customers.filter((c) => c.protection.protected).length === 5, 'protected genuine count is genuine-only even though complimentary/test accounts are protected too');
  check(s.customers.every((c) => typeof c.commercial.genuinePaying === 'boolean' && (c.segment === 'genuine_paying') === c.commercial.genuinePaying), 'segment "genuine_paying" ⇔ classifyCommercialStatus().genuinePaying, for every account');
  check(s.activity.filter((e) => e.celebrate).every((e) => e.genuine), 'only genuine customers ever produce a celebration (NEW GENUINE CUSTOMER / CUSTOMER PROTECTED)');
  check(!s.activity.some((e) => e.celebrate && ['internal_test', 'reviewer', 'sandbox', 'payment_unverified', 'complimentary'].includes(e.segment)), 'test / reviewer / sandbox / unverified / complimentary activity never celebrates');
}

// --- 2. Protection is the canonical gate conjunction -----------------------
{
  // Evidence for an OLD number: the new number became active after the proof.
  const stale = snap({ household: { ...numberActive(ago(H)), ...protectedFacts }, entitlements: [stripePaid] });
  const s = buildControlCentreSummary({ snapshots: [stale] }, NOW);
  const c = s.customers[0];
  check(!c.protection.protected && c.protection.stage !== STAGES.PROTECTED, 'forwarding/delivery proof for a previous number does not make the customer protected (canonical P-3)');
  check(c.journey.find((x) => x.key === 'protected_now').done === false && c.journey.some((x) => x.firstIncomplete), 'journey shows "Protected now" not done and highlights the first missing step');
  check(s.headline.genuineProtected === 0, 'headline protected count follows the canonical state, not the legacy timestamps');
}

// --- 3. The September incident is critical immediately ---------------------
{
  const incident = snap({ household: { ...numberActive(ago(5 * H)), activation_verified_at: ago(2 * H) }, entitlements: [{ ...stripePaid, starts_at: ago(6 * H) }] });
  const sandboxSame = snap({ household: { ...numberActive(ago(5 * H)), activation_verified_at: ago(2 * H) }, entitlements: [{ ...stripePaid, source: 'apple_revenuecat', revenuecat_environment: 'sandbox', starts_at: ago(6 * H) }] });
  const s = buildControlCentreSummary({ snapshots: [incident, sandboxSame] }, NOW);
  const items = s.attention.filter((a) => a.code === 'CALLS_ARRIVING_APP_NOT_REGISTERED');
  check(items.length === 1 && items[0].severity === 'critical' && items[0].genuine && items[0].householdId === incident.household.id,
    'paying customer whose forwarding works but whose app never registered → CRITICAL "missing calls", within hours (not after 24 h)');
  check(s.attention[0].code === 'CALLS_ARRIVING_APP_NOT_REGISTERED', 'it is the first item in the attention list');
  check(s.headline.genuineNeedingAttention === 1, 'it counts as a genuine customer needing attention');
  check(!s.attention.some((a) => a.householdId === sandboxSame.household.id && a.code === 'CALLS_ARRIVING_APP_NOT_REGISTERED'), 'the same situation on a sandbox account is not raised as a missing-calls customer emergency');

  const after24h = snap({ household: { ...numberActive(ago(48 * H)), activation_verified_at: ago(40 * H) }, entitlements: [{ ...stripePaid, starts_at: ago(50 * H) }] });
  const s2 = buildControlCentreSummary({ snapshots: [after24h] }, NOW);
  check(s2.attention.filter((a) => a.householdId === after24h.household.id).map((a) => a.code).join() === 'CALLS_ARRIVING_APP_NOT_REGISTERED', 'after 24 h the specific cause replaces the generic SETUP_STALLED (one item, not two)');
}

// --- 4. Identity and masking -------------------------------------------------
{
  check(maskNumbers('number +442046521883 quarantined') === 'number •••883 quarantined' && maskNumbers('+44 20 7946 0123') === '•••123', 'telephone numbers are masked to the last three digits');
  const conflict = snap({ household: { ...numberActive(), ...protectedFacts }, entitlements: [stripePaid], quarantineRows: [{ id: 'q', household_id: 'x', twilio_number: '+442079460123', quarantined_at: ago(H), released_at: null }] });
  conflict.quarantineRows[0].household_id = conflict.household.id;
  const orphan = { id: 'o', household_id: null, twilio_number: '+442079460999', quarantined_at: ago(H), released_at: null };
  const s = buildControlCentreSummary({ snapshots: [conflict], orphanQuarantineRows: [orphan] }, NOW);
  const json = JSON.stringify(s);
  check(!/\+?44\s?20\s?7946/.test(json) && !json.includes('2079460'), 'no full telephone number anywhere in the summary payload (details are masked)');
  check(!json.includes('@example.com'), 'the summary carries no email addresses (the page joins them from the onboarding feed)');
  check(s.customers[0].accountNumber === conflict.household.account_number && s.attention.some((a) => a.accountNumber === conflict.household.account_number), 'the HCG account number is the identity on customers and attention items');
  const noNumber = buildControlCentreSummary({ snapshots: [snap({ household: { account_number: null }, entitlements: [stripePaid] })] }, NOW);
  check(noNumber.customers[0].accountNumber === null && noNumber.identity.accountNumbersAssigned === 0, 'a household without an account number (062 not applied) is reported as such, never given a Twilio number as identity');
}

// --- 5. Module composes, never re-derives -----------------------------------
{
  const src = readFileSync(path.join(root, 'services/adminControlCentre/summary.js'), 'utf8');
  check(src.includes("require('../commercial/commercialStatus')") && src.includes("require('../lifecycle/exceptionQueue')") && src.includes("require('../opsEvents/detector')"), 'summary imports the canonical commercial, lifecycle and ops-event modules');
  check(!/revenuecat_environment|stripe_livemode|voice_client_registered_at\s*&&|fullyProtected/.test(src.replace(/\/\/.*$/gm, '')), 'summary contains no genuine/protected rule of its own (no environment or protection-timestamp logic)');
  check(!/\.(insert|update|upsert|delete|rpc)\(/.test(src), 'summary performs no writes');
}

// --- 6. Route: admin-only, read-only, fail-closed ----------------------------
{
  const src = readFileSync(path.join(root, 'routes/adminControlCentre.js'), 'utf8');
  check(/router\.get\("\/admin\/api\/control-centre\/summary", requireAuth, requireAdmin,/.test(src), 'GET /admin/api/control-centre/summary requires requireAuth + requireAdmin');
  check(!/router\.(post|put|patch|delete)\(/.test(src), 'the control-centre route file declares no write routes');
  const server = readFileSync(path.join(root, 'server.js'), 'utf8');
  check(server.includes('require("./routes/adminControlCentre").createAdminControlCentreRoutes({ supabaseAdmin })'), 'server.js mounts the control-centre route');
  check(!server.includes('admin-preview'), 'server.js never serves the preview harness');

  const { createAdminControlCentreRoutes } = require('../routes/adminControlCentre');
  const run = async (loadSnapshots) => {
    const router = createAdminControlCentreRoutes({ supabaseAdmin: {}, loadSnapshots, now: () => NOW });
    const layer = router.stack.find((l) => l.route && l.route.path === '/admin/api/control-centre/summary');
    const handler = layer.route.stack[layer.route.stack.length - 1].handle;
    const res = { statusCode: 200, body: null, headers: {}, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, set(k, v) { this.headers[k] = v; return this; } };
    const origError = console.error;
    console.error = () => {};
    try { await handler({}, res); } finally { console.error = origError; }
    return res;
  };
  const failed = await run(async () => { throw new Error('households unreadable'); });
  check(failed.statusCode === 503 && failed.body.error === 'unavailable' && !('headline' in failed.body), 'a failed snapshot load answers 503 unavailable — never a summary with zero customers');
  const ok = await run(async () => ({ snapshots: [snap({ household: { ...numberActive(), ...protectedFacts }, entitlements: [stripePaid] })], orphanQuarantineRows: [], sources: { subscriptions: 'ok' }, truncated: false }));
  check(ok.statusCode === 200 && ok.body.headline.genuineCustomers === 1 && ok.headers['Cache-Control'] === 'no-store', 'a successful load returns the summary with Cache-Control: no-store');
}

// --- 7. Page: brand, structure, rendering safety ------------------------------
const html = readFileSync(path.join(root, 'admin-business.html'), 'utf8');
const extract = (name) => {
  const s = `// TEST-EXTRACT-START: ${name}`;
  const e = `// TEST-EXTRACT-END: ${name}`;
  const i = html.indexOf(s);
  const j = html.indexOf(e);
  return i === -1 || j === -1 ? null : html.slice(i + s.length, j);
};
{
  check(html.includes('<img src="/hcg-shield.png"') && html.includes('class="brand-name">Home Call Guard<') && html.includes('Admin Control Centre'), 'HCG shell: the existing shield logo, "Home Call Guard" and "Admin Control Centre"');
  check(/--green:\s*#3cf07a/.test(html) && /--bg:\s*#050a07/.test(html) && html.includes('family=Inter'), 'brand tokens match the public website (green #3cf07a, background #050a07, Inter)');
  check(!/#22d3ee|#0b1220|#111a2e/i.test(html), 'no legacy navy/cyan colour literals remain');
  check(html.includes('@media (max-width: 640px)') && html.includes('.cc-table .hide-sm { display: none; }'), 'phone layout: stacked status, scrolling tabs, secondary columns hidden');
  const panel = (id) => { const i = html.indexOf(`<div id="${id}" class="tab-panel"`); return html.slice(i, html.indexOf('\n', i)); };
  check(['ccHighlights', 'ccHeadline', 'ccStatus', 'attention', 'ccActivity'].every((x) => panel('overview').includes(`id="${x}"`)) && !panel('overview').includes('id="overviewBody"'), 'Overview = highlights, headline KPIs, HCG status, attention, activity — the technical checks grid is not on it');
  check(panel('operations').includes('id="overviewBody"') && panel('operations').includes('id="ccOpsStatus"'), 'the detailed checks and service & safety status live on Operations');

  const cc = extract('controlCentre');
  check(!!cc, 'controlCentre block is extractable');
  check(!/method:\s*'(POST|PUT|PATCH|DELETE)'/i.test(cc), 'the new control-centre block issues GET requests only');
  check(cc.includes("ccFetch('/admin/api/control-centre/summary')") && cc.includes("ccFetch('/admin/api/fortress/overview')"), 'Overview reads the canonical summary and the Fortress overview');

  const helpers = extract('customerMonitorHelpers');
  const dt = extract('fmtDateTime');
  const evil = '"><img src=x onerror=alert(1)>';
  const api = new Function('document', `${helpers}\n${dt}\nlet openCustomerDetailId = null; let customerSearch = ''; const businessControlCache = {}; let lastBusinessData = null;\n${cc}\nreturn { buildKpis, renderKpisHtml, computeHcgStatus, renderStatusHtml, buildHighlights, renderHighlightsHtml, buildActivity, renderActivityHtml, renderCanonicalAttentionHtml, buildCustomerModels, sortCustomerModels, filterCustomerModels, customerDetailHeaderHtml, journeyHtml, buildNumberGroups, renderNumbersSummaryHtml, isReservedNumber, buildMoneySummary, renderMoneySummaryHtml, renderOpsStatusHtml, setSummary: (s) => { ccSummary = s; } };`)({ getElementById: () => null });

  const fixtures = require('../tools/admin-preview/fixtures');
  const routes = await fixtures.routes();
  const summary = routes['/admin/api/control-centre/summary'];
  const onboarding = routes['/admin/api/customers/onboarding'];
  const overview = routes['/admin/api/business-control/overview'];
  api.setSummary(summary);
  const nowMs = NOW.getTime();

  const kpis = api.buildKpis(summary, overview);
  check(kpis.map((k) => k.label).join('|') === 'Genuine customers|Protected|Needs attention|Monthly revenue', 'four headline KPIs: genuine customers, protected, needs attention, monthly revenue');
  check(kpis[0].value === '5' && kpis[1].value.startsWith('3') && kpis[2].value === '2', 'synthetic five-customer launch: 5 genuine, 3 protected, 2 need attention');
  check(api.buildKpis(null, overview) === null, 'no summary → no headline figures (never zeros)');

  const status = api.computeHcgStatus({ summary, business: routes['/admin/api/business/overview'], fortress: routes['/admin/api/fortress/overview'], overview, opsEvents: null, opsEventsError: 'operational events not deployed (migration 072)' });
  check(status.map((r) => r.label).join('|') === 'Customer protection|Telephony|Financial protection|Payments|Notifications', 'HCG status rows: protection, telephony, financial, payments, notifications');
  check(status.every((r) => ['healthy', 'attention', 'critical', 'unknown'].includes(r.state)), 'every status is Healthy / Attention / Critical (or Not reported)');
  check(status[0].state === 'critical', 'a genuine customer missing calls makes Customer protection CRITICAL');
  check(status[4].state === 'attention' && /072/.test(status[4].text), 'operational notifications not deployed → Notifications: Attention, saying why');
  const breaker = api.computeHcgStatus({ summary, business: null, fortress: { global: { available: true, breakerOpen: true, breakerReason: 'provider usage alert' } }, overview: null, opsEvents: { deliveryProblems: [] } });
  check(breaker[2].state === 'critical' && /OPEN/.test(breaker[2].text), 'an open Fortress breaker → Financial protection: Critical');
  const noData = api.computeHcgStatus({ summary: null, summaryError: 'x', business: null, fortress: null, overview: null, opsEvents: null });
  check(noData[0].state === 'unknown' && noData[2].state === 'unknown', 'missing data is "Not reported", never Healthy');
  check(!api.renderStatusHtml([{ label: evil, state: 'healthy', text: evil }]).includes('<img'), 'status rows escape data');

  const hl = api.buildHighlights(summary, nowMs);
  check(hl.some((h) => h.kind === 'attention') && hl.some((h) => h.kind === 'new') && hl.every((h) => summary.customers.find((c) => c.householdId === h.householdId).segment === 'genuine_paying'), 'highlights: NEW GENUINE CUSTOMER / CUSTOMER PROTECTED / NEEDS ATTENTION, genuine customers only');
  check(hl.length <= 4, 'at most four highlights');

  const models = api.sortCustomerModels(api.buildCustomerModels(summary, onboarding));
  check(models[0].segment === 'genuine_paying' && models[0].attention[0].severity === 'critical', 'Customers: genuine customers first, the most urgent at the top');
  check(models.findIndex((m) => m.segment !== 'genuine_paying') > models.filter((m) => m.segment === 'genuine_paying').length - 1, 'every genuine customer sorts above every non-genuine account');
  check(api.filterCustomerModels(models, 'genuine', '').length === 5 && api.filterCustomerModels(models, 'test', '').length === 2 && api.filterCustomerModels(models, 'all', 'HCG-00100032').length === 1, 'filters by segment and finds a customer by HCG account number');
  const legacy = api.buildCustomerModels(null, onboarding);
  check(legacy.length === onboarding.rows.length && legacy.every((m) => m.canonical === false), 'without the summary the table falls back to the legacy feed, flagged as such');

  const incident = models[0];
  const detail = api.customerDetailHeaderHtml(incident, summary, nowMs);
  check(['Joined', 'Paid', 'HCG number ready', 'App registered', 'Call forwarding confirmed', 'First protected call', 'Protected now'].every((l) => detail.includes(l)), 'customer detail shows the journey: joined → paid → number → app → forwarding → first protected call → protected now');
  check(detail.includes('class="blocker"') && detail.includes('missing calls'), 'the journey highlights the missing step and the detail states what needs doing');

  const hostileSummary = JSON.parse(JSON.stringify(summary));
  for (const a of hostileSummary.attention) { a.title = evil; a.detail = evil; a.nextStep = evil; a.accountNumber = evil; }
  for (const e of hostileSummary.activity) { e.title = evil; e.accountNumber = evil; }
  for (const c of hostileSummary.customers) { c.accountNumber = evil; c.protection.label = evil; c.segmentLabel = evil; }
  const hostileOnboarding = JSON.parse(JSON.stringify(onboarding));
  for (const r of hostileOnboarding.rows) r.email = evil;
  api.setSummary(hostileSummary);
  const outputs = [
    api.renderCanonicalAttentionHtml(hostileSummary, overview, null, hostileOnboarding),
    api.renderActivityHtml(api.buildActivity(hostileSummary, { events: [{ event_type: evil, account_number: evil, occurred_at: NOW.toISOString() }] }), nowMs),
    api.renderHighlightsHtml(api.buildHighlights(hostileSummary, nowMs), nowMs),
    ...api.buildCustomerModels(hostileSummary, hostileOnboarding).map((m) => api.customerDetailHeaderHtml(m, hostileSummary, nowMs)),
  ];
  check(outputs.every((o) => !o.includes('<img') && !o.includes('onerror=alert(1)>')) && outputs.some((o) => o.includes('&lt;img')), 'attention, activity, highlights and customer detail render hostile strings as text');
  api.setSummary(summary);

  check(api.isReservedNumber('+44 •••• ••1883') && api.isReservedNumber('+442046521883') && !api.isReservedNumber('+442079460883'), 'the staging test number (…1883) is recognised as reserved; a different …883 number is not');
  const groups = api.buildNumberGroups(overview.inventory, summary);
  const g = Object.fromEntries(groups.map((x) => [x.key, x.count]));
  check(g.genuine === 5 && g.staging === 1 && g.quarantined === 2 && g.other === 4, 'Numbers: genuine / other / staging / quarantined groups from the inventory and the canonical segments');
  check(groups.reduce((a, x) => a + x.count, 0) === overview.inventory.rows.length, 'every provider number falls in exactly one group');
  check(api.renderNumbersSummaryHtml(overview.inventory, summary).includes('Reserved — do not release'), 'Numbers summary states the staging number is reserved');
  check(/const reserved = typeof isReservedNumber === 'function' && isReservedNumber\(row\.number\)/.test(html) && html.includes("(row.sid && !reserved ? '<button"), 'the inventory never offers a release review for the reserved number');

  const money = api.buildMoneySummary({ finance: routes['/admin/api/business-control/finance'], overview, fortress: routes['/admin/api/fortress/overview'], accounting: null, accountingError: 'accounting tables not present (migration 071 not applied)' });
  const labels = money.cards.map((c) => c.label);
  check(['Genuine subscription revenue', 'Refunds', 'Estimated variable cost', 'Estimated gross contribution', 'Number rental exposure', 'Customer allowance exposure', 'Accounting exceptions'].every((l) => labels.includes(l)), 'Money answers: revenue, refunds, variable cost, contribution, number rental, allowance exposure, accounting exceptions');
  check(money.cards.find((c) => c.label === 'Refunds').value === '—' && !JSON.stringify(money).includes('£0.00 refund'), 'refunds are stated as not reported separately, never shown as £0');
  check(api.renderMoneySummaryHtml(money).includes('£5.99/month including VAT') && api.renderMoneySummaryHtml(money).includes('Nothing here changes Stripe, Apple or Google prices'), 'Money shows the £5.99 inc. VAT launch decision and that live prices are not changed here');

  const ops = api.renderOpsStatusHtml({ fortress: routes['/admin/api/fortress/overview'], opsEvents: null, opsEventsError: 'not deployed', accounting: null, business: routes['/admin/api/business/overview'] });
  check(ops.includes('Emergency controls are deliberately not buttons here') && !/<button[^>]*(breaker|kill)/i.test(ops), 'Operations shows Fortress state read-only; breaker / kill switch stay behind the audited typed-confirmation endpoints');
}

// --- 7b. Final polish (2026-10-04, approved direction) -------------------------
{
  const moneyPanel = (() => { const i = html.indexOf('<div id="money" class="tab-panel"'); return html.slice(i, html.indexOf('\n', i)); })();
  check(moneyPanel.indexOf('id="ccMoney"') < moneyPanel.indexOf('id="finance"') && /<details class="secondary-section"><summary>Acquisition &amp; marketing[^<]*<\/summary><div id="marketing"><\/div><div id="acquisition"><\/div><\/details>/.test(moneyPanel),
    'Money: the commercial summary stays open first; acquisition & marketing is a labelled collapsible section (content kept)');
  const finance = html.slice(html.indexOf('async function renderFinanceTab()'), html.indexOf('// ---------- Marketing ----------'));
  for (const label of ['Spend safety — level', 'Profit &amp; loss and cost lines (with sources)', 'Unit economics, fixed costs &amp; assumptions', 'Data sources &amp; connections']) {
    check(finance.includes('<summary>' + label), `Money finance detail grouped under a labelled collapsible: "${label.replace(/&amp;/g, '&')}"`);
  }
  check((finance.match(/<details class="secondary-section">/g) || []).length === (finance.match(/<\/details>/g) || []).length, 'every finance detail section is closed (balanced <details>)');
  check(/button\.kpi \{[^}]*justify-content: flex-start/.test(html), 'clickable KPI cards are top-aligned like the plain ones');
  check(/\.cc-table tr\.cc-row td \{[^}]*grid-column: 1;[^}]*min-width: 0/.test(html) && /\.cc-table tr\.cc-row td:last-child \{ grid-column: 2; grid-row: 1; \}/.test(html), 'phone: customer rows become cards with the Open action pinned top-right (never clipped)');
  check(/\.ops-table th \{ display: none; \}/.test(html) && html.includes('class="mini-table ops-table"'), 'phone: the Operations status table stacks per area; emergency-control notice stays in the page');
}

// --- 8. Preview harness is local and synthetic ----------------------------
{
  const serve = readFileSync(path.join(root, 'tools/admin-preview/serve.js'), 'utf8');
  check(serve.includes("server.listen(PORT, '127.0.0.1'"), 'preview binds to 127.0.0.1 only');
  check(serve.includes("if (method !== 'GET') return respond(405") && serve.includes('SYNTHETIC PREVIEW DATA'), 'preview refuses every write and stamps a synthetic-data ribbon');
  const fixtures = readFileSync(path.join(root, 'tools/admin-preview/fixtures.js'), 'utf8');
  const emails = fixtures.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || [];
  check(emails.every((e) => /@example\.com$/.test(e)), 'fixtures use example.com addresses only');
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll admin control centre redesign checks passed');
process.exit(failures ? 1 : 0);
