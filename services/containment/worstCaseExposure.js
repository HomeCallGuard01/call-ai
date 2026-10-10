// worstCaseExposure.js — worst-case £ exposure model for the ≤10-customer
// launch cohort (Agent 1, 2026-10-11). PURE: no I/O, no provider calls.
//
// It answers "what is the MOST HCG can be billed per hour / per day" under
// five scenarios, and says plainly which ones have NO provider-enforced
// bound. It is a model, not a measurement: every rate and every provider
// behaviour it relies on is listed in ASSUMPTIONS with its evidence status.
// Printed by scripts/agent1-worst-case-exposure.js and asserted by
// tests/agent1-worst-case-exposure.test.mjs; the table and verdict are in
// docs/launch/2026-10-11-AGENT1-CONTAINMENT-REPORT.md §4.
'use strict';

// ── Rates, GBP per minute (per started minute unless noted) ─────────────
// Sources: docs/launch/2026-10-10-TWILIO-DURATION-EVIDENCE.md §1/§4
// (invoiced Twilio rates, fx as used there) and the BYOC investigation §5.1
// (research/business-decision-2026-10-10, GB list prices Aug 2026, $→£ 0.755).
// Invoiced/estimated rates come from the economics register (the single
// source of provider rates — tests/economics-register.test.mjs forbids
// re-stating them); BYOC-era list rates are not in the register yet.
const register = require('../finance/economicsRegister');
const REG = register.rates({ basis: 'enforcement' });
const RATES = Object.freeze({
  inboundPstn: REG.inboundPerMin,        // Twilio-hosted number, inbound leg (INVOICED)
  sdkLegList: REG.appLegPerMin,          // <Dial><Client> app leg at list; £0 on invoices today
  mediaStream: REG.mediaStreamPerMin,    // <Start><Stream> (INVOICED)
  whisper: REG.transcriptionPerMin,      // OpenAI transcription per monitored minute (ESTIMATED; OpenAI-billed)
  byoc: 0.00302,              // BYOC inbound ($0.004 @0.755, LIST)
  sipInterface: 0.00302,      // SIP interface ($0.004, LIST; whether it stacks on BYOC is unknown — Twilio Q T1)
  sdkByoc: 0.00302,           // Voice SDK leg ($0.004 @0.755, LIST)
  // A COMPROMISED server answering one call can attach more paid features to
  // that one call (up to 4 <Stream>s, <Start><Recording>/<Transcription>,
  // a dial-out child). INDICATIVE ceiling per answered channel-minute, used
  // only to show the multiplier; not a quoted price.
  compromisedPerChannelIndicative: 0.05,
});

const TWILIO_MAX_CALL_MINUTES = 240; // P5: 4 h account maximum (default; console-verified only)

// Fortress defaults (migration 067 fc_policy + seeded 'standard' profile at
// £5.99; the £7.99 profile is a pending proposal) — see the duration evidence §4.
const FORTRESS = Object.freeze({
  householdFreshCeilingGbp: 0.85,       // budget £0.50 + trusted reserve £0.25 + essential £0.10
  householdAutoHoldDailyGbp: 5,
  globalHourlyFloorGbp: 4, globalHourlyPerHousehold: 0.03,
  globalDailyFloorGbp: 15, globalDailyPerHousehold: 0.20,
  globalWorstCaseFloorGbp: 40, globalWorstCasePerHousehold: 0.50,
  globalActiveFloor: 20,
  unattributedDailyGbp: 2,
  numberPurchasesPerDay: 10, numberPurchaseGbp: 1.15,
});

const r2 = (n) => Math.round(n * 100) / 100;
const perHour = (channels, ratePerMin) => channels * 60 * ratePerMin;

