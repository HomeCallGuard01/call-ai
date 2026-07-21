Document: Final Acceptance Report — Launch Polish Sprint
Version: 3.0
Last Updated: 2026-07-21
Status: Active
Owner: Andrew Deane
Related Sprint(s): Launch Polish Sprint (post Sprint 9, unnumbered) — homepage messaging, dashboard redesign, Stripe Portal planning, Terms & Conditions strengthening, automatic Twilio number provisioning

---

# Final Acceptance Report — Launch Polish Sprint

A rendered version of this report with embedded screenshots was published
as a Claude Artifact during the session this work was done in. This
document is the source-of-truth markdown copy for the repository.

## Scope

Five-part sprint: homepage messaging, dashboard redesign, a Stripe
Customer Portal implementation plan, Terms & Conditions strengthening,
and a final review. A sixth, unplanned part followed: a full end-to-end
User Acceptance Test (UAT) against a real customer account, run because
the dashboard and call-logging changes touch live call-handling code and
needed verification beyond a visual check.

Every step that touches running code was verified against a genuine
customer journey — real signup form, a real confirmation email actually
clicked, a real login, a real Stripe Checkout session in test mode, and
two simulated inbound calls processed by the real `/voice` and `/process`
routes. No step used service-role writes, admin-created users, or a
mocked API response to fake being logged in. See "End-to-end acceptance
test" below for the full run.

## 1. Homepage messaging

Target reader: a homeowner whose first objection is "my landline doesn't
have contacts." The rewrite removes that objection in the first two
lines of the hero.

**Original rewrite:**
- New hero heading, sub-copy, four-bullet proof list, exact pricing line
  (`£4.99/month (including VAT)`), and CTA (`Get Protected Today`).
- A reassurance badge under the CTA: "🔒 Setup takes under 2 minutes ·
  Keep your existing phone number · Cancel anytime."
- "How it Works" rewritten to exactly three steps (Register-adjacent
  copy: upload contacts, keep using your phone, unknown callers screened).
- New FAQ entry: "My home phone doesn't have contacts. How does this
  work?"

**Follow-up UX polish** (`public/index.html`):
- Hero paragraph replaced with the exact two-sentence copy supplied.
- New compact "How it works" teaser directly below the hero — three
  numbered-emoji steps (1️⃣ Register, 2️⃣ Upload your trusted contacts,
  3️⃣ We screen everyone else), deliberately lighter-weight than the
  fuller three-step section further down the page so the two don't
  compete.
- New small info card, "How does this work with my home phone?",
  placed just above the FAQ section.
- No changes to the logo, no additional trust badges, no new sections
  beyond the three requested.

**Open judgement call, not resolved silently:** the brief asked for the
new hero paragraph to hold to two short lines on mobile. The exact
wording supplied renders as three to four lines at a legible size on a
390px-wide screen. Shortening it further would mean rewriting the
prescribed copy rather than just laying it out, so the wording was kept
exactly as given and the gap is flagged here rather than edited without
asking.

## 2. Dashboard redesign

Four summary cards (Calls Protected, Trusted Callers, Unknown Callers
Screened, Suspected Scam Callers), a Recent Activity feed with per-call
icons, and friendly empty states in place of blank sections.

