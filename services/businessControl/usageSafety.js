// Operations → Usage & cost safety (2026-10-01). Answers "is call and
// monitoring usage inside safe bounds, and which limits actually exist?"
// from data the deployed code ALREADY records — nothing is invented:
//
//   calls.duration_seconds            (034; Twilio-reported, approved calls)
//   calls.monitored_duration_seconds  (034; how long live monitoring ran)
//   calls.monitoring_limit_reached    (034; per-call monitoring cap hit)
//   calls.dial_call_status            (044; raw Twilio DialCallStatus)
//   calls.terminated_by_system        (025; red-line termination)
//   calls.warning_sent                (024; customer warning SMS)
//
// Everything else that matters for cost safety is either only in server
// logs / alert e-mails today (stream refusals at the concurrency cap,
// transcription failures, rapid-abuse alerts as sent) or not built yet
// (per-household allowance, concurrency and £ ceilings — branches
// feature/financial-safety-hard-limits and security/voice-surface-p0).
// Those are listed as NOT RECORDED / NOT IN THIS BUILD, never as zero.
//
// Rules:
//   - a call with no recorded duration is "not measured", never 0 min;
//     totals that exclude such calls say so (measured part only);
//   - concurrency is ESTIMATED from start time + recorded duration, so a
//     peak is a lower bound whenever durations are missing;
//   - unusual-usage signals use the SAME thresholds the live alerting uses
//     (services/rapidAbuseDetection.js, businessMetrics fair use), so the
//     dashboard shows what the alerts would have said, recomputed;
//   - caller numbers are masked to their last 3 digits;
//   - nothing here acts: no call, number or household is changed.
// STRICTLY OBSERVATIONAL. Pure except loadUsageSafety().
'use strict';

const fs = require('fs');
const path = require('path');
const { normaliseNumber } = require('../phone');
const {
  resolveDailyUnknownCallAlertThreshold,
  resolveRepeatCallerWindowMs,
  resolveRepeatCallerCountThreshold,
} = require('../rapidAbuseDetection');
const { resolveMonitoringMaxDurationMs, resolveMaxConcurrentStreams } = require('../liveMonitoring/monitoringLimit');
const { resolveFairUseThresholds } = require('../businessMetrics/config');

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const TRAILING_DAYS = 7;
const SERIES_DAYS = 14;
// Twilio <Dial> timeLimit default when the verb sets none (Twilio docs:
// "timeLimit … default 14400 seconds"). This build sets none — pinned by
// tests/usage-safety.test.mjs so the statement cannot go stale silently.
const TWILIO_DIAL_DEFAULT_TIME_LIMIT_SECONDS = 14400;
const LONG_CALL_SECONDS = 60 * 60;
// An approved call's Twilio outcome normally lands within seconds of the
// call ending; after this long a missing one is a recording gap.
const OUTCOME_GRACE_MS = 2 * HOUR_MS;
// Spike rule (stated in the UI): today's monitored minutes ≥ SPIKE_RATIO ×
// the trailing 7-day daily average AND ≥ SPIKE_MIN_MINUTES above it.
const SPIKE_RATIO = 3;
const SPIKE_MIN_MINUTES = 10;

const ROOT = path.join(__dirname, '..', '..');

function startOfUtcDay(ms) {
  const d = new Date(ms);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}
function startOfUtcMonth(ms) {
  const d = new Date(ms);
  d.setUTCDate(1);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}
const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);
const mins = (seconds) => Math.round((seconds / 60) * 10) / 10;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;

function maskCaller(number) {
  const digits = String(number || '').replace(/\D/g, '');
  return digits.length >= 3 ? '•••' + digits.slice(-3) : '•••';
}

