// Behavioural tests for the financial-safety call path (services/usage/*,
// migration 056's application side): plans, billing periods, cost model,
// Layer B limits, call admission (incl. fail-safe fallback and races),
// monitoring gate, warning points, the Build 20 allowance contract, SMS
// budget, and the live-monitoring handler's mid-call rules.
// Run with: node tests/financial-safety-callpath.test.mjs

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { resolvePlan } = require('../services/usage/plans.js');
const { resolveBillingPeriod, resolveEntitlementPeriod } = require('../services/usage/billingPeriod.js');
const { resolveCostRates } = require('../services/usage/costModel.js');
const { resolveSafetyConfig, admissionLimits, monitoringLimits, smsLimits } = require('../services/usage/safetyConfig.js');
const { createCallConcurrencyTracker } = require('../services/usage/callConcurrency.js');
const { createCallAdmission, callerKey } = require('../services/usage/callAdmission.js');
const { requestMonitoring, MONITORING_STATUS } = require('../services/usage/monitoringGate.js');
const { notifyUsageThresholds } = require('../services/usage/usageNotifier.js');
const { computeAllowanceStatus } = require('../services/usage/allowanceStatus.js');
const { getHouseholdAllowance } = require('../services/usage/householdAllowance.js');
const { createSmsBudget } = require('../services/usage/smsBudget.js');
const { createMediaStreamHandler } = require('../services/liveMonitoring/mediaStreamHandler.js');

let failures = 0;
const check = (c, m) => { if (c) console.log(`✓ ${m}`); else { console.error(`✗ ${m}`); failures++; } };
const near = (a, b, e = 1e-9) => Math.abs(a - b) <= e;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── plans (Layer A) ────────────────────────────────────────────────────
{
  const p = resolvePlan('standard', {});
  check(p.allowanceMinutes === 100 && p.allowanceSeconds === 6000 && p.enforced === false, 'default plan: 100 min placeholder, NOT enforced until approved');
  check(p.warningPoints.join() === '0.75,0.9' && p.graceSeconds === 300, 'default warning points 75%/90% (+100%), 5-minute mid-call grace');
  const e = resolvePlan('standard', { MONITORING_ALLOWANCE_ENFORCED: 'true', PLAN_STANDARD_ALLOWANCE_MINUTES: '150', MONITORING_ALLOWANCE_GRACE_SECONDS: '0', MONITORING_WARNING_POINTS: '0.5,0.8' });
  check(e.enforced && e.allowanceMinutes === 150 && e.graceSeconds === 0 && e.warningPoints.join() === '0.5,0.8', 'enforcement, allowance, grace and warning points are env-configurable without a deploy');
  check(resolvePlan('made-up', {}).code === 'standard' && resolvePlan(null, {}).code === 'standard', 'an unknown plan code falls back to the smallest plan, never unlimited');
}

