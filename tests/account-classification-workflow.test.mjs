// Account classification workflow (2026-09-29): dashboard change with an
// append-only audit trail (migration 069, drafted as 055 — SQL behaviour is tested in
// tests/migrations.pglite.test.mjs). This file covers the service, the
// route and the UI helpers, and proves the change path cannot touch
// entitlement, billing, routing or telephony.
//
// Run with: node tests/account-classification-workflow.test.mjs

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:1';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'x';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'x';

const svc = require('../services/accountClassificationChanges.js');

let failures = 0;
function check(condition, message) {
  if (condition) console.log(`✓ ${message}`);
  else { console.error(`✗ ${message}`); failures++; }
}

const HH = '11111111-2222-4333-8444-555555555555';
const ACTOR = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

// ---------- validation ----------
const valid = { householdId: HH, classification: 'genuine_customer', note: 'Paid by Stripe 6 Sep', expectedPrevious: 'unclassified' };
check(svc.validateClassificationChange(valid).ok, 'a complete change is valid');
check(svc.validateClassificationChange({ ...valid, householdId: 'x' }).status === 400, 'invalid household id refused');
check(svc.validateClassificationChange({ ...valid, classification: 'admin' }).ok === false, 'admin/QA are not offered as targets (still valid stored values)');
check(svc.validateClassificationChange({ ...valid, note: ' a ' }).ok === false && svc.validateClassificationChange({ ...valid, note: 'x'.repeat(501) }).ok === false, 'reason required (3–500 characters)');
check(svc.validateClassificationChange({ ...valid, expectedPrevious: '' }).ok === false, 'the value the admin was looking at is required (stale-edit protection)');
check(svc.validateClassificationChange({ ...valid, expectedPrevious: 'genuine_customer' }).ok === false, 'a no-op change is refused');
check(svc.ALLOWED_TARGETS.join() === 'genuine_customer,internal_test,reviewer,other_non_customer', 'the four choices: genuine customer / internal test / reviewer / other non-customer');

// ---------- error mapping (fail closed) ----------
check(svc.mapRpcError({ code: 'PGRST202', message: 'Could not find the function public.set_account_classification' }).status === 503, 'migration 055 not applied → 503, change refused (never written without an audit record)');
check(svc.mapRpcError({ message: 'set_account_classification: stale edit — current classification is reviewer, expected unclassified' }).status === 409, 'stale edit → 409');
check(svc.mapRpcError({ message: 'boom' }).status === 500 && !/boom/.test(svc.mapRpcError({ message: 'boom' }).reason), 'unexpected error → 500 without leaking detail');

// ---------- service against a fake database ----------
function fakeDb({ rpcError = null, eventsError = null } = {}) {
  const calls = [];
  const table = (name) => {
    const q = { _name: name, select() { return q; }, eq() { return q; }, order() { return q; }, limit() { return Promise.resolve(name === 'account_classification_events' ? { data: eventsError ? null : [{ new_classification: 'reviewer', note: 'n' }], error: eventsError } : { data: [], error: null }); },
      maybeSingle() { return Promise.resolve({ data: { classification: 'reviewer', note: 'App Review' }, error: null }); } };
    for (const w of ['insert', 'update', 'upsert', 'delete']) q[w] = () => { calls.push(`${w}:${name}`); return q; };
    return q;
  };
  return { calls, from: (name) => { calls.push(`from:${name}`); return table(name); }, rpc: async (fn, args) => { calls.push({ fn, args }); return rpcError ? { data: null, error: rpcError } : { data: { previous: 'unclassified', classification: args.p_classification }, error: null }; } };
}
{
  const db = fakeDb();
  const r = await svc.setAccountClassification({ ...valid, note: '  Paid by Stripe 6 Sep  ', actorUserId: ACTOR, actorEmail: 'admin@example.com' }, { supabaseAdmin: db });
  const rpc = db.calls.find((c) => c.fn);
  check(r.ok && db.calls.length === 1 && rpc.fn === 'set_account_classification', 'one write only: the audited RPC — no direct table write');
  check(rpc.args.p_household_id === HH && rpc.args.p_note === 'Paid by Stripe 6 Sep' && rpc.args.p_actor_user_id === ACTOR && rpc.args.p_actor_email === 'admin@example.com' && rpc.args.p_expected_previous === null, 'RPC gets household, trimmed reason, actor, and "unclassified" as NULL expected previous');
}
{
  const db = fakeDb({ rpcError: { code: '42883', message: 'function public.set_account_classification does not exist' } });
  const r = await svc.setAccountClassification({ ...valid, actorUserId: ACTOR }, { supabaseAdmin: db });
  check(!r.ok && r.status === 503 && !db.calls.some((c) => typeof c === 'string' && /^(insert|update|upsert|delete):/.test(c)), 'without 055: refused, and no fallback write to account_classifications');
}
{
  const r = await svc.setAccountClassification({ ...valid, note: '' }, { supabaseAdmin: fakeDb() });
  check(!r.ok && r.status === 400, 'invalid input never reaches the database');
}
{
  const h = await svc.getClassificationHistory(HH, { supabaseAdmin: fakeDb() });
  check(h.available && h.current === 'reviewer' && h.writable === true && h.history.length === 1, 'history: current value + events, writable');
  const noMig = await svc.getClassificationHistory(HH, { supabaseAdmin: fakeDb({ eventsError: { code: '42P01', message: 'relation "public.account_classification_events" does not exist' } }) });
  check(noMig.available && noMig.writable === false && /069/.test(noMig.reason), 'history without 069: current value shown, changes disabled with the reason');
}