// Pure. Minutes for one set of calls: measured totals plus how many calls
// could not be measured (so a total is never mistaken for complete).
function summariseMinutes(calls) {
  let callSeconds = 0, monitoredSeconds = 0, knownSeconds = 0, unknownSeconds = 0;
  let durationMissing = 0, monitoredMissing = 0, unknown = 0, known = 0, limitReached = 0, warnings = 0;
  for (const c of calls) {
    const isUnknown = c.status === 'Unknown';
    if (isUnknown) unknown++; else known++;
    if (isNum(c.duration_seconds)) {
      callSeconds += c.duration_seconds;
      if (isUnknown) unknownSeconds += c.duration_seconds; else knownSeconds += c.duration_seconds;
    } else if (c.result === 'SAFE') {
      // Only approved (SAFE) calls are dialled and so ever get a duration;
      // a blocked call's missing duration is expected, not a gap.
      durationMissing++;
    }
    if (isUnknown) {
      if (isNum(c.monitored_duration_seconds)) monitoredSeconds += c.monitored_duration_seconds;
      else monitoredMissing++;
    }
    if (c.monitoring_limit_reached) limitReached++;
    if (c.warning_sent) warnings++;
  }
  return {
    calls: calls.length,
    knownCalls: known,
    unknownCalls: unknown,
    callMinutes: mins(callSeconds),
    trustedCallMinutes: mins(knownSeconds),
    unknownCallMinutes: mins(unknownSeconds),
    monitoredMinutes: mins(monitoredSeconds),
    callsWithoutDuration: durationMissing,
    unknownCallsWithoutMonitoringRecord: monitoredMissing,
    monitoringLimitReached: limitReached,
    warningSmsSent: warnings,
  };
}

// Pure. Peak simultaneous intervals via a sweep. Intervals with no
// recorded length are skipped and counted, so the peak is a lower bound.
function peakConcurrency(calls, secondsField) {
  const events = [];
  let skipped = 0;
  for (const c of calls) {
    const start = new Date(c.created_at).getTime();
    const len = c[secondsField];
    if (!Number.isFinite(start) || !isNum(len) || len === 0) { skipped++; continue; }
    events.push([start, 1], [start + len * 1000, -1]);
  }
  // Ends sort before starts at the same instant: back-to-back is not overlap.
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0, peak = 0, peakAt = null;
  for (const [t, d] of events) {
    cur += d;
    if (cur > peak) { peak = cur; peakAt = t; }
  }
  return { peak, peakAt: peakAt === null ? null : new Date(peakAt).toISOString(), intervalsWithoutLength: skipped };
}

// Pure. Same rule as the live repeat-caller alert: ≥ threshold calls from
// one caller number to one household inside the window. One finding per
// (household, caller) with the worst window.
function findRepeatCallerBursts(calls, { windowMs, threshold }) {
  const groups = new Map();
  for (const c of calls) {
    const norm = normaliseNumber(c.number);
    if (!norm || !c.household_id) continue;
    const t = new Date(c.created_at).getTime();
    if (!Number.isFinite(t)) continue;
    const key = c.household_id + '|' + norm;
    if (!groups.has(key)) groups.set(key, { householdId: c.household_id, caller: maskCaller(norm), times: [] });
    groups.get(key).times.push(t);
  }
  const out = [];
  for (const g of groups.values()) {
    g.times.sort((a, b) => a - b);
    let best = 0, bestAt = null, i = 0;
    for (let j = 0; j < g.times.length; j++) {
      while (g.times[j] - g.times[i] > windowMs) i++;
      if (j - i + 1 > best) { best = j - i + 1; bestAt = g.times[j]; }
    }
    if (best >= threshold) out.push({ householdId: g.householdId, caller: g.caller, callsInWindow: best, totalCalls: g.times.length, at: new Date(bestAt).toISOString() });
  }
  return out.sort((a, b) => b.callsInWindow - a.callsInWindow);
}

