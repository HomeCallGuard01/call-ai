// failureScenarios.js — maximum £ exposure, per failure scenario, before a
// safeguard intervenes, computed from the ACTUAL configured limits
// (services/usage/safetyConfig.js, plans.js, costModel.js) so the numbers
// in the report can never drift from the code. Pure.
//
// Rates are the conservative real-time safety rates (connected minute
// includes the app leg at list price). Figures are upper bounds per
// household unless stated; "day" is the UTC day, "period" the billing period.
'use strict';

const { resolveSafetyConfig } = require('../usage/safetyConfig');
const { resolveCostRates } = require('../usage/costModel');
const { resolvePlan } = require('../usage/plans');

const MONITORING_CAP_MIN = 30; // MONITORING_MAX_DURATION_MINUTES (existing)

function computeFailureScenarios({ env = {}, entitledHouseholds = 10 } = {}) {
  const cfg = resolveSafetyConfig(env, { entitledHouseholds });
  const r = resolveCostRates(env);
  const plan = resolvePlan('standard', env);
  const c = r.connectedPerMinGbp;
  const m = r.monitoringPerMinGbp;
  const K = cfg.maxCallsPerHousehold;
  const L = cfg.maxCallMinutes;
  const S = cfg.maxMonitoredStreamsPerHousehold;
  const oneCall = L * c;                                   // one call to its time limit
  const oneMonitoring = MONITORING_CAP_MIN * m;            // one call's maximum monitoring
  const inFlight = K * oneCall + S * oneMonitoring;        // everything already admitted when a ceiling trips
  const smsPeriod = cfg.householdPeriodSms * r.smsPerSegment;
  const round = (x) => Math.round(x * 100) / 100;

  const scenarios = [
    {
      id: 'business_user',
      scenario: 'Plumber/business user receiving unknown calls all day (one genuine line)',
      stoppedBy: `Layer A allowance / monitoring ceilings (£${cfg.dailyMonitoringCostLimitGbp}/day, £${cfg.periodMonitoringCostLimitGbp}/period) stop monitoring; admission refuses NEW UNKNOWN calls once the period reaches £${cfg.householdPeriodUnknownBlockGbp}; ALL new calls at £${cfg.householdPeriodHardGbp}`,
      perDayGbp: round(Math.min(cfg.householdDailyHardGbp, 16 * 60 * c + cfg.dailyMonitoringCostLimitGbp) + inFlight),
      perPeriodGbp: round(cfg.householdPeriodHardGbp + inFlight + smsPeriod),
      note: 'Genuine use: 10 h/day of talk ≈ £6.43 + ≤ £1.50 monitoring. Unknown callers are refused after ≈ 3 such days; trusted callers until £40.',
    },
    {
      id: 'call_left_connected',
      scenario: 'Customer accidentally leaves a call connected',
      stoppedBy: `<Dial timeLimit=${L * 60}> (Twilio ends the leg); monitoring stops at ${MONITORING_CAP_MIN} min`,
      perCallGbp: round(oneCall + oneMonitoring),
    },
    {
      id: 'call_24h',
      scenario: '24-hour connected call',
      stoppedBy: `Impossible: the explicit <Dial timeLimit> ends it at ${L} min even if the account allows 24-hour calls`,
      perCallGbp: round(oneCall + oneMonitoring),
      withoutControlGbp: round(1440 * c + oneMonitoring),
    },
    {
      id: 'forwarding_loop',
      scenario: 'Forwarding loop',
      stoppedBy: `Caller = an HCG number, From == To, ForwardedFrom = an HCG number or a ParentCallSid → refused at the first looped leg (unbilled). Loop presenting the original caller ID → per-caller limit (${cfg.callerMaxAttempts} attempts / ${cfg.callerWindowSeconds}s, plus the abuse layer's cooldown)${cfg.burstMaxAttempts > 0 ? `, household burst backstop (${cfg.burstMaxAttempts} / ${cfg.burstWindowSeconds}s)` : ''}, ≤ ${K} concurrent, the Financial Fortress household budget, then the £${cfg.householdDailyHardGbp}/day ceiling`,
      perDayGbp: round(cfg.householdDailyHardGbp + inFlight),
      firstLegOnlyGbp: round(oneCall),
    },
    {
      id: 'ten_simultaneous',
      scenario: '10 simultaneous calls to one household',
      stoppedBy: `${K} admitted, ${10 - K} refused with <Reject> (unbilled)`,
      perWaveGbp: round(inFlight),
      perDayGbp: round(cfg.householdDailyHardGbp + inFlight),
      perPeriodGbp: round(cfg.householdPeriodHardGbp + inFlight),
    },
    {
      id: 'hundred_simultaneous',
      scenario: '100 simultaneous calls to one household',
      stoppedBy: `Same as 10: ${K} admitted, ${100 - K} refused (unbilled); refused attempts keep the burst rule tripped while the flood lasts`,
      perWaveGbp: round(inFlight),
      perDayGbp: round(cfg.householdDailyHardGbp + inFlight),
      perPeriodGbp: round(cfg.householdPeriodHardGbp + inFlight),
    },
    {
      id: 'malicious_attack',
      scenario: 'Malicious attack on an HCG number (rotating caller IDs, spaced to dodge the burst rule)',
      stoppedBy: `Concurrency ${K}; caller-flood rule (${cfg.callerMaxAttempts}/${cfg.callerWindowSeconds / 60} min) per ID; £${cfg.householdDailyHardGbp}/day; unknown callers refused at £${cfg.householdPeriodUnknownBlockGbp}/period; company EMERGENCY refuses already-abnormal households`,
      perDayGbp: round(cfg.householdDailyHardGbp + inFlight),
      perPeriodGbp: round(cfg.householdPeriodUnknownBlockGbp + inFlight),
      note: 'Spoofing trusted numbers raises the period bound to the £40 hard ceiling.',
    },
    {
      id: 'attack_many_numbers',
      scenario: 'Coordinated attack on many HCG numbers at once',
      stoppedBy: `Each household as above; company EMERGENCY (£${cfg.companyDailyEmergencyGbp}/day or £${round(cfg.companyHourlyEmergencyGbp)}/hour) refuses households already over £${cfg.householdDailyWatchGbp} today; company HARD (£${cfg.companyDailyHardGbp}/day) refuses all new unknown calls`,
      perAttackedHouseholdAfterEmergencyGbp: round(cfg.householdDailyWatchGbp + inFlight),
      companyDayGbp: round(cfg.companyDailyHardGbp),
      note: 'Company bound ≈ HARD ceiling + calls already in flight (≤ 3 per attacked household × 240 min). Trusted calls keep flowing everywhere.',
    },
    {
      id: 'monitoring_malfunction',
      scenario: 'Monitoring service malfunction (stream never closes, transcription loop)',
      stoppedBy: `30-min per-call cap; 90 s stale heartbeat; transcription-rate anomaly guard; usage-unrecordable-for-60 s stop; £${cfg.dailyMonitoringCostLimitGbp}/day and £${cfg.periodMonitoringCostLimitGbp}/period per household; company monitoring £${round(cfg.globalDailyCostLimitGbp)}/day and ${cfg.globalMaxMonitoredStreams} streams`,
      perDayGbp: round(cfg.dailyMonitoringCostLimitGbp + S * oneMonitoring),
      companyDayGbp: round(cfg.globalDailyCostLimitGbp + cfg.globalMaxMonitoredStreams * oneMonitoring),
      serverHungGbp: round(cfg.globalMaxMonitoredStreams * L * r.mediaStreamPerMin),
      note: 'If the server hangs with sockets open, streams bill until each call ends (≤ time limit); transcription stops with the server.',
    },
    {
      id: 'transcription_price_change',
      scenario: 'Transcription provider starts charging more than expected (e.g. 5×)',
      stoppedBy: 'NOT DETECTABLE by HCG until the invoice (no OpenAI billing access). Monitored MINUTES stay bounded by the £ ceilings at the configured rate; the true £ scales with the price.',
      perPeriodGbp: round((cfg.periodMonitoringCostLimitGbp / m) * (r.mediaStreamPerMin + 5 * r.transcriptionPerMin)),
      provider: 'OpenAI project budget (provider-side) is the only hard stop',
    },
    {
      id: 'app_leg_charged',
      scenario: 'Twilio starts billing the app leg',
      stoppedBy: 'Already priced into every real-time limit (conservative list rate) — no limit loosens; the ledger raises NEW_COST_CATEGORY CRITICAL within one ingestion cycle',
      perDayGbp: 0,
      note: `Commercial (not safety) impact: +£${r.appLegPerMin.toFixed(5)} per connected minute on every call.`,
    },
    {
      id: 'data_stale',
      scenario: 'Ledger / usage data stops updating',
      stoppedBy: 'Ledger stale → ALERT (COST_DATA_STALE), never read as £0; enforcement does not depend on the ledger. Real-time counters unavailable → admission falls back to in-memory limits (≤ 2× concurrency if the provider can\'t be asked), monitoring fails CLOSED, CRITICAL alert',
      perHouseholdPerHourGbp: round(2 * K * 60 * c),
      note: 'Per household under attack during a database outage; genuine households are unaffected. The per-call time limit still applies (it is in the TwiML).',
    },
    {
      id: 'allowance_mid_call',
      scenario: 'Customer reaches the allowance during an active call',
      stoppedBy: `Monitoring continues for the ${plan.graceSeconds}s grace, then stops; the call continues unmonitored`,
      perEventGbp: round(S * (plan.graceSeconds / 60) * m),
    },
    {
      id: 'server_down',
      scenario: 'HCG server unreachable (outage) while calls arrive',
      stoppedBy: 'NOTHING in HCG software: Twilio bills each call that reaches the number (~1 started minute) and plays an error. Provider-side only: a static <Reject> fallback URL (unbilled) and usage triggers',
      perCallGbp: round(r.inboundPerMin),
      provider: 'Twilio voice fallback URL → static <Reject> TwiML (DECISION REQUIRED)',
    },
  ];
  return { config: cfg, rates: r, plan, scenarios };
}

module.exports = { computeFailureScenarios };
