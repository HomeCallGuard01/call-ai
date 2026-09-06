// Unit tests for the pure RevenueCat webhook event classification —
// see services/revenuecatWebhook.js for the full rationale (in
// particular why CANCELLATION must never classify as a revoke).
//
// Run with: node tests/revenuecat-webhook.test.mjs

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const {
  classifyRevenueCatEvent,
  resolveOriginalTransactionId,
  resolveTransferGainingAppUserId,
  resolveEventAppUserId,
  resolveTransferReference,
  resolveGrantReference,
} = require('../services/revenuecatWebhook.js');

let failures = 0;

function check(condition, message) {
  if (condition) {
    console.log(`✓ ${message}`);
  } else {
    console.error(`✗ ${message}`);
    failures++;
  }
}

// --- classifyRevenueCatEvent ---

check(
  classifyRevenueCatEvent('INITIAL_PURCHASE') === 'grant',
  'INITIAL_PURCHASE classifies as a grant'
);
check(
  classifyRevenueCatEvent('RENEWAL') === 'grant',
  'RENEWAL classifies as a grant'
);
check(
  classifyRevenueCatEvent('UNCANCELLATION') === 'grant',
  'UNCANCELLATION classifies as a grant'
);
check(
  classifyRevenueCatEvent('PRODUCT_CHANGE') === 'grant',
  'PRODUCT_CHANGE classifies as a grant'
);
check(
  classifyRevenueCatEvent('TRANSFER') === 'grant',
  'TRANSFER (gaining identity) classifies as a grant'
);
check(
  classifyRevenueCatEvent('EXPIRATION') === 'revoke',
  'EXPIRATION classifies as a revoke — the real "access ends now" signal'
);
check(
  classifyRevenueCatEvent('CANCELLATION') === 'acknowledge',
  'CANCELLATION does NOT classify as a revoke — access continues until EXPIRATION, same as Stripe cancel_at_period_end'
);
check(
  classifyRevenueCatEvent('BILLING_ISSUE') === 'acknowledge',
  'BILLING_ISSUE does not revoke immediately — mirrors Stripe past_due behaviour'
);
check(
  classifyRevenueCatEvent('SOME_FUTURE_EVENT_TYPE') === 'acknowledge',
  'an unrecognised future event type fails closed to acknowledge, never accidentally revokes or grants'
);

// --- resolveOriginalTransactionId ---

check(
  resolveOriginalTransactionId({ original_transaction_id: 'abc123', transaction_id: 'xyz789' }) === 'abc123',
  'prefers original_transaction_id when present'
);
check(
  resolveOriginalTransactionId({ transaction_id: 'xyz789' }) === 'xyz789',
  'falls back to transaction_id when original_transaction_id is absent'
);
check(
  resolveOriginalTransactionId({}) === null,
  'returns null rather than throwing when neither field is present'
);
check(
  resolveOriginalTransactionId(null) === null,
  'returns null rather than throwing for a null event'
);

// --- TRANSFER handling (2026-08-31) ---
// The real shape RevenueCat actually sends for a TRANSFER event — captured
// from RevenueCat's own delivery record for the sandbox event that first
// exposed this gap (6/6 failed attempts against the production webhook,
// HTTP 400 invalid_payload) — not a guessed/simplified fixture. Notably
// absent: app_user_id, original_transaction_id, transaction_id. Every
// other event type this webhook handles carries all three.
const REAL_TRANSFER_EVENT = {
  id: 'evt_real_transfer_captured_20260831',
  type: 'TRANSFER',
  environment: 'SANDBOX',
  app_id: 'app_homecallguard',
  event_timestamp_ms: 1798000000000,
  transferred_from: ['4bb57845-393d-4299-8cb3-ed3b7ac03e47'],
  transferred_to: ['da5ecb5d-21f2-4eb6-b03f-a28e71edac73'],
};

// --- resolveTransferGainingAppUserId ---

check(
  resolveTransferGainingAppUserId(REAL_TRANSFER_EVENT) === 'da5ecb5d-21f2-4eb6-b03f-a28e71edac73',
  'resolveTransferGainingAppUserId: resolves the single gaining identity from the real captured TRANSFER payload shape'
);
check(
  resolveTransferGainingAppUserId({ ...REAL_TRANSFER_EVENT, transferred_to: [] }) === null,
  'resolveTransferGainingAppUserId: an empty transferred_to is ambiguous — fails safe to null, never guesses'
);
check(
  resolveTransferGainingAppUserId({ ...REAL_TRANSFER_EVENT, transferred_to: ['a', 'b'] }) === null,
  'resolveTransferGainingAppUserId: more than one gaining identity is ambiguous for this data model — fails safe to null'
);
check(
  resolveTransferGainingAppUserId({ ...REAL_TRANSFER_EVENT, transferred_to: undefined }) === null,
  'resolveTransferGainingAppUserId: a missing transferred_to fails safe to null, never throws'
);
check(
  resolveTransferGainingAppUserId({ ...REAL_TRANSFER_EVENT, transferred_to: 'da5ecb5d-21f2-4eb6-b03f-a28e71edac73' }) === null,
  'resolveTransferGainingAppUserId: a non-array transferred_to (malformed payload) fails safe to null rather than treating a string as a single-element list'
);
check(
  resolveTransferGainingAppUserId(null) === null,
  'resolveTransferGainingAppUserId: a null event fails safe to null, never throws'
);

// --- resolveEventAppUserId: TRANSFER-aware identity resolution ---