// What actually bounds usage in THIS build. `present(rel)` reports whether
// a source file exists, so a control that lands from another branch is
// reported as "code present — verify configuration" instead of staying
// described as missing.
function describeControls({ env, present }) {
  const monitoringMin = Math.round(resolveMonitoringMaxDurationMs(env) / 60000);
  const streamCap = resolveMaxConcurrentStreams(env);
  const fairUse = resolveFairUseThresholds(env);
  const notBuilt = (rel, branch) => (present(rel)
    ? { mode: 'present_unverified', note: `Code present (${rel}); the dashboard does not read its configuration — verify it is enabled.` }
    : { mode: 'not_in_build', note: `Not in this build. Designed on ${branch}; not deployed.` });
  return [
    { id: 'monitoring_per_call', label: 'Live monitoring per call', limit: `${monitoringMin} min`, mode: 'enforced',
      effect: 'Monitoring (transcription/scoring) stops; the call itself stays connected and the customer is sent an SMS.',
      evidence: 'Recorded: calls.monitoring_limit_reached', source: env.MONITORING_MAX_DURATION_MINUTES ? 'MONITORING_MAX_DURATION_MINUTES' : 'default' },
    { id: 'streams_concurrent_global', label: 'Simultaneous monitoring streams (whole server)', limit: String(streamCap), mode: 'enforced',
      effect: 'A new stream over the cap is refused (no monitoring for that call); the call still rings.',
      evidence: 'NOT recorded in the database — server log + alert e-mail only. Refusals cannot be counted here.', source: env.MEDIA_STREAM_MAX_CONCURRENT_STREAMS ? 'MEDIA_STREAM_MAX_CONCURRENT_STREAMS' : 'default' },
    { id: 'call_length', label: 'Call length (Twilio <Dial>)', limit: `${TWILIO_DIAL_DEFAULT_TIME_LIMIT_SECONDS / 3600} h (Twilio default)`, mode: 'provider_default',
      effect: 'No timeLimit is set, so Twilio\'s default applies: one call can bill inbound minutes for up to 4 hours.',
      evidence: 'calls.duration_seconds (longest call shown below)', source: 'server.js sets no timeLimit' },
    { id: 'rapid_daily', label: 'Unknown calls per household per day', limit: String(resolveDailyUnknownCallAlertThreshold(env)), mode: 'alert_only',
      effect: 'E-mail alert only; calls are never blocked.', evidence: 'Recomputed below from calls (alert e-mails themselves are not stored)', source: env.RAPID_ABUSE_DAILY_UNKNOWN_CALL_THRESHOLD ? 'RAPID_ABUSE_DAILY_UNKNOWN_CALL_THRESHOLD' : 'default' },
    { id: 'rapid_repeat', label: 'Same caller repeatedly', limit: `${resolveRepeatCallerCountThreshold(env)} in ${Math.round(resolveRepeatCallerWindowMs(env) / 60000)} min`, mode: 'alert_only',
      effect: 'E-mail alert only; calls are never blocked.', evidence: 'Recomputed below from calls', source: 'RAPID_ABUSE_REPEAT_CALLER_* or default' },
    { id: 'fair_use', label: 'Unknown calls per household per month', limit: `${fairUse.warningCallsPerMonth} / ${fairUse.hardCallsPerMonth}`, mode: 'visibility_only',
      effect: 'Dashboard tier only (Operations → Call activity). Nothing is restricted.', evidence: 'calls (count, not minutes)', source: 'BUSINESS_FAIR_USE_* or default' },
    { id: 'household_streams', label: 'Simultaneous streams per household', limit: '—', ...notBuilt('services/liveMonitoring/costCaps.js', 'security/voice-surface-p0'),
      effect: 'One household can run as many monitored calls at once as the whole-server cap allows.', evidence: 'Estimated peak per household below', source: '—' },
    { id: 'household_allowance', label: 'Monitored minutes per household per period', limit: '—', ...notBuilt('services/usage/householdAllowance.js', 'feature/financial-safety-hard-limits (migration 056, draft)'),
      effect: 'Monitored minutes are recorded per call but never summed or limited at call time.', evidence: 'Per-household minutes below (this dashboard sums them)', source: '—' },
    { id: 'household_concurrency', label: 'Simultaneous calls per household', limit: '—', ...notBuilt('services/usage/callConcurrency.js', 'feature/financial-safety-hard-limits'),
      effect: 'No per-household call admission limit.', evidence: 'Estimated peak per household below', source: '—' },
    { id: 'spend_ceilings', label: '£ spend per household / company', limit: '—', ...notBuilt('services/usage/callAdmission.js', 'feature/financial-safety-hard-limits + ledger'),
      effect: 'No £ ceiling. Money → Spend safety shows provider spend once the spend monitor is connected.', evidence: 'Money tab', source: '—' },
    { id: 'sms_budget', label: 'Warning SMS volume', limit: '—', ...notBuilt('services/usage/smsBudget.js', 'feature/financial-safety-hard-limits / security/voice-surface-p0'),
      effect: 'No cap on in-call warning SMS.', evidence: 'calls.warning_sent (count below); the limit-reached SMS is not recorded', source: '—' },
  ];
}

