// Customer-facing 5-step protection checklist (2026-09-27, launch
// hardening). Explicit instruction this exists to satisfy: "Reuse the
// existing deliveryConfirmed work already merged into main. Do NOT
// create another competing verification mechanism."
//
// This is a pure PRESENTATION layer over signals that already exist and
// are already trusted elsewhere in this codebase — it introduces zero
// new verification logic:
//   - hasProvisionedNumber (services/adminOnboardingStatus.js) — the
//     exact same function the admin dashboard already uses for "HCG
//     number provisioned". Imported, not reimplemented.
//   - computeProtectionStatus (services/callRouting.js) — the single
//     source of truth for forwardingVerified/deliveryReady/
//     endToEndDeliveryVerified/fullyProtected, already used by the web
//     dashboard, the mobile Home tab, and POST /api/v1/activation/verify's
//     deliveryConfirmed field. Called here unchanged.
//
// Critical rule this function exists to make structurally impossible to
// violate: step 5 ("Protection Active") can only ever be `done` when
// `fullyProtected` is true, which itself requires BOTH `deliveryReady`
// AND `endToEndDeliveryVerified` — a forwarded call merely reaching the
// HCG backend (`forwardingVerified` alone) can never satisfy it. This
// isn't a runtime check that could be wrong under some untested
// condition; it's a fact about this function's control flow — step 5's
// `done` value is a direct, unmodified pass-through of
// `protectionStatus.fullyProtected`, never independently computed.
//
// Guidance is deliberately ONE message (not per-step) — "keep the
// customer-facing UI extremely simple. These are technical states
// internally; customers should NOT need to understand Twilio, Voice SDK
// registration, webhooks, call legs or the underlying architecture."
// Wherever an equivalent situation already has reviewed, tested copy on
// the mobile Home tab (mobile/app/(tabs)/index.tsx's confirming_delivery
// and reconnect_needed states), that exact wording is mirrored here
// rather than inventing new copy — same reuse principle as the
// verification signals themselves.

'use strict';

const { computeProtectionStatus } = require('./callRouting');

function hasProvisionedNumber(household) {
  return !!(household && household.twilio_provisioning_status === 'active' && household.twilio_number);
}

const GUIDANCE = {
  // Step 1 not done: no HCG number assigned yet. Not a customer action —
  // this is provisioning, entirely server-side.
  number_pending: {
    key: 'number_pending',
    message: "We're setting up your protected number now. This usually only takes a moment.",
  },
  // Step 2 not done: number exists, but no call has ever reached it.
  // "forwarding not detected" — the customer's own action (dial their
  // carrier's forwarding code) is what's outstanding.
  forwarding_not_detected: {
    key: 'forwarding_not_detected',
    message: 'Turn on call forwarding on your phone so calls reach Home Call Guard — see the setup steps for your network.',
  },
  // Step 3 not done, step 2 done: forwarding works, but this app has
  // never registered / isn't currently reachable, and delivery has never
  // once been confirmed either. "Voice SDK/app not registered or
  // reachable" (first-time case).
  app_not_ready: {
    key: 'app_not_ready',
    message: 'Open the Home Call Guard app and keep it running in the background so it can receive protected calls.',
  },
  // Step 3 done, step 4 not done: forwarding works AND the app is
  // currently reachable, but no real call has ever been confirmed
  // delivered yet. Mirrors mobile/app/(tabs)/index.tsx's
  // "confirming_delivery" state wording exactly — "forwarded call
  // reaches HCG but app delivery isn't confirmed".
  confirming_delivery: {
    key: 'confirming_delivery',
    message:
      "Your call forwarding is set up correctly. We're just confirming we can reach your phone with a protected call — this completes automatically the next time a real call comes through.",
  },
  // Step 4 was satisfied before (delivery has genuinely worked at least
  // once) but the app isn't currently reachable — "temporary
  // connectivity problems". Mirrors index.tsx's "reconnect_needed" state
  // wording exactly. Deliberately never sends the customer back through
  // forwarding/device setup — nothing about their carrier configuration
  // needs to change.
  reconnecting: {
    key: 'reconnecting',
    message:
      "Home Call Guard has protected you before — we just can't currently reach this app. Keep it open for a moment to reconnect. You don't need to redo call forwarding.",
  },
  // All 5 steps done — nothing to show; the caller should treat this as
  // "no outstanding guidance needed", not render this row at all.
  // 2026-09-29 (P0 call-delivery resilience) — driven by real call
  // evidence (services/deliveryHealth.js), never by elapsed time alone.
  // Deliberately plain: no FCM/Twilio/push-token language. Neither tells
  // the customer to turn off call forwarding — whether to recommend that
  // is an open product decision (docs/launch/CALL_DELIVERY_RESILIENCE.md).
  calls_not_reaching_app: {
    key: 'calls_not_reaching_app',
    message:
      "Protected calls can't currently reach this phone. Open the Home Call Guard app to reconnect it. If this message stays, please contact support.",
  },
  delivery_needs_attention: {
    key: 'delivery_needs_attention',
    message:
      "Some recent calls may not have reached this phone. Open the Home Call Guard app to make sure it's connected.",
  },
  none: null,
};

