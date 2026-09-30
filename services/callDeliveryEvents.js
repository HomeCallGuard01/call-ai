'use strict';

// Structured call-delivery telemetry (2026-09-30, release readiness P3).
//
// One append-only, content-free event per stage of an approved call's
// journey, so "the phone didn't ring" can be answered from evidence:
//
//   inbound_received → household_identified → caller_classified →
//   routing_decision (+ endpoint status) → push_requested →
//   [push_failed] → app_invite_received → app_ringing | app_presentation_blocked →
//   app_answered | app_declined | app_invite_cancelled → app_media_connected →
//   dial_outcome → delivered | delivery_failed → fallback_triggered
//
// Privacy by construction: every event's `detail` passes through a per-event
// allow-list (sanitizeDetail). Only enumerated values, booleans and small
// numbers survive. Caller numbers, names, transcripts and free text can
// never be stored or logged here, and any string that looks like a phone
// number is dropped even inside an allowed key.
//
// Never on the critical path: recordDeliveryEvent never throws and never
// awaits inside a TwiML handler (callers fire-and-forget). It always emits
// one `HCG_CALL_DELIVERY {json}` log line; the database write happens only
// when CALL_DELIVERY_EVENTS_DB=on (set only after migration 060 is applied),
// so deploying this code before the migration changes nothing.

const EVENTS = Object.freeze({
  INBOUND_RECEIVED: 'inbound_received',
  HOUSEHOLD_IDENTIFIED: 'household_identified',
  HOUSEHOLD_NOT_FOUND: 'household_not_found',
  CALLER_CLASSIFIED: 'caller_classified',
  ROUTING_DECISION: 'routing_decision',
  ENDPOINT_HEALTH: 'endpoint_health',
  PUSH_REQUESTED: 'push_requested',
  PUSH_FAILED: 'push_failed',
  APP_INVITE_RECEIVED: 'app_invite_received',
  APP_RINGING: 'app_ringing',
  APP_PRESENTATION_BLOCKED: 'app_presentation_blocked',
  APP_ANSWERED: 'app_answered',
  APP_DECLINED: 'app_declined',
  APP_INVITE_CANCELLED: 'app_invite_cancelled',
  APP_MEDIA_CONNECTED: 'app_media_connected',
  DIAL_OUTCOME: 'dial_outcome',
  DELIVERED: 'delivered',
  DELIVERY_FAILED: 'delivery_failed',
  FALLBACK_TRIGGERED: 'fallback_triggered',
  DEVICE_READINESS: 'device_readiness',
});

const EVENT_NAMES = new Set(Object.values(EVENTS));
const SOURCES = new Set(['server', 'app', 'poller']);

const PERMISSION_STATES = ['granted', 'denied', 'not_required', 'unknown'];
const PLATFORMS = ['android', 'ios', 'web', 'unknown'];

// Per-event allow-list: key → validator. Anything not listed is dropped.
const enumOf = values => v => (values.includes(v) ? v : undefined);
const bool = v => (typeof v === 'boolean' ? v : undefined);
const smallInt = max => v => (Number.isInteger(v) && v >= 0 && v <= max ? v : undefined);
const shortToken = v => (typeof v === 'string' && /^[a-z0-9_.:-]{1,40}$/i.test(v) && !looksLikePhoneNumber(v) ? v : undefined);

