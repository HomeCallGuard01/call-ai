// Tests for the authoritative unit-economics register (unit economics v1,
// 2026-10-04): every runtime default, the migration 067 SQL defaults/seeds,
// plans.js placeholders and the Twilio carrier baseline must equal the
// register, so contradictory figures cannot silently coexist; the model's
// identities hold; the consistency check detects the known contradictions;
// and the generated tables in docs/ are current.
// Run with: node tests/economics-register.test.mjs

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const register = require('../services/finance/economicsRegister.js');
const model = require('../services/finance/hcgUnitEconomics.js');
const { checkEconomicsConsistency } = require('../services/finance/economicsConsistency.js');
const { DEFAULT_RATES } = require('../services/usage/costModel.js');
const { DEFAULT_ECONOMICS, deriveVariableEnvelope } = require('../services/containment/economicPolicy.js');
const { CHANNELS } = require('../services/finance/unitEconomics.js');
const { DEFAULT_ASSUMPTIONS } = require('../services/finance/carrierComparison.js');
const { ASSUMPTIONS } = require('../services/finance/pricingScenarios.js');
const { DEFAULTS: TOPUP_DEFAULTS } = require('../services/allowance/productCatalog.js');
const plans = require('../services/usage/plans.js');

let failures = 0;
function check(condition, message) {
  if (condition) console.log(`✓ ${message}`);
  else { console.error(`✗ ${message}`); failures++; }
}
const close = (a, b, eps = 1e-9) => Math.abs(Number(a) - Number(b)) < eps;
const v = register.value;

// --- 1. The register itself ------------------------------------------------
check(register.validateRegister(register.REGISTER).length === 0, 'the register validates (status, kind, unit, source on every entry)');
check(register.validateRegister({ assumptions: { x: { value: 1, unit: 'u', status: 'GUESSED', kind: 'fact', source: 'abc' } } }).some((e) => /status/.test(e)), 'an entry with a status outside KNOWN/CONFIGURED/ESTIMATED/UNKNOWN/PROVIDER_CONFIRMATION_REQUIRED is rejected');
check(register.validateRegister({ assumptions: { x: { value: null, unit: 'u', status: 'KNOWN', kind: 'fact', source: 'abc' } } }).length > 0, 'a null value is only allowed for UNKNOWN (no silent blanks)');
let threw = false;
try { v('noSuchAssumption'); } catch { threw = true; }
check(threw, 'reading an unknown assumption throws instead of returning undefined');
const byStatus = register.byStatus();
check(register.STATUSES.every((s) => Array.isArray(byStatus[s])) && byStatus.UNKNOWN.includes('appleSmallBusinessEnrolled') && byStatus.UNKNOWN.includes('customerUsageDistribution'), 'the biggest unknowns are labelled UNKNOWN, not presented as facts');
check(close(register.transcriptionGbpPerMin(), 0.00474) && close(register.appLegListGbpPerMin(), 0.00316), 'derived USD→GBP rates are exactly the £0.00474 / £0.00316 the system has always used');