// ─── billing periods (Stripe / Apple / Google / complimentary) ──────────
{
  const now = new Date('2026-09-30T12:00:00Z');
  const stripe = resolveEntitlementPeriod({ entitlement: { source: 'stripe', starts_at: '2026-01-10T08:00:00Z' }, subscription: { current_period_end: '2026-10-12T09:00:00Z' }, now });
  check(stripe.basis === 'stripe_period' && stripe.periodStart.toISOString() === '2026-09-12T09:00:00.000Z' && stripe.periodEnd.toISOString() === '2026-10-12T09:00:00.000Z',
    'Stripe: the allowance period is Stripe\'s own current period (resets when Stripe renews)');
  const stripeSecs = resolveEntitlementPeriod({ entitlement: { source: 'stripe' }, subscription: { current_period_end: Date.parse('2026-10-12T09:00:00Z') / 1000 }, now });
  check(stripeSecs.basis === 'stripe_period', 'Stripe period end given in epoch seconds is understood');
  const store = resolveEntitlementPeriod({ entitlement: { source: 'apple_revenuecat', starts_at: '2026-03-05T10:00:00Z', ends_at: '2026-10-05T10:00:00Z' }, now });
  check(store.basis === 'store_expiry' && store.periodStart.toISOString() === '2026-09-05T10:00:00.000Z', 'Apple/Google (RevenueCat): the period ends at the store expiry each renewal extends');
  const lapsed = resolveEntitlementPeriod({ entitlement: { source: 'apple_revenuecat', starts_at: '2026-03-05T10:00:00Z', ends_at: '2026-09-29T10:00:00Z' }, now });
  check(lapsed.basis === 'anniversary' && lapsed.periodStart.toISOString() === '2026-09-05T10:00:00.000Z', 'a store expiry in the past (billing retry/grace) falls back to the purchase anniversary');
  const comp = resolveEntitlementPeriod({ entitlement: { source: 'admin_manual', starts_at: '2026-08-31T00:00:00Z', ends_at: '2026-12-31T00:00:00Z' }, now });
  check(comp.basis === 'anniversary' && comp.periodStart.toISOString() === '2026-09-30T00:00:00.000Z' && comp.periodEnd.toISOString() === '2026-10-31T00:00:00.000Z',
    'complimentary grants: monthly anniversary of starts_at (31st clamps to 30 Sep, then 31 Oct)');
  const none = resolveEntitlementPeriod({ entitlement: null, now });
  check(none.basis === 'calendar_month' && none.periodStart.toISOString() === '2026-09-01T00:00:00.000Z', 'no entitlement: calendar month — always a finite period');
  const feb = resolveBillingPeriod('2026-01-31T00:00:00Z', new Date('2026-02-28T12:00:00Z'));
  check(feb.periodStart.toISOString() === '2026-02-28T00:00:00.000Z' && feb.periodEnd.toISOString() === '2026-03-31T00:00:00.000Z', 'a 31st anniversary resets on 28 Feb, then 31 Mar');
}

// ─── cost model and Layer B limits ──────────────────────────────────────
{
  const r = resolveCostRates({});
  check(near(r.connectedPerMinGbp, 0.007558 + 0.00316) && near(r.monitoringPerMinGbp, 0.003329 + 0.00474), 'real-time rates: connected minute includes the app leg at list price (conservative); monitoring = stream + transcription');
  check(near(resolveCostRates({ SAFETY_COST_APP_LEG_GBP_PER_MIN: '0' }).connectedPerMinGbp, 0.007558), 'the app-leg rate can be set to today\'s billed £0 explicitly');
  const small = resolveSafetyConfig({}, { entitledHouseholds: 10 });
  const big = resolveSafetyConfig({}, { entitledHouseholds: 2000 });
  check(small.companyDailyEmergencyGbp === 25 && big.companyDailyEmergencyGbp === 1500 && big.companyDailyHardGbp === 4000 && small.companyDailyHardGbp === 100,
    'company thresholds scale with entitled households, with floors for a small base');
  check(small.maxCallMinutes === 240 && small.maxCallsPerHousehold === 3 && small.householdDailyHardGbp === 10 && small.householdPeriodHardGbp === 40, 'Layer B defaults: 240-min calls, 3 simultaneous, £10/day, £40/period');
  check(small.householdDailyHardGbp / r.connectedPerMinGbp > 900, `£10/day ≈ ${Math.round(small.householdDailyHardGbp / r.connectedPerMinGbp)} connected minutes — beyond one line\'s genuine use`);
  // The jsonb keys the app sends must be exactly the keys the SQL reads.
  const sql = readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '056_financial_safety_allowance_and_admission.sql'), 'utf8');
  const sqlKeys = new Set([...sql.matchAll(/p_limits->>'(\w+)'/g)].map((m) => m[1]));
  const appKeys = new Set([...Object.keys(admissionLimits(small, r)), ...Object.keys(monitoringLimits(small)), ...Object.keys(smsLimits(small))]);
  check([...sqlKeys].every((k) => appKeys.has(k)), `every limit the SQL reads is supplied by the app (${sqlKeys.size} keys)`);
}

