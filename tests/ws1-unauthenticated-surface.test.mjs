// WS1 2026-10-10 — unauthenticated HTTP attack surface of the release
// candidate (docs/launch/2026-10-10-WS1-REPORT.md §1).
//
// Part A (static): every route in server.js + routes/** that has no
// authenticating middleware (requireAuth / requireAuthApi /
// twilioSignatureGuard) must be in the classified allowlist below. A NEW
// unauthenticated route fails this test until it is classified (and, if it
// can send email/SMS, spend provider money or write the database, limited).
// Part B (behavioural, middleware): the limiter additions (session /
// acquisition groups, budget(), unknown-group refusal, JSON 429, shared
// instance).
// Part C (black-box): boots the REAL server.js against a local fake Supabase
// (no real service; every Supabase request is recorded) and proves the fixes.
//
// Run: node tests/ws1-unauthenticated-surface.test.mjs
import { spawn } from 'node:child_process';
import http from 'node:http';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT, listRoutes, isAuthenticatedByMiddleware, hasToken } from './helpers/ws1RouteInventory.mjs';

const require = createRequire(import.meta.url);
let failures = 0;
const check = (c, m) => { if (c) console.log(`✓ ${m}`); else { console.error(`✗ ${m}`); failures++; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Part A: classified allowlist ────────────────────────────────────────
// class: rate-limited  → must mount a *RateLimiter.limit( in its chain
//        signed-webhook → must verify the provider inside the handler (marker)
//        needs-auth     → authenticates inside the handler (marker)
//        static         → no email/SMS/provider spend; at most a bounded read
//                         or a budgeted analytics write (marker, if any)
const ALLOW = {
  'POST /webhooks/provider-usage-alert': { cls: 'signed-webhook', marker: 'isGenuineTwilioRequest(' },
  'POST /voice-sdk-outbound-not-supported': { cls: 'static', why: 'constant <Reject/> TwiML; no side effect but one log line' },
  'POST /register': { cls: 'rate-limited' },
  'POST /login': { cls: 'rate-limited' },
  'POST /confirm-session': { cls: 'rate-limited' },
  'POST /verify-confirmation-token': { cls: 'rate-limited' },
  'POST /resend-confirmation': { cls: 'rate-limited' },
  'POST /logout': { cls: 'static', why: 'clears the caller\'s own cookies' },
  'POST /forgot-password': { cls: 'rate-limited' },
  'POST /reset-password-complete': { cls: 'rate-limited' },
  'POST /reset-password-verify': { cls: 'rate-limited' },
  'GET /': { cls: 'static', marker: 'authRateLimiter.budget("acquisition", req)' },
  'GET /api/v1/launch-flags': { cls: 'static', why: 'two env booleans' },
  'POST /api/v1/waiting-list': { cls: 'rate-limited' },
  'GET /health': { cls: 'static', why: 'one bounded (2 s) Supabase read' },
  'GET /privacy': { cls: 'static' },
  'GET /support': { cls: 'static' },
  'GET /go': { cls: 'static', marker: 'authRateLimiter.budget("acquisition", req)' },
  'POST /billing/webhook': { cls: 'signed-webhook', marker: 'stripe.webhooks.constructEvent(' },
  'POST /api/v1/register': { cls: 'rate-limited' },
  'POST /api/v1/register/resend': { cls: 'rate-limited' },
  'POST /api/v1/me/bootstrap': { cls: 'needs-auth', marker: 'await verifyBearerToken(req)' },
  'POST /api/v1/billing/apple/revenuecat-webhook': { cls: 'signed-webhook', marker: 'REVENUECAT_WEBHOOK_AUTHORIZATION' },
};

const routes = listRoutes();
check(routes.length >= 100, `route inventory parsed ${routes.length} routes from server.js + routes/**`);
const unauth = routes.filter((r) => !isAuthenticatedByMiddleware(r));
const seen = new Set();
for (const r of unauth) {
  const key = `${r.method} ${r.path}`;
  seen.add(key);
  const a = ALLOW[key];
  if (!a) { check(false, `UNCLASSIFIED unauthenticated route ${key} (${r.file}:${r.line}) — classify it in this test and limit/auth it`); continue; }
  if (a.cls === 'rate-limited') check(/RateLimiter\.limit\(/.test(r.args), `${key} [rate-limited] mounts the shared auth limiter (${r.file}:${r.line})`);
  else if (a.marker) check(r.body.includes(a.marker), `${key} [${a.cls}] has its in-handler guard: ${a.marker}`);
  else check(true, `${key} [${a.cls}] ${a.why || ''}`.trim());
}
for (const k of Object.keys(ALLOW)) check(seen.has(k), `allowlisted ${k} still exists and is still unauthenticated (no stale allowlist entries)`);
check(!routes.some((r) => /^\/debug\//.test(r.path)), 'no /debug/* route exists (HCG policy: telemetry uses requireAuthApi, never an unauthenticated debug beacon)');
check(routes.every((r) => !/^\/admin/.test(r.path) || hasToken(r.args, 'requireAdmin')), 'every /admin route mounts requireAdmin (detail: tests/ws1-admin-route-guards.test.mjs)');

const mobileSrc = readFileSync(path.join(ROOT, 'routes', 'mobileApi.js'), 'utf8');
const serverSrc = readFileSync(path.join(ROOT, 'server.js'), 'utf8');
check(/if \(req\.authEmailSuppressed\) \{\s*return res\.json\(\{ status: "no_action" \}\);/.test(mobileSrc), '/api/v1/register/resend skips the send (and the admin lookup) when suppressed');
check(/sharedAuthEndpointLimiter\(\)/.test(mobileSrc) && /sharedAuthEndpointLimiter\(\)/.test(serverSrc), 'server.js and routes/mobileApi.js use ONE shared limiter instance');
check(/mobileAuthRateLimiter\.limit\("resend-confirmation",/.test(mobileSrc) && /authRateLimiter\.limit\("resend-confirmation",/.test(serverSrc), 'web and app resend share the same per-mailbox label');

// ── Part B: middleware behaviour ────────────────────────────────────────
const { createAuthEndpointLimiter, sharedAuthEndpointLimiter } = require('../middleware/authEndpointRateLimit.js');
const quiet = () => {};
function run(mw, { body = {}, ip = '203.0.113.9', p = '/x', json = false } = {}) {
  return new Promise((resolve) => {
    const req = { body, ip, path: p, is: (t) => json && t === 'application/json' };
    const res = { statusCode: 200, kind: null, status(c) { this.statusCode = c; return this; }, json() { this.kind = 'json'; resolve({ status: this.statusCode, kind: 'json', passed: false }); return this; }, type() { return this; }, send() { resolve({ status: this.statusCode, kind: 'text', passed: false }); return this; } };
    mw(req, res, () => resolve({ status: 200, passed: true, req }));
  });
}
{
  let threw = false;
  try { createAuthEndpointLimiter({ env: {}, log: quiet }).limit('x', { group: 'no_such_group' }); } catch { threw = true; }
  check(threw, 'an unknown limiter group is refused at wiring time (it would otherwise have no global ceiling)');
}
{
  const l = createAuthEndpointLimiter({ env: { AUTH_RATE_GLOBAL_SESSION: '2' }, log: quiet });
  const mw = l.limit('confirm-session', { group: 'session', emailField: null });
  const o = [];
  for (let i = 0; i < 3; i++) o.push(await run(mw, { p: '/confirm-session', json: true }));
  check(o[0].passed && o[1].passed && o[2].status === 429 && o[2].kind === 'json', 'session group: global ceiling → 429, as JSON for a JSON caller');
  check(l.config.global.session === 600 || createAuthEndpointLimiter({ env: {} }).config.global.session === 600, 'session group default global ceiling = 600 per window');
}
{
  const l = createAuthEndpointLimiter({ env: { AUTH_RATE_PER_IP: '2', TRUST_PROXY_HOPS: '1' }, log: quiet });
  const mw = l.limit('reset-password-verify', { group: 'session', emailField: null });
  const o = [];
  for (let i = 0; i < 3; i++) o.push(await run(mw, { ip: '198.51.100.20', p: '/reset-password-verify' }));
  check(o[2].status === 429, 'session group: per-IP limit applies when TRUST_PROXY_HOPS is set');
}
{
  const l = createAuthEndpointLimiter({ env: { AUTH_RATE_GLOBAL_ACQUISITION: '2' }, log: quiet });
  const r = [l.budget('acquisition', { ip: '1.2.3.4' }), l.budget('acquisition', { ip: '1.2.3.4' }), l.budget('acquisition', { ip: '1.2.3.4' })];
  check(r[0] && r[1] && !r[2], 'budget(): allows up to the ceiling, then returns false without responding');
}
check(sharedAuthEndpointLimiter() === sharedAuthEndpointLimiter(), 'sharedAuthEndpointLimiter() returns one process-wide instance');

// ── Part C: real server.js, fake Supabase ───────────────────────────────
const supa = [];
function startFakeSupabase() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const u = new URL(req.url, 'http://x');
        supa.push({ method: req.method, path: u.pathname });
        res.setHeader('content-type', 'application/json');
        if (u.pathname === '/auth/v1/admin/users') { res.end(JSON.stringify({ users: [{ id: 'u1', email: 'victim@example.invalid', email_confirmed_at: null }], aud: 'authenticated' })); return; }
        if (u.pathname === '/auth/v1/resend') { res.end('{}'); return; }
        if (u.pathname.startsWith('/auth/v1/')) { res.statusCode = 401; res.end(JSON.stringify({ code: 401, error_code: 'bad_jwt', msg: 'invalid' })); return; }
        res.statusCode = req.method === 'POST' ? 201 : 200;
        res.end('[]');
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}
function request(port, method, p, { headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { host: 'hcg.test', ...headers, 'content-length': Buffer.byteLength(body) } }, (res) => {
      let text = ''; res.on('data', (c) => { text += c; }); res.on('end', () => resolve({ status: res.statusCode, text, type: res.headers['content-type'] || '' }));
    });
    req.on('error', reject); req.end(body);
  });
}
const postJson = (port, p, obj) => request(port, 'POST', p, { headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) });
const postForm = (port, p, obj) => request(port, 'POST', p, { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(obj).toString() });
const count = (pred) => supa.filter(pred).length;

const fake = await startFakeSupabase();
const port = 20000 + Math.floor(Math.random() * 20000);
const child = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    PATH: process.env.PATH, NODE_ENV: 'test', PORT: String(port), APP_URL: 'https://hcg.test',
    SUPABASE_URL: `http://127.0.0.1:${fake.address().port}`, SUPABASE_ANON_KEY: 'x', SUPABASE_SERVICE_ROLE_KEY: 'x',
    TWILIO_ACCOUNT_SID: 'AC00000000000000000000000000000000', TWILIO_AUTH_TOKEN: 'x', OPENAI_API_KEY: 'x', OPENAI_BASE_URL: 'http://127.0.0.1:9/v1',
    AUTH_RATE_GLOBAL_SESSION: '3', AUTH_RATE_GLOBAL_ACQUISITION: '2',
  },
});
let logs = '';
child.stdout.on('data', (d) => { logs += d; });
child.stderr.on('data', (d) => { logs += d; });
try {
  let up = false;
  for (let i = 0; i < 150 && !up; i++) { await sleep(100); try { await request(port, 'GET', '/api/v1/launch-flags'); up = true; } catch { /* booting */ } }
  check(up, 'real server.js booted with inert env');

  // C1: token-exchange routes share the "session" budget (3 here).
  const before = count((e) => e.path.startsWith('/auth/v1/'));
  const s = [];
  for (let i = 0; i < 3; i++) s.push(await postJson(port, '/confirm-session', { access_token: 'forged', refresh_token: 'forged' }));
  check(s.every((r) => r.status === 401), '/confirm-session: forged tokens → 401 (first 3)');
  const after3 = count((e) => e.path.startsWith('/auth/v1/'));
  const blocked = [
    await postJson(port, '/confirm-session', { access_token: 'forged', refresh_token: 'forged' }),
    await postJson(port, '/verify-confirmation-token', { token_hash: 'x', type: 'signup' }),
    await postJson(port, '/reset-password-verify', { token_hash: 'x', type: 'recovery' }),
    await postJson(port, '/reset-password-complete', { access_token: 'a', refresh_token: 'b', new_password: 'c' }),
  ];
  check(blocked.every((r) => r.status === 429 && r.type.includes('json')), 'over the session ceiling: /confirm-session, /verify-confirmation-token, /reset-password-verify, /reset-password-complete → 429 JSON');
  check(count((e) => e.path.startsWith('/auth/v1/')) === after3 && after3 > before, 'refused requests made ZERO Supabase Auth calls');

  // C2: app resend is limited and shares the mailbox budget with web resend.
  const r = [];
  for (let i = 0; i < 4; i++) r.push(await postJson(port, '/api/v1/register/resend', { email: 'victim@example.invalid' }));
  const resendCalls = count((e) => e.path === '/auth/v1/resend');
  check(r.slice(0, 3).every((x) => x.status === 200 && JSON.parse(x.text).status === 'resent'), '/api/v1/register/resend: first 3 per hour to one mailbox are sent');
  check(r[3].status === 200 && JSON.parse(r[3].text).status === 'no_action', '/api/v1/register/resend: 4th is suppressed, answering "no_action" (app shows the same hedged notice)');
  check(resendCalls === 3, `exactly 3 Supabase resend calls were made (saw ${resendCalls})`);
  const lookups = count((e) => e.path === '/auth/v1/admin/users');
  await postForm(port, '/resend-confirmation', { email: 'Victim@example.invalid' });
  check(count((e) => e.path === '/auth/v1/resend') === 3, 'web /resend-confirmation for the same mailbox is suppressed too (one shared budget)');
  check(count((e) => e.path === '/auth/v1/admin/users') === lookups, 'suppressed requests ran no admin user lookup');

  // C3: the debug beacon is gone.
  const beacon = await postJson(port, '/debug/purchase-beacon', { stage: 'x\nFAKE LOG LINE', detail: 'y' });
  check(beacon.status === 404, '/debug/purchase-beacon → 404 (removed)');
  check(!logs.includes('PURCHASE BEACON') && !logs.includes('FAKE LOG LINE'), 'attacker text never reached the server log');

  // C4: landing analytics writes are budgeted; the page is always served.
  // (/go, not /: express.static serves public/index.html for "/" before the
  // app.get("/") handler is ever reached — see the WS1 report, finding F-6.)
  const pages = [];
  for (let i = 0; i < 4; i++) pages.push(await request(port, 'GET', '/go'));
  await sleep(300);
  const inserts = count((e) => e.method === 'POST' && e.path === '/rest/v1/acquisition_events');
  check(pages.every((p) => p.status === 200), 'GET /go is served every time');
  check(inserts === 2, `only 2 landing_visit rows written for 4 visits with AUTH_RATE_GLOBAL_ACQUISITION=2 (saw ${inserts})`);
} finally {
  child.kill('SIGKILL');
  fake.close();
}

console.log(failures === 0 ? '\nAll WS1 unauthenticated-surface checks passed.' : `\n${failures} WS1 unauthenticated-surface check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
