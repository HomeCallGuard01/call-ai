// Regression tests for the admin post-login routing fix (2026-09).
//
// Root cause: an admin account logging in was always redirected to
// /dashboard (the customer route) regardless of role, and GET /dashboard
// itself never considered role at all — an admin with no active
// consumer entitlement landed on the customer membership/paywall
// screen ("You don't currently have an active membership.").
//
// The pure decision logic lives in services/postLoginRouting.js
// (server.js has no exports and calls app.listen() at module load
// time, same reason services/registrationFlow.js and
// services/householdBootstrap.js exist as separate files — see their
// own header comments). Route-wiring concerns (which middleware gates
// which route, that requireEntitlement is never touched) are checked
// structurally against the real server.js/routes/mobileApi.js source,
// matching this codebase's existing convention (see
// tests/get-protected-now-button.test.mjs, tests/account-classification.test.mjs)
// since there's no HTTP test tooling in this project.
//
// Run with: node tests/admin-post-login-routing.test.mjs

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { decidePostLoginRedirect, decideDashboardRouteRedirect } = require('../services/postLoginRouting.js');

const serverSource = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const mobileApiSource = readFileSync(new URL('../routes/mobileApi.js', import.meta.url), 'utf8');
const requireEntitlementSource = readFileSync(new URL('../middleware/requireEntitlement.js', import.meta.url), 'utf8');

let failures = 0;

function check(condition, message) {
  if (condition) {
    console.log(`✓ ${message}`);
  } else {
    console.error(`✗ ${message}`);
    failures++;
  }
}

// --- decidePostLoginRedirect: the /login redirect decision ---

check(
  decidePostLoginRedirect({ role: 'admin' }) === '/admin/business',
  'decidePostLoginRedirect: an authenticated admin is redirected to /admin/business on login'
);

check(
  decidePostLoginRedirect({ role: 'household' }) === '/dashboard',
  'decidePostLoginRedirect: a normal customer login still goes to the normal customer /dashboard route, unchanged'
);

check(
  decidePostLoginRedirect({ role: 'support' }) === '/dashboard',
  'decidePostLoginRedirect: any non-admin role (e.g. support) is treated the same as a normal customer, not specially — only role==="admin" ever redirects to the admin dashboard'
);

check(
  decidePostLoginRedirect({ role: undefined }) === '/dashboard',
  'decidePostLoginRedirect: a missing/undefined role fails closed to the normal customer route, never the admin one'
);

// --- decideDashboardRouteRedirect: the GET /dashboard direct-navigation decision ---

check(
  decideDashboardRouteRedirect({ role: 'admin', hasActiveEntitlement: false }) === '/admin/business',
  'decideDashboardRouteRedirect: an admin with no active consumer entitlement navigating directly to /dashboard is redirected to /admin/business'
);

check(
  decideDashboardRouteRedirect({ role: 'household', hasActiveEntitlement: false }) === null,
  'decideDashboardRouteRedirect: a non-admin customer with no entitlement is NOT redirected — they still see the existing customer dashboard shell, which itself shows the membership/payment flow via /dashboard-data (unchanged)'
);

check(
  decideDashboardRouteRedirect({ role: 'admin', hasActiveEntitlement: true }) === null,
  'decideDashboardRouteRedirect: an admin who genuinely also holds an active entitlement sees the normal customer dashboard, exactly like any other entitled household — admin status alone never redirects away from a legitimately entitled view'
);

check(
  decideDashboardRouteRedirect({ role: 'household', hasActiveEntitlement: true }) === null,
  'decideDashboardRouteRedirect: a normal entitled customer is never redirected'
);

// --- Structural: server.js wiring ---

check(
  serverSource.includes('const role = await getUserRole(data.user.id);') &&
    serverSource.includes('const redirectTarget = decidePostLoginRedirect({ role });'),
  '/login resolves the real role via getUserRole and feeds it through decidePostLoginRedirect — not a hand-rolled or duplicated check'
);

const loginBlockStart = serverSource.indexOf('app.post("/login"');
const loginBlockEnd = serverSource.indexOf('app.post("/confirm-session"');
const loginBlock = serverSource.slice(loginBlockStart, loginBlockEnd);

check(
  loginBlock.includes('setSessionCookies(res, data.session);') &&
    loginBlock.indexOf('setSessionCookies(res, data.session);') < loginBlock.indexOf('decidePostLoginRedirect'),
  '/login sets the session cookie BEFORE deciding/redirecting — an admin redirected straight to /admin/business must already be able to pass requireAuth there'
);

const dashboardRouteStart = serverSource.indexOf('app.get("/dashboard", requireAuth');
const dashboardRouteEnd = serverSource.indexOf('\n});', dashboardRouteStart) + 4;
const dashboardRouteBlock = serverSource.slice(dashboardRouteStart, dashboardRouteEnd);

check(
  dashboardRouteBlock.includes('requireAuth') && !dashboardRouteBlock.includes('requireEntitlement'),
  'GET /dashboard is still gated by requireAuth only, exactly as before this fix — this route itself never gained an entitlement check'
);

check(
  dashboardRouteBlock.includes('req.role === "admin" ? await getActiveEntitlement(req.household.id) : null') &&
    dashboardRouteBlock.includes('decideDashboardRouteRedirect({ role: req.role, hasActiveEntitlement: !!entitlement })'),
  'GET /dashboard only queries entitlement for an admin session (never for a normal customer) and feeds the result through decideDashboardRouteRedirect'
);

// --- Structural: requireEntitlement itself is untouched by this fix ---

check(
  !requireEntitlementSource.includes('role') && !requireEntitlementSource.includes('postLoginRouting'),
  'middleware/requireEntitlement.js has no reference to role or the new routing module at all — the entitlement gate protected consumer/API routes depend on is completely unmodified by this fix'
);

// --- Structural: no protected consumer API route was changed to accept admin in place of entitlement ---

const protectedApiRoutes = [
  '/api/v1/me/dashboard',
  '/api/v1/activation/instructions',
  '/api/v1/household/phone-number',
  '/api/v1/voice/token',
  '/api/v1/contacts',
];

for (const route of protectedApiRoutes) {
  const routeDeclLine = mobileApiSource
    .split('\n')
    .find((line) => line.includes(`"${route}"`) && line.includes('router.'));
  check(
    !!routeDeclLine && routeDeclLine.includes('requireEntitlement') && !routeDeclLine.includes('requireAdmin'),
    `${route} is still gated by requireEntitlement (not requireAdmin, not an admin-status bypass) — admin authorisation does not substitute for a real consumer entitlement on protected APIs`
  );
}

console.log(failures === 0 ? '\nAll admin-post-login-routing checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
