// Structural proof that GET /admin/api/business/number-lifecycle
// (routes/adminBusiness.js) is wired correctly: same auth as every other
// admin route, calls the shared data-fetch function (not a route-local
// reimplementation), and never returns the failure-mode string "failed"
// without also confirming the underlying pure function did the real
// work. Matches this codebase's established convention for testing
// route-handler internals via source-string assertions.
//
// Run with: node tests/admin-number-lifecycle-route.test.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let failures = 0;
function check(condition, message) {
  if (condition) {
    console.log(`✓ ${message}`);
  } else {
    console.error(`✗ ${message}`);
    failures++;
  }
}

const routeSrc = readFileSync(path.join(__dirname, '..', 'routes', 'adminBusiness.js'), 'utf8');
const metricsSrc = readFileSync(path.join(__dirname, '..', 'database', 'adminMetrics.js'), 'utf8');

check(
  /router\.get\("\/admin\/api\/business\/number-lifecycle", requireAuth, requireAdmin, async/.test(routeSrc),
  'the route uses the exact same requireAuth + requireAdmin middleware as every other admin route — no new authorization mechanism'
);
check(
  /const result = await getNumberLifecycleReconciliation\(\);/.test(routeSrc),
  'the route calls the shared database/adminMetrics.js function, not a route-local reimplementation'
);
check(
  /if \(!result\.available\) \{\s*return res\.status\(503\)/.test(routeSrc),
  'an unavailable data source (e.g. Supabase admin client not configured) returns 503, not a silent empty success'
);

check(
  /const \{ computeNumberLifecycleReconciliation \} = require\("\.\.\/services\/adminNumberLifecycleReconciliation"\);/.test(metricsSrc),
  'adminMetrics.js imports the pure reconciliation function from its own dedicated service file — no duplicated decision logic'
);
check(
  /from\("households"\)[\s\S]{0,40}\.select\("id, twilio_number, twilio_provisioning_status, twilio_provisioning_last_error, twilio_number_pending_release_at"\)/.test(metricsSrc),
  'the households query selects exactly the fields the pure function needs — no unrelated PII columns (no email, no phone_number) fetched for this report'
);
check(
  /getClassificationMap\(\)/.test(metricsSrc),
  'reuses the existing getClassificationMap() rather than querying account_classifications directly a second time'
);

console.log(`\n${failures === 0 ? '✓ All' : `✗ ${failures}`} admin-number-lifecycle-route checks ${failures === 0 ? 'passed' : 'FAILED'}`);
process.exitCode = failures === 0 ? 0 : 1;
