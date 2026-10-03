'use strict';

// Call-delivery health monitoring (2026-09-29, P0 call-delivery
// resilience). Two entry points, both fail-open and dependency-injected:
//
// 1. evaluateAfterDeliveryOutcome — called after /call-delivery-failed
//    has recorded a Dial outcome. Recomputes the household's delivery
//    health with and without that attempt and alerts only on a
//    DEGRADATION (UNKNOWN/HEALTHY → SUSPECT → UNREACHABLE), so one
//    household's run of failures produces one alert per step, not one
//    per call.
//
// 2. ingestPushFailureAlerts — reads Twilio Monitor alerts (read-only on
//    Twilio's side) and attaches push failures such as 52103
//    (FCM 'NotRegistered') to the call whose client leg they belong to.
//    Twilio reports push failures only asynchronously, never on the Dial
//    action callback, so this is the only way HCG learns a device token
//    is dead. Polling was chosen over Twilio's Debugger webhook because
//    the webhook is an account-level console setting (a live provider
//    configuration change); polling needs no provider change and can be
//    enabled/disabled by an environment variable.
//
// Events (the `event` field of every structured log line and alert
// context, stable names for Dashboard/ops consumers):
//   VOICE_CLIENT_PUSH_FAILED            — a push to the app failed
//   STALE_REGISTRATION                  — that failure says the device token is dead
//   REPEATED_APP_DELIVERY_FAILURE       — health degraded to SUSPECT
//   HOUSEHOLD_MAY_NOT_BE_RECEIVING_CALLS— health degraded to UNREACHABLE
//
// No customer notification is sent from here: no approved customer
// notification mechanism covers this condition yet. Alerts go to the
// existing internal support mailbox via services/alerting.js.

const {
  computeDeliveryHealth,
  attemptFromCallRow,
  isDeliveryHealthDegradation,
  isDeadTokenFailure,
  STATES,
} = require("./deliveryHealth");
const { parsePushFailureAlert } = require("./incomingCallTriage");
const { recordDeliveryEvent, EVENTS: DELIVERY_EVENTS } = require("./callDeliveryEvents");
const {
  getRecentDeliveryAttempts,
  hasVerifiedInviteReporting,
  recordPushFailure,
  recordDialCallSid,
} = require("../database/deliveryEvidence");

const EVENTS = Object.freeze({
  VOICE_CLIENT_PUSH_FAILED: "VOICE_CLIENT_PUSH_FAILED",
  STALE_REGISTRATION: "STALE_REGISTRATION",
  REPEATED_APP_DELIVERY_FAILURE: "REPEATED_APP_DELIVERY_FAILURE",
  HOUSEHOLD_MAY_NOT_BE_RECEIVING_CALLS: "HOUSEHOLD_MAY_NOT_BE_RECEIVING_CALLS",
});

function logEvent(log, event, payload) {
  // One grep-able, JSON-parseable line per event (Railway log search).
  log(`HCG_DELIVERY_EVENT ${JSON.stringify({ event, ...payload })}`);
}

function summarise(health) {
  return {
    state: health.state,
    consecutiveFailures: health.consecutiveFailures,
    hardFailures: health.hardFailures,
    softFailures: health.softFailures,
    lastFailureCategory: health.lastFailureCategory,
    lastFailureAt: health.lastFailureAt,
    lastSuccessAt: health.lastSuccessAt,
    lastRegisteredAt: health.lastRegisteredAt,
  };
}

async function getRegistration(supabase, householdId) {
  const { data, error } = await supabase
    .from("households")
    .select("id, voice_client_registered_at")
    .eq("id", householdId)
    .maybeSingle();
  if (error || !data) return null;
  return data;
}

