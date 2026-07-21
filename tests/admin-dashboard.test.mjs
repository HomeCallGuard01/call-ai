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
  'formatRevenue',
  'describeActivityEvent',
  'describeAlert',
  'formatQuickActionResult',
  'formatLaunchReadinessBadge',
];

const sources = names.map(name => extractBetween(html, name));

if (sources.some(s => !s)) {
  console.error('✗ could not find one or more TEST-EXTRACT markers in admin.html — test cannot run');
  failures++;
} else {
  const combinedSource = `${sources.join('\n')}\nreturn { ${names.join(', ')} };`;
  const {
    formatHealthBadge,
    formatRevenue,
    describeActivityEvent,
    describeAlert,
    formatQuickActionResult,
    formatLaunchReadinessBadge,
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

  // --- formatRevenue ---

  check(
    formatRevenue({ available: true, amount: 69.93, currency: 'gbp' }) === '£69.93',
    'formatRevenue: formats an available revenue figure as GBP currency'
  );

  check(
    formatRevenue({ available: false, amount: null, currency: null }) === '—',
    'formatRevenue: renders an em dash, not a fabricated number, when unavailable'
  );

  check(formatRevenue(null) === '—', 'formatRevenue: handles a missing revenue object without throwing');

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
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
} else {
  console.log('\nAll admin dashboard checks passed.');
}
