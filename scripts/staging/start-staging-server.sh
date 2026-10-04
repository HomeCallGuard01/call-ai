#!/usr/bin/env bash
# PREPARED 2026-10-04 — start the soft-launch candidate as STAGING, with every
# safety precondition checked first. Run from the candidate worktree only.
#   STAGING_ENV_FILE=/path/to/staging.env scripts/staging/start-staging-server.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
# server.js loads ./.env with dotenv: a .env here could silently fill missing
# staging values with PRODUCTION secrets (the primary checkout's .env is prod).
if [[ -e .env ]]; then echo "REFUSED: a .env exists in $(pwd); staging must not inherit it"; exit 2; fi
: "${STAGING_ENV_FILE:?set STAGING_ENV_FILE to the staging env file}"
set -a; source "$STAGING_ENV_FILE"; set +a
[[ "${SUPABASE_URL:-}" == *"tigwgmayeuisrxjjykqd.supabase.co"* ]] || { echo "REFUSED: SUPABASE_URL is not staging"; exit 2; }
[[ "${HCG_DEPLOYMENT:-}" == "staging" ]] || { echo "REFUSED: HCG_DEPLOYMENT must be staging"; exit 2; }
[[ "${STRIPE_SECRET_KEY:-}" == sk_test_* || "${STRIPE_SECRET_KEY:-}" == rk_test_* ]] || { echo "REFUSED: Stripe key is not test mode"; exit 2; }
[[ "${NUMBER_PROVISIONING_MODE:-}" == "fake" ]] || { echo "REFUSED: NUMBER_PROVISIONING_MODE must be fake on the shared Twilio account"; exit 2; }
[[ "${ENABLE_NUMBER_LIFECYCLE_SWEEP_SCHEDULE:-false}" != "true" ]] || { echo "REFUSED: lifecycle sweep must stay off"; exit 2; }
[[ "${OPS_NOTIFY_EMAIL_ENABLED:-false}" != "true" ]] || { echo "REFUSED: ops email must stay off in staging until approved"; exit 2; }
[[ "${ACCOUNTING_XERO_POSTING_ENABLED:-false}" != "true" ]] || { echo "REFUSED: Xero posting must stay off"; exit 2; }
node scripts/check-launch-config.js
exec node server.js