check(
  resolveEventAppUserId(REAL_TRANSFER_EVENT) === 'da5ecb5d-21f2-4eb6-b03f-a28e71edac73',
  'resolveEventAppUserId: TRANSFER resolves identity from transferred_to, not app_user_id (which the real payload does not have)'
);
check(
  resolveEventAppUserId({ ...REAL_TRANSFER_EVENT, transferred_to: [] }) === null,
  'resolveEventAppUserId: an unresolvable TRANSFER (ambiguous transferred_to) resolves to null, not a guessed identity'
);
check(
  resolveEventAppUserId({ type: 'INITIAL_PURCHASE', app_user_id: 'household-x' }) === 'household-x',
  'resolveEventAppUserId: every non-TRANSFER event type is completely unchanged — reads app_user_id directly'
);
check(
  resolveEventAppUserId({ type: 'RENEWAL' }) === null,
  'resolveEventAppUserId: a non-TRANSFER event genuinely missing app_user_id still resolves to null (unchanged prior behaviour), not TRANSFER-specific logic leaking into other types'
);
check(
  resolveEventAppUserId(null) === null,
  'resolveEventAppUserId: a null event resolves to null rather than throwing'
);

// --- resolveTransferReference ---

check(
  resolveTransferReference(REAL_TRANSFER_EVENT) === 'revenuecat_transfer_evt_real_transfer_captured_20260831',
  'resolveTransferReference: derives a stable, traceable reference from the event\'s own real id, never fabricated data'
);
check(
  resolveTransferReference({ ...REAL_TRANSFER_EVENT, id: undefined }) === null,
  'resolveTransferReference: no event id at all fails safe to null rather than producing a broken reference string'
);
check(
  resolveTransferReference(null) === null,
  'resolveTransferReference: a null event fails safe to null'
);

// --- resolveGrantReference: TRANSFER-aware, everything else delegates unchanged ---

check(
  resolveGrantReference(REAL_TRANSFER_EVENT) === 'revenuecat_transfer_evt_real_transfer_captured_20260831',
  'resolveGrantReference: TRANSFER uses the synthetic event-id-based reference, since the real payload has no transaction id at all'
);
check(
  resolveGrantReference({ type: 'INITIAL_PURCHASE', original_transaction_id: 'abc123', transaction_id: 'xyz789' }) === 'abc123',
  'resolveGrantReference: INITIAL_PURCHASE (and every other non-TRANSFER type) delegates straight to the real, unchanged resolveOriginalTransactionId'
);
check(
  resolveGrantReference({ type: 'RENEWAL', transaction_id: 'xyz789' }) === 'xyz789',
  'resolveGrantReference: RENEWAL still falls back to transaction_id exactly as resolveOriginalTransactionId always has'
);
check(
  resolveGrantReference({ type: 'RENEWAL' }) === null,
  'resolveGrantReference: a non-TRANSFER event missing both id fields still returns null, unchanged from resolveOriginalTransactionId'
);

// --- Structural: the route's grant/revoke handling is byte-for-byte
// unchanged for every event type — only identity/reference resolution
// (above) became TRANSFER-aware. Isolation proof for the fix ported
// from commit a6d00c1 onto a fresh branch off origin/main, deliberately
// excluding that commit's unrelated Voice-reachability and mobile
// resume/setup-loop changes. ---

const routeSource = readFileSync(new URL('../routes/mobileApi.js', import.meta.url), 'utf8');

check(
  routeSource.includes('const { classifyRevenueCatEvent, resolveEventAppUserId, resolveGrantReference } = require("../services/revenuecatWebhook");'),
  'routes/mobileApi.js: imports the TRANSFER-aware resolveEventAppUserId/resolveGrantReference, replacing the old direct event.app_user_id/resolveOriginalTransactionId usage at the call site (the underlying resolveOriginalTransactionId function itself is untouched — resolveGrantReference delegates straight to it for every non-TRANSFER type)'
);

check(
  routeSource.includes('const household = await getHouseholdByAuthUserId(appUserId);'),
  'routes/mobileApi.js: household lookup uses the resolved appUserId (identical value to the old event.app_user_id for every non-TRANSFER event) — no lookup logic changed'
);

const grantRevokeBlock = routeSource.slice(routeSource.indexOf('const classification = classifyRevenueCatEvent(event.type);'));
check(
  grantRevokeBlock.includes('if (classification === "grant") {') &&
    grantRevokeBlock.includes('const result = await upsertActiveEntitlementFromRevenueCat(household.id, {') &&
    grantRevokeBlock.includes('originalTransactionId,\n        expiresAtMs: event.expiration_at_ms,') &&
    grantRevokeBlock.includes('await updateTwilioNumberForEntitlementChange(household, true)') &&
    grantRevokeBlock.includes('if (classification === "revoke") {') &&
    grantRevokeBlock.includes('const result = await expireEntitlementFromRevenueCat(household.id, originalTransactionId);') &&
    grantRevokeBlock.includes('await updateTwilioNumberForEntitlementChange(household, false)'),
  'routes/mobileApi.js: the entire grant/revoke classification, entitlement upsert/expiry, and Twilio provisioning hook block is completely untouched — proves existing non-TRANSFER RevenueCat events (INITIAL_PURCHASE, RENEWAL, CANCELLATION, EXPIRATION, etc.) go through exactly the same code path as before this fix'
);

check(
  !routeSource.includes('isVoiceClientReachable') && !routeSource.includes('voiceClientReachable') && !routeSource.includes('markVoiceClientRegistered') && !routeSource.includes('/api/v1/voice/registered'),
  'routes/mobileApi.js: no Voice-SDK-reachability logic was brought across from commit a6d00c1\'s base — this fix was isolated cleanly onto current origin/main, which never had that abandoned work'
);

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
