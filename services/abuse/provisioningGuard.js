'use strict';

// Telephony abuse P0 — number purchase safety.
//
// Wraps the ONE provider purchase path (services/twilioProvisioning.js
// ensureTwilioNumberProvisioned). Guarantees, in order:
//
//   1. single-flight     one in-flight purchase per household per process;
//                        concurrent callers (double-tapped reconcile, webhook
//                        + reconcile, RevenueCat + Stripe) share ONE result
//                        instead of each buying a number. Cross-instance
//                        exclusivity needs the DB claim in the provisional
//                        migration (claimProvisioning port).
//   2. incident mode     no purchases in contain/suspend/full_stop, and none
//                        when the breaker state cannot be read (fail closed).
//   3. global velocity   per-hour / per-day purchase ceilings (process-local).
//   4. account risk      accountRisk.evaluateProvisioning → hold before buying.
//   5. provider-side     every number is bought with friendlyName
//      idempotency       `hcg-hh-<householdId>`; before buying, the account is
//                        searched for that tag and an existing, unassigned
//                        number is ADOPTED instead of buying another. This is
//                        what makes "create timed out but actually succeeded"
//                        and "bought but DB assign failed" safe to retry.
//   6. response check    the purchased number must be the requested one and a
//                        UK geographic number (numberPolicy PROVISIONED_NUMBER);
//                        otherwise it is released immediately, never assigned.

const { evaluateNumberForPurpose, PURPOSES } = require('./numberPolicy');
const { ACTIONS } = require('./incidentMode');

const TAG_PREFIX = 'hcg-hh-';
const HOUR = 60 * 60 * 1000;

function friendlyNameFor(householdId) {
  return `${TAG_PREFIX}${householdId}`;
}

/**
 * @param {object} deps
 * @param {object} deps.config
 * @param {object} deps.incident
 * @param {object} deps.velocity
 * @param {object} deps.audit
 * @param {object} deps.accountRisk
 * @param {(householdId: string, ttlMs: number) => Promise<boolean>} [deps.claimProvisioning]  cross-instance claim PORT
 * @param {(householdId: string) => Promise<string|null>} [deps.entitlementSource]
 * @param {(type, message, ctx) => void} [deps.alert]
 */
function createProvisioningGuard(deps) {
  const { config, incident, velocity, audit, accountRisk } = deps;
  const alert = deps.alert || (() => {});
  const inFlight = new Map(); // householdId -> Promise

  function hold(reasonCode, household, facts = {}, severity = 'warning') {
    audit.record({ reasonCode, action: 'hold', kind: 'number_purchase', householdId: household.id, facts, severity });
    return { allowed: false, reason: reasonCode };
  }

  /** Pre-purchase admission. Does not consume velocity — call noteSuccessfulPurchase() after a real purchase. */
  async function admit(household, { override = null } = {}) {
    const inc = await incident.check(ACTIONS.PROVISION_NUMBER);
    if (!inc.allowed) return hold(inc.reason, household, { level: inc.level }, 'critical');

    const perHour = velocity.count('purchase:global:hour', HOUR);
    const perDay = velocity.count('purchase:global:day', 24 * HOUR);
    if (perHour >= config.maxPurchasesGlobalPerHour || perDay >= config.maxPurchasesGlobalPerDay) {
      incident.trip('provisioning_velocity', config.incidentAutoTripMs);
      alert('abuse_provisioning_velocity', `Number purchases at the global ceiling (${perHour}/h, ${perDay}/day) — purchases held, contain mode`, { perHour, perDay });
      return hold('global_purchase_velocity', household, { perHour, perDay }, 'critical');
    }

    if (override !== 'admin') {
      const source = typeof deps.entitlementSource === 'function' ? await deps.entitlementSource(household.id).catch(() => null) : null;
      const risk = await accountRisk.evaluateProvisioning(household, { entitlementSource: source });
      if (risk.decision !== 'allow') {
        alert('abuse_provisioning_hold', 'A number purchase was held for review (multi-account / repeat-provisioning signals)', { householdId: household.id, reasons: risk.reasons.join(',') });
        // Integration 2026-10-04: repeated number provisioning (buy → abandon →
        // repeat) also places the household under a Fortress financial hold.
        // Softer signals (shared phone / email base) stay provisioning-only.
        if (risk.reasons.includes('repeated_number_provisioning') && typeof deps.onFraudHold === 'function') {
          await Promise.resolve(deps.onFraudHold(household.id, 'automatic: repeated number provisioning (buy, abandon, repeat)')).catch((err) =>
            alert('abuse_fraud_hold_failed', 'Could not place the automatic financial hold', { householdId: household.id, error: String(err && err.message || err).slice(0, 120) }));
        }
        return hold('account_risk_hold', household, { reasons: risk.reasons.join(','), signalsAvailable: Object.entries(risk.signals).filter(([, v]) => v && v.available).map(([k]) => k).join(',') });
      }
    } else {
      audit.record({ reasonCode: 'account_risk_admin_override', action: 'allow_flagged', kind: 'number_purchase', householdId: household.id, facts: {} });
    }

    if (typeof deps.claimProvisioning === 'function') {
      const claimed = await deps.claimProvisioning(household.id, 5 * 60 * 1000).catch(() => null);
      if (claimed !== true) return hold(claimed === false ? 'provisioning_claimed_elsewhere' : 'provisioning_claim_unavailable', household, {});
    }
    return { allowed: true, reason: null };
  }

  function noteSuccessfulPurchase() {
    velocity.hit('purchase:global:hour', HOUR);
    velocity.hit('purchase:global:day', 24 * HOUR);
  }

  /** Run `fn` at most once concurrently per household; concurrent callers share the result. */
  function singleFlight(householdId, fn) {
    if (inFlight.has(householdId)) {
      audit.record({ reasonCode: 'concurrent_purchase_coalesced', action: 'suppress', kind: 'number_purchase', householdId, facts: {} });
      return inFlight.get(householdId);
    }
    const p = Promise.resolve().then(fn).finally(() => inFlight.delete(householdId));
    inFlight.set(householdId, p);
    return p;
  }

  /** Validate what the provider says it sold us. */
  function checkPurchased(requested, purchased) {
    if (!purchased || typeof purchased.phoneNumber !== 'string') return 'provider_response_missing_number';
    if (requested && purchased.phoneNumber !== requested) return 'provider_number_mismatch';
    const verdict = evaluateNumberForPurpose(PURPOSES.PROVISIONED_NUMBER, purchased.phoneNumber, { denyPrefixes: [] });
    if (!verdict.allowed) return `provider_number_${verdict.reason}`;
    return null;
  }

  return { admit, singleFlight, noteSuccessfulPurchase, checkPurchased, friendlyNameFor, TAG_PREFIX };
}

/** Read-only: tagged numbers on the provider account not assigned to any household (orphans). */
async function findOrphanedTaggedNumbers(client, assignedNumbers) {
  const assigned = new Set(assignedNumbers || []);
  const all = await client.incomingPhoneNumbers.list({ limit: 1000 });
  return all
    .filter((n) => typeof n.friendlyName === 'string' && n.friendlyName.startsWith(TAG_PREFIX) && !assigned.has(n.phoneNumber))
    .map((n) => ({ sid: n.sid, phoneNumber: n.phoneNumber, householdId: n.friendlyName.slice(TAG_PREFIX.length) }));
}

module.exports = { createProvisioningGuard, findOrphanedTaggedNumbers, friendlyNameFor, TAG_PREFIX };
