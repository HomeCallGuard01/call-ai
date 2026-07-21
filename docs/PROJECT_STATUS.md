Document: Project Status
Version: 1.1
Last Updated: 2026-07-17
Status: Active
Owner: Andrew Deane
Related Sprint(s): All (1–8) — see docs/sprints/README.md for the per-sprint index

---

# Home Call Guard – Project Status

## Current Status

**Project:** Home Call Guard

**Version:** v0.6 Pre-MVP

**Overall Status:** 🟢 Healthy

**Current Sprint:** None in progress — Sprint 7 (Household Identity) not yet started

**Date Updated:** July 2026

---

# Vision

Protect every household from scam and nuisance calls without changing how they use their home phone.

Our mission is to deliver peace of mind through intelligent call screening, trusted contact management and simple, reassuring customer experiences.

---

# Completed Sprints

## ✅ Sprint 1 – Foundation

Completed:

- Node.js backend
- Express server
- Twilio integration
- OpenAI integration
- Local development environment
- Git repository

---

## ✅ Sprint 2 – AI Screening

Completed:

- AI call classification
- Keyword scam detection
- Trusted caller bypass
- Safe caller routing
- Scam call blocking

---

## ✅ Sprint 3 – Contact Protection

Completed:

- CSV upload
- Contact parsing
- Supabase integration
- Trusted contact storage
- Known caller identification

---

## ✅ Sprint 4 – Dashboard MVP

Completed:

- Converted the static `/dashboard` demo into a live page reading from `GET /dashboard-data`
- Protection status hero, 4 live stat cards (protected contacts, calls today, blocked, safe)
- Recent activity list with a calm empty state, no fake/demo rows
- Calm on-page error handling if `/dashboard-data` fails to load
- CSV upload form kept working, unchanged
- Mobile responsive, accessible contrast and font sizes

---

## ✅ Sprint 5 – Dashboard Experience

Completed:

- Protection status made dynamic (loading / protected / status-unavailable) instead of a hardcoded "Protected"
- Removed the non-functional sidebar navigation entirely; replaced with a simple top header (logo, "Home Call Guard", "Protection Dashboard" subtitle)
- Refresh interval tuned to 15 seconds
- Empty-activity wording consolidated to one consistent message (previously duplicated/inconsistent between the static markup and the JS render path)
- Larger, more visible pulsing shield; larger, precisely cropped header logo

---

## ✅ Sprint 6 – Reliable Call History

### Objective

Persist genuine call activity in Supabase so dashboard statistics and recent activity survive server restarts.

### What was built

