// Admin safety controls (integration 2026-10-04): manual LATCHED-breaker
// reset, global kill switch, per-household hold. Behavioural, against the real
// router and the real requireAdmin; requireAuth is replaced by a header-driven
// stand-in (the real one validates a Supabase session cookie — no network here).
// Proves: unauthenticated and non-admin requests cannot act; an admin must send
// JSON, a typed confirmation and a reason; the audited ACTOR is the
// authenticated admin's id and can never be supplied by the request.
import { createRequire } from 'node:module';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
const check = (c, m) => { if (c) console.log(`✓ ${m}`); else { console.error(`✗ ${m}`); failures++; } };

// Header-driven requireAuth stand-in (x-test-user / x-test-role).
const authPath = require.resolve(path.join(ROOT, 'middleware', 'requireAuth.js'));
require.cache[authPath] = { id: authPath, filename: authPath, loaded: true, exports: {
  requireAuth: (req, res, next) => {
    if (!req.get('x-test-user')) return res.status(401).json({ error: 'unauthenticated' });
    req.authUserId = req.get('x-test-user'); req.role = req.get('x-test-role') || 'customer'; return next();
  },
} };
const express = require('express');
const { createAdminFortressRoutes } = require(path.join(ROOT, 'routes', 'adminFortress.js'));
const calls = [];
const db = {
  resetBreaker: async (a) => { calls.push(['resetBreaker', a]); return { ok: true, wasOpen: true }; },
  setKillSwitch: async (a) => { calls.push(['setKillSwitch', a]); return { ok: true, killSwitch: a.on }; },
  setHouseholdHold: async (a) => { calls.push(['setHouseholdHold', a]); return { ok: true, held: a.hold }; },
  globalStatus: async () => ({}),
};
const app = express();
app.use(createAdminFortressRoutes({ supabaseAdmin: {}, financialContainmentDb: db, telephonyAbuse: null }));
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const port = server.address().port;
const post = (p, body, headers = {}) => new Promise((resolve, reject) => {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: p, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...headers } }, (res) => {
    let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => resolve({ status: res.statusCode, body: t, location: res.headers.location }));
  });
  req.on('error', reject); req.end(data);
});
const ADMIN = { 'x-test-user': 'admin-uuid-1', 'x-test-role': 'admin' };
const HH = '11111111-2222-4333-8444-555555555555';
const good = { reason: 'Breaker reviewed: spend storm traced to a test script', confirm: 'RESET GLOBAL BREAKER' };

try {
  check((await post('/admin/api/fortress/breaker/reset', good)).status === 401 && calls.length === 0, 'unauthenticated → refused, nothing changed');
  const cust = await post('/admin/api/fortress/breaker/reset', good, { 'x-test-user': 'cust-1', 'x-test-role': 'customer' });
  check(cust.status === 302 && calls.length === 0, 'authenticated NON-admin → refused (requireAdmin), nothing changed');
  check((await post('/admin/api/fortress/breaker/reset', { reason: good.reason }, ADMIN)).status === 400 && calls.length === 0, 'admin without the typed confirmation → refused');
  check((await post('/admin/api/fortress/breaker/reset', { confirm: good.confirm, reason: 'short' }, ADMIN)).status === 400 && calls.length === 0, 'admin without a real reason → refused');
  check((await post('/admin/api/fortress/breaker/reset', 'reason=x&confirm=RESET+GLOBAL+BREAKER', { ...ADMIN, 'content-type': 'application/x-www-form-urlencoded' })).status === 415 && calls.length === 0, 'non-JSON (cross-site form) → refused');
  const ok = await post('/admin/api/fortress/breaker/reset', { ...good, actor: 'someone-else' }, ADMIN);
  check(ok.status === 200 && calls.length === 1 && calls[0][0] === 'resetBreaker' && calls[0][1].actor === 'admin:admin-uuid-1' && calls[0][1].reason === good.reason,
    'admin + JSON + confirmation + reason → manual reset; the audited actor is the AUTHENTICATED admin (a body-supplied actor is ignored)');
  const ks = await post('/admin/api/fortress/kill-switch', { on: true, reason: 'Emergency stop during provider incident', confirm: 'KILL SWITCH ON' }, ADMIN);
  check(ks.status === 200 && calls[1][0] === 'setKillSwitch' && calls[1][1].on === true, 'admin can engage the global kill switch (audited)');
  const wrongPhrase = await post('/admin/api/fortress/kill-switch', { on: false, reason: 'Releasing after review of the incident', confirm: 'KILL SWITCH ON' }, ADMIN);
  check(wrongPhrase.status === 400 && calls.length === 2, 'the confirmation phrase must match the direction (ON vs OFF)');
  const hold = await post(`/admin/api/fortress/households/${HH}/hold`, { hold: true, reason: 'Suspicious call pattern under review', confirm: 'HOLD HOUSEHOLD' }, ADMIN);
  check(hold.status === 200 && calls[2][0] === 'setHouseholdHold' && calls[2][1].source === 'admin' && calls[2][1].householdId === HH && calls[2][1].actor === 'admin:admin-uuid-1', 'admin can place a household hold (source admin, authenticated actor)');
  check((await post('/admin/api/fortress/households/not-a-uuid/hold', { hold: true, reason: 'Suspicious call pattern under review', confirm: 'HOLD HOUSEHOLD' }, ADMIN)).status === 400 && calls.length === 3, 'malformed household id → refused');
} finally {
  server.close();
}
console.log(failures === 0 ? '\nAll admin control checks passed.' : `\n${failures} admin control check(s) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
