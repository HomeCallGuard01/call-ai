# Claude session handover — RC1 mobile app staging E2E test

**Written:** 2026-08-05, by Claude Sonnet 5, at the end of a long-running session
covering a full RC1 staging end-to-end test, a staging-environment isolation
fix, and a company-information branding audit. This document exists so a
fresh Claude Code conversation can resume without re-deriving context. For
broader project/launch-readiness context beyond this session's work, see
`docs/mobile-app/RC1_HANDOVER.md` (a separate, pre-existing document with
different scope).

---

## 1. Branch and worktree

- **Repo:** `/Users/ad/call-ai-sandbox-mobile-app-v1`
- **Branch:** `sandbox/mobile-app-v1`
- **PR:** #2 against `main` — **OPEN, unmerged.** Title: "RC1: Mobile app
  onboarding redesign, production hardening, and full V1 screen set."
  **Do not merge without explicit approval** — this is a standing constraint
  across the whole engagement, not new.
- A second repo, `/Users/ad/call-ai` (branch `main`), is the production-adjacent
  main repo. It currently has **unrelated pre-existing uncommitted changes**
  from earlier work (production migration docs/SQL for migrations 021/022,
  flagged in that work's own release record as "left for separate review
  before committing") **plus** the same `public/privacy.html` /
  `public/terms.html` content fix this session made in the sandbox repo,
  copied over but **deliberately left uncommitted** pending your review — see
  §6.

## 2. Latest commit hashes (sandbox/mobile-app-v1, all pushed)

```
4524c9f content(legal): fill in registered office / postal address placeholder
6407010 fix(rc1): activation not_provisioned redirect loop; sign-out never navigated away
24a07cb fix(rc1): isolate staging env config; stop OpenAI crash on missing key
e85aedc docs(rc1): record email verification enforcement and web logout defect
6e17659 fix(rc1): logout non-functional on web; add staging test-user reset script
```
`git status -sb` shows `sandbox/mobile-app-v1...origin/sandbox/mobile-app-v1`
with no ahead/behind — fully pushed, nothing pending in this repo.

## 3. Staging Supabase project

- **Ref:** `tigwgmayeuisrxjjykqd`
- This is the **only** project safe to test against. Production is
  `psbzynxplxfbyrbdidmn` — call-ai has no other staging environment; never
  refer to anything else as "staging."
- Two pre-existing protected staging accounts exist in this project and were
  **not touched** this session — confirmed via direct query: only 3
  households total in staging (the 2 protected ones + this session's 1 new
  test household), and the other two have zero contacts (unchanged).

## 4. Canonical staging env-file arrangement (new this session)

Root cause fixed this session: `server.js` used to *always* also load cwd's
`.env` regardless of what was explicitly passed at launch, which is how the
staging backend ended up silently drawing Stripe/Twilio/OpenAI config from
the sandbox repo's default `.env` — which also carries a live-prefixed
Stripe key — instead of any file actually named "staging."

- **Canonical file:** `/Users/ad/call-ai-sandbox-mobile-app-v1/.env.staging`
  (gitignored, not committed — contains real staging Supabase keys and a
  test-mode Stripe key, so it must never be committed). Twilio/OpenAI are
  deliberately left unset there.
- **Launch command:**
  ```
  ENV_FILE=/Users/ad/call-ai-sandbox-mobile-app-v1/.env.staging node server.js
  ```
  (run from `/Users/ad/call-ai-sandbox-mobile-app-v1`)
- `server.js` now loads **exactly one** file: the one named by `ENV_FILE` if
  set, else the default `.env` (plain local dev, unaffected by this change).
  No silent fallback merge anymore.
- Boot-time safeguards (only run when `ENV_FILE` is set, so plain local dev
  is never affected): refuses to start if `SUPABASE_URL` doesn't resolve to
  the staging ref or resolves to the known production ref, if
  `STRIPE_SECRET_KEY` isn't a recognizable `sk_test_` key or is live-prefixed,
  or if any required staging var is missing — plus a runtime
  `stripe.balance.retrieve()` check confirming `livemode: false`. Logic in
  `services/serverConfig.js` (`validateStagingEnv`), tests in
  `tests/server-config.test.mjs`.
- **Two now-superseded files, left in place but marked with a header
  comment, not deleted:**
  `/Users/ad/call-ai-sandbox-mobile-app-v1/.env.staging.local` and
  `/Users/ad/call-ai/.env.staging.local` — neither is actually loaded by the
  server; both predate this fix and looked authoritative but weren't.

## 5. Processes and ports currently running

| PID | What | Port | Command |
|---|---|---|---|
| 13510 | Staging backend | 3099 | `ENV_FILE=.../.env.staging node server.js`, cwd `/Users/ad/call-ai-sandbox-mobile-app-v1` |
| 99735 | Expo web dev server | 8081 | `expo start --web --clear`, cwd `.../mobile` |
| 13705 | Stripe CLI listener | — | `stripe listen --api-key sk_test_... --forward-to http://192.168.1.237:3099/billing/webhook` |

The backend has a host-canonicalization middleware that 301-redirects
`localhost` requests to `192.168.1.237` (matching `APP_URL` in
`.env.staging`) — always hit the canonical host directly for anything
webhook- or POST-related, since a redirected POST can silently degrade to a
GET. The Stripe listener must forward to the **canonical host**, not
`localhost` — using `localhost` here was the exact mistake that produced a
`301` instead of webhook delivery earlier this session.

`mobile/.env` already points the Expo web app at this staging backend and
Supabase project correctly — no change needed there.

## 6. Stripe test-mode status

- Confirmed test mode: `stripe.balance.retrieve()` reports `livemode: false`
  for the key now in `.env.staging` (account `acct_1TqCXMEopg3VmrHs`, same
  account that owns the real checkout session created during this test).
- A full test-mode checkout (`4242 4242 4242 4242`) was completed live
  against Stripe Sandbox, and the resulting webhook was correctly delivered
  and processed after the env fix — see §7.
- **Company-information audit (separate from the env work):** support email
  (`support@homecallguard.co.uk`), legal entity naming ("AFMD Ltd"),
  `mailto:` links, footers, and Stripe checkout copy were all already
  correct. One real finding: the Privacy Policy and Terms pages had a live
  `[REGISTERED OFFICE ADDRESS TO BE CONFIRMED]` / `[BUSINESS POSTAL ADDRESS
  TO BE CONFIRMED]` placeholder — filled in with **128 City Road, London,
  EC1V 2NX, United Kingdom** in both `public/privacy.html` and
  `public/terms.html`. Fixed and committed in the sandbox repo (`4524c9f`).
  The identical fix was also applied to `/Users/ad/call-ai`'s copies of
  those two files (byte-identical `public/` between the repos) but **left
  uncommitted** there, since that repo already had unrelated pending
  changes and pushing to `main` wasn't something this session had standing
  authorization for — review and commit those two files yourself when
  ready.
- **Not addressed:** a separate, unrelated data-retention-periods
  placeholder in `privacy.html`'s retention section (`[Exact retention
  periods to be confirmed...]`) — left alone since filling it in requires an
  actual business-policy decision, not just inserting an already-known
  detail.

## 7. Completed end-to-end stages (this session, staging, real backend)

All of the following were driven live through the actual UI in a browser
against the running staging backend, using a genuine new signup
(`ga***om`, masked — real Gmail address, full value known to the account
owner) with password `StagingTest0802!x`:

1. **Registration** — real `/register` screen, genuine Supabase signup.
2. **Email verification** — genuinely enforced (not bypassable client-side);
   Yahoo `+`-alias didn't deliver (Yahoo limitation, not a bug); Gmail
   delivery confirmed and the real confirmation link was clicked.
3. **Login** — password login establishes a real session; dashboard/bootstrap
   fetch sequence confirmed correct on a clean first attempt (an earlier
   apparent "Status unavailable" glitch was root-caused to this session's own
   test methodology — navigating away before the SPA processed a URL
   fragment — not a real app defect).
4. **Stripe test-mode checkout** — real Sandbox checkout, `4242 4242 4242
   4242`, completed; `stripe_customer_id` correctly attached synchronously;
   subscription/entitlement only appeared after the webhook was correctly
   delivered post-env-fix (exactly one `subscriptions` row, one
   `entitlements` row — confirmed idempotent by replaying the same webhook
   event twice with no duplicate rows created).
5. **Trusted contact** — added "Margaret (Mum)" manually (native contact
   picker correctly fails open on web with a clear message — expected,
   `expo-contacts` isn't available in browser preview); persisted
   server-side, correctly household-scoped.
6. **Device/provider selection → activation** — Landline → BT. Found and
   fixed a real redirect-loop bug here (see §8). After the fix and a
   synthetic Twilio-number assignment (via the existing
   `assign_household_twilio_number` RPC, a UK Ofcom-reserved fictional
   number, never real), activation instructions rendered correctly with the
   BT-specific dialling code.
7. **Activation verification** — via a synthetic `calls` row inserted
   directly (matching the established, documented staging pattern — never a
   real Twilio call); verification correctly succeeded and
   `activation_verified_at` was set.
8. **Home dashboard final state** — "Protected", correct contact count (1),
   Account tab shows Membership: Active, Protection: Protected.
9. **Logout → login** — found and fixed a real bug here too (see §8); after
   the fix, logout correctly lands on the Welcome carousel, and a fresh
   login correctly and immediately restores full state (membership,
   protection, contact).
10. **Refresh and Back navigation** — tested at Home, Account, and mid-setup
    (landline provider list); all persist/behave correctly, no crashes.
11. **Household scoping** — verified directly against the database: exactly
    one row each in `contacts`/`calls`/`entitlements`/`subscriptions`, all
    correctly scoped to the one test household; only 3 households total in
    staging; the two protected accounts unaffected.
12. **Full automated test suite** — 467 checks, 0 failures, run twice (once
    after the env-isolation fix, once after the two live bug fixes).

## 8. Two real defects found and fixed this session (both committed)

1. **`mobile/app/(setup)/activate.tsx`** — a `409 not_provisioned` response
   (household's Twilio number not yet assigned — confirmed a real,
   customer-reachable state on production too, not just a staging artifact;
   see `docs/mobile-app/RC1_HANDOVER.md`'s UK Twilio Address blocker) used to
   `router.replace` to `/welcome`, which always redirected straight back to
   `device-picker` since activation isn't verified yet either — a silent,
   unexplained infinite bounce with zero error message whenever provisioning
   isn't complete. Now shows an inline "Still setting up your line" state
   with its own retry, on the same screen.
2. **`mobile/lib/AuthContext.tsx`** — the function's own header comment
   always claimed "onAuthStateChange firing with a null session redirects to
   login from wherever the customer happens to be" (documented E4 behavior),
   but the actual `router.replace` call was never written. Logging out from
   a screen that fetches dashboard data (e.g. Account) correctly cleared the
   session but left that screen showing an infinite loading spinner forever.
   Added the missing redirect on the `SIGNED_OUT` event.

Both were reproduced live, fixed, verified live again post-fix, and are
covered by the still-passing full test suite (though neither had dedicated
new automated tests added — see §9 outstanding work).

## 9. Outstanding blockers / remaining launch tasks, roughly in priority order

1. **UK Twilio Address/bundle requirement** — a real Severity-1 blocker
   documented in `docs/mobile-app/RC1_HANDOVER.md`: purchasing a real UK
   Twilio number requires a registered Twilio "Address" object and bundle,
   which blocks real call-screening provisioning for **every** new customer
   until resolved. This is why this session had to assign a synthetic
   Twilio number by hand to get past `not_provisioned` — real customers will
   hit exactly the redirect-loop bug that was just fixed, until this
   Twilio-side blocker is separately resolved. Not something Claude can fix
   from within the codebase.
2. **`/Users/ad/call-ai`'s uncommitted `public/privacy.html` /
   `public/terms.html`** — the same registered-office fix applied there,
   waiting on your review/commit (§6).
3. **Data-retention-periods placeholder** in `privacy.html`'s retention
   section — needs an actual business decision, not a lookup.
4. **Legal review flagged but not done**: the 30-day money-back
   guarantee / Founding Member pricing copy in
   `mobile/app/(setup)/subscribe.tsx` has its own code comment explicitly
   flagging it as "a reasonable working draft, not a legal sign-off."
5. **Minor cleanup, not urgent:** a stray `public/dashboard.htmly` file
   (note the `.htmly` extension) — an old prototype dashboard, statically
   reachable at `/dashboard.htmly` in both repos, no branding issues itself
   but shouldn't ship. Not removed this session (destructive action, left
   for your decision).
6. **No dedicated regression tests added** for the two bugs fixed in §8 —
   the fixes are covered incidentally by the still-passing suite but don't
   have their own new test cases pinning the exact scenarios (409
   not_provisioned handling, SIGNED_OUT redirect). Worth adding if continuing
   RC1 hardening.
7. **Remaining RC1 checklist items** beyond what this session's test covered
   — check `docs/RC1_CHECKLIST.md` for the current full list; this session
   substantially advanced it but didn't re-audit it end-to-end against every
   line item.

## 10. Production boundaries that must not be crossed

- **Never** target `psbzynxplxfbyrbdidmn` (production Supabase) for any
  test/write action. Only `tigwgmayeuisrxjjykqd` is safe.
- **Never** touch the two pre-existing protected staging accounts, or the
  handful of unrelated pre-existing Stripe test customers in the same
  account.
- **Never** merge PR #2 without explicit approval.
- **Never** use real Twilio calls or a live Stripe mode for any RC1 testing.
- **Never** add collaborators/accounts on `HomeCallGuard01/call-ai` — this
  project is solo-maintained.
- Any production database migration or deploy requires the exact confirmation
  phrase pattern already established in `docs/releases/` — don't improvise a
  new one.
- The `.env.staging` file itself must never be committed (gitignored,
  contains real staging keys).

## 11. Official company details (for any future branding/legal content work)

- Customer support email: **support@homecallguard.co.uk**
- Company: **AFMD Ltd**
- Registered office: **128 City Road, London, EC1V 2NX, United Kingdom**
- Website: **https://homecallguard.co.uk**

## 12. "Sync all contacts" (iOS + Android, 2026-08-22) — implemented, iOS physically verified

**STATUS UPDATE (2026-08-22, later same day):** implemented (bulk
`POST /api/v1/contacts/sync`, `mobile/app/(tabs)/contacts/from-phone.tsx`
rewritten as a one-tap sync) and physically tested on a real iPhone —
**PASSED**: full address book sync, repeat-sync idempotency, and the
iOS Limited Access flow (detection, "Allow full contact access" → iOS
Settings, "Choose more contacts individually", "Continue with just my
selected contacts", auto-recheck on returning from Settings) all
confirmed working on-device. No further iOS contacts changes planned.
Android preview build separately fixed same day (missing
`GOOGLE_SERVICES_JSON` EAS file secret for the `preview` environment —
see build history) and rebuilding.

Original request (below) kept for the full design rationale.

**What**: a one-tap "Sync all contacts" bulk-import action in
`(setup)/contacts.tsx`, alongside the existing "Select contacts" (native
single-contact picker) and "Add manually" options — not a replacement for
either. Clear permission/consent prompt before any bulk address-book
access. Normalise and dedupe numbers on import. Synced numbers become
trusted contacts exactly like today's manually-picked ones — calls from
them ring through unmonitored, which is also the business case: fewer
unknown-caller calls means lower live-monitoring/transcription/Twilio
cost per household, in addition to faster onboarding for anyone with a
large contact list.

**iOS + Android only** — landline setup is explicitly excluded, since
Home Call Guard has no way to access a landline customer's address book
at all. Landline customers keep adding trusted contacts manually via
their account/dashboard, unchanged.

**Why not a quick add-on**: today's picker (`Contacts.presentContactPickerAsync()`)
is a system UI that never grants the app contacts permission at all — see
the standing comment at the top of `mobile/app/(setup)/contacts.tsx`
("no bulk address-book access ever granted"). A real bulk sync needs
`Contacts.getContactsAsync()`, which is a materially different, broader
permission grant. That means, at minimum:
- Updated `NSContactsUsageDescription` (iOS) / contacts-permission copy
  (Android) reflecting "we import your whole contact list," not today's
  implied one-at-a-time framing.
- A Privacy Policy update stating plainly that contact data leaves the
  device and is stored server-side for every imported contact, not just
  ones explicitly hand-picked — a materially different privacy posture
  from today's model.
- Likely a new shared bulk-import backend endpoint (e.g.
  `POST /api/v1/contacts/bulk`) rather than looping today's single
  `POST /api/v1/contacts` hundreds of times per sync — one entitlement
  check and one DB round trip instead of hundreds, with a structured
  per-item success/failure result reusing the same outcome-handling
  pattern already in `mobile/app/(tabs)/contacts/from-phone.tsx`.

None of that is same-day work — assessed twice now (2026-08-21 and
2026-08-22) and both times judged out of scope for a quick add-on. Worth
scoping as real, separately-reviewed work: permission copy, Privacy
Policy revision, and the new bulk endpoint, before any implementation
starts on either platform.

---

## Recommended opening prompt for the next Claude conversation

```
Read docs/mobile-app/CLAUDE_SESSION_HANDOVER.md in
/Users/ad/call-ai-sandbox-mobile-app-v1 (branch sandbox/mobile-app-v1) to
pick up this session's context, then confirm the staging backend (port
3099), Expo web dev server (port 8081), and Stripe CLI listener are still
running before doing anything else — they may have been stopped since this
handover was written. Once confirmed, [state your actual next goal here,
e.g. "continue working down the remaining RC1 checklist items" or "add
regression tests for the two bugs fixed in the handover's §8"].
```
