// Abandoned-number retirement planner (customer lifecycle automation,
// 2026-10-04).
//
// The release path is: membership ends → 30-day grace → quarantine → a
// HUMAN confirms deactivation → the daily runner releases at the provider.
// Nothing ever moves an unconfirmed quarantine row forward (037 header), and
// the confirm route has no admin UI, so every abandoned number is billed
// until Andrew acts. This planner says, per quarantined number, what the next
// step is, what it costs to keep waiting, and whether an (approved) policy
// would let it proceed automatically.
//
// It never confirms anything. `autoConfirmAfterDays` defaults to null =
// "no automatic confirmation" (today's policy). Setting it is a decision:
// confirming releases a number the ex-customer's carrier may still divert
// to, so their calls would fail rather than reach HCG (doc §8, D-N2).
// When a policy is set, the plan output is what a future job would act on —
// through the existing audited confirm path, never a new provider call.
'use strict';

const { DAY_MS, parseTimestampMs, isCurrentlyEntitled, isUpcomingEntitlement } = require('../numberLifecycle/state');

/**
 * @param {object[]} rows  unreleased twilio_number_quarantine rows, each optionally
 *                         carrying `entitlements` (for its household) and `householdDeleted`
 * @param {{ now, autoConfirmAfterDays?: number|null, monthlyNumberCostGbp?: number|null }} opts
 */
function planQuarantineActions(rows, { now, autoConfirmAfterDays = null, monthlyNumberCostGbp = null } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const plans = [];
  for (const q of rows || []) {
    if (q.released_at) continue;
    const quarantinedMs = parseTimestampMs(q.quarantined_at);
    const ageDays = quarantinedMs === null ? null : (nowMs - quarantinedMs) / DAY_MS;
    const ents = q.entitlements || [];
    const entitled = ents.some((e) => isCurrentlyEntitled(e, nowMs) || isUpcomingEntitlement(e, nowMs));
    const unknownStatus = ents.some((e) => !['scheduled', 'active', 'expired', 'revoked'].includes(e.status));
    let next;
    let autoEligible = false;
    if (unknownStatus) next = 'blocked_ambiguous_entitlement';
    else if (entitled) next = 'reinstate_or_investigate'; // never confirm a number of an entitled household
    else if (q.deactivation_confirmed) next = 'awaiting_provider_release'; // the daily runner owns it
    else if (!q.household_id) next = 'manual_confirmation_no_route';
    else {
      next = 'awaiting_human_confirmation';
      autoEligible = autoConfirmAfterDays !== null && ageDays !== null && ageDays >= autoConfirmAfterDays;
    }
    const accruedGbp = monthlyNumberCostGbp === null || ageDays === null ? null : Math.round(monthlyNumberCostGbp * (ageDays / 30) * 100) / 100;
    plans.push({
      quarantineId: q.id || null,
      householdId: q.household_id || null,
      twilioNumber: q.twilio_number,
      reason: q.release_reason || null,
      ageDays: ageDays === null ? null : Math.floor(ageDays),
      next,
      autoConfirmEligible: autoEligible,
      householdDeleted: !!q.householdDeleted,
      costSinceQuarantineGbp: accruedGbp,
    });
  }
  const awaiting = plans.filter((p) => p.next === 'awaiting_human_confirmation' || p.next === 'manual_confirmation_no_route');
  return {
    policy: { autoConfirmAfterDays, monthlyNumberCostGbp },
    plans,
    summary: {
      unreleased: plans.length,
      awaitingConfirmation: awaiting.length,
      autoConfirmEligible: plans.filter((p) => p.autoConfirmEligible).length,
      monthlyCostOfWaitingGbp: monthlyNumberCostGbp === null ? null : Math.round(awaiting.length * monthlyNumberCostGbp * 100) / 100,
    },
  };
}

module.exports = { planQuarantineActions };