// ─── call admission ─────────────────────────────────────────────────────
function makeAdmission({ db, env = {}, isHcgNumber = async () => false, verifyActive = async () => true } = {}) {
  const audits = [];
  const memory = createCallConcurrencyTracker({ maxCallsPerHousehold: 3, burstMaxAttempts: 10, burstWindowMs: 120000, callerMaxAttempts: 6, callerWindowMs: 600000, verifyActive });
  const ended = [];
  const admission = createCallAdmission({
    admitCallDb: db, endCallDb: async (p) => { ended.push(p); return { ok: true }; },
    memory, recordIntervention: async (e) => { audits.push(e); }, isHcgNumber, env: { SAFETY_BUDGET_CHECK_TIMEOUT_MS: '50', ...env },
  });
  return { admission, audits, memory, ended };
}
const HH = { id: 'hh-1' };
{
  const seen = [];
  const ok = makeAdmission({ db: async (p) => { seen.push(p); return { allowed: true, reason: null }; } });
  const a = await ok.admission.admit({ household: HH, callSid: 'CA1', from: '+447700900123', to: '+441615700779', isKnown: true, signatureValid: true });
  check(a.allowed && a.source === 'database' && a.maxCallSeconds === 14400 && seen[0].limits.maxCallsPerHousehold === 3, 'a signed call is admitted by the database with the Layer B limits; the Dial timeLimit is 4 h');
  check(seen[0].callerKey && !JSON.stringify(seen[0]).includes('7700900123'), 'the caller is identified by a salted hash, never the phone number');
  check(ok.memory.activeFor('hh-1') === 1, 'admitted calls are mirrored in memory for the fallback');
  await ok.admission.end({ callSid: 'CA1', source: 'dial_action' });
  check(ok.memory.activeFor('hh-1') === 0 && ok.ended[0].callSid === 'CA1', 'ending a call releases it and closes the database session');

  const unsigned = makeAdmission({ db: async () => { throw new Error('must not be called'); } });
  const u = await unsigned.admission.admit({ household: HH, callSid: 'CAu', from: '+447700900123', to: '+441615700779', isKnown: false, signatureValid: false });
  check(u.allowed && u.source === 'not_counted' && unsigned.audits.some((e) => e.rule === 'voice_signature_unverified' && e.level === 'critical'),
    'an unsigned /voice request is answered but never counted (forged requests can\'t exhaust a household\'s limits) — and it is alerted');

  const rej = makeAdmission({ db: async () => ({ allowed: false, reason: 'household_burst', burstAttempts: 11 }) });
  const results = [];
  for (let i = 0; i < 50; i++) results.push(await rej.admission.admit({ household: HH, callSid: `CAb${i}`, from: '+447700900999', to: '+441615700779', isKnown: false, signatureValid: true }));
  check(results.every((r) => !r.allowed && r.reason === 'household_burst' && r.level === 'critical'), 'a database refusal is returned with its level (burst → critical)');
  check(rej.audits.filter((e) => e.rule === 'household_burst').length === 1, 'a flood of 50 refusals is audited/alerted once per 10 minutes, not 50 times');

  const loopSeen = [];
  const loop = makeAdmission({ db: async (p) => { loopSeen.push(p.isLoop); return { allowed: false, reason: 'forwarding_loop' }; }, isHcgNumber: async (n) => n === '+441615700111' });
  const l = await loop.admission.admit({ household: HH, callSid: 'CAl', from: '+441615700111', to: '+441615700779', isKnown: false, signatureValid: true });
  check(loopSeen[0] === true && !l.allowed && l.reason === 'forwarding_loop', 'a call FROM an HCG number is flagged as a forwarding loop and refused');
  const hung = makeAdmission({ db: async () => ({ allowed: true }), isHcgNumber: () => new Promise(() => {}) });
  const t0 = Date.now();
  const h = await hung.admission.admit({ household: HH, callSid: 'CAh', from: '+447700900321', to: '+441615700779', isKnown: false, signatureValid: true });
  check(h.allowed && Date.now() - t0 < 1000, 'a hung loop lookup cannot delay call delivery (bounded by the check timeout)');
}
{
  // Fail-safe: database unavailable → memory limits, alerted; never unlimited, never blocking genuine calls.
  const slow = makeAdmission({ db: () => new Promise(() => {}) });
  const concurrent = await Promise.all(Array.from({ length: 10 }, (_, i) => slow.admission.admit({ household: HH, callSid: `CAs${i}`, from: `+4477009001${10 + i}`, to: '+441615700779', isKnown: false, signatureValid: true })));
  check(concurrent.filter((r) => r.allowed).length === 3 && concurrent.every((r) => r.source === 'memory_fallback'),
    'database timeout: 10 simultaneous calls → exactly 3 admitted by the in-memory fallback (race-safe)');
  check(slow.audits.some((e) => e.rule === 'admission_database_unavailable' && e.level === 'critical'), 'the fallback raises a CRITICAL alert (£ ceilings are not being evaluated)');
  const blind = makeAdmission({ db: () => new Promise(() => {}), verifyActive: null });
  const blindRes = await Promise.all(Array.from({ length: 20 }, (_, i) => blind.admission.admit({ household: HH, callSid: `CAv${i}`, from: `+4477009002${10 + i}`, to: '+441615700779', isKnown: false, signatureValid: true })));
  check(blindRes.filter((r) => r.allowed).length === 6, 'database AND provider verification unavailable: still bounded — at most 2 × the limit (6 of 20) admitted');
  const failing = makeAdmission({ db: async () => { throw new Error('connection refused'); } });
  const first = await failing.admission.admit({ household: HH, callSid: 'CAf1', from: '+447700900555', to: '+441615700779', isKnown: true, signatureValid: true });
  check(first.allowed, 'with the database down, a normal call is still delivered');
  const retry = await failing.admission.admit({ household: HH, callSid: 'CAf1', from: '+447700900555', to: '+441615700779', isKnown: true, signatureValid: true });
  check(retry.allowed && failing.memory.activeFor('hh-1') === 1, 'a Twilio retry of the same CallSid is not counted twice (fallback)');
  const flood = makeAdmission({ db: async () => { throw new Error('down'); } });
  const f = [];
  for (let i = 0; i < 8; i++) { const r = await flood.admission.admit({ household: HH, callSid: `CAc${i}`, from: '07700 900777', to: '+441615700779', isKnown: false, signatureValid: true }); f.push(r.reason); await flood.admission.end({ callSid: `CAc${i}` }); }
  check(f[6] === 'caller_flood', 'fallback still refuses a repeat-caller flood (7th call in 10 min)');
  check(callerKey('+44 7700 900777') === callerKey('07700900777') && callerKey('Anonymous') === null, 'caller keys ignore number formatting; withheld numbers have no key');
}

