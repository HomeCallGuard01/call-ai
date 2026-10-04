// economicsConsistency.js — finds contradictions between the authoritative
// register (economicsRegister.js), the runtime cost rates actually in effect
// (costModel.js, incl. SAFETY_COST_* overrides) and the commercial
// placeholders (plan minutes, Fortress £ seeds). Pure. Reports; decides
// nothing. Consumed by commercialConfigValidation.js (boot log + admin view).
//
//   error   — limits would silently UNDER-count HCG's real cost
//   warning — two configured figures cannot both be true / be kept
//   info    — a deliberate-looking difference made visible
'use strict';

const register = require('./economicsRegister');
const model = require('./hcgUnitEconomics');
const { resolveCostRates } = require('../usage/costModel');

const EPS = 1e-9;
const g = (n) => `£${n.toFixed(4)}`;

function checkEconomicsConsistency({ env = process.env, profiles = null } = {}) {
  const findings = [];
  const add = (severity, code, detail) => findings.push({ severity, code, detail });
  const billed = register.rates({ basis: 'expected' });
  const live = resolveCostRates(env);

  // 1. Runtime enforcement rates must never be below what the provider bills.
  for (const [name, liveRate, billedRate] of [
    ['inbound', live.inboundPerMin, billed.inboundPerMin],
    ['media stream', live.mediaStreamPerMin, billed.mediaStreamPerMin],
    ['transcription', live.transcriptionPerMin, billed.transcriptionPerMin],
    ['SMS', live.smsPerSegment, billed.smsPerSegment],
  ]) {
    if (liveRate + EPS < billedRate) add('error', 'enforcement_rate_below_billed_rate', `${name}: limits use ${g(liveRate)} but the register's billed rate is ${g(billedRate)} — every limit under-counts`);
  }

  // 2. Fortress £ seeds vs the plan minutes promised (enforcement basis, as the Fortress charges).
  const enforcementMonitored = model.minuteCosts({ basis: 'enforcement' }).monitoredPerMin;
  const minutes = register.value('planAllowanceMinutes');
  const seed = register.value('fortressSeedBudgetGbp');
  for (const plan of Object.keys(minutes)) {
    const p = Array.isArray(profiles) ? profiles.find((r) => r.profile === plan) : null;
    const budgetGbp = p ? Number(p.period_budget_gbp) : seed.budget;
    const need = minutes[plan] * enforcementMonitored;
    if (need > budgetGbp + EPS) {
      add('warning', 'plan_minutes_unfundable', `${plan}: ${minutes[plan]} monitored minutes need ≈ ${g(need)} of Fortress budget (enforcement basis) but the ${p ? 'database' : 'seeded'} budget is ${g(budgetGbp)} — the minutes promise cannot be kept`);
    }
  }

  // 3. Basis mismatch: a £ figure derived from billed cost funds fewer minutes under the Fortress.
  const e = model.minuteCosts({ basis: 'expected' });
  const f = model.minuteCosts({ basis: 'enforcement' });
  add('info', 'enforcement_basis_premium', `the Fortress charges a trusted minute at ${(f.trustedPerMin / e.trustedPerMin).toFixed(2)}× and a monitored minute at ${(f.monitoredPerMin / e.monitoredPerMin).toFixed(2)}× what HCG is billed today (app leg at list + ${register.value('fortressEstimateUplift')} uplift); convert with hcgUnitEconomics.fortressEquivalent before setting a profile`);

  // 4. economicPolicy's "worst channel" is 15%; Apple 30% applies until SBP enrolment is confirmed.
  if (register.value('appleSmallBusinessEnrolled') !== true) {
    const apple30 = model.budget({ channel: 'apple30' }).safeVariableBudget;
    const store15 = model.budget({ channel: 'apple15' }).safeVariableBudget;
    add('warning', 'apple_commission_unconfirmed', `Apple Small Business Program enrolment is UNKNOWN: at 30% the safe variable budget is ${g(apple30)} vs ${g(store15)} at 15% (economicPolicy's envelope assumes 15%)`);
  }

  // 5. Two different safety reserves.
  const planR = register.value('planSafetyReserveRatio');
  const topR = register.value('topUpSafetyReserveRatio');
  if (Math.abs(planR - topR) > EPS) add('info', 'reserve_ratios_differ', `plan reserve ${planR} (economicPolicy) ≠ top-up reserve ${topR} (productCatalog)`);

  // 6. The safe budget vs an external usage anchor.
  const stripeSafe = model.budget({ channel: 'stripe' }).safeVariableBudget;
  const trustedMinutes = Math.floor(stripeSafe / e.trustedPerMin);
  const anchor = register.value('ofcomAverageOutgoingMinutesPerMonth');
  if (trustedMinutes < anchor) add('warning', 'safe_budget_below_average_use', `at £${register.value('priceIncVatGbp')} the best channel's safe budget buys ${trustedMinutes} trusted minutes/month, below the Ofcom average of ${anchor} outgoing minutes (HCG pays for every forwarded incoming minute)`);

  return {
    registerVersion: register.REGISTER.version,
    ok: !findings.some((x) => x.severity === 'error'),
    findings,
  };
}

module.exports = { checkEconomicsConsistency };
