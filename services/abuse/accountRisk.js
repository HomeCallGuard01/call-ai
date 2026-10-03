'use strict';

// Telephony abuse P0 — multi-account / mass-provisioning risk.
//
// Evaluated BEFORE HCG buys a phone number for a household (the first
// resource that costs HCG money regardless of usage). The answer is
// 'allow' or 'hold'; a hold buys nothing, is audited and alerted, and an
// admin can release it (routes/admin.js retry-provisioning with override).
//
// Only signals the system ACTUALLY has are scored. Signals it does not
// have are defined as ports and documented, never invented:
//
//   AVAILABLE NOW (households table / quarantine history)
//     - customer phone number already used by another household
//     - normalised email base reused (gmail dots, +tags, case)
//     - previous numbers for this household in 30 days (buy → abandon → repeat)
//     - provisioning failure count (failed-payment / retry loops)
//     - entitlement source (complimentary / trial are free to the attacker)
//
//   PORTS — NOT CURRENTLY COLLECTED (see threat model §5)
//     - paymentFingerprint (Stripe card.fingerprint — needs webhook expansion)
//     - signupNetwork (registration IP — not stored; X-Forwarded-For is only
//       trustworthy at Railway's last hop, needs `trust proxy` configured)
//     - deviceId (the app sends none; deliberately NOT adding device
//       fingerprinting without a privacy decision)
//
// No signal on its own is proof; the thresholds hold for human review
// rather than refuse permanently.

const { canonicalKey } = require('./numberPolicy');

const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

function normaliseEmailBase(email) {
  if (typeof email !== 'string') return null;
  const s = email.normalize('NFKC').trim().toLowerCase();
  const at = s.lastIndexOf('@');
  if (at <= 0 || at === s.length - 1) return null;
  let local = s.slice(0, at);
  let domain = s.slice(at + 1);
  local = local.split('+')[0];
  if (GMAIL_DOMAINS.has(domain)) { local = local.replace(/\./g, ''); domain = 'gmail.com'; }
  if (!local) return null;
  return `${local}@${domain}`;
}

/**
 * @param {object} deps
 * @param {object} deps.config
 * @param {(phoneE164: string, excludeHouseholdId: string) => Promise<number>} [deps.countHouseholdsWithPhone]
 * @param {(emailBase: string, excludeHouseholdId: string) => Promise<number>} [deps.countHouseholdsWithEmailBase]
 * @param {(householdId: string) => Promise<number>} [deps.countRecentNumbersForHousehold]
 * @param {(householdId: string) => Promise<string|null>} [deps.paymentFingerprint]   PORT — not implemented
 * @param {(fingerprint: string) => Promise<number>} [deps.countHouseholdsWithPaymentFingerprint] PORT
 */
function createAccountRisk(deps) {
  const { config } = deps;

  async function signal(fn, ...args) {
    if (typeof fn !== 'function') return { available: false, value: null };
    try { return { available: true, value: await fn(...args) }; } catch { return { available: false, value: null, error: true }; }
  }

  /**
   * @param {object} household  households row
   * @param {object} [ctx]      { entitlementSource }
   * @returns {Promise<{decision: 'allow'|'hold', reasons: string[], signals: object}>}
   */
  async function evaluateProvisioning(household, ctx = {}) {
    const reasons = [];
    const signals = {};
    const phone = canonicalKey(household.phone_number);
    if (phone) {
      const s = await signal(deps.countHouseholdsWithPhone, phone, household.id);
      signals.sharedPhone = s;
      if (s.available && s.value >= config.maxHouseholdsPerPhoneNumber) reasons.push('phone_number_shared_with_other_household');
    }
    const emailBase = normaliseEmailBase(household.email);
    if (emailBase) {
      const s = await signal(deps.countHouseholdsWithEmailBase, emailBase, household.id);
      signals.emailBase = s;
      if (s.available && s.value >= config.maxSignupsPerNormalisedEmailBase) reasons.push('email_base_reused');
    }
    const prior = await signal(deps.countRecentNumbersForHousehold, household.id);
    signals.priorNumbers = prior;
    if (prior.available && prior.value >= config.maxPurchasesPerHouseholdPer30d) reasons.push('repeated_number_provisioning');
    if (!prior.available) reasons.push('provisioning_history_unavailable');
    const failures = Number(household.twilio_provisioning_attempts || 0);
    signals.failures = failures;
    const fp = await signal(deps.paymentFingerprint, household.id);
    if (fp.available && fp.value) {
      const n = await signal(deps.countHouseholdsWithPaymentFingerprint, fp.value);
      signals.paymentFingerprint = { available: n.available, value: n.value };
      if (n.available && n.value >= 2) reasons.push('payment_instrument_reused');
    } else {
      signals.paymentFingerprint = { available: false, value: null };
    }
    // Free entitlements cost the attacker nothing — combine with any other signal.
    const free = ['complimentary', 'trial', 'trialing'].includes(String(ctx.entitlementSource || '').toLowerCase());
    signals.freeEntitlement = free;
    if (free && reasons.length) reasons.push('free_entitlement_with_risk_signal');

    return { decision: reasons.length ? 'hold' : 'allow', reasons, signals };
  }

  return { evaluateProvisioning };
}

module.exports = { createAccountRisk, normaliseEmailBase };
