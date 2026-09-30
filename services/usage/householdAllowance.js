// householdAllowance.js — reads a household's current monitored allowance
// for the customer dashboards (mobile /api/v1/me/dashboard and web
// /dashboard-data), so both show identical numbers and the same honest
// monitoring state (allowanceStatus.js). Never throws.
//
// If usage can't be read, the result is state 'unavailable' with
// monitoringActive: null — never a guess of "active".
'use strict';

const { resolvePlanForEntitlement } = require('./plans');
const { resolveEntitlementPeriod } = require('./billingPeriod');
const { computeAllowanceStatus } = require('./allowanceStatus');
const { resolveSafetyConfig } = require('./safetyConfig');

const KIND_POINT = { warn_75: 75, warn_90: 90, exhausted_100: 100 };

async function getHouseholdAllowance({ household, entitlement, subscription = null, deps, now = new Date(), env = process.env }) {
  const plan = resolvePlanForEntitlement(entitlement, env);
  const period = resolveEntitlementPeriod({ entitlement, subscription, now });
  const day = now.toISOString().slice(0, 10);
  const config = resolveSafetyConfig(env);

  try {
    const [usage, dayUsage, safetyState, claims] = await Promise.all([
      deps.getUsagePeriod({ householdId: household.id, periodStart: period.periodStart }),
      deps.getHouseholdDayUsage({ householdId: household.id, day }),
      deps.getSafetyState(),
      deps.getClaimedNotifications ? deps.getClaimedNotifications({ householdId: household.id, periodStart: period.periodStart }) : [],
    ]);
    const periodMonitoringCost = usage ? Number(usage.monitoring_cost_gbp) : 0;
    const dayMonitoringCost = dayUsage ? Number(dayUsage.monitoring_cost_gbp) : 0;
    const safetyPaused =
      config.emergencyDisabled ||
      Boolean(safetyState && safetyState.monitoring_suspended) ||
      dayMonitoringCost >= config.dailyMonitoringCostLimitGbp ||
      periodMonitoringCost >= config.periodMonitoringCostLimitGbp;
    const points = (claims || []).map((c) => KIND_POINT[c.kind]).filter(Boolean);
    return computeAllowanceStatus({
      plan,
      usedSeconds: usage ? Number(usage.monitored_seconds) : 0,
      bonusSeconds: usage ? Number(usage.bonus_monitored_seconds) : 0,
      periodStart: period.periodStart,
      periodEnd: period.periodEnd,
      safetyPaused,
      lastWarningPoint: points.length ? Math.max(...points) : null,
    });
  } catch {
    return computeAllowanceStatus({ plan, usedSeconds: 0, periodStart: period.periodStart, periodEnd: period.periodEnd, readFailed: true });
  }
}

module.exports = { getHouseholdAllowance };
