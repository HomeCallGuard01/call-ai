// Extracted from server.js (mobile app Phase 2, backend groundwork) so
// these are reusable from routes/mobileApi.js without server.js needing
// to export anything — matches the established per-table module pattern
// already used by database/households.js, database/contacts.js, and
// database/billing.js. Logic is unchanged from the original inline
// functions, only relocated.
const { supabaseAdmin } = require("../services/supabaseClients");

async function getCallsToday(householdId) {
  if (!supabaseAdmin) return [];

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const { data, error } = await supabaseAdmin
    .from("calls")
    .select("*")
    .eq("household_id", householdId)
    .gte("created_at", startOfToday.toISOString());

  if (error) {
    console.error("SUPABASE CALLS READ ERROR:", error);
    return [];
  }

  return data || [];
}

async function getRecentCalls(householdId, limit) {
  if (!supabaseAdmin) return [];

  const { data, error } = await supabaseAdmin
    .from("calls")
    .select("*")
    .eq("household_id", householdId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    console.error("SUPABASE CALLS READ ERROR:", error);
    return [];
  }

  return data || [];
}

async function logCall({ callSid, number, status, result, aiModel, processingTimeMs, householdId }) {
  if (!supabaseAdmin) {
    console.error("SUPABASE CALL LOG ERROR: SUPABASE_SERVICE_ROLE_KEY not configured");
    return;
  }

  const { error } = await supabaseAdmin
    .from("calls")
    .upsert(
      {
        call_sid: callSid,
        number,
        status,
        result,
        ai_model: aiModel,
        processing_time_ms: processingTimeMs,
        household_id: householdId,
      },
      { onConflict: "call_sid", ignoreDuplicates: true }
    );

  if (error) {
    console.error("SUPABASE CALL LOG ERROR:", error);
  }
}

// Distinct from logCall: that one upserts with ignoreDuplicates:true (a
// second write for the same call_sid is a no-op there, by design — see
// its own use in server.js /voice and /process, which can both fire for
// the same call). This one is a real update, called once, after the call
// has already ended (services/liveMonitoring/mediaStreamHandler.js's
// "stop" handling) — deliberately the only place this gets written, so
// there's no risk of a stray retry silently overwriting a real result
// with an incomplete one.
//
// Minimum sensible persistence only (2026-08-11, restoring progressive
// monitoring): riskScore is the PEAK score reached during the call, never
// per-chunk history. decisionReason is a short list of signal-category
// IDs (e.g. "urgency_or_threat, payment_or_transfer_request") — never the
// transcript or any of the caller's actual words. Never touches `result`
// (schema only allows 'SAFE'/'SCAM', and a call that was safe enough to
// connect shouldn't be retroactively relabelled just because monitoring
// later saw something — that's a policy decision for later, not a data
// model change to make implicitly here).
// terminatedBySystem/terminationReason added 2026-08-15 for the red-line
// architecture: terminationReason is the matched critical signal ID(s)
// only (e.g. "isolation_from_bank, isolation_from_family"), same
// data-minimisation principle as decisionReason — never the transcript.
// terminated_at is stamped here, at persistence time, rather than
// threaded through from riskMonitor — close enough to the real event
// given termination and stream-stop happen back-to-back, and it avoids
// carrying a timestamp through the whole call chain for one field.
// monitoredDurationSeconds/monitoringLimitReached (cost-protection
// safeguard) — how long services/liveMonitoring actually ran
// transcription/scoring for this call, and whether that ended because
// the configurable per-call safety limit (services/liveMonitoring/
// monitoringLimit.js) was reached rather than the call itself ending —
// see migration 034's own comment on both columns.
//
// duration_seconds fallback: a red-line-terminated call
// (terminatedBySystem) is redirected away from its <Dial> to end it,
// which means the <Dial> action callback that normally records
// duration_seconds (recordCallDuration, below) never fires for this one
// case. Rather than leave duration_seconds permanently null for exactly
// the calls the red-line system existed to catch, this uses
// monitoredDurationSeconds as a reasonable estimate — monitoring runs
// for the live duration of the call right up until termination, so the
// two are effectively the same number here. Only applied when
// terminatedBySystem is true; every other call's duration_seconds comes
// exclusively from the real Twilio-reported value via
// recordCallDuration, never estimated.
async function recordMonitoringOutcome({
  callSid,
  riskScore,
  decisionReason,
  warningSent,
  terminatedBySystem = false,
  terminationReason = null,
  monitoredDurationSeconds = null,
  monitoringLimitReached = false,
}) {
  if (!supabaseAdmin) {
    console.error("SUPABASE MONITORING OUTCOME ERROR: SUPABASE_SERVICE_ROLE_KEY not configured");
    return;
  }

  const { error } = await supabaseAdmin
    .from("calls")
    .update({
      risk_score: riskScore,
      decision_reason: decisionReason,
      warning_sent: warningSent,
      terminated_by_system: terminatedBySystem,
      termination_reason: terminationReason,
      terminated_at: terminatedBySystem ? new Date().toISOString() : null,
      monitored_duration_seconds: monitoredDurationSeconds,
      monitoring_limit_reached: monitoringLimitReached,
      ...(terminatedBySystem ? { duration_seconds: monitoredDurationSeconds } : {}),
    })
    .eq("call_sid", callSid);

  if (error) {
    console.error("SUPABASE MONITORING OUTCOME ERROR:", error);
  }
}

// Persists the real, Twilio-reported duration of the dialled leg
// (DialCallDuration) — called from server.js's <Dial> action callbacks
// (/call-delivery-failed for client-only, /call-status for client-and-
// number), which fire for every completed, no-answer, busy, or failed
// dial, covering normal completion and either party hanging up. Never
// called for a red-line-terminated call (the redirect that ends that
// call happens before the action callback can fire) — see
// recordMonitoringOutcome above for that case's fallback. Fails open
// (logs, never throws): a duration-recording failure must never affect
// the TwiML response already being returned to Twilio for this request.
async function recordCallDuration(callSid, durationSeconds) {
  if (!supabaseAdmin) {
    console.error("SUPABASE CALL DURATION ERROR: SUPABASE_SERVICE_ROLE_KEY not configured");
    return;
  }

  const { error } = await supabaseAdmin
    .from("calls")
    .update({ duration_seconds: durationSeconds })
    .eq("call_sid", callSid);

  if (error) {
    console.error("SUPABASE CALL DURATION ERROR:", error);
  }
}

function toClientCall(call) {
  return {
    number: call.number,
    status: call.status,
    result: call.result,
    time: call.created_at,
  };
}

module.exports = {
  getCallsToday,
  getRecentCalls,
  logCall,
  recordCallDuration,
  recordMonitoringOutcome,
  toClientCall,
};