// ─── monitoring gate ────────────────────────────────────────────────────
{
  const calls = [];
  const deps = (impl) => ({ beginMonitoringSession: async (p) => { calls.push(p); return impl(p); }, env: { SAFETY_BUDGET_CHECK_TIMEOUT_MS: '50' } });
  const ent = { plan_code: 'standard', source: 'stripe', starts_at: '2026-01-01T00:00:00Z' };
  const ok = await requestMonitoring({ household: HH, callSid: 'CAm1', entitlement: ent, deps: deps(() => ({ allowed: true, periodSeconds: 10 })) });
  check(ok.monitor && calls[0].enforceAllowance === false && calls[0].allowanceSeconds === 6000 && calls[0].limits.maxHouseholdStreams === 2, 'monitoring gate passes the plan (not enforced by default) and the Layer B stream/£ ceilings');
  const unsigned = await requestMonitoring({ household: HH, callSid: 'CAm2', entitlement: ent, countable: false, deps: deps(() => ({ allowed: true })) });
  check(!unsigned.monitor && calls.length === 1 && unsigned.monitoringStatus === MONITORING_STATUS.UNAVAILABLE, 'an unsigned request never reserves paid monitoring');
  const slow = await requestMonitoring({ household: HH, callSid: 'CAm3', entitlement: ent, deps: { beginMonitoringSession: () => new Promise(() => {}), env: { SAFETY_BUDGET_CHECK_TIMEOUT_MS: '30' } } });
  check(!slow.monitor && slow.reason === 'safety_check_unavailable', 'a budget check that times out means NO monitoring (fail closed), call unaffected');
  const exhausted = await requestMonitoring({ household: HH, callSid: 'CAm4', entitlement: ent, deps: deps(() => ({ allowed: false, reason: 'allowance_exhausted', periodSeconds: 6000 })) });
  check(exhausted.monitoringStatus === 'not_monitored_allowance_exhausted', 'allowance exhausted → the call is logged as not monitored (allowance), never as monitored');
  const off = await requestMonitoring({ household: HH, callSid: 'CAm5', entitlement: ent, deps: { ...deps(() => ({ allowed: true })), env: { MONITORING_EMERGENCY_DISABLED: 'true' } } });
  check(!off.monitor && off.reason === 'emergency_disabled', 'the env kill switch stops new monitoring without touching the database');
}

