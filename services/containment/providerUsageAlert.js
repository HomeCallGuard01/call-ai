// Provider usage alert → HCG latching global stop (soft-launch integration
// 2026-10-04; provider containment final T11).
//
// What this is NOT: a provider spend cap. Twilio usage triggers are alerts
// that fire after the spend happened; Twilio documents no hard spend limit.
// This turns a VERIFIED alert into an APPLICATION stop: the Fortress kill
// switch (fc_set_kill_switch, migration 067) — latching, admin-reset only,
// audited, refuses new spend and (breaker_terminates_active) ends live calls.
//
// Which alerts stop the service is explicit, because a stop also stops
// trusted-call delivery:
//   PROVIDER_USAGE_ALERT_TRIP_TRIGGER_SIDS  comma list of UT… SIDs that trip
//   PROVIDER_USAGE_ALERT_TRIP_ALL=true      every verified alert trips
// Any other verified alert is recorded (emergency intervention), as before.
//
// Authentication: the caller passes `genuine` (Twilio signature check); an
// unsigned/forged request has NO effect. AccountSid must match this
// deployment's TWILIO_ACCOUNT_SID when that is configured.
// Replay: a signed request carries DateFired; one older than
// PROVIDER_USAGE_ALERT_MAX_AGE_MINUTES (default 60) does not trip (so a
// captured alert cannot re-latch the switch after an admin reset), and the
// same alert (IdempotencyToken, else trigger SID + DateFired) trips at most
// once per process. DateFired missing/unparseable → trips anyway (financial
// fail-closed; availability is the cost) and says so.
'use strict';

function list(v) { return String(v || '').split(',').map((s) => s.trim()).filter(Boolean); }

function createProviderUsageAlertHandler({ env = process.env, setKillSwitch, recordIntervention = async () => {}, sendCriticalAlert = async () => {}, now = () => new Date(), seen = new Map() } = {}) {
  if (typeof setKillSwitch !== 'function') throw new Error('providerUsageAlert: setKillSwitch required');

  return async function handleProviderUsageAlert({ genuine, body = {} }) {
    if (!genuine) return { status: 403, tripped: false, reason: 'signature_invalid' };
    const expectedAccount = env.TWILIO_ACCOUNT_SID;
    if (expectedAccount && body.AccountSid !== expectedAccount) return { status: 403, tripped: false, reason: 'account_mismatch' };

    const context = {
      usageCategory: body.UsageCategory || null,
      currentValue: body.CurrentValue || null,
      triggerValue: body.TriggerValue || null,
      triggerBy: body.TriggerBy || null,
      recurring: body.Recurring || null,
      friendlyName: body.FriendlyName || null,
      usageTriggerSid: body.UsageTriggerSid || null,
      dateFired: body.DateFired || null,
    };
    const tripSids = list(env.PROVIDER_USAGE_ALERT_TRIP_TRIGGER_SIDS);
    const tripAll = env.PROVIDER_USAGE_ALERT_TRIP_ALL === 'true';
    const designated = tripAll || (!!context.usageTriggerSid && tripSids.includes(context.usageTriggerSid));

    await Promise.resolve(recordIntervention({
      level: 'emergency',
      rule: 'provider_usage_trigger',
      action: designated
        ? 'provider-side spend alarm fired; designated to latch the HCG kill switch (the provider does not stop spending)'
        : 'provider-side spend alarm fired (alert only; the provider does not stop spending)',
      details: context,
    })).catch(() => {});
    if (!designated) return { status: 204, tripped: false, reason: 'alert_only' };

    const maxAgeMs = Math.max(1, Number(env.PROVIDER_USAGE_ALERT_MAX_AGE_MINUTES) || 60) * 60000;
    const firedMs = context.dateFired ? Date.parse(context.dateFired) : NaN;
    const nowMs = now().getTime();
    if (Number.isFinite(firedMs) && nowMs - firedMs > maxAgeMs) {
      return { status: 204, tripped: false, reason: 'stale_alert_not_tripped' };
    }
    const key = body.IdempotencyToken || `${context.usageTriggerSid}:${context.dateFired || 'undated'}`;
    for (const [k, at] of seen) if (nowMs - at > maxAgeMs) seen.delete(k);
    if (seen.has(key)) return { status: 204, tripped: false, reason: 'duplicate_alert' };

    const reason = `provider usage trigger ${context.usageTriggerSid || 'unknown'} fired (${context.usageCategory || '?'} ${context.currentValue || '?'}/${context.triggerValue || '?'} ${context.triggerBy || ''})`.slice(0, 480);
    try {
      await setKillSwitch({ on: true, reason, actor: 'system:provider-usage-alert' });
    } catch (err) {
      await Promise.resolve(sendCriticalAlert('provider_usage_alert_trip_failed', 'A designated provider usage alert fired but the HCG kill switch could NOT be latched — stop spend manually', { ...context, error: err.message })).catch(() => {});
      return { status: 500, tripped: false, reason: 'kill_switch_unavailable' };
    }
    seen.set(key, nowMs);
    await Promise.resolve(sendCriticalAlert('provider_usage_alert_tripped', 'A designated provider usage alert latched the HCG kill switch: new spend refused, live calls ending. Admin reset required.', { ...context, undated: !Number.isFinite(firedMs) })).catch(() => {});
    return { status: 204, tripped: true, reason: Number.isFinite(firedMs) ? 'tripped' : 'tripped_undated' };
  };
}

module.exports = { createProviderUsageAlertHandler };
