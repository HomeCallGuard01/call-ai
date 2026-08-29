// Unit tests for the pure RevenueCat webhook event classification —
// see services/revenuecatWebhook.js for the full rationale (in
// particular why CANCELLATION must never classify as a revoke).
//
// Run with: node tests/revenuecat-webhook.test.mjs

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { classifyRevenueCatEvent, resolveOriginalTransactionId } = require('../services/revenuecatWebhook.js');

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

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
