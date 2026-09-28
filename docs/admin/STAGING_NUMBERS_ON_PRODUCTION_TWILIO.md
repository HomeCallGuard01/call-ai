<!--
STATUS (2026-09-28): explanation only. Nothing was released, purchased or
reconfigured. No production data was read in this session. Numbers and
counts come from the read-only runs of 2026-09-27 (below); the cause was
re-verified from code and local configuration on 2026-09-28.
-->
# The 7 staging numbers billed on the production Twilio account

## What they are

On 27 Sep 2026, read-only runs listed 19 numbers on HCG's single Twilio account, about £16.51/month. Two runs agreed on 7 of them:
- the dashboard's number inventory (voice-URL evidence);
- the Finance number-cost report (which joins the staging database).

These 7 numbers:
- belong to **households in the staging Supabase project** (`tigwgmayeuisrxjjykqd`), not to production;
- have a **voice URL on a development ngrok tunnel**, so production never answers calls to them;
- cost about **£0.87 each per month, £6.08/month together**, and more with every staging signup.

They are **not customer numbers**, and no production household references them. That's why production-only tools (the admin API in PR #47, and the lifecycle sweep) can't see them. Only the provider list shows them.

The Numbers tab labels each one "Development/staging number on the production account" (amber). It shows the tunnel host as evidence and explains the cause in the next step.

## Why they exist

There are three mechanisms. All are verified from code or local configuration.

1. **A staging server uses the production Twilio account.**
   - `.env.staging.local` contains no `TWILIO_ACCOUNT_SID` or `TWILIO_AUTH_TOKEN`. This was checked 2026-09-28, with presence only printed and no values.
   - `server.js` starts with `require("dotenv").config()`, which loads the default `.env` and **fills in every variable not already set**.
   - The default `.env` holds the production Twilio account: it points at the production Supabase project, and it is the file the 27 Sep production inventory scripts loaded.
   - So a staging server buys numbers with production credentials. `scripts/start-staging.js` (branch `feature/staging-safety-hardening`) says the default `.env` "can never silently supply" values. That holds for *overriding* values, not for *supplying* missing ones.
2. **Nothing stops a non-production purchase on `main`.**
   - The purchase guard (`services/telephony/provisioningGuard.js`, commit `d3caeb9`) exists only on the unmerged branch `feature/nonprod-provisioning-guard`.
   - That guard adds `NUMBER_PROVISIONING_MODE=fake` and blocks mixed configuration.
3. **Nothing ever releases them.**
   - Staging memberships come from Stripe **test** subscriptions, which don't lapse, so the release lifecycle never starts.
   - The staging-safety branch also refuses a real Twilio release unless the Supabase project is production. That's correct for safety, but it means staging can't release its own numbers.

HCG has **one Twilio account and no sub-accounts**, so development and production costs are mixed together. A buyer's due diligence would flag this (see `ACQUISITION_READINESS_REVIEW.md`).

## What was not done

- No number was released, purchased or reconfigured.
- No production or staging database was queried in this session. A read-only production check was requested on 2026-09-28 and declined by the session's permission policy. Re-running the Numbers tab (or `scripts/number-cost-report.js` on the ledger branch) against production confirms today's count.

## DECISION REQUIRED (Andrew)

1. Create a **Twilio sub-account for staging/dev**, with its own balance cap. Put its credentials in `.env.staging.local`, so staging never falls back to production.
2. Merge the **non-production provisioning guard** (`feature/nonprod-provisioning-guard`), or set `NUMBER_PROVISIONING_MODE=fake` for staging.
3. **Release the existing 7** once each is confirmed to be staging-only. Check that it has no inbound calls from real people. Release them deliberately, one by one; never in bulk from a dashboard. Saving: about £6/month now, and it stops the growth.
4. Separately, the **orphan** number (no household in either environment, inbound calls as recently as 21 Sep) must be investigated before anything happens to it.
