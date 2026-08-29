# Home Call Guard — Codebase Audit (Mobile App Phase 1)

STATUS: Discovery document. No code changed. Verified against the real repository on 2026-07-28, not from memory alone (route list, directory structure, and dependency list re-confirmed via direct inspection during this audit).

## 1. Project structure

```
server.js              Single Express entrypoint — all routes, no framework router until routes/
routes/                billing.js, admin.js (mounted as Express Routers)
middleware/             requireAuth.js, requireEntitlement.js, requireAdmin.js
services/               registrationFlow.js, householdBootstrap.js, twilioProvisioning.js,
                        twilioClient.js, stripeClient.js, supabaseClients.js, healthChecks.js,
                        adminActionLog.js, launchReadiness.js, serverConfig.js, phone.js
database/               households.js, contacts.js, billing.js, adminMetrics.js — thin query
                        wrappers, one per table/domain, all going through supabaseAdmin
public/                 Static HTML pages (register, login, forgot/reset password, confirmed,
                        terms, privacy) — plain HTML + inline <script>, no build step, no
                        framework. dashboard.html exists but is DEAD — not routed anywhere.
upload.html             The REAL customer dashboard — served at /dashboard via
                        res.sendFile(__dirname + "/upload.html"). Lives at repo ROOT, not in
                        public/ — the one structural inconsistency worth fixing before mobile
                        work begins (see technical debt below).
supabase/migrations/    21 tracked, numbered, sequential .sql files — the actual schema source
                        of truth. One (005) is deliberately frozen/skipped by the test suite.
tests/                  Plain node scripts (no Jest/Mocha), run via `npm test` chaining ~12
                        files with &&. Two testing patterns: (a) pure functions/injected fake
                        collaborators for services/*.js, (b) a shared PGlite (real Postgres,
                        WASM) instance that applies every migration file in order and runs
                        smoke assertions against the actual RPC functions.
```

## 2. Authentication

Cookie-session based, not a bearer-token API. Two cookies: `sb_access_token`, `sb_refresh_token` — these **are** the raw Supabase-issued JWTs, not app-signed tokens. No app-level session secret exists at all.

- `POST /register` → `supabase.auth.signUp()`. Email confirmation required — no session returned until confirmed.
- `POST /login` → `supabase.auth.signInWithPassword()`.
- `POST /reset-password-complete` → recovery-token exchange.
- All three of the above call `ensureHouseholdAndRole()` (services/householdBootstrap.js) the first time a real session exists for that user — idempotent, creates exactly one `households` + `user_roles` row, never duplicates.
- `middleware/requireAuth.js` reads the two cookies, calls `supabase.auth.getUser()`, falls back to `refreshSession()` if the access token expired, then requires a `households` row to exist — clears cookies and redirects to `/login.html` if not found. **This is a web-session model (cookies + redirects), not a mobile-appropriate one** — see APP_DECISION_005.

## 3. Customer dashboard (`upload.html`, served at `/dashboard`)

Single monolithic HTML file (self-contained CSS + vanilla JS, ~600+ lines) covering: membership card, setup checklist, trusted contacts CRUD, contact upload (manual/CSV/VCF/Android Contact Picker), recent call activity, protection status. Data comes from `GET /dashboard-data` (one aggregate JSON payload). No client-side framework, no component reuse, no design system beyond ad hoc inline CSS repeated per page.

## 4. Admin dashboard (`routes/admin.js`)

Separate, `requireAdmin`-gated surface: household search, provisioning retry, system health (`services/healthChecks.js`), aggregate metrics (`database/adminMetrics.js`), launch-readiness banner (`services/launchReadiness.js`). Not customer-facing — stays on the web platform per your stated intent (website = admin/support, app = customer experience).

## 5. Trusted contacts

`database/contacts.js` — full CRUD (`getContacts`, `insertContacts`, `updateContact`, `deleteContact`), scoped by `household_id` + `id` together on every write. Duplicate prevention is app-level (checked before insert), not a DB constraint. UK number normalisation is a simple digit-stripping function (`normaliseNumber` in `server.js`), not a full E.164 library — works for the "last 10 digits" comparison this app needs but isn't a general-purpose phone-parsing solution.

## 6. CSV / contact upload

`POST /upload-contacts` handles three input shapes through one endpoint: manual single-contact, CSV (`Name,Phone number` header), and VCF/vCard (minimal `BEGIN:VCARD`/`FN`/`TEL`/`END:VCARD` parsing, no line-folding support). Multer-based, 512KB/500-contact caps. The web page also feature-detects `"contacts" in navigator` for the browser Contact Picker API (Chrome-on-Android only, confirmed via research this engagement) as a fourth path into the *same* endpoint.

## 7. Stripe integration

