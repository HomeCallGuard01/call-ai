'use strict';

// Call-delivery evidence reads/writes (2026-09-29, migration 055).
//
// Every function takes its Supabase client (and, where needed, a Twilio
// REST client) as an argument so it can be unit tested without a
// network. All writes are scoped to the calling household and fail open
// (log, never throw): this is evidence collection, and must never affect
// a live call or an API response the app depends on.
//
// See services/deliveryHealth.js for how the evidence is interpreted.

const { computeDeliveryHealth, attemptFromCallRow } = require("../services/deliveryHealth");
const { getHouseholdDeliveryEvents, summariseDeviceReadiness } = require("../services/callDeliveryEvents");
const { assessEndpointReachability } = require("../services/endpointReachability");

// How many recent delivery attempts are enough to evaluate health. The
// run that matters ends at the most recent delivered call; 25 attempts
// comfortably exceeds any threshold in services/deliveryHealth.js while
// keeping the query bounded.
const RECENT_ATTEMPT_LIMIT = 25;

// Twilio CallSids are "CA" + 32 lowercase hex. App-reported SIDs are
// validated against this before being used in any filter (the
// PostgREST .or() filter below is string-built) or Twilio request.
const CALL_SID_PATTERN = /^CA[0-9a-f]{32}$/;

function isValidCallSid(value) {
  return typeof value === "string" && CALL_SID_PATTERN.test(value);
}

const ATTEMPT_COLUMNS =
  "call_sid, created_at, dial_call_status, client_invite_received_at, client_outcome, push_failure, push_failure_at, dial_call_sid";

// The mobile app reports the CHILD (client-leg) CallSid — that is what
// the Twilio Voice SDK's CallInvite.getCallSid() returns — but calls.call_sid
// is the PARENT inbound SID. Resolve child → parent row for this household:
//   1. a row whose call_sid or dial_call_sid already equals the SID;
//   2. otherwise ask Twilio for the child call's parentCallSid, and use
//      that only if a row with that call_sid belongs to THIS household
//      (never trust the parent SID alone — household scoping is the
//      authorisation boundary for these app-reported writes).
// Returns the parent call_sid, or null.
// Negative cache (2026-09-30, release readiness P5): a SID that Twilio could
// not map to one of this household's calls is not looked up again for 10
// minutes, so repeated reports of an unknown SID (bug or abuse) can't turn
// into repeated Twilio REST requests. Bounded size.
const NEGATIVE_LOOKUP_TTL_MS = 10 * 60 * 1000;
const NEGATIVE_LOOKUP_MAX = 10000;
const negativeLookups = new Map(); // `${householdId}:${callSid}` -> expiresAt

function isNegativelyCached(key, nowMs) {
  const exp = negativeLookups.get(key);
  if (exp === undefined) return false;
  if (exp > nowMs) return true;
  negativeLookups.delete(key);
  return false;
}

function rememberNegative(key, nowMs) {
  if (negativeLookups.size >= NEGATIVE_LOOKUP_MAX) {
    const oldest = negativeLookups.keys().next().value;
    negativeLookups.delete(oldest);
  }
  negativeLookups.set(key, nowMs + NEGATIVE_LOOKUP_TTL_MS);
}

