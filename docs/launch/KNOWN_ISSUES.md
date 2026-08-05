Document: Known Issues — Pre-Launch
Version: 4.0
Last Updated: 2026-08-05
Status: Active — reconciled against live production and staging state
Owner: Andrew Deane
Related Sprint(s): Launch Polish Sprint (post Sprint 9, unnumbered) — see FINAL_ACCEPTANCE_REPORT.md for full evidence

---

# Known Issues — Pre-Launch

Ordered by severity. Full evidence and reasoning for each is in
`FINAL_ACCEPTANCE_REPORT.md`; this file is the short, scannable list.

**Status legend**, used consistently below:
- **Resolved** — fixed and verified, including on production where relevant.
- **Resolved on staging only** — fixed and verified on the staging Supabase
  project (`tigwgmayeuisrxjjykqd`); not yet deployed/exercised on production,
  or not yet customer-facing (e.g. the mobile app itself isn't released).
- **Pending production** — code complete and staging-verified; production
  deployment specifically has not happened yet.
- **Blocked** — cannot proceed without an external dependency (a business
  decision or a third party's approval/action), not a coding task.
- **Deferred** — legitimately not started; nothing today is blocking it,
  it simply isn't due yet.

## Reconciliation summary — 2026-08-05

This pass corrected several items that were stale or flatly wrong given the
project's actual current state, verified live (not just read from docs)
against both Supabase projects immediately before writing this:

| Item | Status | Evidence |
|---|---|---|
| Separate staging Supabase environment | **Resolved** | `tigwgmayeuisrxjjykqd` exists, distinct from production `psbzynxplxfbyrbdidmn`, wired into `services/serverConfig.js` and `.env.staging`. The "no staging environment exists" claim below is now corrected. |
| Staging migration recovery (016/017 silent revert) | **Resolved** | Live-reverified 2026-08-05: `assign_household_twilio_number` correctly raises "household does not exist" on both staging and production — the reverted/buggy behaviour has not recurred. |
| Migrations 021 and 022 | **Resolved** (staging and production) | Live-reverified 2026-08-05 on both projects: `households.activation_verified_at` present, `mark_household_activation_verified` and `cancel_household_twilio_number_pending_release` callable, anon correctly gets `permission denied` (022's grant lockdown enforced). See `docs/releases/RELEASE_2026-08-02.md` on `main` (not yet on this branch) for the original deployment record. Migration files' own `STATUS` headers corrected to match in this pass. |
| Registered office address | **Resolved** | 128 City Road, London, EC1V 2NX stated in `public/terms.html` §1 and `public/privacy.html` §1 (2026-08-05 content audit). |
| Stripe Customer Portal | **Resolved on staging only** | Code is fully implemented (`routes/billing.js`, `routes/mobileApi.js`, real `stripe.billingPortal.sessions.create`) — the "not yet built" claim below was wrong. Live-tested 2026-08-05: a real portal session was created in Stripe test mode for a genuine staging customer. Full in-app UI round-trip ("Manage membership" → portal → back) not exercised this pass; live-mode Stripe portal configuration not separately confirmed. |
| Twilio Address / Bundle provisioning | **Blocked** | Code is ready and merged (`TWILIO_ADDRESS_SID`/`TWILIO_BUNDLE_SID` pass-through, from the now-merged `sandbox/twilio-addresssid-fix` and `sandbox/twilio-bundlesid-fix` branches). Neither variable is actually set anywhere (`.env`, `.env.staging`) — the real Twilio `Address` object and an approved UK Regulatory Bundle have not been created/submitted yet. This needs a Twilio-side action and Twilio's own approval turnaround, not further coding. |
| Overall production migration status | **Resolved** | Production is current through migration 022 with no gaps; live-verified 2026-08-05 (016, 017, 021, 022 all present and correctly enforced). |
| Mobile app staging validation | **Resolved on staging only** | Full E2E walkthrough (registration → email verification → login → Stripe checkout → trusted contact → device/provider → activation → dashboard → logout/login → household-scoping) completed 2026-08-05 against staging; automated suite 467/0. Not deployed to production or any app store; PR #2 (`sandbox/mobile-app-v1` → `main`) remains unmerged. |
| Remaining App Store / Google Play requirements | **Deferred** | Nothing started — see `docs/mobile-app/RC1_HANDOVER.md` §10 for the full checklist (no `eas.json`, placeholder icons, no developer accounts, no store listings). Not blocked on anything; genuinely just not due yet. |

---

## Resolved

### Twilio number auto-provisioning, and the migration 016/017 silent-revert incident

Was Severity 1, blocking. Root cause and full design are in
`TWILIO_NUMBER_LIFECYCLE.md` and `FINAL_ACCEPTANCE_REPORT.md`. A Twilio
number is purchased and assigned automatically the moment a household's
entitlement first becomes active, via `services/twilioProvisioning.js` and
the RPC functions in `016_household_twilio_provisioning.sql` /
`017_household_twilio_number_lifecycle.sql`. Idempotency is enforced at the
database layer with a row-locked RPC. Failure is never silent: every
household tracks `twilio_provisioning_status`, `twilio_provisioning_attempts`,
and `twilio_provisioning_last_error`, with bounded automatic retry. Covered
by `tests/migrations.pglite.test.mjs` and `tests/twilio-provisioning.test.mjs`.

**History, for context — the fix genuinely reverted once, then was
re-fixed and has now held:**
- 2026-07-21: verified working end-to-end against the real Twilio API
  (test Stripe mode, real Twilio credentials, a temporary ngrok tunnel).
  Reached Twilio's real purchase endpoint; stopped only on the (then)
  missing Address object — see the Twilio Address/Bundle item below.
- 2026-07-22: the same regression test (`assign_household_twilio_number`
  with a nonexistent household ID) showed the fix had silently reverted —
  the deployed function had reverted to its earlier, pre-fix, buggy
  definition (a manually-selected `v_found` flag instead of Postgres's
  built-in `FOUND`). Root cause never conclusively identified (schema-cache
  staleness, project restart, replica/HA, backup/restore, DDL event
  triggers, pg_cron, and GitHub migration-sync drift were all checked and
  ruled out — see `docs/engineering/016_017_migration_incident_notes.md`).
  Migrations 016/017 were held back from any further deployment pending
  Supabase support or a reliable re-verification process.
- **2026-08-02: migrations 021 and 022 deployed to production** (see
  `docs/releases/RELEASE_2026-08-02.md` on `main`), which included
  re-confirming 016/017's objects as part of the same verified `db push`.
- **2026-08-05 (this reconciliation pass): re-verified live, independently,
  against both staging and production** — the exact 2026-07-22 regression
  test now correctly raises `assign_household_twilio_number: household ...
  does not exist` on both databases. The revert has not recurred. Treating
  this as resolved, not merely "repaired again" — but per the project's own
  hard-won lesson here, any future session relying on this should still
  re-verify rather than assume, given the one-time unexplained root cause.

### There is now a separate staging Supabase environment

**This item as originally written below is stale — corrected here.** A
second, genuine Supabase project (`tigwgmayeuisrxjjykqd`, created
2026-07-30) now exists, fully separate from production
(`psbzynxplxfbyrbdidmn`), with its own migrations, its own test data, and
its own `.env.staging`. `services/serverConfig.js` defines
`STAGING_SUPABASE_REF`/`PRODUCTION_SUPABASE_REF` and validates a server
process is pointed at the right one before starting. See
`docs/engineering/STAGING_ENVIRONMENT_PLAN.md` for the design, and
`docs/mobile-app/CLAUDE_SESSION_HANDOVER.md` for the canonical env-file
arrangement. (The staging→production promotion process described in that
plan's §6 is still manual/human-driven — that part is not itself an open
issue, just worth knowing.)

### Migrations 021 and 022

Both applied and live-verified, on staging and on production, as of this
2026-08-05 reconciliation pass (see the summary table above for the exact
checks run). Production deployment happened 2026-08-02, approved by the
repository owner via the project's required confirmation phrase, with a
full pre-flight/rollback plan — see `docs/releases/RELEASE_2026-08-02.md`
on `main` (not yet brought into this branch). Both migration files'
`STATUS` headers, previously still reading `DRAFT — NOT APPLIED`, are
corrected in this pass to reflect the real applied state.

### Registered office address

Resolved 2026-08-05. `public/terms.html` §1 and `public/privacy.html` §1
both state AFMD Ltd's registered office as 128 City Road, London, EC1V
2NX, United Kingdom. `services/launchReadiness.js` updated to match. This
also unblocks the address-decision half of the Twilio Address item below —
the remaining work there is now purely operational (see Blocked, below).

### Stripe Customer Portal

**The "not yet built" status previously recorded here was wrong — corrected
in this pass.** The Billing Portal is implemented for both the web
(`routes/billing.js` `POST /billing/manage-membership`) and mobile
(`routes/mobileApi.js`) surfaces, using `stripe.billingPortal.sessions.create`
scoped server-side to the caller's own household — no client-supplied
customer ID. Live-tested 2026-08-05: a real Stripe test-mode portal session
was successfully created for a genuine staging household. Recorded as
**resolved on staging only** because the full in-app round trip ("Manage
membership" tap → Stripe-hosted portal → return) hasn't been exercised in
this pass (`docs/RC1_CHECKLIST.md`: "Account / billing-portal live flow —
not tested this pass"), and live-mode Stripe Dashboard portal configuration
hasn't been separately confirmed.

### Mobile app staging validation

Full RC1 end-to-end walkthrough completed 2026-08-05 against staging:
registration, email verification, login, Stripe checkout, trusted-contact
add (manual and native-picker), device/provider selection, activation
instructions, activation verification, dashboard state, logout/login, and
household-scoping — all confirmed against the real staging backend. Two
real app defects were found and fixed in the process (see
`docs/mobile-app/CLAUDE_SESSION_HANDOVER.md`). Automated suite: 467
checks, 0 failures. Recorded as **resolved on staging only**: nothing here
has touched production, and PR #2 (`sandbox/mobile-app-v1` → `main`)
remains open and unmerged, so none of this is customer-facing yet.

## Blocked

### Twilio Address / Regulatory Bundle for UK number purchase

**This remains the Severity 1 blocker preventing any live UK number
purchase.** Even with a perfectly-deployed database, no number can be
purchased for any customer until this is resolved. Two separate Twilio
requirements were discovered via real purchase attempts:
1. UK local numbers require a registered `Address` object on file
   (*"Phone Number Requires an Address but the 'AddressSid' parameter was
   empty"*).
2. UK local numbers additionally require an approved Regulatory `Bundle`
   (*"Bundle required and not provided for country: [GB] and numberType:
   [LOCAL]"*), a second, separate Twilio requirement discovered after the
   first was understood.

**Code-side, both are done and merged into this branch**
(`sandbox/twilio-addresssid-fix`, `sandbox/twilio-bundlesid-fix`):
`buildIncomingPhoneNumberParams()` in `services/twilioProvisioning.js`
passes `TWILIO_ADDRESS_SID` and `TWILIO_BUNDLE_SID` through when
configured, with zero behaviour change while unset, covered by a
backwards-compatibility regression test.

**What's actually still missing, confirmed by this reconciliation pass:**
neither `TWILIO_ADDRESS_SID` nor `TWILIO_BUNDLE_SID` is set in `.env`,
`.env.staging`, or `.env.staging.local` — only placeholder keys exist in
`.env.example`. The registered-office address decision that was blocking
the Address object is now resolved (see above); what remains is creating
the Twilio `Address` object itself, and — separately, and likely slower —
submitting and getting Twilio's approval on a UK Regulatory Bundle, which
is an external, Twilio-side KYC-style review process outside this
codebase's or this session's control. This is why the item is marked
**Blocked** rather than **Pending production**: there is no further coding
task that moves it forward.

## Deferred

### App Store / Google Play submission requirements

Nothing has been started — full checklist in
`docs/mobile-app/RC1_HANDOVER.md` §10: no `eas.json`, only default Expo
template icon/splash assets, bundle ID never reserved with either store,
no developer accounts, no store-listing copy, no real-device screenshots,
no data-safety/App Privacy answers prepared. Not blocked on anything else
in this list — it simply isn't due until the app is otherwise ready to
submit, and none of it was in scope for the mobile app Phase 2 work.

## Legal items — deliberately kept open

Not resolving these further without your explicit direction; each needs a
business/legal decision, not a lookup.

### Solicitor review of `public/terms.html`

The Terms are a considered draft, not a solicitor-reviewed contract.
Recommend UK consumer-law review before go-live, particularly §5
(Cancellation), §9 (Fair use and abuse), §10 (Refund policy and statutory
cancellation rights), and the new §11 (Money-back guarantee) added in the
2026-08-05 launch-readiness audit.

### Whether to show the 30-day guarantee on the public landing page

The guarantee appears throughout the mobile app's onboarding (Subscribe,
Complete, Welcome, Confirmation screens) and, as of the 2026-08-05 audit,
in `terms.html` §11 — but not on `public/index.html`, the public marketing
site. Not a contradiction as-is, but an open decision on whether it should
be surfaced there too as a conversion/trust signal.

### Contractual wording for the Founding Member 12-month price lock

`mobile/app/(setup)/subscribe.tsx` promises "your price is locked for 12
months" as a founding-member benefit, but `terms.html` §3 only states the
general price-change clause (reasonable advance notice, opportunity to
cancel) without mentioning a founding-member lock specifically. Needs a
decision on whether to add explicit contractual language for this
time-limited offer.

### Whether the existing cookie disclosure is sufficient

There is no standalone cookie policy page. `public/privacy.html` §9
discloses the two strictly-necessary session cookies inline. Needs
confirmation that this inline disclosure is sufficient for launch, rather
than requiring a separate cookie policy page or banner.

## Still open — Severity 2

### No scheduled runner for expired-number release

`scripts/release-expired-twilio-numbers.js` correctly releases numbers
whose 30-day cancellation grace period has passed (see
`TWILIO_NUMBER_LIFECYCLE.md`), but nothing invokes it on a schedule —
there is no cron/job runner configured in this project today. Needs a
daily Railway Cron Job (or equivalent) before the first cancellation's
window elapses; a manual run is a fine stopgap until then.

### Web dashboard has no real activation instructions

`upload.html`'s setup checklist shows only a bare manual toggle ("I've set
up call forwarding") with no number, code, or instructions anywhere, and
by deliberate design the Twilio number itself is never sent to any client.
No automated channel (email/SMS) communicates it either. The mobile app's
`GET /api/v1/activation/instructions` solves this for its own onboarding
flow; the web dashboard has no equivalent yet. Not fixed as part of mobile
Phase 2, per explicit scope decision — a genuine pre-existing gap worth a
real fix, web-side, before or shortly after launch.

### No automated test coverage for dashboard/call-logging changes

The `/voice` trusted-call logging branch and the reshaped `/dashboard-data`
response were verified live, end-to-end, against a real account — not by
the automated suite. The existing suite still passes unchanged, but
nothing in it exercises these specific code paths.

### service_role has no INSERT/UPDATE grant on public.user_roles

Migration 002 grants `authenticated` a `select`-own policy on
`user_roles`, but never grants `service_role` any write privilege on the
table. The existing `setUserRole()` helper (`database/households.js`) has
likely never actually worked from the app itself — any role assignment so
far has been done directly via the SQL Editor (as `postgres`, which
bypasses the missing grant). No in-app "make this user an admin/support"
feature could work today without this being fixed first. Needs its own
reviewed migration, not a quick patch.

## Severity 3 — cosmetic / optional

### Hero paragraph doesn't hold to two lines on every phone

The prescribed hero copy (`public/index.html`) renders as three to four
lines at a legible size on a 390px-wide screen, not the two originally
asked for. The exact wording was kept as supplied rather than rewritten
without asking — see `FINAL_ACCEPTANCE_REPORT.md` §1. Optional: tighten
the sentence if the literal line count matters more than the exact copy.

## Non-issues confirmed during testing

For completeness — investigated and found not to be problems:

- **Local server serving stale code mid-UAT.** Found and fixed during
  testing (process restarted). Confirmed to be a local-development
  artefact only: Railway redeploys the process fresh on every push, so
  this cannot recur in production.
- **`stripe_webhook_events.household_id`** — confirmed present on the
  live schema (not just the migration file) before being relied on in
  the cleanup SQL, given this project has had schema drift before (the
  `contacts` table itself predates its migration).
- **Migrations 021/022 and the 016/017 revert, on both staging and
  production** — all confirmed correctly applied and enforced via live,
  read-only checks on 2026-08-05 (see Reconciliation summary above).
- **Stripe Customer Portal** — confirmed genuinely implemented and
  functional in test mode, not merely planned (see Resolved, above).