// --- 2. Runtime defaults derive from the register (no scattered magic numbers)
const enf = register.rates({ basis: 'enforcement' });
check(DEFAULT_RATES.inboundPerMin === enf.inboundPerMin && DEFAULT_RATES.appLegPerMin === enf.appLegPerMin && DEFAULT_RATES.mediaStreamPerMin === enf.mediaStreamPerMin && DEFAULT_RATES.transcriptionPerMin === enf.transcriptionPerMin && DEFAULT_RATES.smsPerSegment === enf.smsPerSegment, 'costModel DEFAULT_RATES = register enforcement rates');
check(DEFAULT_ECONOMICS.priceIncVatGbp === v('priceIncVatGbp') && DEFAULT_ECONOMICS.vatRate === v('vatRate') && close(DEFAULT_ECONOMICS.deliveryCostCeilingRatio, 1 - v('targetGrossMargin')) && DEFAULT_ECONOMICS.numberRentalGbp === v('numberRentalGbpPerMonth') && DEFAULT_ECONOMICS.infrastructureGbp === v('infrastructureAllocationGbpPerCustomer') && DEFAULT_ECONOMICS.safetyReserveRatio === v('planSafetyReserveRatio') && DEFAULT_ECONOMICS.overrunAllowanceGbp === v('overrunAllowanceGbp'), 'economicPolicy DEFAULT_ECONOMICS = register');
const s = register.stripeFeeParts();
check(close(CHANNELS.stripe.fee(5.99), 5.99 * s.pct + s.fixedGbp) && close(CHANNELS.store15.fee(5.99, 5), 5 * v('googlePlayServiceFeeRate')) && close(CHANNELS.apple30.fee(5.99, 5), 5 * v('appleStandardRate')), 'unitEconomics fee models = register fee rates');
check(DEFAULT_ASSUMPTIONS.avgCallMinutes === v('avgCallMinutes') && DEFAULT_ASSUMPTIONS.roundUpPerCallAt60s === v('roundUpMinutesPerCall') && DEFAULT_ASSUMPTIONS.transcriptionGbpPerMonitoredMin === register.transcriptionGbpPerMin() && DEFAULT_ASSUMPTIONS.vatRate === v('vatRate'), 'carrierComparison DEFAULT_ASSUMPTIONS = register');
check(ASSUMPTIONS.roundUpMinutesPerCall === v('roundUpMinutesPerCall') && ASSUMPTIONS.streamRoundUpPerMonitoredCall === v('streamRoundUpPerMonitoredCall') && ASSUMPTIONS.transcriptionGbpPerMin === register.transcriptionGbpPerMin(), 'pricingScenarios ASSUMPTIONS = register');
check(TOPUP_DEFAULTS.vatRate === v('vatRate') && TOPUP_DEFAULTS.targetMargin === v('targetGrossMargin') && TOPUP_DEFAULTS.safetyReserve === v('topUpSafetyReserveRatio'), 'productCatalog top-up DEFAULTS = register');
const std = plans.resolvePlan('standard', {});
const plus = plans.resolvePlan('plus', {});
check(std.allowanceMinutes === v('planAllowanceMinutes').standard && plus.allowanceMinutes === v('planAllowanceMinutes').plus, 'plans.js allowance placeholders = register');
check(JSON.stringify(std.warningPoints) === JSON.stringify(v('planWarningPoints')), 'plans.js warning points = register');

