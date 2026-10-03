// planSync.js — keeps entitlements.plan_code in step with the subscription
// product the customer actually pays for (customer allowance workstream,
// 2026-10-03). This is the whole "higher plan" mechanism: Fortress already
// sizes the allowance from plan_code (plans.js / 056), so a higher tier
// needs only (1) a plan in plans.js, (2) a store/Stripe product, and
// (3) a PLAN_PRODUCT_MAP entry. No second architecture.
//
// NO-OP until PLAN_PRODUCT_MAP is configured (today nothing is on sale
// above Standard). Once configured, an unmapped product means Standard, so
// a downgrade or an unknown product can never keep a larger allowance.
// Called only from verified webhooks, after the entitlement was written.
// Never throws (best effort; the next renewal event retries it).
'use strict';

const { planCodeForProduct } = require('./productCatalog');
const { PLAN_DEFAULTS, DEFAULT_PLAN_CODE } = require('../usage/plans');

function mapConfigured(env) {
  try { const m = JSON.parse(env.PLAN_PRODUCT_MAP || '{}'); return m && typeof m === 'object' && Object.keys(m).length > 0; } catch { return false; }
}

async function syncPlanCode({ householdId, source, providerProductId, setPlanCode, env = process.env, log = console }) {
  if (!householdId || !mapConfigured(env)) return { changed: false, reason: 'not_configured' };
  const planCode = planCodeForProduct(providerProductId, env, Object.keys(PLAN_DEFAULTS)) || DEFAULT_PLAN_CODE;
  try {
    const changed = await setPlanCode({ householdId, planCode, source });
    if (changed) log.log('PLAN CODE SYNCED', { householdId, planCode });
    return { changed, planCode };
  } catch (err) {
    log.error('PLAN CODE SYNC FAILED:', err.message);
    return { changed: false, error: err.message };
  }
}

module.exports = { syncPlanCode };