// Returns { before, after, degraded } or null when nothing to evaluate.
// "before" is the same evidence minus what just arrived: either a whole
// attempt (excludeCallSid — a new Dial outcome) or just the push failure
// on one client leg (withoutPushFailureFor — a newly ingested alert).
async function evaluateHouseholdDeliveryHealth({ supabase, householdId, excludeCallSid = null, withoutPushFailureFor = null, alert, log = console.error }) {
  if (!supabase || !householdId) return null;
  const household = await getRegistration(supabase, householdId);
  if (!household) return null;

  const [rows, inviteReportingVerified] = await Promise.all([
    getRecentDeliveryAttempts({ supabase, householdId }),
    hasVerifiedInviteReporting({ supabase, householdId }),
  ]);
  const attempts = rows.map(attemptFromCallRow);
  const lastRegisteredAt = household.voice_client_registered_at || null;
  const after = computeDeliveryHealth({ attempts, lastRegisteredAt, inviteReportingVerified });
  const before = computeDeliveryHealth({
    attempts: attempts
      .filter(a => !excludeCallSid || a.callSid !== excludeCallSid)
      .map(a => (withoutPushFailureFor && a.dialCallSid === withoutPushFailureFor ? { ...a, pushFailure: null } : a)),
    lastRegisteredAt,
    inviteReportingVerified,
  });
  const degraded = isDeliveryHealthDegradation(before, after);

  if (degraded && alert) {
    const event = after.state === STATES.UNREACHABLE
      ? EVENTS.HOUSEHOLD_MAY_NOT_BE_RECEIVING_CALLS
      : EVENTS.REPEATED_APP_DELIVERY_FAILURE;
    const payload = { householdId, previousState: before.state, ...summarise(after), reasons: after.reasons };
    logEvent(log, event, payload);
    await alert(
      event === EVENTS.HOUSEHOLD_MAY_NOT_BE_RECEIVING_CALLS ? "household_not_receiving_calls" : "household_delivery_needs_attention",
      event === EVENTS.HOUSEHOLD_MAY_NOT_BE_RECEIVING_CALLS
        ? "A household's app appears unable to receive protected calls — forwarded calls to them are being dropped"
        : "A household's protected calls are repeatedly failing to reach their app",
      { event, ...payload },
      { dedupeKey: householdId }
    );
  }
  return { before, after, degraded };
}

// Called after /call-delivery-failed has written dial_call_status.
// dialCallSid is Twilio's DialCallSid (the client leg) from the same
// callback; stored first so later push-failure alerts can be matched.
async function evaluateAfterDeliveryOutcome({ supabase, callSid, dialCallSid, alert, log = console.error }) {
  try {
    if (!supabase || !callSid) return null;
    if (dialCallSid) await recordDialCallSid({ supabase, parentCallSid: callSid, dialCallSid });
    const { data } = await supabase.from("calls").select("household_id").eq("call_sid", callSid).maybeSingle();
    if (!data || !data.household_id) return null;
    return await evaluateHouseholdDeliveryHealth({
      supabase,
      householdId: data.household_id,
      excludeCallSid: callSid,
      alert,
      log,
    });
  } catch (err) {
    log(`DELIVERY HEALTH EVALUATION FAILED: ${err.message}`);
    return null;
  }
}

