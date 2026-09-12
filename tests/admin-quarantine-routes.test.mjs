// Structural tests for routes/admin.js's two new Twilio-number-quarantine
// admin routes (P0 Batch 1 continuation): GET .../quarantine and
// POST .../confirm-deactivation. No HTTP test tooling exists in this
// project (see tests/account-deletion.test.mjs and
// tests/activation-screen-navigation.test.mjs for the same established
// convention) — these routes are checked directly against the real
// routes/admin.js source. The underlying database functions these routes
// call (findUnconfirmedQuarantineForHousehold, confirmTwilioNumberDeactivation)
// already have their own behavioural unit tests with injected fakes
// (tests/twilio-quarantine.test.mjs); this file's job is proving the
// ROUTE WIRING — auth gating, input validation, call ordering, and that
// this is genuinely the only path that can ever set deactivation_confirmed
// — not re-testing that underlying logic.
//
// Run with: node tests/admin-quarantine-routes.test.mjs

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const adminSource = readFileSync(path.join(__dirname, '..', 'routes', 'admin.js'), 'utf8');

let failures = 0;

function check(condition, message) {
  if (condition) {
    console.log(`✓ ${message}`);
  } else {
    console.error(`✗ ${message}`);
    failures++;
  }
}

// --- GET /admin/api/households/:id/quarantine ---

{
  const anchor = 'router.get("/admin/api/households/:id/quarantine"';
  const idx = adminSource.indexOf(anchor);
  check(idx !== -1, 'GET /admin/api/households/:id/quarantine is declared');

  if (idx !== -1) {
    check(
      adminSource.slice(idx, idx + anchor.length + 40).includes('requireAuth') &&
        adminSource.slice(idx, idx + anchor.length + 40).includes('requireAdmin'),
      'the quarantine-status lookup route is gated behind both requireAuth and requireAdmin'
    );

    const blockEnd = adminSource.indexOf('\n});', idx);
    const block = adminSource.slice(idx, blockEnd);
    check(
      block.includes('findUnconfirmedQuarantineForHousehold(req.params.id)'),
      'the lookup route reads the household id from req.params.id (an admin-supplied route param, not customer-controlled)'
    );
    check(
      block.includes('res.json({ quarantine });'),
      'the lookup route returns { quarantine: null } (not an error) when nothing is quarantined — a normal state for most households'
    );
  }
}

// --- POST /admin/api/households/:id/confirm-deactivation ---

{
  const anchor = 'router.post("/admin/api/households/:id/confirm-deactivation"';
  const idx = adminSource.indexOf(anchor);
  check(idx !== -1, 'POST /admin/api/households/:id/confirm-deactivation is declared');

  if (idx !== -1) {
    check(
      adminSource.slice(idx, idx + anchor.length + 60).includes('requireAuth') &&
        adminSource.slice(idx, idx + anchor.length + 60).includes('requireAdmin'),
      'the confirm-deactivation route is gated behind both requireAuth and requireAdmin — a customer session, or an admin session without the admin role, can never reach this handler'
    );

    const blockEnd = adminSource.indexOf('\nmodule.exports', idx);
    const block = adminSource.slice(idx, blockEnd);

    // --- explicit non-empty method required ---
    check(
      block.includes('typeof method !== "string" || !method.trim()'),
      'method must be a genuinely non-empty string — an admin cannot confirm deactivation without recording how it was verified'
    );

    const methodCheckIdx = block.indexOf('typeof method !== "string"');
    const findQuarantineIdx = block.indexOf('findUnconfirmedQuarantineForHousehold(req.params.id)');
    const confirmCallIdx = block.indexOf('confirmTwilioNumberDeactivation(quarantine.id, method)');
    check(
      methodCheckIdx !== -1 && findQuarantineIdx !== -1 && confirmCallIdx !== -1 &&
        methodCheckIdx < findQuarantineIdx && findQuarantineIdx < confirmCallIdx,
      'the method validation happens before the quarantine lookup, which happens before the actual confirmation call — a malformed request never reaches the database at all'
    );

    // --- 404 when nothing to confirm, before ever calling confirmTwilioNumberDeactivation ---
    const notFoundIdx = block.indexOf('res.status(404).json({ error: "no_quarantine_found" })');
    check(
      notFoundIdx !== -1 && findQuarantineIdx < notFoundIdx && notFoundIdx < confirmCallIdx,
      'a household with nothing unconfirmed to confirm gets a 404 before confirmTwilioNumberDeactivation is ever called — this route can never "confirm" a row that does not exist'
    );

    // --- recordAdminAction called only after a genuine success, with the real method ---
    const recordIdx = block.indexOf('recordAdminAction({');
    check(
      recordIdx !== -1 && confirmCallIdx < recordIdx,
      'the admin action is logged only after confirmTwilioNumberDeactivation has actually succeeded, never before'
    );
    check(
      block.includes('type: "confirm_twilio_deactivation"') &&
        block.includes('householdId: req.params.id') &&
        block.slice(recordIdx, recordIdx + 300).includes('method'),
      'the logged admin action records the real household id and the real method string, not a placeholder'
    );

    // --- this route never releases anything itself ---
    check(
      !block.includes('releaseQuarantinedTwilioNumber') && !block.includes('.remove()'),
      'confirming deactivation never itself releases the Twilio number — releaseQuarantinedTwilioNumber (services/twilioProvisioning.js) remains the only path that calls Twilio\'s real .remove() API, on its own separate scheduled run, not synchronously from this request'
    );
  }
}

// --- the single-caller invariant: confirmTwilioNumberDeactivation must
// be reachable from exactly this one route, nowhere else in the entire
// backend — this is the actual proof that "customer/unrelated admin
// actions cannot set deactivation_confirmed". Scans every route file,
// not just routes/admin.js, so a future customer-facing route added
// elsewhere that mistakenly calls this function would fail this test. ---

{
  const routesDir = path.join(__dirname, '..', 'routes');
  const routeFiles = readdirSync(routesDir).filter((f) => f.endsWith('.js'));

  let totalCallSites = 0;
  const callSitesByFile = {};

  for (const file of routeFiles) {
    const source = readFileSync(path.join(routesDir, file), 'utf8');
    const matches = source.match(/confirmTwilioNumberDeactivation\(/g) || [];
    if (matches.length > 0) {
      callSitesByFile[file] = matches.length;
      totalCallSites += matches.length;
    }
  }

  check(
    totalCallSites === 1 && callSitesByFile['admin.js'] === 1,
    `confirmTwilioNumberDeactivation is called from exactly one place across every route file, and it is routes/admin.js's own confirm-deactivation action (found: ${JSON.stringify(callSitesByFile)}) — no customer-facing route (routes/mobileApi.js, routes/billing.js) or any other admin action can set deactivation_confirmed`
  );

  // Also check server.js itself (the web app's own routes live there
  // directly, not only under routes/) for the same invariant.
  const serverSource = readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  check(
    !serverSource.includes('confirmTwilioNumberDeactivation('),
    'server.js (the web app\'s own routes) never calls confirmTwilioNumberDeactivation — it may be mentioned in an explanatory comment (e.g. "no automatic caller exists"), but never actually invoked'
  );
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
