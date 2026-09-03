// systemHealth.js — the dashboard's GREEN/AMBER/RED operational health
// panel. Deliberately conservative: "configured" alone is never
// sufficient for GREEN (per this build's own brief) — where this app has
// no persisted record of a recent *successful* operation for a
// component, that's reported as an explicit gap (AMBER, with a stated
// reason), not silently upgraded to GREEN because the credential exists.
'use strict';

const { twilioRestClient } = require('../twilioClient');
const { checkSupabaseHealth } = require('../healthCheck');
const { isOpenAiKeyConfigured } = require('./openaiCosts');

// Lazily resolved, not destructured at module load — services/
// supabaseClients.js's plain (non-admin) client is constructed
// unconditionally and throws synchronously if SUPABASE_URL is unset (a
// pre-existing quirk of that shared file, unrelated to this dashboard).
// Since this module is required by tests and by other pure-logic
// contexts that don't necessarily load Supabase configuration, a failed
// require here is treated the same as "admin client unavailable", not
// as a crash — matching this codebase's established fail-open
// convention (see database/householdUsage.js on the mobile-onboarding
// branch for the identical, previously-diagnosed pattern).
function resolveSupabaseAdmin() {
  try {
    return require('../supabaseClients').supabaseAdmin;
  } catch (err) {
    console.error('BUSINESS METRICS: failed to load Supabase client:', err.message);
    return null;
  }
}

const SUPABASE_HEALTH_TIMEOUT_MS = 3000;

async function checkTwilioHealth() {
  if (!twilioRestClient) {
    return { status: 'RED', reason: 'TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN not configured — inbound call forwarding cannot function at all' };
  }
  try {
    const balance = await twilioRestClient.balance.fetch();
    const amount = Number(balance.balance);
    if (Number.isFinite(amount) && amount <= 0) {
      return { status: 'RED', reason: `Twilio account balance is ${balance.balance} ${balance.currency} — calls may fail to place/receive` };
    }
    return { status: 'GREEN', reason: 'credentials valid, account reachable, balance positive', balance: { amount: balance.balance, currency: balance.currency } };
  } catch (err) {
    return { status: 'RED', reason: `Twilio account unreachable: ${err.message}` };
  }
}

// Cannot currently confirm "recent successful transcription" — this app
// has no persisted transcription-outcome record (transcribeChunk.js
// logs to console only, via logEvent, not to a queryable table). Stated
// as an explicit, named gap rather than silently reported as healthy.
function checkOpenAiHealth(env = process.env) {
  if (!isOpenAiKeyConfigured(env)) {
    return { status: 'RED', reason: 'OPENAI_API_KEY not configured — live scam-risk transcription cannot function; calls still connect, but unscreened' };
  }
  return {
    status: 'AMBER',
    reason: 'OPENAI_API_KEY is configured, but this app has no persisted record of recent successful transcription to confirm it is actually working — see Known Gaps',
  };
}

async function checkSupabaseHealthStatus() {
  const supabaseAdmin = resolveSupabaseAdmin();
  if (!supabaseAdmin) {
    return { status: 'RED', reason: 'SUPABASE_SERVICE_ROLE_KEY not configured — no household/call/billing data can be read or written' };
  }
  const result = await checkSupabaseHealth(supabaseAdmin, SUPABASE_HEALTH_TIMEOUT_MS);
  if (result === 'ok') return { status: 'GREEN', reason: 'database reachable' };
  if (result === 'timeout') return { status: 'AMBER', reason: `database did not respond within ${SUPABASE_HEALTH_TIMEOUT_MS}ms` };
  return { status: 'RED', reason: 'database query failed' };
}

// Stripe: reuses the same signal database/adminMetrics.js's getAlerts
// already surfaces (stripe_webhook_events rows with status='failed') —
// not a new integration, just a health-status framing of existing data.
function checkStripeHealth(recentFailedWebhookCount) {
  if (recentFailedWebhookCount > 0) {
    return { status: 'AMBER', reason: `${recentFailedWebhookCount} failed Stripe webhook event(s) on record — subscription state may be out of date for affected households` };
  }
  return { status: 'GREEN', reason: 'no failed Stripe webhook events on record' };
}

// RevenueCat: no failure-tracking table exists in this schema today
// (confirmed this session) — genuinely cannot report recent operational
// evidence one way or the other. Named as a gap, not guessed.
function checkRevenueCatHealth() {
  return {
    status: 'AMBER',
    reason: 'no RevenueCat webhook failure log exists in this schema — cannot confirm recent operational success or failure. See Known Gaps.',
  };
}

// Resend: same — services/alerting.js sends but never persists outcome.
function checkResendHealth(env = process.env) {
  if (!env.Resend_API_Key) {
    return { status: 'AMBER', reason: 'Resend_API_Key not configured — admin alert emails will not be delivered (this is a visibility gap, not a protection gap)' };
  }
  return { status: 'AMBER', reason: 'Resend_API_Key is configured, but delivery success/failure is not persisted anywhere to confirm recent operation' };
}

// The app responding to this very request is itself the evidence Railway
// health is fine — no separate check needed or meaningful to add.
function checkRailwayHealth() {
  return { status: 'GREEN', reason: 'this response was served by the production process — the process is up' };
}

// Pure — worst-status-wins rollup, matching the brief's definition of
// RED ("protection or revenue-critical failure") taking priority over
// any AMBER visibility gap.
function computeOverallStatus(components) {
  const statuses = Object.values(components).map((c) => c.status);
  if (statuses.includes('RED')) return 'RED';
  if (statuses.includes('AMBER')) return 'AMBER';
  return 'GREEN';
}

async function getSystemHealthSnapshot({ recentFailedStripeWebhookCount = 0, env = process.env } = {}) {
  const [twilio, supabase] = await Promise.all([checkTwilioHealth(), checkSupabaseHealthStatus()]);
  const components = {
    twilio,
    openai: checkOpenAiHealth(env),
    supabase,
    stripe: checkStripeHealth(recentFailedStripeWebhookCount),
    revenuecat: checkRevenueCatHealth(),
    resend: checkResendHealth(env),
    railway: checkRailwayHealth(),
  };
  return { overall: computeOverallStatus(components), components, checkedAt: new Date().toISOString() };
}

module.exports = {
  checkTwilioHealth,
  checkOpenAiHealth,
  checkSupabaseHealthStatus,
  checkStripeHealth,
  checkRevenueCatHealth,
  checkResendHealth,
  checkRailwayHealth,
  computeOverallStatus,
  getSystemHealthSnapshot,
};
