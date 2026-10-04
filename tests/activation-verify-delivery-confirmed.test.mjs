// Structural proof that POST /api/v1/activation/verify (routes/mobileApi.js)
// now reports a genuine delivery-confirmation signal alongside its
// existing forwarding-only `verified` field (2026-09-27, P0-3 launch
// hardening). Matches this codebase's established convention for testing
// route-handler internals via source-string assertions.
//
// Real gap this closes, found tracing a production household whose Voice
// SDK client never once registered: this route previously reported
// "verified: true" based entirely on activation_verified_at — proof only
// that a call reached Home Call Guard, never proof it reached the
// customer's phone. The mobile app's own verify.tsx screen then showed
// "Verified! Your calls are now forwarding correctly," which reads as a
// stronger claim than the evidence actually supports.
//
// Run with: node tests/activation-verify-delivery-confirmed.test.mjs

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

const routeMatch = src.match(/router\.post\("\/api\/v1\/activation\/verify", requireAuthApi, async \(req, res\) => \{[\s\S]*?\n\}\);\n/);
check(Boolean(routeMatch), 'sanity check: the POST /api/v1/activation/verify route handler body is found');
const routeBody = routeMatch ? routeMatch[0] : '';

// --- the existing fields and behaviour must be completely unchanged —
// this is an additive change, not a rewrite ---
check(
  routeBody.includes('const recentCalls = await getRecentCalls(req.household.id, 1);') &&
    routeBody.includes('const verified = isCallWithinVerificationWindow(recentCalls[0]);'),
  'the existing forwarding-verification check (getRecentCalls + isCallWithinVerificationWindow) is completely unchanged'
);
check(
  routeBody.includes('const verifiedAt = await markActivationVerified(req.household.id);'),
  'activation_verified_at is still stamped exactly as before on a genuine forwarding-verified call'
);

// --- the new field must exist on BOTH response branches (not-yet-
// verified and verified), always as an honest boolean, never omitted ---
const notYetMatch = routeBody.match(/if \(!verified\) \{\s*return res\.json\(\{([^}]*)\}\);/);
check(Boolean(notYetMatch), 'sanity check: the not-yet-verified early-return branch is found');
check(
  Boolean(notYetMatch) && /deliveryConfirmed:\s*false/.test(notYetMatch[1]),
  'the not-yet-verified branch explicitly reports deliveryConfirmed: false — never omitted, never left for the client to assume'
);

check(
  /res\.json\(\{ verified: true, verifiedAt, deliveryConfirmed: protectionStatus\.endToEndDeliveryVerified \}\);/.test(routeBody),
  'the verified branch reports deliveryConfirmed from protectionStatus.endToEndDeliveryVerified — the exact same, already-tested signal computeProtectionStatus uses elsewhere for "You\'re protected", never a separately re-derived or looser check'
);
check(
  /const \{ protection: protectionStatus \} = await resolveCanonicalProtection\(\{ supabase: supabaseAdmin, household: req\.household, deliveryHealth, now: new Date\(\) \}\);/.test(routeBody),
  'the canonical status is reused (2026-10-04: resolveCanonicalProtection, which wraps computeProtectionStatus + the lifecycle state machine — tests/canonical-protection.test.mjs), not reimplemented'
);

// --- the old `verified` field's meaning and value must be byte-for-byte
// unchanged — a current app build (which only reads `verified`) must see
// identical behaviour to before this change ---
check(
  routeBody.includes('res.json({ verified: false, deliveryConfirmed: false });'),
  'the not-yet-verified response still returns verified: false exactly as before — only a new field was added alongside it'
);
check(
  /verified: true, verifiedAt, deliveryConfirmed/.test(routeBody),
  'the verified response still returns verified: true and the real verifiedAt exactly as before — deliveryConfirmed is additive, not a replacement for either'
);

console.log(`\n${failures === 0 ? '✓ All' : `✗ ${failures}`} activation-verify-delivery-confirmed checks ${failures === 0 ? 'passed' : 'FAILED'}`);
process.exitCode = failures === 0 ? 0 : 1;