// Reads Twilio Monitor alerts since `since` and records push failures.
// Idempotent: recordPushFailure only fills an empty push_failure, and an
// event/alert is only emitted when a row was newly updated.
async function ingestPushFailureAlerts({ supabase, twilioClient, since, alert, log = console.error }) {
  const summary = { alertsRead: 0, pushFailures: 0, recorded: 0, unmatched: 0 };
  if (!supabase || !twilioClient) return summary;

  const alerts = await twilioClient.monitor.v1.alerts.list({ startDate: since, limit: 500 });
  summary.alertsRead = alerts.length;

  for (const a of alerts) {
    const parsed = parsePushFailureAlert(a.alertText);
    if (!parsed) continue;
    summary.pushFailures++;
    const failure = `${parsed.bindingType || "push"}:${parsed.failure || "unknown"}`;
    const at = a.dateCreated ? new Date(a.dateCreated).toISOString() : null;

    let householdId = await recordPushFailure({ supabase, dialCallSid: parsed.callSid, failure, at });
    if (!householdId) {
      // The Dial action callback (which stores dial_call_sid) may not
      // have run — e.g. the caller hung up. Ask Twilio for the parent.
      try {
        const child = await twilioClient.calls(parsed.callSid).fetch();
        if (child && child.parentCallSid) {
          await recordDialCallSid({ supabase, parentCallSid: child.parentCallSid, dialCallSid: parsed.callSid });
          householdId = await recordPushFailure({ supabase, dialCallSid: parsed.callSid, failure, at });
        }
      } catch (err) {
        log(`PUSH FAILURE INGEST: Twilio lookup failed for ${parsed.callSid}: ${err.message}`);
      }
    }
    if (!householdId) {
      summary.unmatched++;
      continue;
    }
    summary.recorded++;

    // Timeline event (migration 064) — recorded once: recordPushFailure only
    // returns a household the first time a given dial leg's failure is stored.
    await recordDeliveryEvent({
      event: DELIVERY_EVENTS.PUSH_FAILED,
      source: "poller",
      householdId,
      clientCallSid: parsed.callSid,
      detail: { reason: failure },
      now: at ? new Date(at) : new Date(),
    }, { supabase });

    const deadToken = isDeadTokenFailure(failure);
    const payload = { householdId, dialCallSid: parsed.callSid, failure, at };
    logEvent(log, EVENTS.VOICE_CLIENT_PUSH_FAILED, payload);
    if (deadToken) logEvent(log, EVENTS.STALE_REGISTRATION, payload);
    if (alert) {
      await alert(
        deadToken ? "voice_client_stale_registration" : "voice_client_push_failed",
        deadToken
          ? "A household's app push registration is dead — calls cannot reach the app until it is reopened"
          : "A protected call could not be pushed to a household's app",
        { event: deadToken ? EVENTS.STALE_REGISTRATION : EVENTS.VOICE_CLIENT_PUSH_FAILED, ...payload },
        { dedupeKey: householdId }
      );
    }
    await evaluateHouseholdDeliveryHealth({ supabase, householdId, withoutPushFailureFor: parsed.callSid, alert, log });
  }
  return summary;
}

// Poll cadence: push failures are reported by Twilio within seconds; 5
// minutes keeps detection well inside the time before a household's next
// call on typical traffic while making ~288 small read-only API calls a
// day. Each poll overlaps the previous one by 10 minutes because alert
// publication can lag; overlap is harmless (idempotent writes).
const DEFAULT_POLL_INTERVAL_MS = 5 * 60 * 1000;
const POLL_OVERLAP_MS = 10 * 60 * 1000;
const INITIAL_LOOKBACK_MS = 2 * 60 * 60 * 1000;

function isPushFailurePollingEnabled(env = process.env) {
  return env.DELIVERY_PUSH_FAILURE_POLLING === "on";
}

function startPushFailurePolling({ supabase, twilioClient, alert, env = process.env, now = () => Date.now(), setIntervalFn = setInterval, log = console.error }) {
  if (!isPushFailurePollingEnabled(env)) return null;
  let lastPollMs = now() - INITIAL_LOOKBACK_MS;
  const tick = async () => {
    const startedMs = now();
    const since = new Date(Math.min(lastPollMs, startedMs) - POLL_OVERLAP_MS);
    try {
      const summary = await ingestPushFailureAlerts({ supabase, twilioClient, since, alert, log });
      lastPollMs = startedMs;
      if (summary.pushFailures) log(`PUSH FAILURE INGEST: ${JSON.stringify(summary)}`);
    } catch (err) {
      log(`PUSH FAILURE INGEST FAILED: ${err.message}`);
    }
  };
  const handle = setIntervalFn(tick, DEFAULT_POLL_INTERVAL_MS);
  if (handle && typeof handle.unref === "function") handle.unref();
  return { tick, handle };
}

module.exports = {
  EVENTS,
  DEFAULT_POLL_INTERVAL_MS,
  evaluateHouseholdDeliveryHealth,
  evaluateAfterDeliveryOutcome,
  ingestPushFailureAlerts,
  isPushFailurePollingEnabled,
  startPushFailurePolling,
};