const DETAIL_SCHEMA = {
  inbound_received: { signatureValid: bool },
  household_identified: {},
  household_not_found: {},
  caller_classified: {
    classification: enumOf(['known_contact', 'unknown', 'withheld']),
  },
  routing_decision: {
    mode: enumOf(['client-only', 'self-protecting-unreachable', 'fail-closed']),
    monitoring: bool,
    entitled: bool,
    endpointRegistered: bool,
    registrationAgeHours: smallInt(24 * 365 * 5),
    deliveryHealth: enumOf(['UNREGISTERED', 'UNKNOWN', 'HEALTHY', 'SUSPECT', 'UNREACHABLE']),
    deviceReady: enumOf(['ready', 'not_ready', 'unknown']),
  },
  endpoint_health: {
    reachability: enumOf(['unregistered', 'unreachable', 'degraded', 'presumed', 'confirmed']),
    deliveryHealth: enumOf(['UNREGISTERED', 'UNKNOWN', 'HEALTHY', 'SUSPECT', 'UNREACHABLE']),
    deviceReady: enumOf(['ready', 'not_ready', 'unknown']),
    registrationAgeDays: smallInt(3650),
  },
  push_requested: { timeoutSeconds: smallInt(600) },
  push_failed: { errorCode: shortToken, reason: shortToken },
  app_invite_received: { platform: enumOf(PLATFORMS), presented: bool },
  app_ringing: { platform: enumOf(PLATFORMS) },
  app_presentation_blocked: { platform: enumOf(PLATFORMS), errorCode: shortToken, cause: enumOf(['microphone', 'notifications', 'unknown']) },
  app_answered: { platform: enumOf(PLATFORMS) },
  app_declined: { platform: enumOf(PLATFORMS) },
  app_invite_cancelled: { platform: enumOf(PLATFORMS) },
  app_media_connected: { platform: enumOf(PLATFORMS) },
  dial_outcome: {
    dialCallStatus: enumOf(['completed', 'answered', 'no-answer', 'busy', 'failed', 'canceled']),
    durationSeconds: smallInt(24 * 3600),
  },
  delivered: { durationSeconds: smallInt(24 * 3600) },
  delivery_failed: {
    reason: enumOf(['no_registered_endpoint', 'no_household', 'no_answer', 'busy', 'dial_failed', 'caller_hung_up', 'unknown']),
  },
  fallback_triggered: { type: enumOf(['apology_message', 'voicemail_prototype', 'unavailable_message']) },
  device_readiness: {
    platform: enumOf(PLATFORMS),
    microphone: enumOf(PERMISSION_STATES),
    notifications: enumOf(PERMISSION_STATES),
    osVersion: smallInt(100),
    trigger: enumOf(['registration', 'foreground', 'sdk_error']),
  },
};

function looksLikePhoneNumber(value) {
  return typeof value === 'string' && /\+?\d[\d\s-]{6,}\d/.test(value);
}