async function resolveHouseholdCallSid({ supabase, twilioClient, callSid, householdId, nowMs = Date.now() }) {
  if (!supabase || !isValidCallSid(callSid) || !householdId) return null;

  const direct = await supabase
    .from("calls")
    .select("call_sid")
    .eq("household_id", householdId)
    .or(`call_sid.eq.${callSid},dial_call_sid.eq.${callSid}`)
    .limit(1)
    .maybeSingle();
  if (direct.error) {
    // dial_call_sid does not exist until migration 055 is applied —
    // fall back to the pre-055 parent-only match rather than failing.
    const parentOnly = await supabase
      .from("calls")
      .select("call_sid")
      .eq("household_id", householdId)
      .eq("call_sid", callSid)
      .limit(1)
      .maybeSingle();
    if (parentOnly.data) return parentOnly.data.call_sid;
  } else if (direct.data) {
    return direct.data.call_sid;
  }

  if (!twilioClient) return null;
  const negativeKey = `${householdId}:${callSid}`;
  if (isNegativelyCached(negativeKey, nowMs)) return null;
  let parentCallSid = null;
  try {
    const child = await twilioClient.calls(callSid).fetch();
    parentCallSid = child && child.parentCallSid;
  } catch (err) {
    console.error("CALL SID RESOLUTION: Twilio lookup failed", { callSid, error: err.message });
    rememberNegative(negativeKey, nowMs);
    return null;
  }
  if (!parentCallSid) {
    rememberNegative(negativeKey, nowMs);
    return null;
  }

  const parent = await supabase
    .from("calls")
    .select("call_sid")
    .eq("household_id", householdId)
    .eq("call_sid", parentCallSid)
    .limit(1)
    .maybeSingle();
  if (parent.error || !parent.data) {
    rememberNegative(negativeKey, nowMs);
    return null;
  }

  // Remember the pairing so later evidence (push-failure alerts, the
  // invite outcome) resolves without another Twilio round trip.
  await recordDialCallSid({ supabase, parentCallSid, dialCallSid: callSid, householdId });
  return parentCallSid;
}

async function recordDialCallSid({ supabase, parentCallSid, dialCallSid, householdId = null }) {
  if (!supabase || !parentCallSid || !isValidCallSid(dialCallSid)) return false;
  let query = supabase.from("calls").update({ dial_call_sid: dialCallSid }).eq("call_sid", parentCallSid);
  if (householdId) query = query.eq("household_id", householdId);
  const { error } = await query;
  if (error) {
    console.error("DIAL CALL SID WRITE ERROR (is migration 055 applied?):", error.message || error);
    return false;
  }
  return true;
}

async function recordInviteReceived({ supabase, twilioClient, callSid, householdId, now = new Date() }) {
  const parentCallSid = await resolveHouseholdCallSid({ supabase, twilioClient, callSid, householdId });
  if (!parentCallSid) {
    console.error("CLIENT INVITE RECEIVED: no calls row for this household matches the reported CallSid", { callSid, householdId });
    return false;
  }
  const { error } = await supabase
    .from("calls")
    .update({ client_invite_received_at: now.toISOString() })
    .eq("call_sid", parentCallSid)
    .eq("household_id", householdId);
  if (error) {
    console.error("SUPABASE CLIENT INVITE RECEIVED WRITE ERROR:", error);
    return false;
  }
  return true;
}

async function recordInviteOutcome({ supabase, twilioClient, callSid, householdId, outcome }) {
  const parentCallSid = await resolveHouseholdCallSid({ supabase, twilioClient, callSid, householdId });
  if (!parentCallSid) {
    console.error("CLIENT CALL OUTCOME: no calls row for this household matches the reported CallSid", { callSid, householdId, outcome });
    return false;
  }
  const { error } = await supabase
    .from("calls")
    .update({ client_outcome: outcome })
    .eq("call_sid", parentCallSid)
    .eq("household_id", householdId);
  if (error) {
    console.error("SUPABASE CLIENT CALL OUTCOME WRITE ERROR:", error);
    return false;
  }
  return true;
}

// Records a provider push failure against the call whose client leg it
// belongs to. Only fills an empty push_failure (idempotent across
// repeated polls of the same alert). Returns the household_id of the
// updated row, or null when nothing matched yet (the Dial action
// callback that stores dial_call_sid may not have arrived).
async function recordPushFailure({ supabase, dialCallSid, failure, at }) {
  if (!supabase || !dialCallSid || !failure) return null;
  const { data, error } = await supabase
    .from("calls")
    .update({ push_failure: failure, push_failure_at: at || new Date().toISOString() })
    .eq("dial_call_sid", dialCallSid)
    .is("push_failure", null)
    .select("household_id")
    .maybeSingle();
  if (error) {
    console.error("PUSH FAILURE WRITE ERROR (is migration 055 applied?):", error.message || error);
    return null;
  }
  return data ? data.household_id : null;
}

