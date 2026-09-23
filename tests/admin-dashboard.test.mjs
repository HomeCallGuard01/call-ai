// Unit tests for the consolidated Admin Dashboard's pure rendering-logic
// functions in admin-business.html — extracted from the real page markup
// (between TEST-EXTRACT markers) and executed standalone, no browser or
// DOM library required. Same extraction convention as
// tests/dashboard-status.test.mjs.
//
// Dashboard Consolidation (2026-09): this used to read admin.html, now
// retired (routes/admin.js's GET /admin redirects to /admin/business).
// formatHealthBadge is dropped along with it — that function rendered the
// old, separate services/healthChecks.js-based health panel, which no
// longer exists anywhere in this dashboard; System Health now has exactly
// one rendering path, covered by tests/dashboard-consolidation.test.mjs.
//
// Run with: node tests/admin-dashboard.test.mjs

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(__dirname, '..', 'admin-business.html'), 'utf8');

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
  console.error('✗ could not find one or more TEST-EXTRACT markers in admin-business.html — test cannot run');
  failures++;
} else {
  const combinedSource = `${sources.join('\n')}\nreturn { ${names.join(', ')} };`;
  const {
    formatCurrency,
    formatProtectionRate,
    describeActivityEvent,
    describeAlert,
    formatQuickActionResult,
    formatLaunchReadinessBadge,
    describeReadinessBanner,
    describeAdminAction,
  } = new Function(combinedSource)();

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

  check(
    formatLaunchReadinessBadge({ status: 'done', severity: 'blocker' }).label === 'Done',
    'formatLaunchReadinessBadge: a resolved item renders as "Done" regardless of its original severity'
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

// --- Operations list rendering escapes customer data (security regression, 2026-09) ---
// A customer-chosen email address (or a caller-controlled number) must
// never reach innerHTML as live markup. Uses the same escapeHtml helper
// as the Customers tab, extracted from the real page.

{
  const renderers = extractBetween(html, 'operationsListRenderers');
  const helpers = extractBetween(html, 'customerMonitorHelpers');
  const describers = ['describeActivityEvent', 'describeAlert', 'describeAdminAction', 'formatQuickActionResult'].map(n => extractBetween(html, n));

  if (!renderers || !helpers || describers.some(s => !s)) {
    check(false, 'operationsListRenderers / customerMonitorHelpers TEST-EXTRACT markers found in admin-business.html');
  } else {
    const ops = new Function(
      `${helpers}\n${describers.join('\n')}\n${renderers}\nreturn { renderListHtml, renderCallsHtml, renderSearchResultsHtml, describeActivityEvent, describeAlert, describeAdminAction };`
    )();

    const evil = '"><img src=x onerror=alert(1)>@example.com';
    const escaped = '&quot;&gt;&lt;img src=x onerror=alert(1)&gt;@example.com';
    const noLiveTag = (out) => !out.includes('<img') && !out.includes('onerror=alert(1)>');

    const signups = ops.renderListHtml([{ type: 'signup', email: evil, at: '2026-09-23T10:00:00Z' }], 'none', ops.describeActivityEvent);
    check(noLiveTag(signups) && signups.includes(escaped), 'Recent registrations: a malicious email is rendered as escaped text, not markup');

    const alerts = ops.renderListHtml(
      [{ type: 'provisioning_failed', severity: 'high', email: evil, message: '<script>x</script>', at: '2026-09-23T10:00:00Z' }],
      'none',
      ops.describeAlert
    );
    check(noLiveTag(alerts) && !alerts.includes('<script>') && alerts.includes('&lt;script&gt;'), 'Recent errors: malicious email and error message are escaped');

    const actions = ops.renderListHtml(
      [{ type: 'grant_complimentary', email: evil, result: { granted: true }, at: '2026-09-23T10:00:00Z' }],
      'none',
      ops.describeAdminAction
    );
    check(noLiveTag(actions) && actions.includes(escaped), 'Admin actions: a malicious email is escaped');

    const calls = ops.renderCallsHtml([{ number: '<b>+44</b>', result: 'SAFE', householdEmail: evil, time: '2026-09-23T10:00:00Z' }]);
    check(noLiveTag(calls) && calls.includes(escaped) && !calls.includes('<b>') && calls.includes('&lt;b&gt;+44&lt;/b&gt;'), 'Recent calls: household email and caller number are escaped');

    const search = ops.renderSearchResultsHtml([{ email: evil, id: 'h1', twilio_number: '+447700900001', twilio_provisioning_status: 'active', status: 'active' }]);
    check(noLiveTag(search) && search.includes(escaped), 'Customer search: a malicious email is escaped');

    const normal = ops.renderListHtml([{ type: 'signup', email: 'jane@example.com', at: '2026-09-23T10:00:00Z' }], 'none', ops.describeActivityEvent);
    check(normal.includes('jane@example.com signed up') && normal.includes('<div class="list-title ">'), 'ordinary emails render unchanged (no functional change)');

    check(ops.renderListHtml([], 'No signups yet.', ops.describeActivityEvent).includes('No signups yet.'), 'empty-state message unchanged');
  }
}

// --- Business tab fair-use table escapes customer email (security regression, 2026-09) ---

{
  const rowRenderer = extractBetween(html, 'renderFairUseRowHtml');
  const helpers = extractBetween(html, 'customerMonitorHelpers');
  const badgeMatch = html.match(/function badge\(status\) \{[^\n]*\}/);

  if (!rowRenderer || !helpers || !badgeMatch) {
    check(false, 'renderFairUseRowHtml / customerMonitorHelpers / badge found in admin-business.html');
  } else {
    const { renderFairUseRowHtml } = new Function(`${badgeMatch[0]}\n${helpers}\n${rowRenderer}\nreturn { renderFairUseRowHtml };`)();

    const evil = renderFairUseRowHtml({ email: '"><img src=x onerror=alert(1)>@example.com', householdId: 'h1', unknownCallCount: 12, tier: 'normal' });
    check(
      !evil.includes('<img') && evil.includes('&quot;&gt;&lt;img src=x onerror=alert(1)&gt;@example.com'),
      'Fair use table: a malicious email is rendered as escaped text, not markup'
    );

    const normal = renderFairUseRowHtml({ email: 'jane@example.com', householdId: 'h1', unknownCallCount: 250, tier: 'over_hard_threshold' });
    check(
      normal === '<tr><td>jane@example.com</td><td>250</td><td><span class="badge badge-RED">RED</span> over_hard_threshold</td></tr>',
      'Fair use table: an ordinary row renders exactly as before (no functional change)'
    );

    const noEmail = renderFairUseRowHtml({ email: null, householdId: 'h-123', unknownCallCount: 1, tier: 'approaching_threshold' });
    check(noEmail.startsWith('<tr><td>h-123</td>') && noEmail.includes('badge-AMBER'), 'Fair use table: falls back to household ID when no email');

    check(html.includes('html += renderFairUseRowHtml(h);'), 'Business tab fair-use loop uses the escaping row renderer');
  }
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
} else {
  console.log('\nAll admin dashboard checks passed.');
}