// ─── warning points ─────────────────────────────────────────────────────
{
  const claimed = new Set();
  const claim = async ({ kind }) => (claimed.has(kind) ? false : (claimed.add(kind), true));
  const delivered = [];
  const deliver = async (d) => { delivered.push(d.kind); };
  const r74 = await notifyUsageThresholds({ householdId: 'h', periodStart: 'p', usedSeconds: 4440, allowanceSeconds: 6000, claim, deliver });
  const r75 = await notifyUsageThresholds({ householdId: 'h', periodStart: 'p', usedSeconds: 4500, allowanceSeconds: 6000, claim, deliver });
  const r75b = await notifyUsageThresholds({ householdId: 'h', periodStart: 'p', usedSeconds: 4600, allowanceSeconds: 6000, claim, deliver });
  const r100 = await notifyUsageThresholds({ householdId: 'h', periodStart: 'p', usedSeconds: 6100, allowanceSeconds: 6000, claim, deliver });
  check(r74.claimed === null && r75.claimed === 'warn_75' && r75b.claimed === null, '75% is claimed once, at the crossing');
  check(r100.claimed === 'exhausted_100' && claimed.has('warn_90') && delivered.join() === 'warn_75,exhausted_100', 'jumping past 90% to 100% claims both but delivers only the highest (no out-of-order 90% later)');
}

