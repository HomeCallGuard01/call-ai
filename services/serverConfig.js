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
];

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);

// Known Supabase project refs — used only to catch an explicitly-selected
// non-production environment (ENV_FILE set; see server.js) pointing at the
// wrong project, never to gate plain default local development.
const STAGING_SUPABASE_REF = "tigwgmayeuisrxjjykqd";
const PRODUCTION_SUPABASE_REF = "psbzynxplxfbyrbdidmn";

// Mirrors REQUIRED_IN_PRODUCTION's shape but for the canonical staging env
// file (.env.staging) — see that file's own header comment for why Twilio
// and OpenAI are excluded here too.
const REQUIRED_IN_STAGING = [
  "APP_URL",
  "PORT",
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "STRIPE_SECRET_KEY",
  "STRIPE_PUBLISHABLE_KEY",
  "STRIPE_PRICE_ID",
  "STRIPE_WEBHOOK_SECRET",
];

// The staging-environment counterpart to validateProductionEnv() above —
// added after a real incident where the staging backend's Stripe/Twilio/
// OpenAI config silently fell through to the sandbox repo's default .env
// (which also carries a live-prefixed Stripe key) because nothing checked
// that an explicitly-selected non-production environment actually pointed
// at non-production services. Same contract: pure, no I/O, problem
// messages name which check failed and never include a variable's value.
// server.js only calls this when ENV_FILE was explicitly supplied and
// NODE_ENV isn't "production" — plain default local dev (no ENV_FILE) is
// untouched.
function validateStagingEnv(env) {
  const problems = [];

  for (const name of REQUIRED_IN_STAGING) {
    if (!env[name]) {
      problems.push(`${name} is not set`);
    }
  }

  if (env.SUPABASE_URL) {
    if (env.SUPABASE_URL.includes(PRODUCTION_SUPABASE_REF)) {
      problems.push(
        "SUPABASE_URL references the production Supabase project — refusing to start a non-production process against it"
      );
    } else if (!env.SUPABASE_URL.includes(STAGING_SUPABASE_REF)) {
      problems.push(`SUPABASE_URL does not reference the staging Supabase project (${STAGING_SUPABASE_REF})`);
    }
  }

  if (env.STRIPE_SECRET_KEY) {
    if (env.STRIPE_SECRET_KEY.startsWith("sk_live_")) {
      problems.push("STRIPE_SECRET_KEY is a live Stripe secret key — refusing to start a non-production process with it");
    } else if (!env.STRIPE_SECRET_KEY.startsWith("sk_test_")) {
      problems.push("STRIPE_SECRET_KEY is not a recognizable Stripe test-mode key (expected an sk_test_ prefix)");
    }
  }

  if (env.STRIPE_PUBLISHABLE_KEY && env.STRIPE_PUBLISHABLE_KEY.includes("_live_")) {
    problems.push("STRIPE_PUBLISHABLE_KEY looks like a live Stripe key — refusing to start a non-production process with it");
  }

  return problems;
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

  return problems;
}

module.exports = {
  resolvePort,
  validateProductionEnv,
  REQUIRED_IN_PRODUCTION,
  validateStagingEnv,
  REQUIRED_IN_STAGING,
  STAGING_SUPABASE_REF,
  PRODUCTION_SUPABASE_REF,
};
