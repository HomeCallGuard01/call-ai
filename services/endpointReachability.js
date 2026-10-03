'use strict';

// Endpoint reachability (2026-09-30, release readiness P1).
//
// "Registered at some point" is not "reachable now". Twilio keeps a push
// binding for about a year, but the device token behind it can die silently
// (FCM rotation, reinstall, force-stop, a denied permission). This turns the
// evidence HCG does hold into one explicit, explainable classification:
//
//   unregistered — the app has never registered: nothing to ring
//   unreachable  — positive evidence the phone cannot receive calls now
//                  (dead token, repeated failures, permission block)
//   degraded     — some evidence against (SUSPECT), or the registration is
//                  old with no delivered call since it (nothing has proven the
//                  binding still works)
//   confirmed    — a call was delivered after the latest registration, or
//                  within the confirmation window
//   presumed     — registered recently, no evidence either way
//
// Routing is deliberately NOT changed by this (a Dial to a doubtful client
// costs nothing and may still connect); it drives what customers and
// operators are told, the trace, and alerting.

const DAY_MS = 24 * 3600 * 1000;
const STALE_REGISTRATION_DAYS = 30;
const CONFIRMATION_WINDOW_DAYS = 30;

function ms(v) {
  if (!v) return NaN;
  return new Date(v).getTime();
}

function assessEndpointReachability({ lastRegisteredAt = null, health = null, now = new Date() } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const regMs = ms(lastRegisteredAt);
  const registrationAgeDays = Number.isFinite(regMs) ? Math.max(0, Math.floor((nowMs - regMs) / DAY_MS)) : null;
  const successMs = health ? ms(health.lastSuccessAt) : NaN;

  if (!Number.isFinite(regMs)) {
    return { reachability: 'unregistered', registrationAgeDays, reasons: ['the app has never registered for calls'] };
  }
  if (health && health.state === 'UNREACHABLE') {
    return { reachability: 'unreachable', registrationAgeDays, reasons: health.reasons && health.reasons.length ? health.reasons : ['recent evidence shows calls cannot reach the app'] };
  }
  if (health && health.state === 'SUSPECT') {
    return { reachability: 'degraded', registrationAgeDays, reasons: health.reasons && health.reasons.length ? health.reasons : ['some recent calls may not have reached the app'] };
  }
  const deliveredSinceRegistration = Number.isFinite(successMs) && successMs >= regMs;
  const deliveredRecently = Number.isFinite(successMs) && nowMs - successMs <= CONFIRMATION_WINDOW_DAYS * DAY_MS;
  if (deliveredSinceRegistration || deliveredRecently) {
    return { reachability: 'confirmed', registrationAgeDays, reasons: [] };
  }
  if (registrationAgeDays >= STALE_REGISTRATION_DAYS) {
    return {
      reachability: 'degraded',
      registrationAgeDays,
      reasons: [`the app last registered ${registrationAgeDays} days ago and no call has been delivered since; it may need to be opened`],
    };
  }
  return { reachability: 'presumed', registrationAgeDays, reasons: [] };
}

module.exports = { assessEndpointReachability, STALE_REGISTRATION_DAYS, CONFIRMATION_WINDOW_DAYS };