function sanitizeDetail(event, detail) {
  const schema = DETAIL_SCHEMA[event];
  if (!schema || !detail || typeof detail !== 'object') return {};
  const out = {};
  for (const [key, validate] of Object.entries(schema)) {
    if (!(key in detail)) continue;
    const value = validate(detail[key]);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

const CALL_SID_PATTERN = /^CA[0-9a-f]{32}$/;
const cleanSid = sid => (typeof sid === 'string' && CALL_SID_PATTERN.test(sid) ? sid : null);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const cleanHouseholdId = id => (typeof id === 'string' && UUID_PATTERN.test(id) ? id : null);

function isDeliveryEventsDbEnabled(env = process.env) {
  return String(env.CALL_DELIVERY_EVENTS_DB || '').toLowerCase() === 'on';
}

// Builds the row that would be stored/logged, or null if the event is not
// a known event. Pure.
function buildDeliveryEvent({ event, source = 'server', householdId = null, callSid = null, clientCallSid = null, detail = {}, now = new Date() }) {
  if (!EVENT_NAMES.has(event) || !SOURCES.has(source)) return null;
  return {
    household_id: cleanHouseholdId(householdId),
    call_sid: cleanSid(callSid),
    client_call_sid: cleanSid(clientCallSid),
    event,
    source,
    occurred_at: (now instanceof Date ? now : new Date(now)).toISOString(),
    detail: sanitizeDetail(event, detail),
  };
}

let dbWriteWarned = false;

// Never throws. Resolves to the row (or null). Callers on a TwiML path must
// not await it.
async function recordDeliveryEvent(args, { supabase = null, env = process.env, log = console.log } = {}) {
  let row = null;
  try {
    row = buildDeliveryEvent(args || {});
    if (!row) return null;
    log(`HCG_CALL_DELIVERY ${JSON.stringify(row)}`);
    if (supabase && isDeliveryEventsDbEnabled(env)) {
      const { error } = await supabase.from('call_delivery_events').insert(row);
      if (error && !dbWriteWarned) {
        dbWriteWarned = true;
        console.error('CALL DELIVERY EVENT WRITE ERROR (is migration 060 applied?):', error.message || error);
      }
    }
  } catch (err) {
    try { console.error('CALL DELIVERY EVENT RECORD FAILED:', err && err.message); } catch (_) { /* never throw */ }
  }
  return row;
}

// ---------------------------------------------------------------------------
// Timeline + diagnosis (pure). Groups a household's events by parent call
// and names the first stage that did not happen — the answer to "why didn't
// it ring?" — in plain operator English.

const APP_OUTCOME_EVENTS = new Set([EVENTS.APP_ANSWERED, EVENTS.APP_DECLINED, EVENTS.APP_INVITE_CANCELLED]);

function diagnoseCall(events) {
  const has = name => events.some(e => e.event === name);
  const first = name => events.find(e => e.event === name);
  const routing = first(EVENTS.ROUTING_DECISION);
  const dial = first(EVENTS.DIAL_OUTCOME);
  const dialStatus = dial && dial.detail && dial.detail.dialCallStatus;

  if (has(EVENTS.HOUSEHOLD_NOT_FOUND)) {
    return { stage: 'household', verdict: 'not_delivered', explanation: 'The HCG number that was called is not linked to any household.' };
  }
  if (routing && routing.detail && routing.detail.mode === 'self-protecting-unreachable') {
    return { stage: 'routing', verdict: 'not_delivered', explanation: 'HCG had no registered app for this household, so it did not try to ring the phone.' };
  }
  if (has(EVENTS.DELIVERED) || has(EVENTS.APP_MEDIA_CONNECTED) || dialStatus === 'completed' || dialStatus === 'answered') {
    return { stage: 'connected', verdict: 'delivered', explanation: 'The call rang on the app, was answered and connected.' };
  }
  if (has(EVENTS.PUSH_FAILED)) {
    return { stage: 'push', verdict: 'not_delivered', explanation: 'The push to the phone failed: the device token is no longer valid, or the push service rejected it. The app must be opened to re-register.' };
  }
  if (has(EVENTS.APP_PRESENTATION_BLOCKED)) {
    return { stage: 'presentation', verdict: 'not_delivered', explanation: 'The call reached the app, but the phone blocked it from ringing because the microphone or notification permission is off.' };
  }
  if (has(EVENTS.APP_DECLINED)) {
    return { stage: 'answer', verdict: 'customer_declined', explanation: 'The phone rang and the customer declined the call.' };
  }
  if (has(EVENTS.APP_INVITE_CANCELLED) || dialStatus === 'canceled') {
    return { stage: 'answer', verdict: 'caller_hung_up', explanation: 'The caller hung up while the phone was ringing.' };
  }
  if (has(EVENTS.APP_ANSWERED) && !has(EVENTS.APP_MEDIA_CONNECTED)) {
    return { stage: 'media', verdict: 'not_delivered', explanation: 'The customer answered, but the call never connected: check network and microphone on the phone.' };
  }
  if (has(EVENTS.APP_INVITE_RECEIVED) || has(EVENTS.APP_RINGING)) {
    return { stage: 'answer', verdict: 'rang_unanswered', explanation: 'The phone received the call and rang, but nobody answered before the timeout.' };
  }
  if (has(EVENTS.PUSH_REQUESTED)) {
    return { stage: 'device', verdict: 'not_delivered', explanation: 'HCG asked Twilio to ring the app, but the phone never reported receiving the call. Likely causes: dead push token, app force-stopped or battery-restricted, phone offline, or an app build that does not report.' };
  }
  if (routing) {
    return { stage: 'routing', verdict: 'not_delivered', explanation: 'A routing decision was made but no ring was attempted.' };
  }
  if (has(EVENTS.INBOUND_RECEIVED)) {
    return { stage: 'inbound', verdict: 'incomplete', explanation: 'The call reached HCG but no later stage was recorded.' };
  }
  return { stage: 'none', verdict: 'incomplete', explanation: 'No delivery evidence recorded for this call.' };
}

const STAGE_ORDER = [
  EVENTS.INBOUND_RECEIVED, EVENTS.HOUSEHOLD_IDENTIFIED, EVENTS.HOUSEHOLD_NOT_FOUND, EVENTS.CALLER_CLASSIFIED,
  EVENTS.ROUTING_DECISION, EVENTS.ENDPOINT_HEALTH, EVENTS.PUSH_REQUESTED, EVENTS.PUSH_FAILED, EVENTS.APP_INVITE_RECEIVED,
  EVENTS.APP_RINGING, EVENTS.APP_PRESENTATION_BLOCKED, EVENTS.APP_ANSWERED, EVENTS.APP_DECLINED,
  EVENTS.APP_INVITE_CANCELLED, EVENTS.APP_MEDIA_CONNECTED, EVENTS.DIAL_OUTCOME, EVENTS.DELIVERED,
  EVENTS.DELIVERY_FAILED, EVENTS.FALLBACK_TRIGGERED,
];
const stageRank = name => {
  const i = STAGE_ORDER.indexOf(name);
  return i === -1 ? STAGE_ORDER.length : i;
};

// events: rows as stored. Rows reported by the app carry the client (child)
// SID; `dialSidToCallSid` maps child → parent so they join the right call.
function buildDeliveryTimeline(events, { dialSidToCallSid = {} } = {}) {
  // Any event carrying both SIDs (dial_outcome does) teaches the child →
  // parent mapping, so app-reported events join their call without a
  // separate calls-table read.
  const childToParent = { ...dialSidToCallSid };
  for (const e of events || []) {
    if (e && e.call_sid && e.client_call_sid && !childToParent[e.client_call_sid]) childToParent[e.client_call_sid] = e.call_sid;
  }
  dialSidToCallSid = childToParent;
  const calls = new Map();
  const deviceReadiness = [];
  for (const e of events || []) {
    if (!e || !EVENT_NAMES.has(e.event)) continue;
    if (e.event === EVENTS.DEVICE_READINESS || (e.event === EVENTS.APP_PRESENTATION_BLOCKED && !e.call_sid && !e.client_call_sid)) {
      deviceReadiness.push(e);
      if (e.event === EVENTS.DEVICE_READINESS) continue;
    }
    const key = e.call_sid || dialSidToCallSid[e.client_call_sid] || e.client_call_sid;
    if (!key) continue;
    if (!calls.has(key)) calls.set(key, []);
    calls.get(key).push(e);
  }
  const timeline = [...calls.entries()].map(([callSid, list]) => {
    const ordered = list.slice().sort((a, b) => {
      const t = new Date(a.occurred_at) - new Date(b.occurred_at);
      return t !== 0 ? t : stageRank(a.event) - stageRank(b.event);
    });
    const startedAt = ordered[0].occurred_at;
    return {
      callSid,
      startedAt,
      stages: ordered.map(e => ({ event: e.event, source: e.source, at: e.occurred_at, detail: e.detail || {} })),
      diagnosis: diagnoseCall(ordered),
    };
  });
  timeline.sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
  deviceReadiness.sort((a, b) => new Date(b.occurred_at) - new Date(a.occurred_at));
  return { calls: timeline, deviceReadiness: deviceReadiness.map(e => ({ event: e.event, at: e.occurred_at, detail: e.detail || {} })) };
}

// Latest device-readiness picture for health evaluation. Pure.
function summariseDeviceReadiness(events) {
  const list = (events || []).filter(e => e && (e.event === EVENTS.DEVICE_READINESS || e.event === EVENTS.APP_PRESENTATION_BLOCKED));
  list.sort((a, b) => new Date(b.occurred_at) - new Date(a.occurred_at));
  const latestReport = list.find(e => e.event === EVENTS.DEVICE_READINESS) || null;
  const latestBlock = list.find(e => e.event === EVENTS.APP_PRESENTATION_BLOCKED) || null;
  if (!latestReport && !latestBlock) return null;
  const d = (latestReport && latestReport.detail) || {};
  return {
    reportedAt: latestReport ? latestReport.occurred_at : null,
    platform: d.platform || null,
    microphone: d.microphone || 'unknown',
    notifications: d.notifications || 'unknown',
    presentationBlockedAt: latestBlock ? latestBlock.occurred_at : null,
  };
}

async function getHouseholdDeliveryEvents({ supabase, householdId, since = null, limit = 500, events = null }) {
  if (!supabase || !cleanHouseholdId(householdId)) return [];
  try {
    let query = supabase
      .from('call_delivery_events')
      .select('household_id, call_sid, client_call_sid, event, source, occurred_at, detail')
      .eq('household_id', householdId);
    if (since) query = query.gte('occurred_at', new Date(since).toISOString());
    if (Array.isArray(events) && events.length) query = query.in('event', events);
    const { data, error } = await query.order('occurred_at', { ascending: false }).limit(limit);
    if (error) return [];
    return data || [];
  } catch (_) {
    return [];
  }
}

module.exports = {
  EVENTS,
  DETAIL_SCHEMA,
  sanitizeDetail,
  looksLikePhoneNumber,
  buildDeliveryEvent,
  recordDeliveryEvent,
  isDeliveryEventsDbEnabled,
  diagnoseCall,
  buildDeliveryTimeline,
  summariseDeviceReadiness,
  getHouseholdDeliveryEvents,
};
