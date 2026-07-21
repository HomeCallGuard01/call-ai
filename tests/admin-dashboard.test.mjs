// Unit tests for the Sprint 11 Operations Dashboard's pure rendering-logic
// functions in admin.html — extracted from the real page markup (between
// TEST-EXTRACT markers) and executed standalone, no browser or DOM
// library required. Same extraction convention as
// tests/dashboard-status.test.mjs.
//
// Run with: node tests/admin-dashboard.test.mjs

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');

let failures = 0;

function check(condition, message) {
  if (condition) {
    console.log(`✓ ${message}`);
  } else {
    console.error(`✗ ${message}`);
    failures++;
  }
}

function extractBetween(source, name) {
  const startMarker = `// TEST-EXTRACT-START: ${name}`;
  const endMarker = `// TEST-EXTRACT-END: ${name}`;
  const startIdx = source.indexOf(startMarker);
  const endIdx = source.indexOf(endMarker);
  if (startIdx === -1 || endIdx === -1) {
    return null;
  }
  return source.slice(startIdx + startMarker.length, endIdx);
}

const names = [
  'formatHealthBadge',
  'formatCurrency',
  'formatProtectionRate',
  'describeActivityEvent',
  'describeAlert',
  'formatQuickActionResult',
  'formatLaunchReadinessBadge',
  'describeReadinessBanner',
  'describeAdminAction',
];

const sources = names.map(name => extractBetween(html, name));

if (sources.some(s => !s)) {
  console.error('✗ could not find one or more TEST-EXTRACT markers in admin.html — test cannot run');
  failures++;
} else {
  const combinedSource = `${sources.join('\n')}\nreturn { ${names.join(', ')} };`;
  const {
    formatHealthBadge,
    formatCurrency,
    formatProtectionRate,
    describeActivityEvent,
    describeAlert,
    formatQuickActionResult,
    formatLaunchReadinessBadge,
    describeReadinessBanner,
    describeAdminAction,
  } = new Function(combinedSource)();

  // --- formatHealthBadge ---

  check(
    formatHealthBadge({ status: 'ok' }).label === 'Operational' && formatHealthBadge({ status: 'ok' }).className === 'ok',
    'formatHealthBadge: ok status renders as Operational'
  );

  check(
    formatHealthBadge({ status: 'error' }).label === 'Error',
    'formatHealthBadge: error status renders as Error'
  );

  check(
    formatHealthBadge({ status: 'not_configured' }).label === 'Not configured',
    'formatHealthBadge: not_configured renders as "Not configured" rather than a fake ok/error result'
  );

  // --- formatCurrency ---

  check(
    formatCurrency({ available: true, amount: 69.93, currency: 'gbp' }) === '£69.93',
    'formatCurrency: formats an available amount as GBP currency'
  );

  check(
    formatCurrency({ available: false, amount: null, currency: null }) === '—',
    'formatCurrency: renders an em dash, not a fabricated number, when unavailable'
  );

  check(formatCurrency(null) === '—', 'formatCurrency: handles a missing money object without throwing');

  // --- formatProtectionRate ---

  check(formatProtectionRate(25) === '25%', 'formatProtectionRate: formats a numeric rate with a percent sign');
  check(formatProtectionRate(null) === 'No calls yet', 'formatProtectionRate: null renders as "No calls yet", not "0%" or "null%"');

  // --- describeActivityEvent ---

  check(
    describeActivityEvent({ type: 'signup', email: 'a@example.com', at: '2026-07-20T10:00:00Z' }).title === 'a@example.com signed up',
    'describeActivityEvent: a signup event names the customer'
  );

  check(
    describeActivityEvent({ type: 'subscription_active', email: 'a@example.com', at: '2026-07-21T09:00:00Z' }).title === 'a@example.com — subscription active',
    'describeActivityEvent: a subscription status event names the new status'
  );

  check(
    describeActivityEvent({ type: 'signup', email: null, at: '2026-07-20T10:00:00Z' }).title === 'Unknown customer signed up',
    'describeActivityEvent: falls back to a placeholder label rather than showing "null" when email is missing'
  );

  // --- describeAlert ---

  check(
    describeAlert({ type: 'provisioning_failed', severity: 'high', email: 'a@example.com', message: 'No numbers available' }).className === 'severity-high',
    'describeAlert: a high-severity alert gets the high-severity class'
  );

  check(
    describeAlert({ type: 'webhook_failed', severity: 'medium', message: 'timeout' }).title === 'Webhook processing failed',
    'describeAlert: a webhook failure is labelled distinctly from a provisioning failure'
  );

  // --- formatQuickActionResult ---

  check(
    formatQuickActionResult({ attempted: false }).startsWith('Not attempted'),
    'formatQuickActionResult: an unattempted retry is reported as such, not as a silent success'
  );

  check(
    formatQuickActionResult({ attempted: true, success: true, twilioNumber: '+447700900123' }) === 'Provisioned successfully: +447700900123',
    'formatQuickActionResult: a successful retry reports the real assigned number'
  );

  check(
    formatQuickActionResult({ attempted: true, success: false, error: 'No available GB Twilio numbers found' }).includes('No available GB Twilio numbers found'),
    'formatQuickActionResult: a failed retry surfaces the real error message, not a generic one'
  );

  // --- formatLaunchReadinessBadge ---

  check(
    formatLaunchReadinessBadge({ severity: 'blocker' }).label === 'Blocker',
    'formatLaunchReadinessBadge: blocker severity renders as "Blocker"'
  );

  check(
    formatLaunchReadinessBadge({ severity: 'medium' }).className === 'medium',
    'formatLaunchReadinessBadge: css class matches the severity level'
  );

  // --- describeReadinessBanner ---

  check(
    describeReadinessBanner({ status: 'not_ready', blockersCount: 2, openCount: 5 }).text.includes('2 open blockers'),
    'describeReadinessBanner: not_ready states the number of open blockers, pluralised correctly'
  );

  check(
    describeReadinessBanner({ status: 'not_ready', blockersCount: 1, openCount: 1 }).text.includes('1 open blocker') &&
      !describeReadinessBanner({ status: 'not_ready', blockersCount: 1, openCount: 1 }).text.includes('1 open blockers'),
    'describeReadinessBanner: singular "blocker" is not pluralised when there is exactly one'
  );

  check(
    describeReadinessBanner({ status: 'ready_with_open_items', blockersCount: 0, openCount: 3 }).className === 'ready_with_open_items',
    'describeReadinessBanner: ready_with_open_items gets its own distinct banner class'
  );

  check(
    describeReadinessBanner({ status: 'ready', blockersCount: 0, openCount: 0 }).text === 'Ready — no outstanding launch checks',
    'describeReadinessBanner: fully ready state has no open-count caveat in its text'
  );

  // --- describeAdminAction ---

  check(
    describeAdminAction({
      type: 'retry_provisioning',
      email: 'a@example.com',
      householdId: 'h1',
      result: { attempted: true, success: true, twilioNumber: '+447700900123' },
      at: '2026-07-21T21:00:00Z',
    }).title === 'Retry provisioning — a@example.com',
    'describeAdminAction: a retry action names the customer it was performed against'
  );

  check(
    describeAdminAction({
      type: 'retry_provisioning',
      email: null,
      householdId: 'h1',
      result: { attempted: false },
      at: '2026-07-21T21:00:00Z',
    }).title === 'Retry provisioning — h1',
    'describeAdminAction: falls back to the household ID when no email is available'
  );
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
} else {
  console.log('\nAll admin dashboard checks passed.');
}