// ---------- isolation from entitlement / billing / routing / telephony ----------
const serviceSrc = readFileSync(path.join(__dirname, '..', 'services', 'accountClassificationChanges.js'), 'utf8');
const routeSrc = readFileSync(path.join(__dirname, '..', 'routes', 'adminClassification.js'), 'utf8');
const requires = [...(serviceSrc + routeSrc).matchAll(/require\(["']([^"']+)["']\)/g)].map((m) => m[1]);
check(requires.every((r) => ['express', '../middleware/requireAuth', '../middleware/requireAdmin', '../services/accountClassificationChanges', './supabaseClients'].includes(r)), `the classification path imports nothing that grants access, bills, routes calls or touches numbers (imports: ${requires.join(', ')})`);
const codeOnly = serviceSrc.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
check(!/\.(insert|update|upsert|delete)\(/.test(codeOnly) && (codeOnly.match(/\.rpc\(/g) || []).length === 1, 'the service has exactly one write (the audited RPC) and no direct table writes');
check(!/entitlement|twilio|stripe|revenuecat|callRouting/i.test(codeOnly.replace(/'[^']*'/g, '')), 'no entitlement / Twilio / Stripe / RevenueCat / routing identifiers in the service code');

// ---------- routes ----------
check(/router\.get\("\/admin\/api\/households\/:id\/classification", requireAuth, requireAdmin,/.test(routeSrc) && /router\.post\("\/admin\/api\/households\/:id\/classification", requireAuth, requireAdmin,/.test(routeSrc), 'both routes are admin-only (requireAuth + requireAdmin)');
check(/actorUserId: req\.authUserId/.test(routeSrc), 'the actor is the authenticated admin, not a value from the request body');
check(!/router\.(delete|put|patch)\(/.test(routeSrc), 'no delete/replace route — classification history is never deleted');
const server = readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
check(server.includes('app.use(adminClassificationRoutes);'), 'server.js mounts the classification routes');

// ---------- UI helpers ----------
{
  const html = readFileSync(path.join(__dirname, '..', 'admin-business.html'), 'utf8');
  const extract = (name) => { const a = html.indexOf(`// TEST-EXTRACT-START: ${name}`); const b = html.indexOf(`// TEST-EXTRACT-END: ${name}`); return a === -1 || b === -1 ? null : html.slice(a, b); };
  const helpers = extract('customerMonitorHelpers') + extract('fmtDateTime') + extract('classificationPanel');
  const ui = new Function(`${helpers}\nreturn { validateClassificationForm, renderClassificationPanelHtml };`)();
  check(ui.validateClassificationForm({ current: 'unclassified', next: 'genuine_customer', note: 'paid', acknowledged: true }).ok, 'form: complete change allowed');
  check(!ui.validateClassificationForm({ current: 'unclassified', next: 'genuine_customer', note: 'paid', acknowledged: false }).ok, 'form: must acknowledge "reporting only — no effect on access, billing, calls or numbers"');
  check(!ui.validateClassificationForm({ current: 'reviewer', next: 'reviewer', note: 'same', acknowledged: true }).ok && !ui.validateClassificationForm({ current: 'reviewer', next: 'genuine_customer', note: '', acknowledged: true }).ok, 'form: no-op and missing reason refused client-side too');
  const evil = '"><img src=x onerror=alert(1)>';
  const out = ui.renderClassificationPanelHtml({ current: 'reviewer', currentNote: evil, writable: true, history: [{ created_at: '2026-09-29T10:00:00Z', previous_classification: null, new_classification: 'reviewer', changed_by_email: evil, note: evil, source: 'admin_dashboard' }] });
  check(!out.includes('<img') && out.includes('&lt;img'), 'panel escapes notes and actor emails');
  check(out.includes('id="clsSave"') && !/value="reviewer"/.test(out) && !/value="admin"/.test(out), 'panel offers only the other allowed choices (not the current one, never admin/QA)');
  const off = ui.renderClassificationPanelHtml({ current: 'unclassified', writable: false, reason: 'History and changes need migration 069 (not applied).', history: null });
  check(!off.includes('clsSave') && off.includes('069'), 'without 069 the panel shows the reason and no form');
}

console.log(failures === 0 ? '\nAll account classification workflow checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
