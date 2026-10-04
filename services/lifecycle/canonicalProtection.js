// Canonical customer protection status (soft-launch integration 2026-10-04,
// brief §6 B7; lifecycle doc §5 step 1).
//
// ONE authoritative answer to "is this customer actually protected?":
// services/lifecycle/activationState.js deriveActivationState (every gate in
// PROTECTION_GATES: account active, state known, entitled now, not on a
// Fortress financial hold, number active, number not quarantined, forwarding
// and delivery evidence for the CURRENT number, app reachable).
//
// Backward compatible: the response keeps the existing `protection` shape
// (forwardingVerified / deliveryReady / endToEndDeliveryVerified /
// fullyProtected) that the web dashboard and every shipped app build read,
// so they become strict WITHOUT an app release. Rules:
//   - fullyProtected     = legacy && activation.protected (can only narrow);
//   - forwardingVerified / endToEndDeliveryVerified = legacy && evidence is
//     for the CURRENT number (old-number proof no longer counts — P-3);
//   - deliveryReady      = legacy (unchanged);
//   - activationStage / protectionBlockers are ADDITIVE machine codes (no
//     customer wording is invented here — copy for e.g. on_hold is decision D-C5).
// Fail closed: if the lifecycle facts cannot be loaded, fullyProtected is
// false ("never a guess of protected") and activationStage = 'unavailable'.
'use strict';

const { computeProtectionStatus } = require('../callRouting');
const { deriveActivationState } = require('./activationState');

function mergeProtection(legacy, activation) {
  if (!activation) {
    return { ...legacy, fullyProtected: false, activationStage: 'unavailable', protectionBlockers: ['stateKnown'] };
  }
  return {
    forwardingVerified: legacy.forwardingVerified && activation.gates.forwardingVerifiedForCurrentNumber === true,
    deliveryReady: legacy.deliveryReady,
    endToEndDeliveryVerified: legacy.endToEndDeliveryVerified && activation.gates.deliveryVerifiedForCurrentNumber === true,
    fullyProtected: legacy.fullyProtected === true && activation.protected === true,
    activationStage: activation.stage,
    protectionBlockers: activation.blockers.slice(),
  };
}

/**
 * @param {object} opts
 * @param {object} opts.supabase       service-role client
 * @param {object} opts.household      the authenticated household row
 * @param {object|null} opts.deliveryHealth
 * @param {Date} [opts.now]
 * @param {Function} [opts.loadSnapshots]  injectable (tests)
 * @returns {Promise<{ protection: object, activation: object|null }>}
 */
async function resolveCanonicalProtection({ supabase, household, deliveryHealth = null, now = new Date(), loadSnapshots = null, log = console.error }) {
  const legacy = computeProtectionStatus(household, now, deliveryHealth);
  let activation = null;
  try {
    const load = loadSnapshots || require('../../database/lifecycleSnapshot').loadLifecycleSnapshots;
    const { snapshots } = await load({ supabase, householdId: household && household.id });
    const snap = (snapshots || []).find((s) => s.household && household && s.household.id === household.id);
    if (!snap) throw new Error('household snapshot not found');
    activation = deriveActivationState({ ...snap, deliveryHealth }, now);
  } catch (err) {
    log('CANONICAL PROTECTION UNAVAILABLE (fail closed: not shown as protected):', err.message);
  }
  return { protection: mergeProtection(legacy, activation), activation };
}

module.exports = { resolveCanonicalProtection, mergeProtection };