// Pure.
function computeUsageSafety({ calls, households = [], classificationMap = new Map(), env = {}, present = () => false, truncated = false }, now) {
  const nowMs = now.getTime();
  const todayStart = startOfUtcDay(nowMs);
  const monthStart = startOfUtcMonth(nowMs);
  const trailingStart = todayStart - TRAILING_DAYS * DAY_MS;
  const rows = (calls || []).filter((c) => Number.isFinite(new Date(c.created_at).getTime()));
  const at = (c) => new Date(c.created_at).getTime();

  const today = rows.filter((c) => at(c) >= todayStart);
  const mtd = rows.filter((c) => at(c) >= monthStart);
  const last7 = rows.filter((c) => at(c) >= trailingStart && at(c) < todayStart);

  const windows = { today: summariseMinutes(today), last7Days: summariseMinutes(last7), monthToDate: summariseMinutes(mtd) };

  // Daily series (oldest first) — monitored minutes and calls per UTC day.
  const series = [];
  for (let i = SERIES_DAYS - 1; i >= 0; i--) {
    const s = todayStart - i * DAY_MS;
    const day = rows.filter((c) => at(c) >= s && at(c) < s + DAY_MS);
    const m = summariseMinutes(day);
    series.push({ day: dayKey(s), calls: m.calls, unknownCalls: m.unknownCalls, monitoredMinutes: m.monitoredMinutes, callMinutes: m.callMinutes, partial: i === 0 });
  }

  const hh = new Map((households || []).map((h) => [h.id, h]));
  const classOf = (id) => {
    const cls = classificationMap.get(id);
    return cls === 'genuine_customer' ? 'genuine' : cls || 'unclassified';
  };
  const label = (id) => (hh.get(id) && hh.get(id).email) || String(id).slice(0, 8);

  // Per household, month to date + its own trailing baseline.
  const dailyUnknownThreshold = resolveDailyUnknownCallAlertThreshold(env);
  const byHousehold = new Map();
  for (const c of rows) {
    if (!c.household_id) continue;
    if (!byHousehold.has(c.household_id)) byHousehold.set(c.household_id, []);
    byHousehold.get(c.household_id).push(c);
  }
  const householdRows = [];
  for (const [id, list] of byHousehold) {
    const mine = list.filter((c) => at(c) >= monthStart);
    const mineToday = list.filter((c) => at(c) >= todayStart);
    const mine7 = list.filter((c) => at(c) >= trailingStart && at(c) < todayStart);
    if (!mine.length && !mineToday.length) continue;
    const m = summariseMinutes(mine);
    const t = summariseMinutes(mineToday);
    const base = summariseMinutes(mine7);
    const unknownByDay = new Map();
    for (const c of mine) if (c.status === 'Unknown') unknownByDay.set(dayKey(at(c)), (unknownByDay.get(dayKey(at(c))) || 0) + 1);
    const [maxDay, maxDayCount] = [...unknownByDay.entries()].sort((a, b) => b[1] - a[1])[0] || [null, 0];
    const longest = mine.reduce((mx, c) => (isNum(c.duration_seconds) && c.duration_seconds > mx ? c.duration_seconds : mx), 0);
    householdRows.push({
      householdId: id,
      label: label(id),
      accountClass: classOf(id),
      monthToDate: m,
      today: { monitoredMinutes: t.monitoredMinutes, unknownCalls: t.unknownCalls, calls: t.calls },
      baselineDailyMonitoredMinutes: Math.round((base.monitoredMinutes / TRAILING_DAYS) * 10) / 10,
      peakDayUnknownCalls: maxDayCount,
      peakDay: maxDay,
      longestCallMinutes: mins(longest),
      peakConcurrentCalls: peakConcurrency(mine, 'duration_seconds').peak,
      peakConcurrentMonitored: peakConcurrency(mine.filter((c) => c.status === 'Unknown'), 'monitored_duration_seconds').peak,
    });
  }
  householdRows.sort((a, b) => b.monthToDate.monitoredMinutes - a.monthToDate.monitoredMinutes || b.monthToDate.callMinutes - a.monthToDate.callMinutes);

  // Concurrency, whole service, month to date (estimated lower bound).
  const concurrency = {
    calls: peakConcurrency(mtd, 'duration_seconds'),
    monitoredStreams: peakConcurrency(mtd.filter((c) => c.status === 'Unknown'), 'monitored_duration_seconds'),
    streamCap: resolveMaxConcurrentStreams(env),
  };

  // ---- Signals (unusual usage + relevant failures). Each states its rule.
  const signals = [];
  const sig = (id, severity, title, rule, items) => signals.push({ id, severity, title, rule, count: items.length, items });

  const dailyBursts = [];
  for (const h of householdRows) if (h.peakDayUnknownCalls >= dailyUnknownThreshold) dailyBursts.push({ householdId: h.householdId, label: h.label, accountClass: h.accountClass, detail: `${h.peakDayUnknownCalls} unknown calls on ${h.peakDay}` });
  sig('rapid_daily', dailyBursts.length ? 'amber' : 'green', 'Household over the daily unknown-call alert threshold',
    `≥ ${dailyUnknownThreshold} unknown-caller calls to one household in one UTC day (month to date). Same threshold as the live alert e-mail.`, dailyBursts);

  const repeat = findRepeatCallerBursts(mtd, { windowMs: resolveRepeatCallerWindowMs(env), threshold: resolveRepeatCallerCountThreshold(env) })
    .map((r) => ({ householdId: r.householdId, label: label(r.householdId), accountClass: classOf(r.householdId), detail: `caller ${r.caller}: ${r.callsInWindow} calls within ${Math.round(resolveRepeatCallerWindowMs(env) / 60000)} min (${r.totalCalls} this month)`, at: r.at }));
  sig('rapid_repeat', repeat.length ? 'amber' : 'green', 'Same caller calling repeatedly',
    `≥ ${resolveRepeatCallerCountThreshold(env)} calls from one caller number to one household within ${Math.round(resolveRepeatCallerWindowMs(env) / 60000)} minutes (month to date). Caller numbers masked.`, repeat);

  const spikes = [];
  const companyBase = windows.last7Days.monitoredMinutes / TRAILING_DAYS;
  if (windows.today.monitoredMinutes >= SPIKE_RATIO * companyBase && windows.today.monitoredMinutes - companyBase >= SPIKE_MIN_MINUTES) {
    spikes.push({ householdId: null, label: 'Whole service', detail: `${windows.today.monitoredMinutes} monitored min today vs ${Math.round(companyBase * 10) / 10}/day average` });
  }
  for (const h of householdRows) {
    if (h.today.monitoredMinutes >= SPIKE_RATIO * h.baselineDailyMonitoredMinutes && h.today.monitoredMinutes - h.baselineDailyMonitoredMinutes >= SPIKE_MIN_MINUTES) {
      spikes.push({ householdId: h.householdId, label: h.label, accountClass: h.accountClass, detail: `${h.today.monitoredMinutes} monitored min today vs ${h.baselineDailyMonitoredMinutes}/day average` });
    }
  }
  sig('usage_spike', spikes.length ? 'amber' : 'green', 'Monitored minutes well above normal today',
    `Today (UTC, so far) ≥ ${SPIKE_RATIO}× the trailing ${TRAILING_DAYS}-day daily average and at least ${SPIKE_MIN_MINUTES} min above it — whole service and per household.`, spikes);

  const capHits = mtd.filter((c) => c.monitoring_limit_reached).map((c) => ({ householdId: c.household_id, label: label(c.household_id), accountClass: classOf(c.household_id), detail: `monitoring stopped at the per-call limit${isNum(c.duration_seconds) ? ` · call lasted ${mins(c.duration_seconds)} min` : ''}`, at: c.created_at }));
  sig('monitoring_cap', capHits.length ? 'amber' : 'green', 'Calls that hit the per-call monitoring limit',
    'calls.monitoring_limit_reached (month to date). Monitoring stopped; the rest of the call was unprotected but still billed for inbound minutes.', capHits);

  const longCalls = mtd.filter((c) => isNum(c.duration_seconds) && c.duration_seconds >= LONG_CALL_SECONDS).map((c) => ({ householdId: c.household_id, label: label(c.household_id), accountClass: classOf(c.household_id), detail: `${mins(c.duration_seconds)} min · ${c.status === 'Unknown' ? 'unknown caller' : 'trusted contact'}`, at: c.created_at }));
  sig('long_calls', longCalls.length ? 'amber' : 'green', 'Calls of an hour or more',
    `duration_seconds ≥ ${LONG_CALL_SECONDS / 60} min (month to date). No call-length limit is set, so Twilio's ${TWILIO_DIAL_DEFAULT_TIME_LIMIT_SECONDS / 3600}-hour default is the only bound.`, longCalls);

  const failedDelivery = mtd.filter((c) => c.dial_call_status === 'failed').map((c) => ({ householdId: c.household_id, label: label(c.household_id), accountClass: classOf(c.household_id), detail: 'Twilio DialCallStatus = failed', at: c.created_at }));
  sig('delivery_failed', failedDelivery.length ? 'red' : 'green', 'Approved calls Twilio could not deliver',
    'dial_call_status = "failed" (month to date). No-answer, busy and cancelled are normal and not counted.', failedDelivery);

  const missingOutcome = mtd.filter((c) => c.result === 'SAFE' && !c.dial_call_status && !isNum(c.duration_seconds) && !c.terminated_by_system && nowMs - at(c) > OUTCOME_GRACE_MS)
    .map((c) => ({ householdId: c.household_id, label: label(c.household_id), accountClass: classOf(c.household_id), detail: 'approved call with no Twilio outcome or duration recorded', at: c.created_at }));
  sig('outcome_not_recorded', missingOutcome.length ? 'amber' : 'green', 'Approved calls with no recorded outcome',
    `Approved (SAFE) calls older than ${OUTCOME_GRACE_MS / HOUR_MS} h with neither dial_call_status nor duration_seconds (month to date). Their minutes are unmeasured, not zero — the known "CALL DURATION RECORD FAILED" gap or a caller who hung up during screening.`, missingOutcome);

  const noMonitoring = mtd.filter((c) => c.status === 'Unknown' && c.dial_call_status === 'completed' && !isNum(c.monitored_duration_seconds) && nowMs - at(c) > OUTCOME_GRACE_MS)
    .map((c) => ({ householdId: c.household_id, label: label(c.household_id), accountClass: classOf(c.household_id), detail: `connected unknown-caller call${isNum(c.duration_seconds) ? ` (${mins(c.duration_seconds)} min)` : ''} with no monitoring record`, at: c.created_at }));
  sig('monitoring_not_recorded', noMonitoring.length ? 'amber' : 'green', 'Connected unknown calls with no monitoring record',
    'Unknown-caller calls that connected (dial_call_status = completed) but have no monitored_duration_seconds. Monitoring may not have started (no entitlement, stream refused at the cap, stream never connected) or its outcome write failed — the database cannot tell which.', noMonitoring);

  const terminated = mtd.filter((c) => c.terminated_by_system).map((c) => ({ householdId: c.household_id, label: label(c.household_id), accountClass: classOf(c.household_id), detail: 'ended by HCG (red-line signal)', at: c.created_at }));
  sig('terminated', 'info', 'Calls ended by HCG', 'terminated_by_system (month to date). Count only: an intervention, not a fault.', terminated);

  const rank = { red: 0, amber: 1, info: 2, green: 3 };
  signals.sort((a, b) => rank[a.severity] - rank[b.severity]);

  const notRecorded = [
    'Stream refusals at the whole-server concurrency cap (server log + alert e-mail only)',
    'Transcription / OpenAI failures during monitoring (logged; monitoring silently degrades)',
    'Rapid-abuse alert e-mails actually sent (recomputed here instead)',
    'The "monitoring limit reached" customer SMS (only in-call warning SMS set warning_sent)',
    'Security events: /media-stream signature results (shadow mode), rejected or forged stream connections, unsigned webhook requests (server log only — no table)',
    'Provider-side minutes for calls with no calls row (e.g. rejected before logging) — check the Twilio console or Money → Spend safety',
  ];

  const overall = signals.some((s) => s.severity === 'red') ? 'red' : signals.some((s) => s.severity === 'amber') ? 'amber' : 'green';
  return {
    available: true,
    generatedAt: now.toISOString(),
    timezone: 'UTC',
    overall,
    truncated,
    windows,
    series,
    concurrency,
    households: householdRows,
    signals,
    controls: describeControls({ env, present }),
    notRecorded,
  };
}

