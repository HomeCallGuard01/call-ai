// usageMeter.js — the live-monitoring pipeline's connection to monitored-
// minute accounting (mediaStreamHandler.js's `usageMeter` dependency).
// Wraps migration 056's RPCs with the cost model, so the handler only deals
// in "attach this stream", "this stream has now run N seconds" and "check
// the warning points".
//
// Usage is reported as the stream's ABSOLUTE elapsed seconds; the database
// adds only the positive delta, so retries, duplicate reports and replays
// can never count the same audio twice. Counting is by stream time, never
// by transcription requests.
'use strict';

const { resolveCostRates } = require('./costModel');
const { notifyUsageThresholds } = require('./usageNotifier');
const { resolvePlan } = require('./plans');

function createUsageMeter({ attachMonitoringStream, recordMonitoringProgress, claimUsageNotification, deliverNotification = null, recordIntervention, env = process.env, now = () => new Date() }) {
  const rates = resolveCostRates(env);
  const plan = resolvePlan(null, env); // warning points / grace are platform-wide settings

  return {
    costPerSecondGbp: rates.monitoringPerSecondGbp,
    graceSeconds: plan.graceSeconds,

    attach({ callSid, streamSid }) {
      return attachMonitoringStream({ callSid, streamSid });
    },

    progress({ callSid, streamSid, totalSeconds, final = false, endReason = null }) {
      return recordMonitoringProgress({
        callSid, streamSid,
        totalSeconds: Math.max(0, Math.floor(totalSeconds)),
        costPerSecondGbp: rates.monitoringPerSecondGbp,
        now: now(), final, endReason,
      });
    },

    notify({ householdId, periodStart, usedSeconds, allowanceSeconds }) {
      return notifyUsageThresholds({
        householdId, periodStart, usedSeconds, allowanceSeconds,
        warningPoints: plan.warningPoints,
        claim: claimUsageNotification,
        deliver: deliverNotification,
      });
    },

    recordIntervention: recordIntervention || (async () => {}),
  };
}

module.exports = { createUsageMeter };
