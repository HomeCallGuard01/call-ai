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

module.exports = { resolvePort, validateProductionEnv, REQUIRED_IN_PRODUCTION };
