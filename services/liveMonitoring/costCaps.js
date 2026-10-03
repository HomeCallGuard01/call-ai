// costCaps.js — hard, server-side ceilings on the variable cost the live-
// monitoring pipeline can create, independent of authentication (P0
// remediation, 2026-10-01). Even if a signature or stream token were
// somehow bypassed, these bound OpenAI transcription and SMS spend.
//
// HCG-controlled and in-process (per instance): they bound cost after
// another control fails, but are NOT a substitute for provider-side caps
// (OpenAI prepaid credit with auto-recharge off; Twilio SMS geo-permissions
// UK-only; prepaid balance). When a ceiling is reached, the expensive
// action is skipped and the call itself is never touched.
//
// Defaults (env-overridable), sized well above genuine use:
//   streams per household (concurrent)          2
//   transcription requests per household / day  2,700  (≈ 3 h of audio at ~4 s/segment)
//   transcription requests globally / hour      6,000  (≈ 6.7 h audio ≈ £1.90/h at $0.006/min)
//   warning SMS per household / day             3
//   warning SMS globally / hour                 30
'use strict';

function int(v, d) { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : d; }

function resolveCostCapConfig(env = process.env) {
  return {
    maxStreamsPerHousehold: int(env.MEDIA_STREAM_MAX_STREAMS_PER_HOUSEHOLD, 2),
    maxTranscriptionsPerHouseholdPerDay: int(env.MEDIA_STREAM_MAX_TRANSCRIPTIONS_PER_HOUSEHOLD_PER_DAY, 2700),
    maxTranscriptionsPerHour: int(env.MEDIA_STREAM_MAX_TRANSCRIPTIONS_PER_HOUR, 6000),
    maxSmsPerHouseholdPerDay: int(env.MEDIA_STREAM_MAX_SMS_PER_HOUSEHOLD_PER_DAY, 3),
    maxSmsPerHour: int(env.MEDIA_STREAM_MAX_SMS_PER_HOUR, 30),
  };
}

// Telephony abuse P0 (2026-10-03): the SMS destination rule now comes from
// the central number policy (services/abuse/numberPolicy.js, purpose
// SMS_WARNING = genuine UK mobile only). The old /^\+447\d{9}$/ also let
// through 070 personal numbers, 076 pagers and 07624 Isle of Man mobiles —
// all classic premium/IRSF destinations.
const { evaluateNumberForPurpose, PURPOSES } = require('../abuse/numberPolicy');
const UK_NUMBER = /^\+44\d{9,10}$/;

function createCostCaps(config = resolveCostCapConfig(), { now = () => Date.now(), onLimit = () => {} } = {}) {
  const active = new Map();   // householdId -> concurrent streams
  const daily = new Map();    // `${day}|${householdId}|${kind}` -> count
  const hourly = new Map();   // `${hour}|${kind}` -> count
  const notified = new Set();

  const day = () => new Date(now()).toISOString().slice(0, 10);
  const hour = () => new Date(now()).toISOString().slice(0, 13);

  function bump(map, key) { const n = (map.get(key) || 0) + 1; map.set(key, n); return n; }
  function prune() {
    const d = day(); const h = hour();
    for (const k of daily.keys()) if (!k.startsWith(d)) daily.delete(k);
    for (const k of hourly.keys()) if (!k.startsWith(h)) hourly.delete(k);
  }
  function limit(rule, householdId) {
    const key = `${hour()}|${rule}|${householdId || ''}`;
    if (!notified.has(key)) { notified.add(key); onLimit(rule, householdId); }
    if (notified.size > 5000) notified.clear();
    return false;
  }

  return {
    tryStartStream(householdId) {
      const n = active.get(householdId) || 0;
      if (n >= config.maxStreamsPerHousehold) return limit('household_stream_limit', householdId);
      active.set(householdId, n + 1);
      return true;
    },
    endStream(householdId) {
      const n = (active.get(householdId) || 0) - 1;
      if (n > 0) active.set(householdId, n); else active.delete(householdId);
    },
    allowTranscription(householdId) {
      prune();
      if ((hourly.get(`${hour()}|t`) || 0) >= config.maxTranscriptionsPerHour) return limit('global_transcription_limit', null);
      if ((daily.get(`${day()}|${householdId}|t`) || 0) >= config.maxTranscriptionsPerHouseholdPerDay) return limit('household_transcription_limit', householdId);
      bump(hourly, `${hour()}|t`); bump(daily, `${day()}|${householdId}|t`);
      return true;
    },
    allowSms(householdId, { to, from }) {
      prune();
      const dest = evaluateNumberForPurpose(PURPOSES.SMS_WARNING, String(to || ''));
      if (!dest.allowed || dest.number.e164 !== to || !UK_NUMBER.test(String(from || '')) || to === from) return limit('sms_destination_invalid', householdId);
      if ((hourly.get(`${hour()}|s`) || 0) >= config.maxSmsPerHour) return limit('global_sms_limit', null);
      if ((daily.get(`${day()}|${householdId}|s`) || 0) >= config.maxSmsPerHouseholdPerDay) return limit('household_sms_limit', householdId);
      bump(hourly, `${hour()}|s`); bump(daily, `${day()}|${householdId}|s`);
      return true;
    },
  };
}

// Wraps the Twilio client handed to riskMonitor so every SMS passes the caps.
// paidActionGate (optional, async): the telephony-abuse global incident
// mode — contain/suspend levels stop new SMS without a deploy.
function guardSmsClient(client, caps, householdId, paidActionGate = null) {
  return {
    messages: {
      async create(params) {
        if (typeof paidActionGate === 'function') {
          let ok = false;
          try { ok = await paidActionGate('sms', { householdId }); } catch { ok = false; }
          if (!ok) throw new Error('SMS not sent: incident mode');
        }
        if (!caps.allowSms(householdId, params)) throw new Error('SMS not sent: cost/destination cap');
        return client.messages.create(params);
      },
    },
  };
}

module.exports = { createCostCaps, resolveCostCapConfig, guardSmsClient };
