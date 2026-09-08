// Regression test for the Apple App Review Guideline 1.5 rejection
// (2026-09-07, Submission ca196b7b): App Store Connect's Support URL
// field has "https://www.homecallguard.co.uk/support" on file (no
// extension). express.static only ever served the .html variant
// (public/support.html), so that exact URL 404'd for Apple's reviewer.
//
// Structural check against the real source, matching this codebase's
// existing convention for route-wiring behavior that isn't a pure,
// extractable function (see tests/admin-post-login-routing.test.mjs) —
// there's no HTTP test tooling in this project, and server.js calls
// app.listen() at module load time so it can't be required directly.
//
// Run with: node tests/support-url-route.test.mjs

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverSource = readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

let failures = 0;

function check(condition, message) {
  if (condition) {
    console.log(`✓ ${message}`);
  } else {
    console.error(`✗ ${message}`);
    failures++;
  }
}

// Same clean-URL pattern already proven for /privacy — assert the /support
// route exists, is a plain unauthenticated GET (matches App Store Connect's
// bare Support URL, no auth gate a reviewer could get stuck behind), and
// serves the real public/support.html file rather than a stub/placeholder.
const routeAnchor = 'app.get("/support"';
const routeIdx = serverSource.indexOf(routeAnchor);

check(routeIdx !== -1, 'server.js declares a GET /support route (clean URL, no .html extension)');

if (routeIdx !== -1) {
  const blockEnd = serverSource.indexOf('});', routeIdx);
  const block = serverSource.slice(routeIdx, blockEnd + 3);

  check(
    block.includes('sendFile') && block.includes('/public/support.html'),
    'GET /support serves the real public/support.html file, not a placeholder or redirect'
  );

  check(
    !/requireAuth|requireEntitlement|requireAdmin/.test(block),
    'GET /support is not gated behind any auth middleware (a reviewer must reach it while signed out)'
  );
}

// Guard against the same route being declared twice (e.g. a duplicate
// added by an unrelated future change) — Express would use only the
// first match, silently making a second declaration dead code.
const occurrences = serverSource.split(routeAnchor).length - 1;
check(occurrences === 1, `GET /support is declared exactly once in server.js (found ${occurrences})`);

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
