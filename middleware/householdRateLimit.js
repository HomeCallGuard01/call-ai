'use strict';

// Per-household fixed-window rate limiter for authenticated app telemetry and
// registration endpoints (2026-09-30, release readiness P5).
//
// Why: these routes are authenticated, but a single signed-in household (or a
// leaked session) could otherwise call them without bound — every call writes
// database rows, and the invite-report routes may make a Twilio REST lookup
// for an unknown call SID (database/deliveryEvidence.js
// resolveHouseholdCallSid). An unbounded loop would grow tables (cost) and
// could consume the Twilio account's REST concurrency that live call handling
// shares. Limits are generous for real use (a real app makes a handful of
// these per call / per hour) and bound abuse.
//
// In-memory, per process: with more than one server instance the effective
// limit is multiplied by the instance count, which is still bounded. Must run
// after requireAuthApi (needs req.household).

function createHouseholdRateLimiter({ name, limit, windowMs, now = () => Date.now(), maxKeys = 50000 }) {
  const buckets = new Map(); // householdId -> { windowStart, count }

  function check(householdId) {
    const t = now();
    let b = buckets.get(householdId);
    if (!b || t - b.windowStart >= windowMs) {
      if (!b && buckets.size >= maxKeys) {
        // Bound memory: drop expired buckets; if still full, refuse (fail closed).
        for (const [k, v] of buckets) if (t - v.windowStart >= windowMs) buckets.delete(k);
        if (buckets.size >= maxKeys) return { allowed: false, retryAfterSeconds: Math.ceil(windowMs / 1000) };
      }
      b = { windowStart: t, count: 0 };
      buckets.set(householdId, b);
    }
    b.count += 1;
    if (b.count > limit) {
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((b.windowStart + windowMs - t) / 1000)) };
    }
    return { allowed: true, remaining: limit - b.count };
  }

  let warnedAt = 0;
  function middleware(req, res, next) {
    const householdId = req.household && req.household.id;
    if (!householdId) return res.status(401).json({ error: 'unauthorized' });
    const result = check(householdId);
    if (result.allowed) return next();
    if (now() - warnedAt > 60000) {
      warnedAt = now();
      console.error(`RATE LIMITED: ${name} for household ${householdId} (limit ${limit}/${Math.round(windowMs / 60000)}min)`);
    }
    res.set('Retry-After', String(result.retryAfterSeconds));
    return res.status(429).json({ error: 'rate_limited' });
  }

  return { check, middleware, _buckets: buckets };
}

const HOUR = 3600 * 1000;

// One shared definition so the route file and tests agree on the numbers.
const LIMITS = Object.freeze({
  voiceToken: { limit: 60, windowMs: HOUR },
  voiceRegistered: { limit: 60, windowMs: HOUR },
  callInviteReports: { limit: 240, windowMs: HOUR },
  deviceReadiness: { limit: 30, windowMs: HOUR },
});

module.exports = { createHouseholdRateLimiter, LIMITS };
