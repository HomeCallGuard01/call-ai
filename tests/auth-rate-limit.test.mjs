// Unauthenticated auth-endpoint rate limits — integration 2026-10-03
// (launch-gate PR-11 / A8 / C8). Behavioural (the middleware itself) plus
// wiring (each route mounts it). Counters are process-local: PARTIAL.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { createAuthEndpointLimiter, normaliseEmailKey } = require('../middleware/authEndpointRateLimit.js');
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
const check = (c, m) => { if (c) console.log(`✓ ${m}`); else { console.error(`✗ ${m}`); failures++; } };

function run(mw, { body = {}, ip = '203.0.113.9', p = '/forgot-password' } = {}) {
  return new Promise((resolve) => {
    const req = { body, ip, path: p };
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json() { resolve({ status: this.statusCode, req, passed: false }); return this; },
      type() { return this; },
      send() { resolve({ status: this.statusCode, req, passed: false }); return this; },
    };
    mw(req, res, () => resolve({ status: 200, req, passed: true }));
  });
}
const quiet = () => {};

check(normaliseEmailKey('Victim.Name+x@GoogleMail.com') === 'victimname@gmail.com' && normaliseEmailKey('a@b.co') === 'a@b.co' && normaliseEmailKey('nope') === null, 'email key folds case, +tags, gmail dots and googlemail');

{
  const l = createAuthEndpointLimiter({ env: {}, log: quiet });
  const mw = l.limit('forgot-password', { group: 'email', onEmailLimit: 'suppress' });
  const outs = [];
  for (const e of ['victim@gmail.com', 'Victim@gmail.com', 'v.i.c.t.i.m+1@googlemail.com', 'victim@gmail.com', 'victim@gmail.com']) outs.push(await run(mw, { body: { email: e } }));
  check(outs.slice(0, 3).every((o) => o.passed && !o.req.authEmailSuppressed), 'forgot-password: first 3 per hour to one mailbox are sent (aliases count as the same mailbox)');
  check(outs.slice(3).every((o) => o.passed && o.req.authEmailSuppressed === true), 'forgot-password: 4th+ to the same mailbox is SUPPRESSED with an identical response (no email bombing, no enumeration)');
  const other = await run(mw, { body: { email: 'someone.else@example.com' } });
  check(other.passed && !other.req.authEmailSuppressed, 'another mailbox is unaffected');
}
{
  const l = createAuthEndpointLimiter({ env: {}, log: quiet });
  const mw = l.limit('register', { group: 'register' });
  const outs = [];
  for (let i = 0; i < 4; i++) outs.push(await run(mw, { body: { email: 'mass@example.com' }, p: '/register' }));
  check(outs.slice(0, 3).every((o) => o.passed) && outs[3].status === 429, 'register: 4th attempt for one email within an hour → 429');
}
{
  const l = createAuthEndpointLimiter({ env: {}, log: quiet });
  const mw = l.limit('login', { group: 'login', emailField: null });
  const outs = [];
  for (let i = 0; i < 20; i++) outs.push(await run(mw, { body: { email: 'victim@example.com' }, p: '/login' }));
  check(outs.every((o) => o.passed), 'login: failing logins with a victim\'s address never lock the victim out (no per-email limit on login)');
}
{
  const l = createAuthEndpointLimiter({ env: { AUTH_RATE_GLOBAL_REGISTER: '5' }, log: quiet });
  const mw = l.limit('register', { group: 'register' });
  const outs = [];
  for (let i = 0; i < 6; i++) outs.push(await run(mw, { body: { email: `bot${i}@example.com` }, p: '/api/v1/register' }));
  check(outs.slice(0, 5).every((o) => o.passed) && outs[5].status === 429, 'global per-route ceiling refuses a flood of distinct emails (429)');
}
{
  const noProxy = createAuthEndpointLimiter({ env: { AUTH_RATE_PER_IP: '2' }, log: quiet });
  const mw = noProxy.limit('register', { group: 'register' });
  const outs = [];
  for (let i = 0; i < 4; i++) outs.push(await run(mw, { body: { email: `p${i}@example.com` }, ip: '10.0.0.1', p: '/register' }));
  check(noProxy.config.ipEnabled === false && outs.every((o) => o.passed), 'without TRUST_PROXY_HOPS no per-IP limit applies (behind a proxy it would become a global limit)');
  const proxied = createAuthEndpointLimiter({ env: { AUTH_RATE_PER_IP: '2', TRUST_PROXY_HOPS: '1' }, log: quiet });
  const mw2 = proxied.limit('register', { group: 'register' });
  const outs2 = [];
  for (let i = 0; i < 3; i++) outs2.push(await run(mw2, { body: { email: `q${i}@example.com` }, ip: '198.51.100.7', p: '/register' }));
  check(outs2[2].status === 429, 'with TRUST_PROXY_HOPS set, the per-IP limit applies');
}
{
  const server = readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const mobile = readFileSync(path.join(ROOT, 'routes', 'mobileApi.js'), 'utf8');
  for (const [route, src] of [['/register', server], ['/login', server], ['/forgot-password', server], ['/resend-confirmation', server], ['/api/v1/waiting-list', server]]) {
    check(new RegExp(`app\\.post\\("${route.replace(/\//g, '\\/')}",[^\\n]*authRateLimiter\\.limit\\(`).test(src), `${route} mounts the auth rate limiter`);
  }
  check(/router\.post\("\/api\/v1\/register", mobileAuthRateLimiter\.limit\(/.test(mobile), '/api/v1/register mounts the auth rate limiter');
  check(/if \(email && !req\.authEmailSuppressed\) \{\s*const \{ error \} = await supabase\.auth\.resetPasswordForEmail/.test(server), '/forgot-password skips the send when suppressed');
  check(/if \(email && !req\.authEmailSuppressed\) \{\s*const \{ error \} = await supabase\.auth\.resend\(/.test(server), '/resend-confirmation skips the send when suppressed');
  check(/if \(Number\(process\.env\.TRUST_PROXY_HOPS\) > 0\) app\.set\("trust proxy", Number\(process\.env\.TRUST_PROXY_HOPS\)\);/.test(server), 'trust proxy is set only with TRUST_PROXY_HOPS, to the same hop count');
}

console.log(failures === 0 ? '\nAll auth rate-limit checks passed.' : `\n${failures} auth rate-limit check(s) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