**Data gap found before building anything:** trusted-contact calls were
never written to the `calls` table — the `/voice` route's known-contact
branch dialled straight through and returned, skipping the logging step
entirely. This was surfaced as a decision point before implementation
(per instruction: "If not, tell me exactly what needs adding before
implementing"). Decision taken: add logging for trusted calls rather than
ship the card without data or hide it behind a placeholder.

**What changed:**
- `server.js`'s known-contact branch in `/voice` now calls `logCall()`
  with `status: "Known"`, `result: "SAFE"` — using the existing schema's
  enum values, no migration required.
- `/dashboard-data` now returns `callsProtected`, `trustedCallers`,
  `unknownScreened`, and `suspectedScam` (replacing the old
  `protectedContacts` / `callsToday` / `blocked` / `safe` shape).
- `upload.html`'s Recent Activity renders each row as
  ✅ Trusted caller, 🤖 AI screened, or ⚠️ Suspected scam based on
  `status`/`result`, with a friendly empty-state message
  ("No calls yet. Once your phone starts receiving calls, they'll show up
  here.") instead of a blank section.
- Removed now-dead CSS (the old table/tag styles) rather than leaving it
  unused.

**Verified live** (see UAT below): after one simulated trusted call and
one simulated unknown call, the dashboard showed `Calls Protected: 2`,
`Trusted Callers: 1`, `Unknown Callers Screened: 1`,
`Suspected Scam Callers: 0`, with both calls correctly represented in
Recent Activity.

**Test coverage gap:** this wiring was verified live end-to-end rather
than through the automated suite — no unit test yet exists for the new
`/voice` logging branch or the reshaped `/dashboard-data` response. See
`KNOWN_ISSUES.md`.

## 3. Stripe Customer Portal — implementation plan (not built)

Full plan, not implemented. Summarized here; see
`POST_LAUNCH_ROADMAP.md` for scheduling.

| Capability | Covered by Stripe Portal | Work required here |
|---|---|---|
| Manage Subscription button | — | New `POST /billing/create-portal-session` route; a dashboard button redirecting to the returned URL, same pattern as the existing subscribe form. |
| Update payment card | Full native flow | None beyond enabling it in Stripe Dashboard portal settings. |
| Download invoices | Full native flow, PDF included | None beyond enabling invoice history in portal settings. |
| Cancel subscription | Native flow; sets `cancel_at_period_end` | None new — the existing webhook already records `cancelAtPeriodEnd` on every `customer.subscription.updated` event (`routes/billing.js`). Verify live, same method as this UAT. |
| Reactivate subscription | Native flow, offered automatically before period end | Same webhook path as cancellation — verify only. |

**Steps:** (1) configure the portal in the Stripe Dashboard; (2) add the
portal-session route and dashboard button; (3) live-verify cancel/
reactivate against the existing webhook; (4) add automated tests.

**Estimate:** ~2–3 days total (0.5 day Stripe config, 0.5–1 day
route+button, 0.5 day live verification, 0.5 day tests).

## 4. Terms & Conditions — legal improvements

Fifteen numbered sections in `public/terms.html`, verified directly
against the live file (not from memory).

| § | Section | What it covers |
|---|---|---|
| 1 | Who we are | AFMD Ltd trading name, company number 07075723, registered office placeholder pending confirmation |
| 2 | The Service | Plain description of the screening service |
| 3 | Subscription, pricing and billing | £4.99/month inclusive of VAT (GB379120684), price-change notice period |
| 4 | When protection starts | Activation timing and dashboard status |
| 5 | Cancellation policy | Exact required wording (quoted below) |
| 6 | Your responsibilities | Accurate details, up-to-date contacts, account security |
| 7 | Service limitations | Includes new "AI screening limitations" subsection |
| 8 | Service availability and maintenance | No uptime guarantee, reasonable-effort standard |
| 9 | Fair use and abuse of the Service | Expanded from the original fair-use clause |
| 10 | Refund policy and statutory cancellation rights | Interacts with the 14-day cooling-off right |
| 11 | Data retention | New section, cross-references the Privacy Policy |
| 12 | Limitation of liability | Renumbered, unchanged in substance |
| 13 | Changes to the Service or these Terms | Renumbered, unchanged in substance |
| 14 | Governing law | England and Wales |
| 15 | Contact us | Renumbered, unchanged in substance |

**Cancellation policy — exact wording, reproduced verbatim:**

> Your subscription renews automatically every month until you cancel.
> You may cancel at any time, with no minimum term and no exit fee.
> Cancelling prevents future renewals — it stops the next and all
> subsequent monthly charges. The Service continues until the end of the
> billing period you've already paid for. Cancelling does not end your
> protection immediately. No partial-month refunds will normally be
> provided once a billing period has started, except where required by
> law or where Home Call Guard has made a billing error.

**UK consumer law:**
- **Consumer Contracts Regulations 2013** — the 14-day cooling-off right
  is addressed in Section 10 alongside the no-partial-refund policy,
  rather than silently overridden by it.
- **Consumer Rights Act 2015** — Service Limitations (§7) and Fair Use
  (§9) are written to inform expectations rather than attempt to
  disclaim statutory rights, which the CRA doesn't permit for a consumer
  contract.
- **UK GDPR** — Data Retention (§11) cross-references the Privacy Policy
  rather than duplicating it.

**Not a substitute for legal sign-off.** This is a strengthened draft,
not a solicitor-reviewed contract. See `KNOWN_ISSUES.md`.

## 5. End-to-end acceptance test

Run against a real customer account, `ad_74uk@yahoo.co.uk`, cleaned to a
blank slate first (every referencing table — `entitlements`,
`subscriptions`, `calls`, `contacts`, `stripe_webhook_events`,
`user_roles`, `households`, `auth.users` — deleted via SQL run manually
in the Supabase SQL Editor, then independently re-verified empty before
starting).

| Step | Method | Result |
|---|---|---|
| Clean slate | Manual SQL, verified read-only before proceeding | Confirmed empty |
| Register | Real `/register.html` form submission (Playwright-driven browser) | Account created, confirmation email sent |
| Confirm email | User clicked the real confirmation link | `email_confirmed_at` set — verified by direct query |
| Log in | Real `/login.html` form, exact registration password | Redirected to a genuine session on `/dashboard` |
| Subscribe | Real Stripe Checkout, test card 4242 4242 4242 4242, test-mode Sandbox | Payment succeeded, dashboard showed "Payment successful" then "Protected" |
| Upload contacts | Real CSV upload through the dashboard form | 2 contacts confirmed in the database, correctly scoped to the household |
| Trusted call | Simulated Twilio-style webhook POST to `/voice` from a saved contact's number | Dialled straight through (`<Dial>`), logged `status: Known`, `result: SAFE` |
| Unknown call | Simulated webhook to `/voice` then `/process`, non-scam speech text | Classified by a live OpenAI call, not a keyword shortcut |
| Dashboard verified | Reloaded the real session | Cards and Recent Activity matched exactly |

**Unknown-call classification log** (from `calls` table, confirmed by
direct query):

```
call_sid:            CAunknownsimulation00000001
status:               Unknown
result:                SAFE
ai_model:              gpt-4o-mini
processing_time_ms:    2252   — a real OpenAI round trip, not a keyword match
```

**Mid-test correction, noted for transparency:** the local server process
had been running since before the `/voice` logging and dashboard changes
were made, so it was still serving the old code partway through testing.
It was restarted once discovered (confirmed by comparing process start
time to `server.js`'s last-modified time) and the trusted-call test was
re-run afterwards. This is a local-development artefact only — production
on Railway redeploys fresh on every push, so it does not recur there.

**Blocking dependency found mid-test:** the test household had
`twilio_number: null` — see "Severity 1" in `KNOWN_ISSUES.md`. Resolved
for this UAT only by a manual SQL update (`+447700900123`, from Ofcom's
reserved fictional-use range), run by Andrew directly, at his instruction,
solely to unblock today's test. Not a production fix.

## 6. Automatic Twilio number provisioning (Severity 1 fix)

Follow-up work, done after this report was first written, closing the
Severity 1 blocker identified above: no new customer was ever assigned a
Twilio number, only worked around today via a manual SQL update. Full
design reasoning is in `TWILIO_NUMBER_LIFECYCLE.md`; summarized here.

**Trigger point:** the moment a household's entitlement first becomes
active (Stripe payment confirmed), not registration or email
verification — so no cost is incurred for accounts that never convert.
Hooked into both places entitlement activation already flows through:
the Stripe webhook handler and the `/billing/reconcile-session` polling
fallback.

**Strategy:** on-demand purchase via the Twilio API, not a pre-purchased
pool — no cron/replenishment system to build and monitor, and no signup-
rate data yet to size a pool against.

**Idempotency:** enforced at the database layer, not application timing.
`assign_household_twilio_number` (migration 016) takes a row lock
(`for update`) before checking whether a household already has a number —
first assignment succeeds, an identical re-assignment no-ops, a
*different* number already present is refused (not silently overwritten),
and the caller releases its own now-redundant Twilio purchase when that
happens rather than leaving it orphaned.

**Failure handling:** never silent, never blocks the subscription.
Every household tracks `twilio_provisioning_status` / `_attempts` /
`_last_error`; a failed attempt is retried automatically (bounded, 5
attempts) on every later webhook/reconciliation check, then settles into
"flagged for administrative attention" rather than retrying forever.

**Cancellation/deletion lifecycle:** a genuinely-terminated subscription
starts a 30-day grace period before its number is released (protects
against a churned customer's still-active call-forwarding rule
misdirecting to whoever gets the number next — see
`TWILIO_NUMBER_LIFECYCLE.md` for the full reasoning); reactivating before
that deadline cancels it and keeps the same number. Account deletion (no
such feature exists yet) gets the opposite policy — immediate release,
no grace period — via a release primitive built ready for that future
feature to call.

**Testing:** two layers, both automated — RPC-level tests against a real
Postgres-compatible engine (`tests/migrations.pglite.test.mjs`) covering
the actual atomic/idempotent database guarantees, and orchestration-level
unit tests with injected fake Twilio/database collaborators
(`tests/twilio-provisioning.test.mjs`) covering successful provisioning,
retry after failure, the attempt-cap cutoff, race resolution, and the
full entitlement-change policy switchboard. 126 checks pass across the
whole suite.

**Incidental finding while building this:** extending the existing
`tests/migrations.pglite.test.mjs` harness surfaced that its role-switching
helper (`SET LOCAL ROLE`) never actually persisted across separate calls,
so every prior "authenticated/anon cannot execute this RPC" assertion in
that file had been passing for the wrong reason (an unrelated
business-logic exception, not a real permission-denied error) — not
something introduced by this work, but fixed as part of it, since it
directly bears on the security guarantees this sprint's tests claim to
verify. Confirmed empirically before changing anything; details in the
file's own updated comments.

**Update, 2026-07-21 — verified end-to-end against the real Twilio API.**
`TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN` have since been added. Getting to
a real test uncovered two further things worth recording plainly:

- **Migration 016 was reported as applied but wasn't.** Running its
  contents as one bundled transaction in the Supabase SQL Editor reported
  success repeatedly while verifiably changing nothing — confirmed via
  direct `information_schema`/`pg_proc` queries and PostgREST's own raw
  descriptor. Neither a schema-cache reload nor a full project restart
  fixed it. What did work: applying each column, backfill, and function
  as its own standalone statement rather than one bundled script — full
  account in `docs/engineering/016_017_migration_incident_notes.md`. No
  root cause was ever conclusively identified; a closely-matching,
  still-unresolved public report exists
  ([supabase/supabase#42183](https://github.com/supabase/supabase/issues/42183)).
- **That isolation surfaced a real bug** in `assign_household_twilio_number`:
  its "household doesn't exist" check used a manually-selected boolean
  that PL/pgSQL sets to `NULL` (not `false`) when zero rows match, so the
  check never fired — a nonexistent household id silently no-op'd and
  returned `true` instead of raising. Fixed using Postgres's built-in
  `FOUND` variable; a regression test now covers this exact case in
  `tests/migrations.pglite.test.mjs`.

With both resolved, a real test (test Stripe mode, real Twilio
credentials, a temporary ngrok tunnel standing in for a public `APP_URL`)
confirmed the system genuinely reaches Twilio's real purchase endpoint.
It stopped there for one specific, expected reason: **UK local numbers
require a registered Twilio `Address` object**, which this app doesn't
create or reference yet — the same open decision as the placeholder
registered office address in the Terms & Conditions, not a separate
piece of work. No number was purchased, no charge occurred (confirmed
directly against the Twilio account), and the failure was correctly
recorded on the test household — `twilio_provisioning_status: 'failed'`,
`attempts: 1`, `last_error` holding Twilio's exact message — exactly as
this system was designed to do. See `KNOWN_ISSUES.md` for current status.

**Migration 017 is unconfirmed.** It was written and tested against the
same bundled-transaction shape 016 turned out not to survive, and has not
been independently re-verified the same way. One of its four functions
was directly confirmed missing via a live call. Tracked as a separate,
deliberately-not-yet-repaired item — see `KNOWN_ISSUES.md`.

## 7. Recommendations before launch

See `KNOWN_ISSUES.md` for the full list with severities, and
`POST_LAUNCH_ROADMAP.md` for scheduling. Headline item: **decide on a
registered office address** — it unblocks both the Terms & Conditions
placeholder and the Twilio `Address` object needed for real number
purchases, the one remaining step between today's verified system and
actual working call screening.
