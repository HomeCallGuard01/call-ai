// Unit/structural tests for the Dashboard Consolidation (2026-09):
// single Admin/Business Dashboard at /admin/business with
// Business/Customers/Operations/System Health sections, replacing the
// two separate, cross-linking pages (admin.html + admin-business.html)
// that existed before.
//
// Follows this codebase's established convention (tests/admin-business-
// auth.test.mjs) of NOT booting the real server — this repo's own .env is
// production configuration, so route/auth wiring is checked structurally
// against the real source files instead of via a live HTTP request.
//
// Run with: node tests/dashboard-consolidation.test.mjs

import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
require('dotenv').config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');

let failures = 0;
function check(condition, message) {
  if (condition) {
    console.log(`✓ ${message}`);
  } else {
    console.error(`✗ ${message}`);
    failures++;
  }
}

// ============================================================
// Routing: GET /admin redirects to /admin/business; the old,
// separate admin.html page no longer exists at all.
// ============================================================

check(!existsSync(path.join(repoRoot, 'admin.html')), 'admin.html has been deleted — fully superseded by the consolidated admin-business.html');

const adminRouteSource = readFileSync(path.join(repoRoot, 'routes', 'admin.js'), 'utf8');

check(
  /router\.get\("\/admin",\s*requireAuth,\s*requireAdmin,[\s\S]{0,120}res\.redirect\("\/admin\/business"\)/.test(adminRouteSource),
  'GET /admin is gated by requireAuth+requireAdmin and redirects to /admin/business, rather than serving a second page'
);

check(
  !adminRouteSource.includes('sendFile') || !adminRouteSource.includes('admin.html'),
  'routes/admin.js no longer serves admin.html directly'
);

// Every /admin/api/* route must be untouched — same requireAuth+requireAdmin
// gating as before, no route removed.
const apiRoutePaths = [
  '/admin/api/overview',
  '/admin/api/search',
  '/admin/api/households/:id/retry-provisioning',
  '/admin/api/households/:id/grant-complimentary',
  '/admin/api/households/:id/revoke-complimentary',
];
for (const p of apiRoutePaths) {
  check(adminRouteSource.includes(`"${p}"`), `routes/admin.js still declares ${p} — Operations-tab functionality was ported into the new page, not deleted from the backend`);
}

// ============================================================
// Filtering: customers default to genuine, diagnostics reveal all —
// unclassified/internal/admin/reviewer/qa accounts never counted as
// genuine, nothing deleted or reclassified.
// ============================================================

const { classifyCustomerList } = require('../services/businessMetrics/customerClassificationOverview.js');

{
  const customers = [
    { householdId: 'h-genuine', email: 'real@customer.com' },
    { householdId: 'h-internal', email: 'internal@homecallguard.test' },
    { householdId: 'h-admin', email: 'andrew@homecallguard.co.uk' },
    { householdId: 'h-unclassified', email: 'unknown@example.com' },
  ];
  const classificationMap = new Map([
    ['h-genuine', 'genuine_customer'],
    ['h-internal', 'internal_test'],
    ['h-admin', 'admin'],
    // h-unclassified deliberately has no entry at all
  ]);

  const result = classifyCustomerList(customers, classificationMap);

  check(result.all.length === 4, 'classifyCustomerList: the "all" diagnostics list keeps every account — nothing is dropped, deleted or hidden');
  check(result.genuine.length === 1 && result.genuine[0].householdId === 'h-genuine', 'classifyCustomerList: the default "genuine" list contains only the explicitly classified genuine_customer account');
  check(
    result.all.find(c => c.householdId === 'h-unclassified').classification === 'unclassified',
    'classifyCustomerList: an account with no row in account_classifications is labelled unclassified, never defaulted to genuine'
  );
  check(
    !result.genuine.some(c => c.classification !== 'genuine_customer'),
    'classifyCustomerList: no internal_test/admin/reviewer/qa_automation/unclassified account ever appears in the genuine list'
  );
}

{
  // HCG's actual current state: zero genuine external customers. The
  // default view must show that honestly rather than falling back to
  // showing everything.
  const customers = [
    { householdId: 'h1', email: 'admin@homecallguard.co.uk' },
    { householdId: 'h2', email: 'tester@example.com' },
  ];
  const classificationMap = new Map([
    ['h1', 'admin'],
    ['h2', 'internal_test'],
  ]);
  const result = classifyCustomerList(customers, classificationMap);
  check(result.genuine.length === 0, 'classifyCustomerList: with zero genuine_customer-classified accounts, the default view is honestly empty, not backfilled from other classifications');
  check(result.all.length === 2, 'classifyCustomerList: the diagnostics view still shows both historical accounts, unaffected by the empty genuine view');
}

// ============================================================
// Launch readiness state — the six items must reflect the completed
// audit's corrected findings; the dashboard must not show a technical
// launch blocker when none remain.
// ============================================================

const { getLaunchReadinessItems } = require('../services/launchReadiness.js');
const { computeReadinessSummary } = require('../database/adminMetrics.js');

const items = getLaunchReadinessItems();

check(items.length === 6, 'getLaunchReadinessItems: still reports exactly the six known launch-readiness items');

const doneTitles = [
  'Registered office address decision',
  'Twilio Address object for UK number purchase',
  'Migration 017 real-database repair',
  'Scheduled runner for expired-number release',
  'Stripe Customer Portal',
];
for (const title of doneTitles) {
  const item = items.find(i => i.title === title);
  check(!!item, `getLaunchReadinessItems: "${title}" is still present`);
  check(item && item.status === 'done', `getLaunchReadinessItems: "${title}" is corrected to status: 'done'`);
}

const solicitorItem = items.find(i => i.title.toLowerCase().includes('solicitor'));
check(!!solicitorItem, 'getLaunchReadinessItems: the solicitor sign-off item is still present');
check(solicitorItem && solicitorItem.status === 'pending', 'getLaunchReadinessItems: the solicitor sign-off item genuinely remains pending — a real legal follow-up, not silently marked done');
check(solicitorItem && solicitorItem.severity === 'medium', 'getLaunchReadinessItems: the solicitor sign-off item keeps its medium severity');

const summary = computeReadinessSummary(items);
check(summary.blockersCount === 0, 'computeReadinessSummary: zero open blockers remain — both former blocker items are resolved (status: done)');
check(summary.status === 'ready_with_open_items', 'computeReadinessSummary: overall status is ready_with_open_items (one genuine, non-blocking open item), never not_ready');

// Regression guard against the bug this consolidation fixed: a blocker
// marked done must never keep counting toward blockersCount.
check(
  computeReadinessSummary([{ severity: 'blocker', status: 'done' }, { severity: 'medium', status: 'pending' }]).blockersCount === 0,
  'computeReadinessSummary: a resolved (status: done) blocker-severity item is never counted in blockersCount'
);
check(
  computeReadinessSummary([{ severity: 'blocker', status: 'pending' }]).blockersCount === 1,
  'computeReadinessSummary: a genuinely open blocker is still counted correctly'
);

// ============================================================
// System Health: exactly one canonical health interpretation is ever
// rendered — no second, contradictory health panel.
// ============================================================

const dashboardHtml = readFileSync(path.join(repoRoot, 'admin-business.html'), 'utf8');

check(!dashboardHtml.includes('formatHealthBadge'), 'admin-business.html: the old, separate services/healthChecks.js-based health-badge renderer is gone entirely');
check(!dashboardHtml.includes('renderHealth('), 'admin-business.html: the old dual health-panel render function is gone entirely');
check(
  (dashboardHtml.match(/systemHealth\.overall/g) || []).length === 2,
  'admin-business.html: systemHealth.overall (the one canonical health source) is read in exactly two places — the Business tab headline badge and the System Health tab — never a second/different health object'
);
check(
  !dashboardHtml.includes('/admin/api/business/overview').valueOf() || dashboardHtml.includes("fetch('/admin/api/business/overview'"),
  'admin-business.html: system health is sourced from the business-overview endpoint (services/businessMetrics/systemHealth.js), not a separate request'
);

const adminBusinessRouteSource = readFileSync(path.join(repoRoot, 'routes', 'adminBusiness.js'), 'utf8');
check(
  adminBusinessRouteSource.includes('getSystemHealthSnapshot'),
  'routes/adminBusiness.js: system health is computed via the single systemHealth.js snapshot function'
);
check(
  !adminBusinessRouteSource.includes('getSystemHealth()') && !adminBusinessRouteSource.includes("require(\"../services/healthChecks\")"),
  'routes/adminBusiness.js: does not also import/use the older services/healthChecks.js system'
);

// ============================================================
// Navigation / UX: no confusing duplicate Business/Operations
// cross-links, admin never routed to the consumer dashboard as a nav
// option, strong active-tab contrast, logout always visible.
// ============================================================

check(!/>\s*Operations dashboard\s*</.test(dashboardHtml), 'admin-business.html: the old "Operations dashboard" cross-link to a second page is gone (there is only one page now)');
check(!dashboardHtml.includes('View Customer Dashboard'), 'admin-business.html: no admin navigation option sends an admin into the consumer dashboard');
check(!/href="\/dashboard"/.test(dashboardHtml), 'admin-business.html: contains no link at all into the consumer /dashboard route');

check(dashboardHtml.includes('aria-current'), 'admin-business.html: the active tab is marked with aria-current for accessibility, not just a visual-only cue');
check(/aria-current="page"\]\s*\{[^}]*background:\s*#22d3ee/.test(dashboardHtml), 'admin-business.html: the active tab gets a solid brand-cyan fill (#22d3ee), not just a border or text-colour change, for strong contrast');
check(/Log out|Logout/.test(dashboardHtml), 'admin-business.html: a logout control is present');
check(dashboardHtml.includes('action="/logout"'), 'admin-business.html: logout submits to the real /logout route, not a fake/local-only control');

for (const tabId of ['business', 'customers', 'operations', 'systemhealth']) {
  check(dashboardHtml.includes(`id="${tabId}"`), `admin-business.html: the ${tabId} tab panel exists`);
  check(dashboardHtml.includes(`id="tabBtn-${tabId}"`), `admin-business.html: the ${tabId} tab button exists`);
}

console.log(failures === 0 ? '\nAll dashboard consolidation checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
