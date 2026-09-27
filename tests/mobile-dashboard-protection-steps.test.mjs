// Structural proof that GET /api/v1/me/dashboard (routes/mobileApi.js)
// wires the 5-step customer-facing checklist (services/
// customerProtectionSteps.js) into its response, additively, alongside
// the existing deliveryReady/endToEndDeliveryVerified/fullyProtected
// fields — never replacing them. Matches this codebase's established
// convention for testing route-handler internals via source-string
// assertions (e.g. tests/activation-verify-delivery-confirmed.test.mjs).
//
// Run with: node tests/mobile-dashboard-protection-steps.test.mjs

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

const src = readFileSync(path.join(__dirname, '..', 'routes', 'mobileApi.js'), 'utf8');

check(
  /require\("\.\.\/services\/customerProtectionSteps"\)/.test(src),
  'mobileApi.js imports buildCustomerProtectionSteps from services/customerProtectionSteps — the one shared implementation, not a route-local reimplementation'
);
check(
  /const customerProtectionSteps = buildCustomerProtectionSteps\(req\.household, new Date\(\)\);/.test(src),
  'buildCustomerProtectionSteps is called with the same req.household used for computeProtectionStatus just above it'
);
check(
  /steps: customerProtectionSteps\.steps,/.test(src) && /guidance: customerProtectionSteps\.guidance,/.test(src),
  'the response includes steps/guidance inside protection'
);

// The pre-existing fields must remain byte-for-byte present — this must
// be a purely additive change, never a replacement.
check(
  /deliveryReady: protectionStatus\.deliveryReady,/.test(src) &&
    /endToEndDeliveryVerified: protectionStatus\.endToEndDeliveryVerified,/.test(src) &&
    /fullyProtected: protectionStatus\.fullyProtected,/.test(src),
  'the pre-existing deliveryReady/endToEndDeliveryVerified/fullyProtected fields are completely unchanged — this is additive, not a rewrite'
);

console.log(`\n${failures === 0 ? '✓ All' : `✗ ${failures}`} mobile-dashboard-protection-steps checks ${failures === 0 ? 'passed' : 'FAILED'}`);
process.exitCode = failures === 0 ? 0 : 1;