// --- 3. SQL defaults/seeds and the carrier baseline (files the runtime can't import)
const sql = readFileSync(path.join(ROOT, 'supabase/migrations/067_financial_containment_authorization_ledger.sql'), 'utf8');
const sqlDefault = (col) => { const m = sql.match(new RegExp(`\\n\\s*${col} [^\\n]*? default ([0-9.]+)`)); return m ? Number(m[1]) : NaN; };
check(close(sqlDefault('connected_rate_gbp_per_min'), v('fortressConnectedRateGbpPerMin')) && close(v('fortressConnectedRateGbpPerMin'), enf.connectedPerMin), '067 connected rate default = register = inbound + app leg at list');
check(close(sqlDefault('monitoring_rate_gbp_per_min'), v('fortressMonitoringRateGbpPerMin')) && close(v('fortressMonitoringRateGbpPerMin'), enf.monitoringPerMin), '067 monitoring rate default = register = stream + transcription');
check(close(sqlDefault('estimate_uplift'), v('fortressEstimateUplift')), '067 estimate uplift default = register');
check(close(sqlDefault('call_fixed_fee_gbp'), v('twilioPollyGbpPerCall')), '067 per-call fixed fee default = register Polly greeting');
check(close(sqlDefault('sms_unit_gbp'), v('twilioSmsGbpPerSegment')), '067 SMS unit default = register');
check(close(sqlDefault('ai_request_gbp'), v('aiClassifierGbpPerRequest')) && close(sqlDefault('number_purchase_gbp'), v('numberPurchaseGbpCeiling')), '067 AI request / number purchase defaults = register');
check(close(sqlDefault('monitoring_max_seconds'), v('fortressMonitoringMaxSeconds')), '067 monitoring cap default = register');
const seed = sql.match(/\('standard',\s*([0-9.]+),\s*([0-9.]+),\s*'[a-z_]+',\s*([0-9.]+),/);
const reg = v('fortressSeedBudgetGbp');
check(seed && close(seed[1], reg.budget) && close(seed[2], reg.deliveryReserve) && close(seed[3], reg.essential), '067 standard budget-profile seed = register');
const env = deriveVariableEnvelope();
check(reg.budget + reg.deliveryReserve + reg.essential <= env.variableEnvelopeGbp + 1e-9, `the seeded profile (£${(reg.budget + reg.deliveryReserve + reg.essential).toFixed(2)}) fits economicPolicy's envelope (£${env.variableEnvelopeGbp})`);
const twilio = JSON.parse(readFileSync(path.join(ROOT, 'docs/finance/carrier-quotes.json'), 'utf8')).carriers[0];
check(twilio.numberMonthly === v('numberRentalGbpPerMonth') && twilio.inboundPerMin === v('twilioInboundGbpPerMin') && twilio.streamPerMin === v('twilioMediaStreamGbpPerMin') && twilio.ttsPerUse === v('twilioPollyGbpPerCall') && twilio.smsPerSegment === v('twilioSmsGbpPerSegment') && twilio.appLegPerMin === v('twilioAppLegBilledGbpPerMin') && twilio.billingIncrementSec === v('twilioBillingIncrementSec'), 'carrier-quotes.json Twilio baseline = register');
const today = register.REGISTER.futureCarrierScenarios.twilioToday;
check(today.numberGbp === v('numberRentalGbpPerMonth') && today.trustedPerMinGbp === v('twilioInboundGbpPerMin') && today.streamPerMinGbp === v('twilioMediaStreamGbpPerMin'), 'the "Twilio today" sensitivity row = register');
const costModelSrc = readFileSync(path.join(ROOT, 'services/usage/costModel.js'), 'utf8');
const policySrc = readFileSync(path.join(ROOT, 'services/containment/economicPolicy.js'), 'utf8');
check(!/0\.007558|0\.003329|0\.042325/.test(costModelSrc.replace(/\/\/.*$/gm, '')) && !/0\.86917/.test(policySrc.replace(/\/\/.*$/gm, '')), 'no provider rate literal remains in costModel/economicPolicy code (comments aside)');

// --- 4. Model identities -----------------------------------------------------
for (const channel of Object.keys(model.CHANNELS)) {
  const b = model.budget({ channel });
  const sc = model.scenario({ channel, usage: { trusted: 0, unknownMinutes: 0, trustedCalls: 0, unknownCalls: 0, sms: 0 } });
  check(close(sc.contribution, b.afterFees - b.fixed.total), `${channel}: an idle customer contributes after-fees revenue minus fixed cost`);
  // Spend the whole safe budget: margin must still meet the target.
  const marginAtSafe = (b.afterFees - b.fixed.total - b.safeVariableBudget) / b.net;
  check(marginAtSafe >= b.targetMargin - 1e-9, `${channel}: a customer consuming exactly the safe budget keeps ≥ ${b.targetMargin * 100}% (${(marginAtSafe * 100).toFixed(1)}%)`);
}
const sb = (c, p = 5.99) => model.budget({ channel: c, priceIncVatGbp: p }).safeVariableBudget;
check(sb('stripe') > sb('apple15') && sb('apple15') > sb('apple30') && close(sb('apple15'), sb('google15')), 'channel order: Stripe > 15% stores > Apple 30%');
check(sb('stripe', 6.99) > sb('stripe', 5.99) && sb('stripe', 9.99) > sb('stripe', 6.99), 'the safe budget rises with price');
const ec = model.minuteCosts({ basis: 'expected' });
const fc = model.minuteCosts({ basis: 'enforcement' });
check(fc.trustedPerMin > ec.trustedPerMin && fc.monitoredPerMin > ec.monitoredPerMin, 'the Fortress (enforcement) basis is never cheaper than the billed basis');
check(close(model.fortressEquivalent(1, { trustedShareOfSpend: 1 }).factor, fc.trustedPerMin / ec.trustedPerMin), 'fortressEquivalent converts by the trusted-minute ratio when all spend is trusted');
for (const ch of ['stripe', 'apple15', 'apple30', 'google15']) {
  const price = model.topUpMinPrice(1, ch);
  const rev = model.revenue({ priceIncVatGbp: price, channel: ch, leakageRate: 0 });
  check(close(rev.afterFees, (1 * (1 + v('topUpSafetyReserveRatio'))) / (1 - v('targetGrossMargin')), 1e-6), `${ch}: the minimum top-up price exactly funds £1 of delivery at the margin + reserve`);
}
check(model.retailPricePoint(1.42) === 1.49 && model.retailPricePoint(2.6) === 2.99 && model.retailPricePoint(4.99) === 4.99 && model.retailPricePoint(5.0) === 5.49, 'retail price points round UP to .49/.99');

// --- 5. Legacy figures are reproduced (the audit trail stays true) -----------
const L = model.reconcileLegacyFigures();
check(close(L.envelope086, 0.858, 1e-4), 'the £0.86 envelope is reproduced from economicPolicy defaults (£0.858)');
check(close(L.hundredMinutes207.withUplift, 2.0666, 1e-4), 'the £2.07 figure is 100 × (connected + monitoring) × 1.10 at Fortress rates');
check(L.budgetSlice050.formula === 0.49 && L.budgetSlice050.seeded === 0.5, 'the £0.50 seed is the envelope\'s 58% slice (formula £0.49, seeded £0.50)');

// --- 6. Consistency detects the real contradictions, and only errors on under-counting
const c = checkEconomicsConsistency({ env: {} });
check(c.ok, 'default configuration has no under-counting error');
check(c.findings.some((f) => f.code === 'plan_minutes_unfundable' && /standard/.test(f.detail)), 'the 100-minute placeholder vs £0.50 budget contradiction is reported');
check(c.findings.some((f) => f.code === 'apple_commission_unconfirmed'), 'the unconfirmed Apple commission is reported');
check(c.findings.some((f) => f.code === 'enforcement_basis_premium'), 'the expected-vs-enforcement basis premium is reported');
const low = checkEconomicsConsistency({ env: { SAFETY_COST_TRANSCRIPTION_GBP_PER_MIN: '0.001' } });
check(!low.ok && low.findings.some((f) => f.code === 'enforcement_rate_below_billed_rate' && /transcription/.test(f.detail)), 'an override that prices a minute below the billed rate is an ERROR');
const funded = checkEconomicsConsistency({ env: {}, profiles: [{ profile: 'standard', period_budget_gbp: 5 }, { profile: 'plus', period_budget_gbp: 5 }] });
check(!funded.findings.some((f) => f.code === 'plan_minutes_unfundable'), 'a database budget that funds the minutes clears the warning (database profiles take precedence over the seed)');

// --- 7. The generated tables in docs/ are current ------------------------------
const generated = execFileSync(process.execPath, [path.join(ROOT, 'scripts/hcg-unit-economics.js')], { cwd: ROOT, encoding: 'utf8' });
const committed = readFileSync(path.join(ROOT, 'docs/finance/HCG_UNIT_ECONOMICS_V1_TABLES.md'), 'utf8');
check(generated === committed, 'docs/finance/HCG_UNIT_ECONOMICS_V1_TABLES.md matches the register (regenerate: node scripts/hcg-unit-economics.js > docs/finance/HCG_UNIT_ECONOMICS_V1_TABLES.md)');

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