// (a) Normal operation, candidate deployed, Fortress enforcing.
function scenarioNormal({ households = 10 } = {}) {
  const f = FORTRESS;
  const hourlyCap = Math.max(f.globalHourlyFloorGbp, households * f.globalHourlyPerHousehold);
  const dailyCap = Math.max(f.globalDailyFloorGbp, households * f.globalDailyPerHousehold);
  const worstCaseLive = Math.max(f.globalWorstCaseFloorGbp, households * f.globalWorstCasePerHousehold);
  // Tighter, per-household bound per billing period (calls + SMS + AI that
  // Fortress meters), plus the separately-capped unattributed and purchase lines.
  const perPeriodHouseholds = households * f.householdFreshCeilingGbp;
  const purchasesPerDay = f.numberPurchasesPerDay * f.numberPurchaseGbp;
  return {
    id: 'a', label: '(a) Normal operation, Fortress enforcing',
    perHourGbp: r2(hourlyCap), perDayGbp: r2(dailyCap),
    bounded: true, enforcedBy: 'HCG application (Fortress latching breaker + per-call <Dial timeLimit>)',
    notes: [
      `global caps at ${households} households: £${r2(hourlyCap)}/h and £${r2(dailyCap)}/day committed+reserved; breaker latches and ends live calls`,
      `live worst case (I5) ≤ £${r2(worstCaseLive)} across all calls in flight`,
      `per-household metered ceiling £${f.householdFreshCeilingGbp}/period fresh → £${r2(perPeriodHouseholds)} for ${households} households, plus unattributed ≤ £${f.unattributedDailyGbp}/day and number purchases ≤ £${r2(purchasesPerDay)}/day`,
      'NOT provider-enforced: lost entirely if the server or its credentials are compromised (scenario c)',
    ],
  };
}

// (b) HCG backend down: Twilio fetches the number's fallback URL (<Reject/>).
function scenarioBackendDown({ households = 10, fallbackConfigured = true, attemptsPerHour = 1000 } = {}) {
  const tail = Math.max(FORTRESS.globalWorstCaseFloorGbp, households * FORTRESS.globalWorstCasePerHousehold);
  const perAttempt = fallbackConfigured ? 0 : RATES.inboundPstn; // Twilio error message ≈ 1 started minute
  return {
    id: fallbackConfigured ? 'b' : 'b-nofallback',
    label: fallbackConfigured ? '(b) HCG backend down, <Reject/> fallback set' : '(b′) HCG backend down, NO fallback URL',
    perHourGbp: r2(perAttempt * attemptsPerHour), perDayGbp: r2(perAttempt * attemptsPerHour * 24),
    oneOffTailGbp: r2(tail),
    bounded: fallbackConfigured,
    enforcedBy: fallbackConfigured ? 'Twilio (fallback <Reject/> is never answered) + per-call timeLimit for calls already live' : 'nothing: every attempt is answered with an error message and billed',
    notes: [
      `calls live when the server died: one-off tail ≤ £${r2(tail)} (Fortress I5 worst case; measured £4.35 at the floors) — relies on Twilio honouring timeLimit + ending the parent after the action fetch fails (UNDEMONSTRATED, staging S-A…S-E)`,
      fallbackConfigured ? '<Reject/> billed £0: Twilio-documented as unanswered; confirm on invoice (Twilio Q)' : `≈ £${RATES.inboundPstn}/attempt; at ${attemptsPerHour} attacker attempts/h → £${r2(perAttempt * attemptsPerHour)}/h (attacker pays origination)`,
    ],
  };
}

// (c) HCG server/credentials fully compromised, Level 1 (Twilio-hosted numbers).
// The runtime holds the subaccount auth token (needed for signature
// validation) = full control of the runtime subaccount.
function scenarioCompromised({ attackerConcurrency = 100, ratePerMin = RATES.inboundPstn + RATES.sdkLegList, prepaidGbp = 25 } = {}) {
  const hour = perHour(attackerConcurrency, ratePerMin);
  const wave = attackerConcurrency * TWILIO_MAX_CALL_MINUTES * ratePerMin;
  return {
    id: `c-${attackerConcurrency}`,
    label: `(c) Server compromised, ${attackerConcurrency} concurrent attacker calls`,
    perHourGbp: r2(hour), perDayGbp: r2(hour * 24), perFourHourWaveGbp: r2(wave),
    bounded: false,
    enforcedBy: 'nothing provider-side caps concurrency on Twilio numbers / SDK / SIP legs',
    notes: [
      'grows linearly with attacker concurrency, each call up to 4 h (P5); suspension (P7) and zero balance (P2) do not end live calls',
      `prepaid £${prepaidGbp} only refuses NEW calls once usage is BOOKED; Twilio books call usage at completion (assumption, Twilio Q), so a wave started inside 4 h is not stopped by the balance at all`,
      'usage triggers (P7) see booked usage only → may fire ≈ 4 h late; triggers in the subaccount can be deleted by the attacker',
    ],
  };
}

