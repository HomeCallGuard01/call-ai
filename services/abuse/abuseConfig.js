'use strict';

// Telephony abuse P0 — every threshold in one place, env-overridable.
// Defaults are conservative starting points, NOT tuned against production
// traffic (none of meaningful volume exists yet). Each is listed with its
// rationale in docs/security/TELEPHONY_ABUSE_THREAT_MODEL.md.

function posInt(v, d) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : d;
}
const MIN = 60 * 1000;

function resolveAbuseConfig(env = process.env) {
  return Object.freeze({
    // Same caller → same household. A human redialling a busy relative
    // does 2–4 calls in a few minutes; 8 in 5 minutes is automation.
    // Action: that caller (only) is refused (<Reject>, unbilled) for the
    // cooldown. Other callers to the household are unaffected.
    callerHouseholdBurst: posInt(env.ABUSE_CALLER_HOUSEHOLD_BURST, 8),
    callerHouseholdWindowMs: posInt(env.ABUSE_CALLER_HOUSEHOLD_WINDOW_MINUTES, 5) * MIN,
    callerHouseholdCooldownMs: posInt(env.ABUSE_CALLER_HOUSEHOLD_COOLDOWN_MINUTES, 15) * MIN,
    // Same caller → many distinct households (one source attacking the
    // customer base). Refused across all households for the cooldown.
    callerFanoutHouseholds: posInt(env.ABUSE_CALLER_FANOUT_HOUSEHOLDS, 5),
    callerFanoutWindowMs: posInt(env.ABUSE_CALLER_FANOUT_WINDOW_MINUTES, 60) * MIN,
    callerFanoutCooldownMs: posInt(env.ABUSE_CALLER_FANOUT_COOLDOWN_MINUTES, 60) * MIN,
    // Household receiving abnormal volume from MANY callers. Never a
    // refusal (that would let an attacker switch a victim's protection
    // off): flagged, alerted, and trusted-contact bypass suspended so a
    // spoofed "trusted" CLI cannot skip monitoring during the event.
    householdElevatedCalls: posInt(env.ABUSE_HOUSEHOLD_ELEVATED_CALLS, 20),
    householdElevatedWindowMs: posInt(env.ABUSE_HOUSEHOLD_ELEVATED_WINDOW_MINUTES, 10) * MIN,
    // A spoofed trusted CLI calling repeatedly: bypass suspended (calls
    // still connect, monitored) after this many in the window.
    trustedBypassBurst: posInt(env.ABUSE_TRUSTED_BYPASS_BURST, 4),
    trustedBypassWindowMs: posInt(env.ABUSE_TRUSTED_BYPASS_WINDOW_MINUTES, 10) * MIN,
    // Concurrency. One person answers one call; a household with more
    // than this many simultaneous inbound calls is being flooded. Refusal
    // here is the same experience as an engaged line.
    maxConcurrentPerHousehold: posInt(env.ABUSE_MAX_CONCURRENT_PER_HOUSEHOLD, 3),
    maxConcurrentPerCaller: posInt(env.ABUSE_MAX_CONCURRENT_PER_CALLER, 2),
    maxConcurrentGlobal: posInt(env.ABUSE_MAX_CONCURRENT_GLOBAL, 200),
    // Leases cover the ringing + talking phase; released on the <Dial>
    // action / status callbacks and media-stream stop. The TTL only bounds
    // a lease whose end we never observed (e.g. caller hung up during the
    // announcement): kept short so a leaked lease cannot become a
    // victim-lockout vector.
    leaseTtlMs: posInt(env.ABUSE_CALL_LEASE_TTL_MINUTES, 10) * MIN,
    // Global auto-trip (contain mode: no purchases, no SMS). Never refuses calls.
    globalCallsPerMinuteTrip: posInt(env.ABUSE_GLOBAL_CALLS_PER_MINUTE_TRIP, 300),
    incidentAutoTripMs: posInt(env.ABUSE_INCIDENT_AUTO_TRIP_MINUTES, 30) * MIN,
    // Webhook replay window (Twilio signs no timestamp; see webhookReplay.js).
    webhookReplayWindowMs: posInt(env.ABUSE_WEBHOOK_REPLAY_WINDOW_MINUTES, 30) * MIN,
    // Provisioning.
    maxPurchasesPerHouseholdPer30d: posInt(env.ABUSE_MAX_PURCHASES_PER_HOUSEHOLD_30D, 2),
    maxPurchasesGlobalPerHour: posInt(env.ABUSE_MAX_PURCHASES_GLOBAL_PER_HOUR, 10),
    maxPurchasesGlobalPerDay: posInt(env.ABUSE_MAX_PURCHASES_GLOBAL_PER_DAY, 40),
    // Multi-account: households sharing the same customer phone number.
    maxHouseholdsPerPhoneNumber: posInt(env.ABUSE_MAX_HOUSEHOLDS_PER_PHONE_NUMBER, 1),
    maxSignupsPerNormalisedEmailBase: posInt(env.ABUSE_MAX_SIGNUPS_PER_EMAIL_BASE, 2),
    // Expected provider account — a webhook for any other AccountSid is refused.
    twilioAccountSid: typeof env.TWILIO_ACCOUNT_SID === 'string' && env.TWILIO_ACCOUNT_SID.startsWith('AC') ? env.TWILIO_ACCOUNT_SID : null,
    // What to do when Claude 1's financial authorisation cannot answer.
    // 'local_caps' (default): connect and keep monitoring, bounded by the
    // process-local cost caps (costCaps.js) — protection stays on.
    // 'unmonitored': connect, no new paid monitoring.
    financialUnavailablePolicy: env.ABUSE_FINANCIAL_UNAVAILABLE_POLICY === 'unmonitored' ? 'unmonitored' : 'local_caps',
    financialAuthTimeoutMs: posInt(env.ABUSE_FINANCIAL_AUTH_TIMEOUT_MS, 1500),
  });
}

module.exports = { resolveAbuseConfig };