// ─── Build 20 allowance contract ────────────────────────────────────────
{
  const plan = resolvePlan('standard', {});
  const enforced = resolvePlan('standard', { MONITORING_ALLOWANCE_ENFORCED: 'true' });
  const s42 = computeAllowanceStatus({ plan: enforced, usedSeconds: 42 * 60 + 59, periodStart: '2026-09-12T09:00:00Z', periodEnd: '2026-10-12T09:00:00Z' });
  check(s42.usedMinutes === 42 && s42.remainingMinutes === 58 && s42.usedPercent === 42 && s42.allowanceMinutes === 100 && s42.state === 'available' && s42.monitoringActive === true,
    '"42 of 100 minutes used, 58 remaining" (partial minutes round in the customer\'s favour)');
  const s80 = computeAllowanceStatus({ plan: enforced, usedSeconds: 4800, periodEnd: null });
  check(s80.state === 'low' && s80.monitoringActive, '80% used → state low, still monitored');
  const s100 = computeAllowanceStatus({ plan: enforced, usedSeconds: 6000, periodEnd: '2026-10-12T09:00:00Z' });
  check(s100.state === 'exhausted' && s100.monitoringActive === false && s100.callsContinue === true && s100.remainingMinutes === 0 && s100.resetsAt === '2026-10-12T09:00:00.000Z',
    'exhausted (enforced) → explicit state: monitoring off, calls continue, resets at the next renewal');
  const notEnforced = computeAllowanceStatus({ plan, usedSeconds: 7000, periodEnd: null });
  check(notEnforced.state === 'low' && notEnforced.overAllowance === true && notEnforced.monitoringActive === true, 'not enforced: usage over 100% is reported but monitoring is (truthfully) still active');
  const paused = computeAllowanceStatus({ plan: enforced, usedSeconds: 60, periodEnd: null, safetyPaused: true });
  check(paused.state === 'paused' && paused.monitoringActive === false && paused.callsContinue, 'a Layer B safety pause → state paused, calls continue');
  const bonus = computeAllowanceStatus({ plan: enforced, usedSeconds: 6000, bonusSeconds: 1800, periodEnd: null });
  check(bonus.allowanceMinutes === 130 && bonus.state !== 'exhausted', 'future top-up seconds extend the displayed and enforced allowance');
  const failed = await getHouseholdAllowance({ household: HH, entitlement: null, deps: { getUsagePeriod: async () => { throw new Error('db'); }, getHouseholdDayUsage: async () => null, getSafetyState: async () => null } });
  check(failed.state === 'unavailable' && failed.monitoringActive === null && failed.usedMinutes === null, 'unreadable usage → unavailable with monitoringActive null — never a guess of "protected"');
  const dayPaused = await getHouseholdAllowance({ household: HH, entitlement: null, env: {}, deps: {
    getUsagePeriod: async () => ({ monitored_seconds: 600, bonus_monitored_seconds: 0, monitoring_cost_gbp: 0.1 }),
    getHouseholdDayUsage: async () => ({ monitoring_cost_gbp: 1.6 }), getSafetyState: async () => ({ monitoring_suspended: false }),
    getClaimedNotifications: async () => [{ kind: 'warn_75' }],
  } });
  check(dayPaused.state === 'paused' && dayPaused.lastWarningPoint === 75, 'the household daily monitoring ceiling shows as paused; the last claimed warning point is exposed');
}

// ─── SMS budget ─────────────────────────────────────────────────────────
{
  const sent = [];
  const client = { messages: { create: async (p) => { sent.push(p); return { sid: 'SM' }; } } };
  const audits = [];
  const period = () => ({ periodStart: '2026-09-12T09:00:00Z', periodEnd: '2026-10-12T09:00:00Z' });
  const allow = createSmsBudget({ client, claimSmsSend: async () => ({ allowed: true }), recordIntervention: async (e) => audits.push(e) }).forHousehold('hh-1', period);
  await allow.messages.create({ to: 'x', body: 'b' });
  const deny = createSmsBudget({ client, claimSmsSend: async () => ({ allowed: false, reason: 'household_daily_sms_limit' }), recordIntervention: async (e) => audits.push(e) }).forHousehold('hh-1', period);
  let threw = false;
  try { await deny.messages.create({ to: 'x', body: 'b' }); } catch { threw = true; }
  const down = createSmsBudget({ client, claimSmsSend: async () => { throw new Error('db'); } }).forHousehold('hh-1', period);
  await down.messages.create({ to: 'x', body: 'b' });
  check(sent.length === 2 && threw && audits.some((e) => e.rule === 'household_daily_sms_limit'), 'SMS: sent within budget, refused (and audited) over it, sent anyway if the budget can\'t be checked (protection message)');
}