/**
 * Pure, directly unit-testable — `now` is always passed in, never read
 * internally (matches this codebase's established convention, e.g.
 * services/adminOnboardingStatus.js, services/callRouting.js).
 *
 * @param {object} household - same shape computeProtectionStatus expects
 * @param {Date} now
 * @param {object|null} [deliveryHealth] - optional computeDeliveryHealth
 *   result (services/deliveryHealth.js); omitted → previous behaviour
 * @returns {{ steps: Array<{key: string, label: string, done: boolean}>, guidance: object|null }}
 */
// canonicalProtection (optional, 2026-10-04): the merged status from
// services/lifecycle/canonicalProtection.js, so "Protection Active" can never
// disagree with the response's own fullyProtected. Omitted → previous behaviour.
function buildCustomerProtectionSteps(household, now, deliveryHealth = null, canonicalProtection = null) {
  const protectionStatus = canonicalProtection || computeProtectionStatus(household, now, deliveryHealth);
  const healthState = deliveryHealth ? deliveryHealth.state : null;
  const numberActive = hasProvisionedNumber(household);
  // Mirrors adminOnboardingStatus.js's own "Forwarding confirmed" done
  // condition exactly (forwardingVerified OR endToEndDeliveryVerified) —
  // a household that has ever had a real delivered call has, by
  // definition, also had forwarding work.
  const forwardingDetected = protectionStatus.forwardingVerified || protectionStatus.endToEndDeliveryVerified;

  const steps = [
    { key: 'number_active', label: 'HCG number active', done: numberActive },
    { key: 'forwarding_detected', label: 'Call forwarding detected', done: forwardingDetected },
    { key: 'app_registered', label: 'Home Call Guard app ready', done: protectionStatus.deliveryReady },
    // The exact deliveryConfirmed signal, unmodified — see this file's
    // own header for why this is a direct pass-through, never re-derived.
    { key: 'delivery_confirmed', label: 'Call delivery confirmed', done: protectionStatus.endToEndDeliveryVerified },
    { key: 'protection_active', label: 'Protection Active', done: protectionStatus.fullyProtected },
  ];

  let guidance = null;
  if (!numberActive) {
    guidance = GUIDANCE.number_pending;
  } else if (!forwardingDetected) {
    guidance = GUIDANCE.forwarding_not_detected;
  } else if (healthState === 'UNREACHABLE' && protectionStatus.endToEndDeliveryVerified) {
    // Real calls have shown the app can't currently receive them — a
    // stronger, more honest claim than the generic "reconnecting".
    guidance = GUIDANCE.calls_not_reaching_app;
  } else if (!protectionStatus.deliveryReady) {
    // Forwarding works; app isn't reachable. Distinguish first-time setup
    // from a reconnect using the same historical-evidence signal the
    // Home tab already uses: has a real delivery EVER been confirmed?
    guidance = protectionStatus.endToEndDeliveryVerified ? GUIDANCE.reconnecting : GUIDANCE.app_not_ready;
  } else if (!protectionStatus.endToEndDeliveryVerified) {
    guidance = GUIDANCE.confirming_delivery;
  } else if (healthState === 'SUSPECT') {
    // All five steps are done, but recent real calls failed. Steps stay
    // as they are (not conclusive); the customer still gets a nudge.
    guidance = GUIDANCE.delivery_needs_attention;
  }
  // else: all 5 steps done — guidance stays null, nothing to show.

  return { steps, guidance };
}

module.exports = { buildCustomerProtectionSteps, hasProvisionedNumber };