async function getRecentDeliveryAttempts({ supabase, householdId, limit = RECENT_ATTEMPT_LIMIT }) {
  if (!supabase || !householdId) return [];
  let result = await supabase
    .from("calls")
    .select(ATTEMPT_COLUMNS)
    .eq("household_id", householdId)
    .not("dial_call_status", "is", null)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (result.error) {
    // Pre-055 schema: read what exists; push evidence is simply absent.
    result = await supabase
      .from("calls")
      .select("call_sid, created_at, dial_call_status, client_invite_received_at, client_outcome")
      .eq("household_id", householdId)
      .not("dial_call_status", "is", null)
      .order("created_at", { ascending: false })
      .limit(limit);
  }
  if (result.error) {
    console.error("SUPABASE DELIVERY ATTEMPTS READ ERROR:", result.error);
    return [];
  }
  return result.data || [];
}

// A household's app has proven it reports CallInvites once any of its
// calls carries client_invite_received_at. Until then, a 'no-answer'
// without an invite report proves nothing (older builds, or the SID bug
// fixed alongside this function, never reported one).
async function hasVerifiedInviteReporting({ supabase, householdId }) {
  if (!supabase || !householdId) return false;
  const { data, error } = await supabase
    .from("calls")
    .select("call_sid")
    .eq("household_id", householdId)
    .not("client_invite_received_at", "is", null)
    .limit(1)
    .maybeSingle();
  if (error) return false;
  return Boolean(data);
}

// The read model for customer/admin/dashboard consumers. `household`
// must carry id and voice_client_registered_at.
async function getHouseholdDeliveryHealth({ supabase, household }) {
  if (!household) return null;
  // Device readiness (migration 064, drafted as 060) is optional evidence: until 064 is
  // applied the read returns [] and health is computed exactly as before.
  const [rows, inviteReportingVerified, readinessEvents] = await Promise.all([
    getRecentDeliveryAttempts({ supabase, householdId: household.id }),
    hasVerifiedInviteReporting({ supabase, householdId: household.id }),
    getHouseholdDeliveryEvents({ supabase, householdId: household.id, limit: 20, events: ["device_readiness", "app_presentation_blocked"] }),
  ]);
  const deviceReadiness = summariseDeviceReadiness(readinessEvents);
  const health = computeDeliveryHealth({
    attempts: rows.map(attemptFromCallRow),
    lastRegisteredAt: household.voice_client_registered_at || null,
    inviteReportingVerified,
    deviceReadiness,
  });
  // 2026-09-30: explicit current reachability (never "registered once =
  // reachable") and the latest device readiness, for the dashboard, admin and
  // the call trace. Additive fields; existing consumers read `state` as before.
  const endpoint = assessEndpointReachability({ lastRegisteredAt: household.voice_client_registered_at || null, health });
  return {
    ...health,
    reachability: endpoint.reachability,
    reachabilityReasons: endpoint.reasons,
    registrationAgeDays: endpoint.registrationAgeDays,
    deviceReadiness,
  };
}

function _resetNegativeLookupCache() {
  negativeLookups.clear();
}

module.exports = {
  _resetNegativeLookupCache,
  RECENT_ATTEMPT_LIMIT,
  isValidCallSid,
  resolveHouseholdCallSid,
  recordDialCallSid,
  recordInviteReceived,
  recordInviteOutcome,
  recordPushFailure,
  getRecentDeliveryAttempts,
  hasVerifiedInviteReporting,
  getHouseholdDeliveryHealth,
};
