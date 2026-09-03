// callStats.js — call/protection statistics for the business dashboard,
// built entirely from the existing `calls` table (call_sid, status,
// result, risk_score, warning_sent, terminated_by_system,
// termination_reason, created_at). No new columns, no schema change —
// this reads exactly what's already recorded in production today.
//
// Explicit, important limitation carried through everywhere in this
// module's output: `calls` has no duration column in production, so
// "monitored minutes" cannot be computed — only counts. Every function
// here reports counts and labels the household cost-ranking as a count-
// based proxy, never as £, to avoid presenting a fabricated precision.
'use strict';

// Lazily resolved — see services/businessMetrics/systemHealth.js's own
// comment on why services/supabaseClients.js cannot be required
// unconditionally at module load time in a context (like this test
// suite) that hasn't loaded SUPABASE_URL.
function resolveSupabaseAdmin() {
  try {
    return require('../supabaseClients').supabaseAdmin;
  } catch (err) {
    console.error('BUSINESS METRICS: failed to load Supabase client:', err.message);
    return null;
  }
}

function startOfTodayIso() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

function startOfMonthIso() {
  const d = new Date();
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

// Pure — turns a raw list of `calls` rows into the dashboard's call-
// statistics shape. Risk bands mirror services/liveMonitoring/scoring/
// thresholds.js's own SAFE_MAX/SUSPICIOUS_MAX boundaries (25/60) so this
// dashboard's "suspicious"/"high_risk" labels mean the same thing the
// live scoring engine itself means by them — not a second, independently
// invented banding.
function summariseCalls(calls) {
  const rows = calls || [];
  const known = rows.filter((c) => c.status === 'Known');
  const unknown = rows.filter((c) => c.status === 'Unknown');
  const scored = unknown.filter((c) => typeof c.risk_score === 'number');
  const safe = scored.filter((c) => c.risk_score <= 25);
  const suspicious = scored.filter((c) => c.risk_score > 25 && c.risk_score <= 60);
  const highRisk = scored.filter((c) => c.risk_score > 60);
  const warningsSent = unknown.filter((c) => c.warning_sent).length;
  const terminated = unknown.filter((c) => c.terminated_by_system).length;
  const avgRiskScore = scored.length > 0 ? scored.reduce((sum, c) => sum + c.risk_score, 0) / scored.length : null;

  return {
    totalCalls: rows.length,
    knownContactCalls: known.length,
    unknownMonitoredCalls: unknown.length,
    safeCalls: safe.length,
    suspiciousCalls: suspicious.length,
    highRiskCalls: highRisk.length,
    warningsSent,
    callsTerminatedByHcg: terminated,
    averageRiskScore: avgRiskScore === null ? null : Number(avgRiskScore.toFixed(1)),
    // Explicitly null, not omitted — makes the gap visible in the API
    // shape itself rather than something the UI has to know to ask for.
    averageMonitoredDurationSeconds: null,
    averageMonitoredDurationUnavailableReason: 'calls.duration_seconds does not exist in production yet',
  };
}

async function getCallStatsForRange(sinceIso) {
  const supabaseAdmin = resolveSupabaseAdmin();
  if (!supabaseAdmin) return { available: false, reason: 'SUPABASE_SERVICE_ROLE_KEY not configured' };

  const { data, error } = await supabaseAdmin
    .from('calls')
    .select('status, result, risk_score, warning_sent, terminated_by_system, household_id, created_at')
    .gte('created_at', sinceIso);

  if (error) return { available: false, reason: error.message };

  return { available: true, ...summariseCalls(data) };
}

async function getCallStatsToday() {
  return getCallStatsForRange(startOfTodayIso());
}

async function getCallStatsMtd() {
  return getCallStatsForRange(startOfMonthIso());
}

// Pure — ranks households by Unknown-caller call COUNT this month, the
// best currently-available proxy for relative cost (see this file's own
// header: no duration data exists to compute real £ per household).
// Never labeled as a £ ranking in its own output — the caller/UI is
// responsible for presenting it as "call volume", not "spend".
function rankHouseholdsByUnknownCallCount(calls, limit = 10) {
  const counts = new Map();
  for (const c of calls || []) {
    if (c.status !== 'Unknown' || !c.household_id) continue;
    counts.set(c.household_id, (counts.get(c.household_id) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([householdId, unknownCallCount]) => ({ householdId, unknownCallCount }))
    .sort((a, b) => b.unknownCallCount - a.unknownCallCount)
    .slice(0, limit);
}

async function getTopUnknownCallHouseholdsMtd(limit = 10) {
  const supabaseAdmin = resolveSupabaseAdmin();
  if (!supabaseAdmin) return { available: false, reason: 'SUPABASE_SERVICE_ROLE_KEY not configured', households: [] };

  const { data, error } = await supabaseAdmin
    .from('calls')
    .select('household_id, status, created_at')
    .eq('status', 'Unknown')
    .gte('created_at', startOfMonthIso());

  if (error) return { available: false, reason: error.message, households: [] };

  return { available: true, isCountProxy: true, households: rankHouseholdsByUnknownCallCount(data, limit) };
}

module.exports = {
  summariseCalls,
  rankHouseholdsByUnknownCallCount,
  getCallStatsToday,
  getCallStatsMtd,
  getTopUnknownCallHouseholdsMtd,
  startOfTodayIso,
  startOfMonthIso,
};