// (d) Level 2: numbers hosted at Magrathea (per-number channel cap) → Twilio BYOC.
const P8_RATE_SETS = Object.freeze({
  unstacked: RATES.byoc,
  plusSdk: RATES.byoc + RATES.sdkByoc,
  stacked: RATES.byoc + RATES.sipInterface + RATES.sdkByoc,
  stackedMonitored: RATES.byoc + RATES.sipInterface + RATES.sdkByoc + RATES.mediaStream + RATES.whisper,
  compromisedIndicative: RATES.compromisedPerChannelIndicative,
});

function scenarioMagrathea({ channelsPerNumber = 2, numbers = 10, accountWideCap = null, rateSet = 'stacked' } = {}) {
  const channels = accountWideCap ? Math.min(accountWideCap, channelsPerNumber * numbers) : channelsPerNumber * numbers;
  const rate = P8_RATE_SETS[rateSet];
  const hour = perHour(channels, rate);
  return {
    id: `d-${channelsPerNumber}-${rateSet}`,
    label: `(d) P8 Magrathea ${channelsPerNumber} ch × ${numbers} numbers${accountWideCap ? ` (account cap ${accountWideCap})` : ''}, ${rateSet}`,
    channels, perHourGbp: r2(hour), perDayGbp: r2(hour * 24),
    // Bounded ONLY for legs that traverse Magrathea; see NON_CAPPED_PATHS.
    bounded: true, boundedScope: 'legs that traverse Magrathea only',
    enforcedBy: 'Magrathea per-number channel limit (provider-enforced); child legs/streams die with their parent',
  };
}

// (e) OpenAI with a project hard limit.
function scenarioOpenAi({ projectHardLimitUsd = 15, fx = 0.755, overshootShare = 0.1, monitoredChannels = 20 } = {}) {
  const limit = projectHardLimitUsd * fx;
  const demandPerHour = perHour(monitoredChannels, RATES.whisper);
  return {
    id: 'e', label: `(e) OpenAI, project hard limit $${projectHardLimitUsd}/month`,
    perHourGbp: r2(Math.min(demandPerHour, limit * (1 + overshootShare))), perDayGbp: r2(limit * (1 + overshootShare)),
    perMonthGbp: r2(limit * (1 + overshootShare)),
    bounded: true, enforcedBy: 'OpenAI (HTTP 429 once the project limit is reached; small documented overshoot)',
    notes: [`${monitoredChannels} monitored streams would demand £${r2(demandPerHour)}/h; the limit binds the MONTH total, so the per-day ceiling equals the monthly limit`, 'binds only project-scoped keys (launchConfig openai_project_key)', 'when the limit is hit, live AI monitoring stops: the app must say so truthfully (WS3 banners) — the limit must be sized above genuine cohort demand'],
  };
}

