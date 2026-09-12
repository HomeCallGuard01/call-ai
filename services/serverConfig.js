// Pure, side-effect-free startup helpers — kept separate from server.js so
// they're directly unit-testable without loading (and thereby starting)
// the actual server. See tests/server-config.test.mjs.

function resolvePort(env) {
  return env.PORT || 3000;
}

// Vars without which the app cannot function correctly or safely in
// production — missing any of these means either nothing works at all
// (Supabase config: no auth, no data access at all) or a core feature is
// silently broken/insecure (Stripe: a missing webhook secret means every
// webhook signature check fails, silently blocking all future subscription
// activations, not a crash anyone would notice quickly).
//
// Deliberately narrower than every env var the app reads. OPENAI_API_KEY
// and Resend_API_Key are not included: the app already fails open around
// them per-request/per-feature elsewhere in the codebase (matching this
// project's existing fail-open convention for optional integrations), and
// turning those into a hard boot-time failure would be a bigger behavioral
// change than this fix calls for.
const REQUIRED_IN_PRODUCTION = [
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "APP_URL",
  "STRIPE_SECRET_KEY",
  "STRIPE_PRICE_ID",
  "STRIPE_WEBHOOK_SECRET",
  // Added 2026-09-10: without this, /voice's Twilio signature check
  // (services/twilioWebhookAuth.js) can never validate anything — the
  // exact same silent-failure shape this file's own comment already
  // describes for STRIPE_WEBHOOK_SECRET, just for the webhook that makes
  // activation_verified_at auto-stamping trustworthy rather than
  // spoofable by anyone who can reach /voice.
  "TWILIO_AUTH_TOKEN",
];

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);

// Staging safety hardening (2026-09-12, following the PR #30 staging
// audit): the two real Supabase project refs this codebase ever talks
// to, named as constants rather than left as scattered/implicit literals
// — see docs/engineering/STAGING_ENVIRONMENT_PLAN.md §7, which proposed
// exactly this and was never implemented until now. The audit found a
// real, already-occurred incident (CURRENT_STATE.md) where a local
// server's default .env pointed at production while everything else
// pointed at staging — this pair of constants plus the checks below are
// the concrete guard against that happening again, undetected.
const PRODUCTION_SUPABASE_REF = "psbzynxplxfbyrbdidmn";
const STAGING_SUPABASE_REF = "tigwgmayeuisrxjjykqd";

// Returns the Supabase project ref (the subdomain segment) from a
// SUPABASE_URL, or null if it can't be parsed — never throws. A ref is
// not a secret (it's the public-facing project identifier, visible in
// every request URL), so this is safe to log directly.
function extractSupabaseRef(supabaseUrl) {
  if (!supabaseUrl) return null;
  try {
    const hostname = new URL(supabaseUrl).hostname;
    return hostname.split(".")[0] || null;
  } catch {
    return null;
  }
}

function isProductionSupabaseRef(supabaseUrl) {
  return extractSupabaseRef(supabaseUrl) === PRODUCTION_SUPABASE_REF;
}

function isStagingSupabaseRef(supabaseUrl) {
  return extractSupabaseRef(supabaseUrl) === STAGING_SUPABASE_REF;
}

// Returns an array of human-readable problem descriptions — variable
// *names* only, never values, so this is safe to log directly — or an
// empty array if everything required is present and valid. Pure so it's
// testable without actually exiting the process; server.js decides what
// to do with a non-empty result.
function validateProductionEnv(env) {
  const problems = [];

  for (const name of REQUIRED_IN_PRODUCTION) {
    if (!env[name]) {
      problems.push(`${name} is not set`);
    }
  }

  if (env.APP_URL) {
    let hostname;
    try {
      hostname = new URL(env.APP_URL).hostname;
    } catch {
      problems.push("APP_URL is not a valid URL");
    }
    if (hostname && LOCAL_HOSTS.has(hostname)) {
      problems.push(
        `APP_URL resolves to "${hostname}" — must be the real production domain, not localhost/127.0.0.1`
      );
    }
  }

  // Added 2026-09-12 (staging audit finding): a production boot pointed
  // at the staging Supabase project is exactly the class of mistake this
  // whole hardening pass exists to catch — inert under today's correct
  // production config, since production's real SUPABASE_URL is not the
  // staging ref.
  if (env.SUPABASE_URL && isStagingSupabaseRef(env.SUPABASE_URL)) {
    problems.push(
      `SUPABASE_URL resolves to the staging project (${STAGING_SUPABASE_REF}) — production must never boot against staging's database`
    );
  }

  return problems;
}

// Staging counterpart to validateProductionEnv — only ever called when
// the caller (server.js) has already decided this process claims to be
// running in staging mode (APP_ENV=staging). Fail-closed by design: an
// unparseable/missing SUPABASE_URL, or one that isn't EXACTLY the known
// staging ref (including production's), is a problem — this never
// assumes "not obviously production" is good enough. Same "names/refs
// only, never secret values" logging safety as validateProductionEnv.
function validateStagingEnv(env) {
  const problems = [];

  const ref = extractSupabaseRef(env.SUPABASE_URL);
  if (ref !== STAGING_SUPABASE_REF) {
    problems.push(
      `SUPABASE_URL must resolve to the staging project (${STAGING_SUPABASE_REF}), got "${ref || "none/unparseable"}"`
    );
  }

  if (!env.STRIPE_SECRET_KEY || !env.STRIPE_SECRET_KEY.startsWith("sk_test_")) {
    problems.push("STRIPE_SECRET_KEY must be a Stripe test-mode key (sk_test_...) in staging");
  }

  return problems;
}

// A safe-to-print snapshot of which environment this process believes
// it's running as — variable *names*/derived-mode only, never a secret
// value (Stripe mode is derived from the key's own public prefix, not
// the key itself; the Supabase ref is not a secret — see
// extractSupabaseRef's own comment). Intended to be logged unconditionally
// at startup so a misconfigured run is visible immediately, not just when
// validation happens to fail.
function describeEnvironmentIdentity(env) {
  let stripeMode = "not set";
  if (env.STRIPE_SECRET_KEY) {
    if (env.STRIPE_SECRET_KEY.startsWith("sk_live_")) stripeMode = "live";
    else if (env.STRIPE_SECRET_KEY.startsWith("sk_test_")) stripeMode = "test";
    else stripeMode = "unrecognised";
  }

  return {
    appEnv: env.APP_ENV || "unset",
    nodeEnv: env.NODE_ENV || "unset",
    supabaseRef: extractSupabaseRef(env.SUPABASE_URL) || "none/unparseable",
    stripeMode,
    appUrl: env.APP_URL || "not set",
  };
}

module.exports = {
  resolvePort,
  validateProductionEnv,
  validateStagingEnv,
  describeEnvironmentIdentity,
  extractSupabaseRef,
  isProductionSupabaseRef,
  isStagingSupabaseRef,
  REQUIRED_IN_PRODUCTION,
  PRODUCTION_SUPABASE_REF,
  STAGING_SUPABASE_REF,
};