// ─── live-monitoring handler: mid-call rules ────────────────────────────
const FRAME = () => Buffer.alloc(160, 0x80);
const start = (sid, callSid) => JSON.stringify({ event: 'start', start: { streamSid: sid, callSid, customParameters: { householdId: 'hh-1', toNumber: '+447700900300', protectedNumber: '+441615700779' } } });
const media = (sid) => JSON.stringify({ event: 'media', streamSid: sid, media: { payload: FRAME().toString('base64') } });
function makeClock() { let t = Date.parse('2026-09-30T10:00:00Z'); const fn = () => new Date(t); fn.advance = (ms) => { t += ms; }; return fn; }
function makeMeter({ enforce, usedBefore = 0, allowance = 6000, grace = 300, attachOk = true }) {
  let period = usedBefore;
  const counted = new Map();
  const m = {
    graceSeconds: grace, interventions: [], progressCalls: [], notifies: 0,
    attach: async ({ callSid }) => (attachOk ? { ok: true, householdId: 'hh-1', periodStart: '2026-09-12T09:00:00Z', periodEnd: '2026-10-12T09:00:00Z', allowanceSeconds: allowance, enforceAllowance: enforce } : { ok: false, reason: 'no_reservation' }),
    progress: async (p) => {
      m.progressCalls.push(p);
      const prev = counted.get(p.callSid) || 0;
      const delta = Math.max(0, p.totalSeconds - prev);
      counted.set(p.callSid, prev + delta);
      period += delta;
      return { ok: true, householdId: 'hh-1', periodStart: '2026-09-12T09:00:00Z', periodSeconds: period, periodCostGbp: 0, dayCostGbp: 0, globalHourCostGbp: 0,
        allowanceSeconds: allowance, enforceAllowance: enforce, dailyCostLimitGbp: 1.5, periodCostLimitGbp: 5 };
    },
    notify: async () => { m.notifies++; return { claimed: null }; },
    recordIntervention: async (e) => { m.interventions.push(e); },
  };
  return m;
}
async function runStream({ meter, seconds, restCalls, outcomes, clock = makeClock(), closeCounter = { n: 0 } }) {
  const requests = [];
  const handler = createMediaStreamHandler({
    // Integration 2026-10-03: since security/voice-surface-p0 a stream with no
    // authoriser is refused (fail closed). This metering test trusts the
    // stream explicitly, as voice-p0's own tests do; stream authentication
    // itself is covered by tests/media-stream-auth-and-cost-caps.test.mjs.
    authorizeStream: ({ callSid }) => ({ householdId: 'hh-1', callSid, toNumber: '+447700900123', fromNumber: '+441615700779' }),
    transcribeClient: { transcribe: async () => { requests.push(1); return 'hello there'; } },
    smsClient: { messages: { create: async () => ({ sid: 'SM' }) } },
    fromNumber: '+441615700779',
    twilioRestClient: { calls: () => ({ update: async () => { restCalls.push(1); } }) },
    usageMeter: meter,
    safetyConfig: resolveSafetyConfig({}),
    sendAlert: async () => true,
    recordOutcome: async (o) => { outcomes.push(o); },
    now: clock,
  });
  await handler.handleMessage(start('MZ1', 'CA1'), { closeConnection: () => { closeCounter.n++; } });
  await sleep(0);
  for (let i = 0; i < seconds * 50; i++) { clock.advance(20); await handler.handleMessage(media('MZ1'), { closeConnection: () => {} }); if (i % 250 === 0) await sleep(0); }
  await sleep(5);
  return { requests, handler };
}
{
  // Allowance (enforced) runs out mid-call: 5,900 s used before; after 100 s + 300 s grace monitoring stops.
  const restCalls = []; const outcomes = []; const closed = { n: 0 };
  const meter = makeMeter({ enforce: true, usedBefore: 5900 });
  const { requests } = await runStream({ meter, seconds: 480, restCalls, outcomes, closeCounter: closed });
  const stop = meter.interventions.find((e) => e.rule === 'allowance_exhausted_mid_call');
  const final = meter.progressCalls.find((p) => p.final);
  check(stop && stop.level === 'info' && final && final.endReason === 'allowance_exhausted_mid_call', 'allowance reached during a call → monitoring stops after the grace period (info, not an incident)');
  check(final.totalSeconds >= 400 && final.totalSeconds <= 415, `monitoring ran ~100 s to exhaustion + 300 s grace, then stopped (${final.totalSeconds} s)`);
  check(restCalls.length === 0 && closed.n === 1, 'only the Media Stream is closed — the phone call itself is never touched');
  const reqAtStop = requests.length;
  check(outcomes[0] && outcomes[0].monitoringStopReason === 'allowance_exhausted_mid_call', 'the call is recorded as monitoring-stopped (allowance), so no surface claims it was monitored throughout');
  check(reqAtStop > 0 && reqAtStop <= Math.ceil(415 / 3) + 2, `no transcription after the stop (${reqAtStop} requests for ≤ 415 s of audio)`);
}
{
  const restCalls = []; const outcomes = [];
  const meter = makeMeter({ enforce: false, usedBefore: 5900 });
  await runStream({ meter, seconds: 480, restCalls, outcomes });
  check(!meter.interventions.some((e) => e.rule === 'allowance_exhausted_mid_call'), 'allowance NOT enforced (pre-approval default): monitoring continues past 100% — metered only');
}
{
  // Forged "start" with no /voice reservation: never transcribed.
  const restCalls = []; const outcomes = [];
  const meter = makeMeter({ enforce: false, attachOk: false });
  const { requests } = await runStream({ meter, seconds: 20, restCalls, outcomes });
  check(requests.length === 0 && meter.interventions.some((e) => e.rule === 'no_budget_reservation'), 'a Media Stream with no reservation from a signed /voice request is never transcribed (no paid AI for forged streams)');
}