// Every billable path that does NOT traverse Magrathea under Level 2, with
// whether it exists in HCG code today and what closes it.
const NON_CAPPED_PATHS = Object.freeze([
  { path: '<Dial><Client> child leg and Media Stream(s)', capped: 'yes (by the parent)', why: 'Twilio ends the dialled leg and streams when the parent call ends; a parent is a Magrathea channel', control: 'none needed; note a compromised server can add up to 4 streams/recording/transcription per channel (finite multiplier, indicative £0.05/channel-min)', blocker: false },
  { path: 'Client-originated Voice SDK calls (outgoing grant → TwiML App)', capped: 'NO', why: 'access tokens carry outgoingApplicationSid; with HCG alive the TwiML App URL answers <Reject/> (server.js /voice client-origin check, /voice-sdk-outbound-not-supported); a compromised server holds the Voice API key secret → can mint unlimited identities and bridge client↔client calls (2 SDK legs, no PSTN, no geo control)', control: 'remove outgoingApplicationSid from the VoiceGrant (incoming-only tokens; needs device test) + point the TwiML App Voice URL at a <Reject/> TwiML Bin; still defeatable by a full subaccount compromise', blocker: true },
  { path: 'Legacy Twilio-owned numbers still in the account', capped: 'NO', why: 'inbound concurrency on Twilio PSTN numbers is not provider-capped', control: 'release every Twilio number once households are on Magrathea DDIs (number inventory: 10 numbers today)', blocker: true },
  { path: 'Outbound PSTN dial (TwiML <Dial><Number> or REST calls.create)', capped: 'NO (geo-limited only)', why: 'no HCG code path creates one (structural test); egress guard rejects any <Dial> but the household <Client>; a compromised server bypasses both', control: 'Twilio voice outbound geo permissions ALL OFF incl. UK + high-risk special services off, set on the parent with subaccount inheritance — Twilio must confirm the subaccount cannot override (Q)', blocker: true },
  { path: 'SIP interface / SIP Domain calls (inbound to a Twilio SIP Domain, or <Dial><Sip>/calls.create to sip:)', capped: 'NO', why: 'no HCG code path uses SIP; a compromised subaccount can create a SIP Domain or dial sip: URIs (not covered by PSTN geo permissions)', control: 'Twilio confirmation/setting that blocks SIP Domain creation and SIP egress for the subaccount (Q); not available as a documented self-serve control', blocker: true },
  { path: 'Calls continuing after transfer', capped: 'n/a', why: 'HCG never transfers: no <Refer>, <Enqueue>, <Conference>, <Redirect> or REST redirect to a non-terminal URL (twilio-duration-bounds + agent1 structural test); Magrathea has no REFER', control: 'structural tests keep it so', blocker: false },
  { path: 'Number purchases / SMS by a compromised server', capped: 'NO (prepaid-bounded)', why: 'discrete requests: refused once the balance is exhausted or the subaccount is suspended (no live tail); SMS UK-only by geo (P3); a queued-SMS tail is possible', control: 'P2 small prepaid balance, P3, P7', blocker: false },
]);

// The verdict the report states. (c) is not bounded under Level 1; P8 alone
// does not bound it either while the runtime holds a full subaccount credential.
function releaseVerdict() {
  const blockers = NON_CAPPED_PATHS.filter((p) => p.blocker).map((p) => p.path);
  return {
    level1CompromiseBounded: false,
    level2CompromiseBounded: false,
    verdict: 'RELEASE BLOCKER (against "no uncapped exposure, even for 10"): a full server/credential compromise has no provider-enforced £ bound under Level 1, and Level 2 (Magrathea caps) bounds only legs that traverse Magrathea.',
    closes: [
      'EITHER Twilio written confirmation of (i) an account/subaccount concurrency or spend limit they enforce on calls in progress, or (ii) that live calls are bounded at zero balance (overrun size), AND that parent-set geo/SIP restrictions cannot be changed by the subaccount;',
      'OR Level 2 (P8) with: every Twilio number released, an ACCOUNT-WIDE Magrathea channel cap confirmed (M5), incoming-only Voice tokens + <Reject/> TwiML App, outbound geo all off (parent, non-overridable), SIP egress/domains blocked by Twilio — leaving the SDK client↔client path, which only Twilio can cap;',
      'OR Andrew explicitly accepts the residual compromise risk for the ≤10 cohort, bounded in practice by detection (Control Centre, Twilio usage alerts, Twilio fraud monitoring) — a business decision, not a cap.',
    ],
    blockerPaths: blockers,
  };
}

module.exports = {
  RATES, FORTRESS, TWILIO_MAX_CALL_MINUTES, P8_RATE_SETS, NON_CAPPED_PATHS,
  scenarioNormal, scenarioBackendDown, scenarioCompromised, scenarioMagrathea, scenarioOpenAi, releaseVerdict,
};
