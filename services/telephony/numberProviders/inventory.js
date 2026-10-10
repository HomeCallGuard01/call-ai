'use strict';

// Inventory number assignment (NUMBER_PROVIDER=magrathea) — WS6, 2026-10-11.
//
// Replaces "search + buy a Twilio number" with "claim one DDI from the
// manually maintained inventory (migration 078) and assign it to the
// household". No provider API is called. The SAME gates as a purchase run
// first, in the same order and with the same fail-closed semantics
// (services/twilioProvisioning.js purchaseTwilioNumber):
//
//   (abuse guard single-flight + admit — done by the caller)
//   1. entitlement provenance  sandbox/test entitlements never get a number;
//                              unreadable ⇒ refused (not a failure).
//   2. Fortress authorisation  authorizeNumberPurchase (company-wide daily cap,
//                              breaker, kill switch): an inventory DDI is a
//                              committed monthly rental, so it is authorised
//                              exactly like a purchase. Unavailable ⇒ refused.
//   3. claim                   DB-enforced: UK 01/02/03 only, one per household
//                              (idempotent), never a held/quarantined number,
//                              cooling-off after release.
//   4. policy re-check         the claimed DDI must parse as UK geographic or
//                              UK-wide 03; otherwise it is returned, never
//                              assigned.
//   5. assign                  households.twilio_number (provider-neutral
//                              column). Assignment outcome unknown ⇒ the DDI
//                              stays claimed (never handed to someone else)
//                              and a critical alert is raised.

const { parsePhoneNumber, CLASSES } = require('../../abuse/numberPolicy');

const INVENTORY_NUMBER_CLASSES = Object.freeze([CLASSES.UK_GEOGRAPHIC, CLASSES.UK_NON_GEOGRAPHIC_03]);

function isPermittedInventoryNumber(e164) {
  const p = parsePhoneNumber(e164);
  return Boolean(p.e164 && p.e164 === e164 && INVENTORY_NUMBER_CLASSES.includes(p.class));
}

async function provisionFromInventory(household, deps) {
  const {
    providerCode = 'magrathea',
    claim,
    giveBack,
    assign,
    readHouseholdNumber,
    recordFailure,
    sendAlert = async () => {},
    readActiveEntitlements = null,
    decideProvenance = null,
    authorizeNumberPurchase = null,
    guard = null,
    abuseOverride = null,
    newAttemptKey = () => require('crypto').randomUUID(),
  } = deps;
  const tag = `NUMBER INVENTORY (${providerCode})`;
  const fail = async (message) => {
    await Promise.resolve(recordFailure(household.id, message)).catch((err) => console.error(`${tag} FAILURE-RECORD ERROR:`, err.message));
    return { attempted: true, success: false, provider: providerCode, error: message };
  };

  if (typeof claim !== 'function' || typeof assign !== 'function' || typeof recordFailure !== 'function') {
    return { attempted: false, held: true, provider: providerCode, reason: 'inventory_not_configured' };
  }

  // 1. entitlement provenance (fail closed; not a provisioning failure)
  if (readActiveEntitlements && decideProvenance) {
    let provenance;
    try {
      provenance = decideProvenance(await readActiveEntitlements(household.id), { adminOverride: abuseOverride });
    } catch (err) {
      provenance = { allowed: false, reason: `entitlement_provenance_unreadable: ${err.message}` };
    }
    if (!provenance.allowed) {
      console.error(`${tag} REFUSED BY ENTITLEMENT PROVENANCE:`, household.id, provenance.reason);
      Promise.resolve().then(() => sendAlert('number_inventory_refused_provenance', `Inventory number assignment refused: ${provenance.reason}`, { householdId: household.id, reason: provenance.reason })).catch(() => {});
      return { attempted: true, success: false, provider: providerCode, provenanceRefused: true, error: `number assignment refused: ${provenance.reason}` };
    }
  }

  // 2. Fortress authorisation (fail closed; not a provisioning failure)
  if (authorizeNumberPurchase) {
    const auth = await Promise.resolve(authorizeNumberPurchase({ householdId: household.id, attemptKey: newAttemptKey() }))
      .catch((err) => ({ allowed: false, reason: `authorization_error: ${err.message}` }));
    if (!auth || !auth.allowed) {
      const reason = (auth && auth.reason) || 'authorization_unavailable';
      console.error(`${tag} REFUSED BY FINANCIAL CONTAINMENT:`, household.id, reason);
      Promise.resolve().then(() => sendAlert('number_inventory_refused_containment', `Inventory number assignment not authorised: ${reason}`, { householdId: household.id, reason })).catch(() => {});
      return { attempted: true, success: false, provider: providerCode, containmentRefused: true, error: `number assignment not authorised: ${reason}` };
    }
  }

  // 3. claim
  let number;
  try {
    number = await claim(household.id, providerCode);
  } catch (err) {
    console.error(`${tag} CLAIM FAILED:`, household.id, err.message);
    sendAlert('number_inventory_unavailable', `Number inventory unreadable: ${err.message}`, { householdId: household.id }).catch(() => {});
    return fail(`inventory claim failed: ${err.message}`);
  }
  if (!number) {
    console.error(`${tag} EXHAUSTED: no claimable number`, household.id);
    sendAlert('number_inventory_exhausted', 'The number inventory has no claimable number — order DDIs, route them to the BYOC trunk and add them to number_inventory', { householdId: household.id, providerCode }).catch(() => {});
    return fail('number inventory exhausted');
  }

  const giveBackSafely = async (why) => {
    if (typeof giveBack !== 'function') return false;
    return Promise.resolve(giveBack(number, household.id)).catch((err) => {
      console.error(`${tag} RETURN FAILED (${why}):`, err.message);
      return false;
    });
  };

  // 4. policy re-check (defence in depth over the 078 CHECK constraint)
  if (!isPermittedInventoryNumber(number)) {
    await giveBackSafely('policy');
    sendAlert('number_inventory_policy_violation', 'An inventory number is not a UK geographic/03 E.164 number — not assigned; fix the inventory row', { householdId: household.id }).catch(() => {});
    return fail('inventory number not permitted');
  }

  // 5. assign
  let assigned;
  try {
    assigned = await assign(household.id, number);
  } catch (assignErr) {
    let holder;
    try { holder = await readHouseholdNumber(household.id); } catch { holder = undefined; }
    if (holder === number) {
      if (guard) guard.noteSuccessfulPurchase();
      return { attempted: true, success: true, provider: providerCode, twilioNumber: number, assignErrorRecovered: true };
    }
    if (holder !== undefined) {
      await giveBackSafely('assign_failed');
      return fail(`assignment failed; inventory number returned: ${assignErr.message}`);
    }
    sendAlert('number_inventory_assign_unknown', 'An inventory number was claimed but its assignment outcome is unknown — kept claimed for this household; verify and reconcile', { householdId: household.id }).catch(() => {});
    return fail(`assignment outcome unknown; inventory number kept claimed: ${assignErr.message}`);
  }
  if (!assigned) {
    // The household already holds a (different) number: release the claim.
    await giveBackSafely('race');
    return { attempted: true, success: false, provider: providerCode, error: 'race: household already provisioned' };
  }
  if (guard) guard.noteSuccessfulPurchase(); // counts toward the global provisioning velocity ceilings
  console.log(`${tag} ASSIGNED:`, household.id);
  return { attempted: true, success: true, provider: providerCode, twilioNumber: number };
}

module.exports = { INVENTORY_NUMBER_CLASSES, isPermittedInventoryNumber, provisionFromInventory };
