// economicPolicy.js — derives the SUGGESTED HCG-funded variable budget per
// customer per month from commercial inputs, and checks a configured budget
// profile against it. Advisory: the authoritative budget lives in the
// database (fc_budget_profiles) and changes only through the audited
// fc_set_budget_profile. Keeping the economics separate from enforcement
// means a price, VAT, fee or carrier change is a recalculation + one audited
// policy change, never a code change.
//
// The delivery-cost ceiling (e.g. 60% of net revenue) is NOT the allowance:
// fixed per-customer costs and a safety reserve come out of it first.
//
//   net            = price / (1 + VAT)
//   ceiling        = net × deliveryCostCeilingRatio
//   fixed          = number rental + worst-channel platform fee (if counted
//                    in the ceiling) + infrastructure allowance
//   variable       = (ceiling − fixed) × (1 − safetyReserveRatio)
//   envelope       = variable − overrun allowance (granularity/termination
//                    latency/abnormal events beyond reservations)
//   total HCG-funded variable authorisation per period
//                  = budget + delivery reserve + essential pool ≤ envelope
'use strict';

// Every input is DECISION REQUIRED; these are the 2026-10 evidence values
// (docs/finance/*, project unit-economics memory): Twilio number £0.86917/mo;
// worst channel = Apple/Google 15% of ex-VAT; infrastructure is a placeholder.
const DEFAULT_ECONOMICS = Object.freeze({
  priceIncVatGbp: 5.99,
  vatRate: 0.2,
  deliveryCostCeilingRatio: 0.6,
  includePlatformFeeInCeiling: true,
  platformFeeRate: 0.15,
  numberRentalGbp: 0.86917,
  infrastructureGbp: 0.25,
  safetyReserveRatio: 0.15,
  overrunAllowanceGbp: 0.1,
});

function finite(n, name, { min = -Infinity, max = Infinity } = {}) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < min || v > max) throw new Error(`economicPolicy: ${name} must be a number in [${min}, ${max}]`);
  return v;
}

const round = (n) => Math.round(n * 1e4) / 1e4;

function deriveVariableEnvelope(inputs = {}) {
  const e = { ...DEFAULT_ECONOMICS, ...inputs };
  const price = finite(e.priceIncVatGbp, 'priceIncVatGbp', { min: 0.01, max: 1000 });
  const vat = finite(e.vatRate, 'vatRate', { min: 0, max: 1 });
  const ratio = finite(e.deliveryCostCeilingRatio, 'deliveryCostCeilingRatio', { min: 0, max: 1 });
  const feeRate = finite(e.platformFeeRate, 'platformFeeRate', { min: 0, max: 1 });
  const rental = finite(e.numberRentalGbp, 'numberRentalGbp', { min: 0, max: 100 });
  const infra = finite(e.infrastructureGbp, 'infrastructureGbp', { min: 0, max: 100 });
  const reserve = finite(e.safetyReserveRatio, 'safetyReserveRatio', { min: 0, max: 0.95 });
  const overrun = finite(e.overrunAllowanceGbp, 'overrunAllowanceGbp', { min: 0, max: 100 });

  const net = price / (1 + vat);
  const ceiling = net * ratio;
  const platformFee = e.includePlatformFeeInCeiling ? net * feeRate : 0;
  const fixed = rental + platformFee + infra;
  const variable = Math.max(0, (ceiling - fixed) * (1 - reserve));
  const envelope = Math.max(0, variable - overrun);
  return {
    inputs: e,
    netRevenueGbp: round(net),
    deliveryCostCeilingGbp: round(ceiling),
    fixedPerCustomerGbp: round(fixed),
    platformFeeGbp: round(platformFee),
    variableCeilingGbp: round(variable),
    variableEnvelopeGbp: round(envelope),
    // A conservative split of the envelope (DECISION REQUIRED): most for
    // the budget (monitoring + telephony), a reserve for unmonitored
    // delivery after it runs out, a small essential pool.
    suggestedProfile: {
      periodBudgetGbp: Math.floor(envelope * 0.58 * 100) / 100,
      deliveryReserveGbp: Math.floor(envelope * 0.3 * 100) / 100,
      essentialReserveGbp: Math.floor(envelope * 0.12 * 100) / 100,
    },
  };
}

// Does a configured profile fit the envelope?
function validateProfileAgainstEconomics(profile, inputs = {}) {
  const d = deriveVariableEnvelope(inputs);
  const total = Number(profile.periodBudgetGbp) + Number(profile.deliveryReserveGbp) + Number(profile.essentialReserveGbp);
  if (!Number.isFinite(total) || total < 0) return { ok: false, reason: 'invalid_profile', derived: d };
  return {
    ok: total <= d.variableEnvelopeGbp + 1e-9,
    totalAuthorisationGbp: round(total),
    variableEnvelopeGbp: d.variableEnvelopeGbp,
    headroomGbp: round(d.variableEnvelopeGbp - total),
    derived: d,
  };
}

module.exports = { DEFAULT_ECONOMICS, deriveVariableEnvelope, validateProfileAgainstEconomics };
