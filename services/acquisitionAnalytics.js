// acquisitionAnalytics.js — privacy-minimised, first-party, server-side
// acquisition/conversion event recording (2026-09). Writes to
// public.acquisition_events (migration 032) only; never sets a cookie,
// never reads/writes localStorage, never fingerprints, never stores a
// full IP address or full referrer URL.
//
// Every recording call is fire-and-forget-safe: a failure here must
// never affect the real page load / registration / checkout / webhook
// request it's attached to, matching this codebase's established
// convention for non-critical side effects (see services/alerting.js's
// sendCriticalAlert, called the same way throughout server.js/routes/).
'use strict';

const KNOWN_EVENT_TYPES = [
  'landing_visit',
  'registration_submitted',
  'registration_completed',
  'checkout_started',
  'paid_conversion',
];

// Postgres SQLSTATE for a unique-constraint violation, surfaced
// verbatim through PostgREST/supabase-js as error.code. See migration
// 032's own header: acquisition_events_dedup_idx enforces at the
// database level that the same (event_type, external_event_id) pair
// can never be inserted twice.
const UNIQUE_VIOLATION_CODE = '23505';

// Lazily resolved — same reasoning as every file in services/businessMetrics/:
// services/supabaseClients.js's plain client is constructed unconditionally
// and throws synchronously if SUPABASE_URL is unset, which would otherwise
// crash a test/context that hasn't loaded it.
function resolveSupabaseAdmin() {
  try {
    return require('./supabaseClients').supabaseAdmin;
  } catch (err) {
    console.error('ACQUISITION ANALYTICS: failed to load Supabase client:', err.message);
    return null;
  }
}

// Pure — extracts only the three UTM fields this app records, from
// whatever query-string object the caller has (Express's req.query, or
// a plain object built from a form POST body). Never reads/returns any
// other query parameter.
function parseUtmParams(query) {
  const source = query && typeof query.utm_source === 'string' ? query.utm_source.slice(0, 255) : null;
  const medium = query && typeof query.utm_medium === 'string' ? query.utm_medium.slice(0, 255) : null;
  const campaign = query && typeof query.utm_campaign === 'string' ? query.utm_campaign.slice(0, 255) : null;
  return { utmSource: source || null, utmMedium: medium || null, utmCampaign: campaign || null };
}

// Pure — extracts ONLY the hostname from a Referer header value, never
// the full URL (which can carry the referring page's own path/query
// string — third-party information this app has no business storing).
// Returns null for a missing/malformed referrer, or one that points at
// this app's own domain (that's internal navigation, not an
// acquisition source).
function parseReferrerHost(referrerHeaderValue, ownAppHost) {
  if (!referrerHeaderValue || typeof referrerHeaderValue !== 'string') return null;
  try {
    const url = new URL(referrerHeaderValue);
    const host = url.hostname.toLowerCase();
    if (ownAppHost && host === String(ownAppHost).toLowerCase()) return null;
    return host || null;
  } catch {
    return null;
  }
}

// Fire-and-forget: never throws, never rejects in a way the caller
// needs to handle. `deps.client` is injectable for tests; defaults to
// the real supabaseAdmin for production use, matching every other
// injectable-dependency pattern in this codebase (services/
// twilioProvisioning.js's client/assign/recordFailure/sendAlert).
//
// Returns { inserted, deduplicated } rather than a plain boolean so a
// caller/test can tell "recorded for the first time" apart from
// "already recorded — a retried webhook, correctly ignored" apart from
// "failed to record at all" — every production call site remains
// fire-and-forget (`.catch(() => {})`) and never reads this value.
async function recordAcquisitionEvent(eventType, fields = {}, deps = {}) {
  const { client = resolveSupabaseAdmin() } = deps;

  if (!KNOWN_EVENT_TYPES.includes(eventType)) {
    console.error('ACQUISITION ANALYTICS: unknown event type, not recorded:', eventType);
    return { inserted: false, deduplicated: false };
  }

  if (!client) {
    // Fails open/silent — matches this codebase's established
    // convention for non-critical telemetry (services/alerting.js
    // itself does the same when Resend_API_Key is absent). A missing
    // analytics table/credential must never be visible to a real
    // visitor/customer request.
    return { inserted: false, deduplicated: false };
  }

  try {
    const { error } = await client.from('acquisition_events').insert({
      event_type: eventType,
      household_id: fields.householdId || null,
      external_event_id: fields.externalEventId || null,
      utm_source: fields.utmSource || null,
      utm_medium: fields.utmMedium || null,
      utm_campaign: fields.utmCampaign || null,
      referrer_host: fields.referrerHost || null,
      path: fields.path || null,
    });

    if (error) {
      if (error.code === UNIQUE_VIOLATION_CODE) {
        // Expected, benign outcome — a retried/redelivered webhook (or
        // any future caller reusing the same externalEventId) hitting
        // the database-level dedup guard (migration 032's
        // acquisition_events_dedup_idx). Not an error: exactly the
        // idempotency this mechanism exists to provide.
        console.log('ACQUISITION ANALYTICS: duplicate event ignored (already recorded):', eventType, fields.externalEventId);
        return { inserted: false, deduplicated: true };
      }
      console.error('ACQUISITION ANALYTICS: insert failed:', error.message);
      return { inserted: false, deduplicated: false };
    }
    return { inserted: true, deduplicated: false };
  } catch (err) {
    console.error('ACQUISITION ANALYTICS: unexpected error recording event:', err.message);
    return { inserted: false, deduplicated: false };
  }
}

module.exports = {
  KNOWN_EVENT_TYPES,
  parseUtmParams,
  parseReferrerHost,
  recordAcquisitionEvent,
};