// ─── server wiring (source-level invariants) ────────────────────────────
{
  const server = readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const voice = server.match(/app\.post\("\/voice",[^\n]*async \(req, res\) => \{[\s\S]*?\n\}\);\n/)[0];
  const admitIdx = voice.indexOf('await callAdmission.admit(');
  const firstTwiml = Math.min(...['twiml.say(', 'attachLiveMonitoring(twiml', 'dialHouseholdOrFailClosed(twiml'].map((k) => voice.indexOf(k)).filter((i) => i >= 0));
  check(admitIdx > 0 && admitIdx < firstTwiml, 'admission runs before any billable TwiML (greeting, stream or dial)');
  const rejectBlock = voice.slice(voice.indexOf('if (!admission.allowed) {'), voice.indexOf('const dialOptions'));
  check(/twiml\.reject\(\{ reason: "busy" \}\)/.test(rejectBlock) && !/twiml\.(say|dial|play|pause)\(/.test(rejectBlock) && !/logCall\(/.test(rejectBlock),
    'a refused call gets <Reject> as its only verb (unbilled) and is not written to the customer\'s call history');
  check((voice.match(/dialHouseholdOrFailClosed\(twiml, household, dialOptions\)/g) || []).length === 2, 'both dial sites carry the per-call timeLimit');
  check(/timeLimit: dialOptions\.timeLimit/.test(server), 'the <Dial> sets timeLimit from financial safety');
  check((server.match(/callAdmission\.end\(\{ callSid: req\.body\.CallSid, source: "dial_action" \}\)/g) || []).length === 2, 'both <Dial> action callbacks close the admission session');
  const usageRoute = server.match(/app\.post\("\/webhooks\/provider-usage-alert"[\s\S]*?\n\}\);\n/)[0];
  check(/isGenuineTwilioRequest/.test(usageRoute) && /status\(403\)/.test(usageRoute), 'the provider usage-alert webhook refuses unsigned requests');
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
