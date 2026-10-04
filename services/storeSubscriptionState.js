// Apple / RevenueCat subscription lifecycle state (migration 073, launch
// sprint 2026-10-05). Pure: maps one RevenueCat webhook event to the
// entitlement columns it updates. No I/O; database/billing.js
// applyRevenueCatStoreState applies the result.
//
// Rules (Andrew, 2026-10-04: "cancellation should not remove protection
// before the paid-through date; billing problems must be represented
// truthfully; sandbox/TestFlight purchases must never become genuine
// customers or trigger paid resources"):
//   * Nothing here touches status or ends_at, so no event processed here can
//     end access. EXPIRATION (unchanged) is still the only revoke.
//   * CANCELLATION              → store_will_renew = false (+ reason).
//     cancel_reason CUSTOMER_SUPPORT (Apple refund) also sets
//     store_refunded_at: recorded and alerted, access not cut (policy: Andrew).
//   * BILLING_ISSUE             → store_billing_issue_at (+ grace period end).
//   * UNCANCELLATION            → store_will_renew = true, reason cleared.
//   * RENEWAL / INITIAL_PURCHASE → will renew, billing issue + grace cleared
//     (a successful charge is the recovery).
//   * Anything else (PRODUCT_CHANGE, TRANSFER, EXPIRATION, TEST,
//     NON_RENEWING_PURCHASE, unknown future types) → null: nothing recorded.
//   * An event without a usable event_timestamp_ms → null (the ordering guard
//     needs it; never guess an order).
'use strict';

const RECOVERY_TYPES = new Set(['RENEWAL', 'INITIAL_PURCHASE']);
const REFUND_REASON = 'CUSTOMER_SUPPORT';

function msToIso(ms) {
  const n = Number(ms);
  return Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : null;
}

function normaliseReason(reason) {
  if (typeof reason !== 'string') return null;
  const r = reason.trim().toUpperCase();
  return /^[A-Z_]{1,40}$/.test(r) ? r : 'UNKNOWN';
}

/**
 * @param {object} event RevenueCat webhook `event` object
 * @returns {{ kind: string, eventAt: string, patch: object } | null}
 */
function deriveStoreStatePatch(event) {
  if (!event || typeof event.type !== 'string') return null;
  const eventAt = msToIso(event.event_timestamp_ms);
  if (!eventAt) return null;

  switch (event.type) {
    case 'CANCELLATION': {
      const reason = normaliseReason(event.cancel_reason);
      const patch = { store_will_renew: false, store_cancel_reason: reason };
      if (reason === REFUND_REASON) patch.store_refunded_at = eventAt;
      return { kind: reason === REFUND_REASON ? 'refund' : 'cancellation', eventAt, patch };
    }
    case 'BILLING_ISSUE':
      return {
        kind: 'billing_issue',
        eventAt,
        patch: { store_billing_issue_at: eventAt, store_grace_period_expires_at: msToIso(event.grace_period_expiration_at_ms) },
      };
    case 'UNCANCELLATION':
      return { kind: 'uncancellation', eventAt, patch: { store_will_renew: true, store_cancel_reason: null } };
    default:
      if (RECOVERY_TYPES.has(event.type)) {
        return {
          kind: 'recovery',
          eventAt,
          patch: { store_will_renew: true, store_cancel_reason: null, store_billing_issue_at: null, store_grace_period_expires_at: null },
        };
      }
      return null;
  }
}

/**
 * Ordering guard: apply only when strictly newer than what the row already
 * reflects. A row with no recorded event time accepts any dated event.
 */
function isNewerThanRecorded(eventAtIso, recordedIso) {
  if (!recordedIso) return true;
  return Date.parse(eventAtIso) > Date.parse(recordedIso);
}

module.exports = { deriveStoreStatePatch, isNewerThanRecorded, REFUND_REASON };