- Checkout: `POST /billing/create-checkout-session` (routes/billing.js), one fixed price ID.
- Billing Portal: `POST /billing/manage-membership` → `stripe.billingPortal.sessions.create()`.
- Webhooks: `/billing/webhook` (raw-body scoped), verified via `STRIPE_WEBHOOK_SECRET`, deduplicated via `claim_stripe_webhook_event` RPC (migration 014), processed via `process_stripe_webhook_event` RPC (013/015/**019** — the event-ordering-guarded version, most recent work this engagement).
- Reconcile fallback: `GET /billing/reconcile-session` — live Stripe lookup used when a webhook hasn't landed yet, so `/dashboard-data` never has to guess.
- `services/stripeClient.js` is a one-line wrapper around the raw `stripe` SDK — no abstraction to change for mobile.

## 8. Twilio integration

- `POST /voice` — the actual call-screening webhook: caller-ID lookup against `contacts`, trusted callers dialed straight through, unknown callers routed into GPT-based screening (see below).
- `services/twilioProvisioning.js` — real number purchase/assignment/release lifecycle (migrations 016/017), including a grace-period release and an immediate-release path, both real-Twilio-API-backed, not just DB bookkeeping.
- Customer's own phone forwards to this Twilio number via carrier-level call diversion — see APP_DECISION_003 for why this remains necessary regardless of platform.

## 9. OpenAI integration

`gpt-4o-mini` for real-time behavioural classification during the call (the actual screening prompt was rewritten this engagement — Decision 014 — from an identity-based to a behaviour-based model: specific high-risk asks like OTP/card-details/remote-access trigger scam classification, not just claiming to be a bank). `whisper-1` for transcription (previously flagged as returning a 400 against a spec-correct synthetic WAV — unrelated to today's audit, still worth a look before scaling call volume).

## 10. Supabase schema (21 migrations)

Core tables: `households`, `user_roles`, `contacts`, `calls`, `subscriptions`, `entitlements`, `stripe_webhook_events`. Deliberate least-privilege grants throughout — `service_role` has no `DELETE` on `households`/`subscriptions`/`entitlements`/`calls`/`stripe_webhook_events` at all (by design, audit-trail preservation), only narrow `SECURITY DEFINER` RPCs can write households (`set_household_stripe_customer_id`, the Twilio lifecycle functions, and — new this engagement — `anonymize_inactive_household`). This pattern (narrow RPC over broad grant) is the single most important architectural convention to carry into any new mobile-specific backend surface.

## 11. Security posture (already-verified facts, not new claims)

- RLS enabled on every customer-data table; household isolation verified this engagement.
- Real least-privilege audit (migrations 009/012) — every grant traces to an explicit decision.
- Full production secrets audit completed 2026-07-28 (see conversation record) — no credential has ever touched git history; the live Stripe key rotation is in progress.
- Anti-enumeration handling on registration (deliberately hedged wording, not a definitive existence claim) — a pattern worth carrying into any mobile-native auth screens.

## 12. Technical debt / opportunities identified (not fixed — reported per your instruction)

1. **`upload.html` at repo root, not `public/`** — the one real structural oddity; every other page lives in `public/`. Harmless today (an absolute `sendFile` path), but confusing, and would need resolving before any shared-component work between web and a future web redesign.
2. **No API layer distinct from the web app.** Every existing endpoint returns either an HTML redirect or a page-shaped JSON payload (`/dashboard-data` returns exactly what `upload.html`'s JS expects, not a general-purpose resource representation). A mobile app cannot consume these as-is without either (a) a thin translation layer, or (b) new, mobile-appropriate endpoints alongside the existing ones. See APP_DECISION_005.
3. **Cookie/redirect auth model is web-only.** `requireAuth` redirects to `/login.html` on failure — meaningless for a mobile app, which needs `401 JSON` + a bearer/refresh-token flow it manages itself (Supabase's own client SDKs for React Native support this natively — see APP_DECISION_005).
4. **No versioned or namespaced API surface** (`/dashboard-data`, `/contacts`, `/upload-contacts` sit at the root alongside page routes). Worth namespacing (`/api/v1/...`) once mobile-specific endpoints are added, so web and mobile traffic are trivially distinguishable in logs/metrics.
5. **`whisper-1` transcription 400 error** (pre-existing, flagged earlier this engagement, not re-verified today) — worth a real fix before mobile-driven call volume increases exposure to this bug.
6. **No push notification infrastructure exists at all** — expected, since there's been no app; flagging as a hard dependency for APP_DECISION_002/006, not a defect.
7. **CSV/VCF upload logic is tightly coupled to the multipart-form web upload path** (`uploadContactsFile` multer wrapper) — the *parsing* functions (`parseContactsCsv`/`parseContactsVcf`) are reusable as-is; the *transport* (multipart form POST) is not what a mobile app would naturally use for a native-contact-picker-sourced payload (plain JSON is more natural — see APP_DECISION_004).

None of the above are launch blockers for the *existing* web platform. They are exactly the kind of thing to resolve as part of Phase 2's backend work, not before.
