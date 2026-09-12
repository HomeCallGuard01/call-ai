// Explicit staging launcher (2026-09-12 staging audit) — the smallest
// reliable way to run this backend against staging without a developer
// having to manually combine variables (and risk repeating the exact
// mixup docs/engineering/STAGING_ENVIRONMENT_PLAN.md and CURRENT_STATE.md
// both document already happening once: a local server's default .env
// pointed at production while everything else pointed at staging).
//
// Loads ONLY .env.staging.local (never the default .env) and sets
// APP_ENV=staging before server.js's own require("dotenv").config() runs
// — dotenv does not override already-set process.env values, so this
// guarantees the default .env can never silently supply (or override)
// SUPABASE_URL/STRIPE_SECRET_KEY/etc. here, matching the exact mechanism
// already used successfully once for this in a prior session
// (CURRENT_STATE.md), now made repeatable instead of ad hoc.
//
// server.js's own startup validation (services/serverConfig.js's
// validateStagingEnv, gated on APP_ENV === "staging") is what actually
// enforces the staging project ref and Stripe test-mode requirement —
// this launcher only loads the file and sets the flag; it does no
// validation itself.
//
// Run with: npm run start:staging

const path = require("node:path");
const dotenv = require("dotenv");

const envPath = path.join(__dirname, "..", ".env.staging.local");
const result = dotenv.config({ path: envPath });

if (result.error) {
  console.error(`FATAL: could not load ${envPath} — copy .env.staging.example to .env.staging.local and fill in real staging values.`);
  process.exit(1);
}

process.env.APP_ENV = process.env.APP_ENV || "staging";

require("../server.js");