- New `calls` table in Supabase (`supabase/migrations/001_create_calls_table.sql`): `id`, `household_id` (nullable, unused until Sprint 7), `call_sid` (unique), `number`, `status`, `result`, `decision_reason`, `risk_score`, `processing_time_ms`, `call_duration`, `ai_model`, `created_at`. Check constraints on `status`, `result`, `risk_score` range, and non-negative `processing_time_ms`/`call_duration`.
- Removed the in-memory `callLogs` array from `server.js` entirely.
- `/process` writes every screened call via `logCall()`, fired without blocking the Twilio response (avoids adding database latency to a live call).
- **Idempotency:** `logCall()` upserts on `call_sid` with `ignoreDuplicates: true` (`INSERT ... ON CONFLICT (call_sid) DO NOTHING`), so a Twilio webhook retry cannot create a duplicate call record.
- **Populated this sprint:** `call_sid` (from Twilio's `CallSid`), `ai_model` (captured only when the OpenAI classification branch actually runs), `processing_time_ms` (wall-clock time spent in `/process`).
- **Left null this sprint (by design):** `decision_reason` and `risk_score` (need an AI prompt change, out of scope), `call_duration` (needs a separate Twilio `statusCallback` webhook that doesn't exist yet), `household_id` (needs Sprint 7's `households` table).
- `/dashboard-data` computes `protectedContacts`, `callsToday`, `blocked`, `safe`, `recentCalls` from live Supabase queries.
- `/logs` also reads from Supabase (capped at the most recent 200 rows) instead of the deleted array.
- Dashboard data now survives server restarts.
- **Security:** `calls` has RLS enabled with no `anon`/`authenticated` policies at all (default-deny). It's reachable only through a `service_role`-backed client (`supabaseAdmin` in `server.js`), used exclusively for `calls` operations. `contacts` is unchanged — it still uses the existing anon-key client. Full reasoning in `docs/DECISIONS.md` (Decisions 007–008).
- **Verified during implementation:** the initial design constructed the service-role Supabase client unconditionally, which throws synchronously and crashes the entire server (not just call logging) if `SUPABASE_SERVICE_ROLE_KEY` is unset. Fixed before shipping — the client is now constructed only when the key is present, and every calls-table helper checks for it and fails open (empty data / logged error), matching the fail-open pattern already used everywhere else in this file.
- Empty recent-activity state: "No recent call activity yet."

### Documentation-only work produced alongside this sprint (not built)

A future commercial access model was designed and approved for later sprints: `households` (replaces the earlier "customers" naming — the product protects a home line, not an individual), `subscriptions`, an optional future `plans` table (conditional on a genuine second pricing tier existing), and an `entitlements` table that separates *service plan* from *Stripe payment record* from *current right to use the service* — covering standard paying households, founding/trial discounts, promotions, free trials, complimentary access (including non-paying households), and future partner/staff accounts. See `docs/DECISIONS.md` (Decision 009) for the full design and reasoning.

### Manual action still required

Run `supabase/migrations/001_create_calls_table.sql` in the Supabase SQL Editor, then add `SUPABASE_SERVICE_ROLE_KEY` to `.env` (Project Settings → API in Supabase) and restart the server. Neither step has been performed yet — this file only reflects code that is ready to run once both are done.

### Success criteria

- Restart server → dashboard still shows previous calls: **pending manual migration + key**
- Recent activity remains available: **pending manual migration + key**
- Statistics generated from database: **pending manual migration + key**
- No functionality lost: **confirmed** — server starts cleanly and every other route works whether or not the service-role key is present

---

## ✅ Stripe Billing — Sandbox End-to-End Verified (17 July 2026)

Full customer journey confirmed working against Stripe Sandbox, using the real app UI (Safari) rather than mocked requests:

- Registration → email confirmation → login → authenticated dashboard
- Checkout Session creation (`POST /billing/create-checkout-session`) → Stripe-hosted Checkout → test-card payment → redirect back with `checkout=success`
- Webhook delivery to `/billing/webhook`, signature-verified, `customer.subscription.created` processed
- `subscriptions` and `entitlements` rows created correctly; dashboard renders "Protected"

Required to get here, now applied and verified against the live Supabase project:

- `013_stripe_billing_rpc_functions.sql` (`set_household_stripe_customer_id`, `process_stripe_webhook_event`)
- `014_claim_stripe_webhook_event_rpc.sql` (`claim_stripe_webhook_event`)
- `015_fix_entitlement_expiry_subscription_match.sql` — bug found during this test: `process_stripe_webhook_event` expired *any* active entitlement for a household when *any* of its subscriptions went non-qualifying, without checking the terminating subscription was the one the entitlement actually referenced. Fixed to require `entitlements.external_reference` match before expiring. Confirmed fixed by cancelling a duplicate subscription and verifying the real active entitlement was untouched.

Also fixed during this test:

- Safari-specific login/session loss, caused by `localhost`/`127.0.0.1` host mixing (cookies don't carry over between the two) — fixed with a canonicalizing 301 redirect middleware in `server.js`, applied before auth
- Dashboard's "Confirming your payment" banner never cleared once the protected state loaded (`upload.html`) — now hidden once `/dashboard-data` reports protected

Known gap surfaced, investigated and largely fixed (18 July 2026): the duplicate Checkout Session/subscription was root-caused to the checkout button never being disabled after submission, combined with no server-side check for an already-in-progress subscription — so when a webhook was delayed/dropped (the CLI relay bug above) and the dashboard gave no confirmation, a genuine second click minutes later was treated as a brand-new request. The idempotency key's wall-clock 5-minute bucket contributed: the two real attempts were only 218 seconds apart but straddled a bucket boundary, so Stripe's own dedup didn't catch it either. Fixed:

- `upload.html`: the subscribe button now disables itself and shows "Redirecting to checkout…" immediately on submission
- `routes/billing.js`: queries Stripe directly for an existing `active`/`trialing` subscription before creating a new Checkout Session (catches the exact "webhook hasn't arrived yet" window that the DB-based entitlement check cannot); the existing idempotency key is unchanged but now documented as only guarding against retries of the identical request, not deliberate repeat attempts
- Automated tests added: `tests/checkout-existing-subscription.test.mjs`, `tests/subscribe-button.test.mjs`

**Follow-up (18 July 2026):** a concurrency investigation found the subscription check above still missed one case — a Checkout Session created but never paid has no Subscription object, so it was invisible to that check. A household that opened Checkout, abandoned it, then tried again later would still get a second session. Closed by also checking `stripe.checkout.sessions.list({customer, status: "open"})` before creating a new one: an existing open session is reused (redirect to its own `url`, or to `/dashboard?checkout=pending` if no usable `url` is returned) rather than creating another; completed/expired sessions never block a fresh attempt. No new schema — an additional Stripe API check only. This closes the abandoned-checkout retry gap specifically; it does not add true cross-process mutual exclusion for genuinely simultaneous requests, which remains the deferred item below.

**Deferred:** a database-level concurrency lock (e.g. a Postgres advisory lock or a reservation row) for two requests arriving genuinely simultaneously — faster than the button can visually disable, or from two tabs. The fixes above close the actual incident (a slow/delayed webhook prompting a manual second click minutes later); true simultaneous-request protection is a separate, deliberately deferred defense-in-depth improvement, not required to close this gap.

Still unconfirmed against the live database (headers say "DRAFT — NOT APPLIED", but this project's headers have been found stale before — see 013/014 above): `007_grant_authenticated_household_reads.sql`, `008_household_isolation_contacts.sql`, `009_service_role_minimum_app_privileges.sql`. These cover contacts/household RLS isolation and minimum service-role grants — real security surface worth explicitly verifying before launch, not just trusting the header.

---

## ✅ Production-Readiness Audit — Fixed (18 July 2026)

An audit found the app was not deployable as-is (no `start` script, hardcoded port). Fixed:

- `package.json`: `"start": "node server.js"` (was the typo `"startt"`, never wired up); added `"engines": { "node": ">=20" }`
- `server.js`: port now resolved via `services/serverConfig.js`'s `resolvePort()`, reading `process.env.PORT` (Railway assigns this dynamically) with a `3000` local-dev fallback
- Removed `/test-db` (unauthenticated, leaked `SUPABASE_URL`) and `/test-get-contacts` (unused by any automated test) — see `docs/LAUNCH_READINESS.md` for full reasoning
- Added `.env.example` documenting every env var the app reads, including explicit notes that no Twilio vars and no `Resend_API_Key` are currently consumed by any code
- Added production startup validation (`validateProductionEnv()`): refuses to boot when `NODE_ENV=production` if any of `SUPABASE_URL`/`SUPABASE_ANON_KEY`/`SUPABASE_SERVICE_ROLE_KEY`/`APP_URL`/`STRIPE_SECRET_KEY`/`STRIPE_PRICE_ID`/`STRIPE_WEBHOOK_SECRET` are missing, or if `APP_URL` still resolves to `localhost`/`127.0.0.1`. Verified by actually running it against the dev `.env` — correctly refused to start. Doesn't affect local dev (`NODE_ENV` unset there).
- Tests added: `tests/server-config.test.mjs`
- No Dockerfile or `railway.json` added — the fixes above are exactly what Railway's Nixpacks auto-detection needs; a Railway-specific config file wasn't judged to add real benefit

**Not done, and explicitly out of scope for this pass:** setting real production values in Railway's environment variables, or triggering a deploy.

---

## ✅ Payment-Completion Flow Rebuild (20 July 2026)

**Root cause:** a real production payment (household `andrewdeane_uk@yahoo.co.uk`, subscription `sub_1TvD5iEopg3VmrHsWzVgVmCE`, confirmed `paid`/`active` in Stripe) never activated in the app. `subscriptions`/`entitlements`/`stripe_webhook_events` were all confirmed empty for that household — not stale, genuinely never written. Cause: **no Stripe webhook endpoint has ever been registered against production** (`stripe.webhookEndpoints.list()` returns zero results). Every webhook test throughout this project used the local Stripe CLI's `stripe listen` tunnel, which only forwards while that CLI process runs on a developer machine — it was never a persistent registration, so Stripe generates `checkout.session.completed`/`customer.subscription.created` events with nowhere to deliver them (`pending_webhooks: 0`). **Still not resolved** — see Outstanding below.

**Fixed, all in `routes/billing.js` / `upload.html`:**
- `success_url` now includes `{CHECKOUT_SESSION_ID}` (was missing entirely, so no reconciliation was even possible from the return URL)
- New `GET /billing/reconcile-session` (requireAuth): bounded fallback that retrieves the completed Checkout Session by ID, verifies it belongs to the caller's own Stripe customer, and — reusing the exact same `claimWebhookEvent`/`processWebhookEvent` pair the real webhook uses — reconciles the subscription/entitlement server-side. Idempotent by construction: if the real webhook does eventually also arrive, both paths converge on the same DB writes rather than double-applying anything.
- New dashboard state machine (`upload.html`): `confirming` → `success` → (or `activation_delayed` after a bounded 60s poll). The subscribe button's visibility is now driven by a single `state !== "unsubscribed"` check covering every state, so a customer who has just paid — or whose activation is delayed — can never be shown a payment button or sent through checkout again, by construction rather than by remembering to guard each state individually.
- Server-side redirect reasons made explicit (`?checkout=already_active`) instead of a silent bounce back to `/dashboard` when a household already has a qualifying subscription — closes the "confusing payment loop" symptom (never a literal double charge: `hasQualifyingStripeSubscription` already blocked a second Stripe subscription being created, confirmed by checking the live subscription status; the confusion was purely a missing explanation).
- `billing_address_collection: "required"` added to every Checkout Session creation path — now collects a full billing address including postcode.
- Explicit recurring-billing wording added via `custom_text.submit.message`: states £4.99/month, that it recurs until cancelled, and references Terms and Conditions/Privacy Policy.
- Tests added: `tests/checkout-confirmation.test.mjs` (bounded polling timing, full state-machine visibility matrix proving the subscribe button is unreachable outside `unsubscribed`); extended `tests/checkout-existing-subscription.test.mjs` (`isSessionPaidWithSubscription`, `buildCheckoutSessionParams`).

**Outstanding — needs a decision, not done automatically:**
- **No webhook endpoint is registered in Stripe at all.** The reconciliation fallback above makes the app resilient to this, but the actual root cause is still live — recommend registering one via `stripe.webhookEndpoints.create()` pointing at `https://www.homecallguard.co.uk/billing/webhook` with the signing secret then set as Railway's `STRIPE_WEBHOOK_SECRET`.
- **Stripe Checkout's enforced Terms of Service checkbox (`consent_collection.terms_of_service: "required"`) is not enabled** — confirmed by attempting real session creation: Stripe rejects it outright until a Terms of Service URL is set under Settings → Public business details in the Stripe Dashboard (not settable via the API). Only the text disclosure is live until that's configured.

---

# Planned Roadmap

## Sprint 7 – Household Identity

Introduce household records, ownership, and authentication.

Deliverables:

- `households` table (see Decision 009)
- `contacts.household_id` / `calls.household_id` backfilled, FK-constrained, then `NOT NULL`
- Supabase Auth wiring (`auth_user_id`)
- Real per-row RLS on `contacts`/`calls` keyed on `auth.uid()`

---

## Sprint 8 – Payments & Entitlements

Deliverables:

- `subscriptions` table
- `entitlements` table (see Decision 009)
- Stripe Checkout, £4.99 subscription, webhook handling
- Automatic `paid_subscription`/`founding_offer` entitlement creation from Stripe events
- Conditional `plans` table — only if a genuine second tier or regional price is planned by this point

---

## Sprint 9 – Weekly Protection Reports

Deliverables:

- Weekly email summary
- Scam statistics
- Trusted caller summary
- Protection score

---

## Sprint 10 – Customer Portal

Deliverables:

- Authentication-backed login
- Personal dashboard, secure household isolation, profile page
- Add / edit / delete / search contacts
- Settings

---

## Sprint 11 – Admin Console

Deliverables:

- Household management
- Revenue dashboard
- System monitoring
- Support tools

---

## Sprint 12 – Launch Candidate

Deliverables:

- Production deployment
- Marketing launch
- Customer onboarding
- First 100 paying households

---

# Current Technical Debt

- No authentication
- No household ownership (`household_id` columns exist but are nullable/unenforced)
- `contacts` table still relies on permissive anon-key RLS; `calls` now uses the stricter service-role pattern but `contacts` hasn't been aligned to match yet
- No Stripe integration
- No weekly reports
- ~~Debug routes still exist (`/test-db`, `/test-get-contacts`)~~ — removed 18 July 2026, see Production-readiness audit below
- Some repository cleanup required

---

# Business Goal

Launch a reliable consumer SaaS product protecting home phone users from scam calls.

Target subscription:

**£4.99/month**

Primary focus:

Deliver outstanding customer value, scale rapidly, and build a business that is attractive for acquisition while remaining robust enough to operate independently.

---

# Next Immediate Actions

1. Run `supabase/migrations/001_create_calls_table.sql` in Supabase
2. Add `SUPABASE_SERVICE_ROLE_KEY` to `.env` and restart the server
3. Confirm dashboard statistics/recent activity survive a real restart
4. Commit Sprint 6
5. Design Sprint 7 (Household Identity)
