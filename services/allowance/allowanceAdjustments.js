// allowanceAdjustments.js — administrative allowance adjustments (goodwill
// minutes, corrections) with a mandatory audit trail (customer allowance
// workstream, 2026-10-03). Written through the same credit_allowance RPC
// as paid top-ups (063): one row per adjustment in allowance_credits with
// the admin's identity and reason, applied to the CURRENT period only, and
// idempotent per admin-supplied key (a double-click or retried request
// applies once).
'use strict';

const { resolveEntitlementPeriod } = require('../usage/billingPeriod');
const { resolveEconomics } = require('./productCatalog');

const MAX_ADJUSTMENT_MINUTES = 1000;

function validateAdjustment({ minutes, reason, idempotencyKey }, env = process.env) {
  const max = Number(env.ALLOWANCE_ADMIN_MAX_ADJUSTMENT_MINUTES) > 0 ? Number(env.ALLOWANCE_ADMIN_MAX_ADJUSTMENT_MINUTES) : MAX_ADJUSTMENT_MINUTES;
  const m = Number(minutes);
  if (!Number.isInteger(m) || m === 0 || Math.abs(m) > max) return `minutes must be a non-zero whole number between -${max} and ${max}`;
  if (typeof reason !== 'string' || reason.trim().length < 3 || reason.length > 500) return 'a reason (3–500 characters) is required';
  if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9-]{8,80}$/.test(idempotencyKey)) return 'idempotencyKey (8–80 letters, digits or dashes) is required';
  return null;
}

async function applyAdminAdjustment({ householdId, actor, minutes, reason, idempotencyKey }, { deps, now = new Date(), env = process.env }) {
  const problem = validateAdjustment({ minutes, reason, idempotencyKey }, env);
  if (problem) return { ok: false, error: problem };
  if (!actor) return { ok: false, error: 'actor required' };
  const entitlement = await deps.getActiveEntitlement(householdId);
  if (!entitlement) return { ok: false, error: 'household has no active entitlement' };
  const subscription = entitlement.source === 'stripe' ? await deps.getSubscriptionByHouseholdId(householdId) : null;
  const period = resolveEntitlementPeriod({ entitlement, subscription, now });
  const result = await deps.creditAllowance({
    householdId, periodStart: period.periodStart, periodEnd: period.periodEnd,
    kind: 'admin_adjustment', seconds: Number(minutes) * 60, source: 'admin', environment: 'production',
    // Integration 2026-10-03 (migration 068): the same £ capacity Fortress
    // enforces moves with the minutes (signed; cost per top-up minute), so an
    // admin goodwill credit is funded — and a correction is clawed back — in £.
    budgetGbp: Math.trunc(Number(minutes) * resolveEconomics(env).costPerMinuteGbp * 1e4) / 1e4,
    transactionId: `admin:${idempotencyKey}`, actor, reason: reason.trim(), allowNonProduction: false,
  });
  return { ok: true, ...result };
}

module.exports = { validateAdjustment, applyAdminAdjustment, MAX_ADJUSTMENT_MINUTES };
