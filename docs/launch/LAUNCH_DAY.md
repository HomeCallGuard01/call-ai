Document: Launch Day Runbook
Version: 1.2
Last Updated: 2026-07-21
Status: Active
Owner: Andrew Deane
Related Sprint(s): Launch Polish Sprint (post Sprint 9, unnumbered) — see FINAL_ACCEPTANCE_REPORT.md and KNOWN_ISSUES.md

---

# Launch Day Runbook

Grounded in what this codebase actually enforces and what today's UAT
actually verified — not a generic launch checklist. Where something is a
real open decision rather than a known fact, it's marked as such rather
than assumed.

## Before you deploy

### 1. Blocking issues from `KNOWN_ISSUES.md`

- [x] **`TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` added and verified**
  (2026-07-21) — confirmed by a real Twilio API call reaching the actual
  purchase endpoint.
- [ ] **A registered Twilio `Address` object, using the confirmed
  registered office address.** The real purchase attempt above got all
  the way to Twilio's API and was rejected only with *"Phone Number
  Requires an Address but the 'AddressSid' parameter was empty."* Same
  underlying decision as the registered-office-address item further down
  this checklist — resolving that one decision unblocks both. Hard
  blocker for real call screening until done; does not affect
  payment/entitlement, which fails open exactly as designed.
- [ ] **Migration 017 needs the same staged repair migration 016 required**
  before its cancellation/release functions can be trusted — see
  `docs/engineering/016_017_migration_incident_notes.md`. Not urgent for
  day-one launch (nothing exercises it until a customer cancels), but
  shouldn't be assumed working.
- [ ] **A scheduled runner for `scripts/release-expired-twilio-numbers.js`
  set up** (e.g. a daily Railway Cron Job). Not launch-blocking on day
  one — nothing needs releasing until the first cancellation's 30-day
  grace period elapses — but needs to exist before that happens.
- [ ] **Registered office address filled in** (`public/terms.html` §1).
  Currently a placeholder — a live UK consumer contract needs a real one.

### 2. Stripe: test mode → live mode

Everything verified today — the checkout, the webhook, the entitlement
activation — was run against Stripe's **test/Sandbox** mode. Live mode
requires:

- [ ] A live-mode Price object created for £4.99/month (test-mode price
  IDs do not carry over to live mode).
- [ ] `STRIPE_SECRET_KEY` switched to the live secret key.
- [ ] `STRIPE_PRICE_ID` switched to the live Price ID.
- [ ] A **live-mode** webhook endpoint registered in the Stripe Dashboard
  pointing at the production `/billing/webhook` URL — live mode has its
  own signing secret, separate from test mode's. `STRIPE_WEBHOOK_SECRET`
  must be updated to match.
- [ ] VAT/Tax ID settings (`gb_vat`, `GB379120684`) confirmed present on
  the **live** Stripe account, not just test mode — these were set up
  against test mode earlier in this project and may need repeating for
  live.

### 3. Environment variables

`server.js` refuses to boot in production if any of these are missing,
or if `APP_URL` still resolves to `localhost`/`127.0.0.1`
(`services/serverConfig.js`, `validateProductionEnv`) — so a genuinely
broken deploy will fail loudly rather than silently, but confirm before
deploying rather than relying on the crash to catch it:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `APP_URL` — the real production domain
- `STRIPE_SECRET_KEY` — live key (see above)
- `STRIPE_PRICE_ID` — live price (see above)
- `STRIPE_WEBHOOK_SECRET` — live webhook secret (see above)

`TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` are **not** in this
boot-time-enforced list (`services/serverConfig.js`'s
`REQUIRED_IN_PRODUCTION` was deliberately not extended for this sprint —
Twilio provisioning fails open by design, so a missing credential
shouldn't crash the whole server the way a missing Stripe/Supabase
credential does). That means a deploy without them will boot
successfully and look fine — it just won't provision working numbers.
Confirm both are set as a manual step; nothing will crash to remind you.

### 4. Everything currently uncommitted

At the time of writing, the homepage, dashboard, `server.js`, and this
documentation are all uncommitted, per instruction, pending your review.
Nothing here should be deployed until you've explicitly approved and
committed it.

## Deploy

Railway redeploys fresh from the pushed branch/commit — there is no
separate build-then-promote step to remember, and no stale in-process
server survives a deploy (unlike the local-dev restart issue found during
today's UAT, which cannot happen in production for this reason).

- [ ] Push the approved commit(s) to the branch Railway deploys from.
- [ ] Watch the deploy complete (GitHub commit-status integration
  reflects Railway's build/deploy result).

## Smoke test immediately after deploy

Mirror today's UAT, in live mode:

- [ ] Register a real test account, confirm the email, log in.
- [ ] Subscribe. **Live mode does not accept Stripe test cards** — this
  requires either a real card (refundable via the Stripe Dashboard
  afterward) or accepting the £4.99 as the cost of a genuine end-to-end
  check. Decide which before doing this, rather than discovering it
  mid-test.
- [ ] Confirm the dashboard shows Protected and the webhook fired (check
  Stripe Dashboard → Developers → Webhooks for a successful delivery).
- [ ] Confirm a real inbound call to the test number is screened
  correctly (only possible once the Twilio `Address` object blocker above
  is resolved and a real number is actually purchased — otherwise there
  is no number to call).

## Rollback

Railway serves whatever was last deployed — rollback is redeploying the
previous known-good commit. Two migrations were added this sprint
(`016_household_twilio_provisioning.sql`,
`017_household_twilio_number_lifecycle.sql`) — both are purely additive
(new columns with safe defaults, new RPC functions) and don't modify or
remove anything existing, so rolling the application code back does not
require rolling the schema back too; the new columns/functions simply go
unused by the older code.

## Not yet in place — decide before or shortly after launch

- **Monitoring/alerting.** No tool is currently configured in this
  codebase. Webhook failures, payment errors, and call-routing/
  provisioning errors are currently only visible via `console.error` in
  Railway's own logs — including every Twilio provisioning failure
  (`"TWILIO PROVISIONING FAILED:"`), which nothing currently pages anyone
  about.
- **Scheduled runner for Twilio number release** — see "Blocking issues"
  above.