// Overview summary: only what "Needs your attention" needs.
function summariseForOverview(result) {
  if (!result || !result.available) return { available: false, reason: result ? result.reason : 'not loaded' };
  return {
    available: true,
    overall: result.overall,
    truncated: result.truncated,
    signals: result.signals.filter((s) => s.severity === 'red' || s.severity === 'amber').map((s) => ({ id: s.id, severity: s.severity, title: s.title, count: s.count, items: s.items.slice(0, 20) })),
  };
}

const CALL_COLUMNS = 'household_id, created_at, number, status, result, duration_seconds, monitored_duration_seconds, monitoring_limit_reached, dial_call_status, terminated_by_system, warning_sent';

async function loadUsageSafety({ now = new Date(), env = process.env } = {}) {
  let supabaseAdmin = null;
  try { supabaseAdmin = require('../supabaseClients').supabaseAdmin; } catch (err) { supabaseAdmin = null; }
  if (!supabaseAdmin) return { available: false, reason: 'SUPABASE_SERVICE_ROLE_KEY not configured' };
  const nowMs = now.getTime();
  const since = new Date(Math.min(startOfUtcMonth(nowMs), startOfUtcDay(nowMs) - (SERIES_DAYS - 1) * DAY_MS)).toISOString();

  const { selectAll } = require('./selectAll');
  const res = await selectAll(() => supabaseAdmin.from('calls').select(CALL_COLUMNS).gte('created_at', since).order('created_at', { ascending: true }));
  if (res.error) return { available: false, reason: res.error.message };
  const calls = res.data;
  const truncated = res.truncated;

  const { getClassificationMap } = require('../businessMetrics/accountClassification');
  const [hRes, classification] = await Promise.all([
    supabaseAdmin.from('households').select('id, email'),
    getClassificationMap(),
  ]);
  if (hRes.error) return { available: false, reason: hRes.error.message };

  return computeUsageSafety({
    calls,
    households: hRes.data || [],
    classificationMap: classification.available ? classification.map : new Map(),
    env,
    present: (rel) => fs.existsSync(path.join(ROOT, rel)),
    truncated,
  }, now);
}

module.exports = {
  TWILIO_DIAL_DEFAULT_TIME_LIMIT_SECONDS,
  summariseMinutes,
  peakConcurrency,
  findRepeatCallerBursts,
  describeControls,
  computeUsageSafety,
  summariseForOverview,
  loadUsageSafety,
  maskCaller,
};
