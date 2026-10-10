// WS1 2026-10-10 — admin hardening (docs/launch/2026-10-10-WS1-REPORT.md §2).
//
// Static: EVERY route whose path starts with /admin, in server.js and
// routes/**, mounts requireAuth THEN requireAdmin before its handler. A new
// admin route that forgets either fails here. Also refuses path-mounted
// middleware/sub-routers under /admin (app.use("/admin…") / .route("/admin…"))
// that this per-route check could not see.
// Behavioural: requireAdmin's per-admin mutation rate limit.
//
// Run: node tests/ws1-admin-route-guards.test.mjs
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { listRoutes, routeSourceFiles, hasToken } from './helpers/ws1RouteInventory.mjs';

const require = createRequire(import.meta.url);
let failures = 0;
const check = (c, m) => { if (c) console.log(`✓ ${m}`); else { console.error(`✗ ${m}`); failures++; } };

const admin = listRoutes().filter((r) => r.path.startsWith('/admin'));
check(admin.length >= 40, `found ${admin.length} /admin routes`);
let ok = 0;
for (const r of admin) {
  const a = r.args;
  const iAuth = a.search(/(^|[^\w$])requireAuth([^\w$A]|$)/);
  const iAdmin = a.search(/(^|[^\w$])requireAdmin([^\w$]|$)/);
  const good = iAuth >= 0 && iAdmin > iAuth && !hasToken(a, 'requireAuthApi');
  if (good) ok++;
  else check(false, `${r.method} ${r.path} (${r.file}:${r.line}) must mount requireAuth then requireAdmin`);
}
check(ok === admin.length, `all ${admin.length} /admin routes mount requireAuth then requireAdmin`);
check(admin.some((r) => r.method !== 'GET'), 'admin mutation routes are included in the scan');

for (const f of routeSourceFiles()) {
  const src = readFileSync(f, 'utf8');
  check(!/\.(use|route)\(\s*["'`]\/admin/.test(src), `${f.split('/').slice(-2).join('/')}: no path-mounted /admin middleware or .route() outside the per-route check`);
}

// Behaviour: mutation rate limit.
const { createRequireAdmin, createAdminMutationLimiter } = require('../middleware/requireAdmin.js');
function call(mw, req) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200, headers: {},
      status(c) { this.statusCode = c; return this; },
      set(k, v) { this.headers[k] = v; return this; },
      json(b) { resolve({ status: this.statusCode, body: b, headers: this.headers, next: false }); return this; },
      redirect(to) { resolve({ status: 302, to, next: false }); return this; },
    };
    mw(req, res, () => resolve({ status: 200, next: true }));
  });
}
{
  let t = 1_000_000;
  const mw = createRequireAdmin({ limiter: createAdminMutationLimiter({ env: { ADMIN_MUTATION_RATE_LIMIT: '3', ADMIN_MUTATION_RATE_WINDOW_MS: '60000' }, now: () => t }), log: () => {} });
  const nonAdmin = await call(mw, { role: 'member', method: 'POST', path: '/admin/api/fortress/kill-switch', authUserId: 'u-x' });
  check(nonAdmin.status === 302 && nonAdmin.to === '/dashboard', 'non-admin is still redirected (unchanged)');
  const outs = [];
  for (let i = 0; i < 4; i++) outs.push(await call(mw, { role: 'admin', method: 'POST', path: '/admin/api/fortress/kill-switch', authUserId: 'admin-1' }));
  check(outs.slice(0, 3).every((o) => o.next), 'admin mutations within the limit pass');
  check(outs[3].status === 429 && outs[3].body.error === 'rate_limited' && Number(outs[3].headers['Retry-After']) > 0, '4th mutation in the window → 429 rate_limited with Retry-After');
  const reads = [];
  for (let i = 0; i < 10; i++) reads.push(await call(mw, { role: 'admin', method: 'GET', path: '/admin/api/fortress/overview', authUserId: 'admin-1' }));
  check(reads.every((o) => o.next), 'admin reads are never limited');
  const other = await call(mw, { role: 'admin', method: 'DELETE', path: '/admin/api/x', authUserId: 'admin-2' });
  check(other.next, 'another admin has a separate budget');
  t += 60_001;
  const later = await call(mw, { role: 'admin', method: 'PUT', path: '/admin/api/x', authUserId: 'admin-1' });
  check(later.next, 'the budget resets after the window');
  const forgedKey = await call(mw, { role: 'admin', method: 'POST', path: '/admin/api/x', authUserId: 'admin-1', body: { authUserId: 'someone-else' } });
  check(forgedKey.next, 'limiter keys only on the verified req.authUserId (body is ignored)');
}
{
  const { requireAdmin } = require('../middleware/requireAdmin.js');
  const r = await call(requireAdmin, { role: 'admin' });
  check(r.next, 'default export still passes an admin request with no method (existing callers/tests unaffected)');
  const lim = createAdminMutationLimiter({ env: {} });
  let n = 0; while (lim.check('k').allowed) n++;
  check(n === 60, `default limit is 60 mutations / 10 min per admin (got ${n})`);
}

console.log(failures === 0 ? '\nAll WS1 admin route guard checks passed.' : `\n${failures} WS1 admin route guard check(s) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
