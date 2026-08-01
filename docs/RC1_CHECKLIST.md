# Mobile App — RC1 Launch Checklist

## RC1 details

- **Branch:** `sandbox/mobile-app-v1`
- **PR:** [#2](https://github.com/HomeCallGuard01/call-ai/pull/2)
- **Commit:** `629c06f` (`feat(onboarding): redesign and production hardening`)
- **Status:** Open, unmerged, feature frozen — only fixes for issues found during RC1 review/testing are permitted from this point forward

## Staging environment

A genuinely separate Supabase staging project exists and is now wired into this branch:

- **Project:** `home-call-guard-staging`, ref `tigwgmayeuisrxjjykqd`, region `eu-west-2`, created 2026-07-30. Distinct project, distinct credentials, distinct auth users — no shared state with production (`psbzynxplxfbyrbdidmn`).
- **Discovered, not created, by this pass** — it was already set up and substantially verified via parallel work on `main` (`docs/engineering/STAGING_ENVIRONMENT_PLAN.md`, `docs/engineering/MIGRATION_RECOVERY_PLAN.md`) that this branch had no visibility into until 2026-08-01. Reconciled into `sandbox/mobile-app-v1` via commit `6affdc9` — cherry-picked (not merged): migration `000_baseline_contacts_table.sql`, migration `022_lock_down_security_definer_execute_grants.sql`, both migrations' rollback scripts, the relocation of `005_household_rls.sql` and 019's rollback to non-scanned directories, `scripts/verify-security-definer-grants.js`, and a merge (not overwrite) of `tests/migrations.pglite.test.mjs` that keeps this branch's own migration-021-specific behavioural tests alongside main's new dynamic grant check.
- **Environment files:** `.env.staging.local` (repo root) and `mobile/.env.staging.local` — both gitignored (`.gitignore`'s `.env.*` and `mobile/.gitignore`'s `.env*.local` patterns, confirmed via `git check-ignore`), never committed, clearly labeled as staging in their own header comments. Stripe keys in the root file are the existing **test-mode** keys already present in `.env` (`STRIPE_TEST_SECRET_KEY` etc.) — never live keys. Twilio credentials deliberately left blank — activation-verification testing uses a synthetic database row, never a real Twilio call.
- **Migration history:** `supabase migration list --linked` (run from this worktree, linked to staging) shows local and remote versions matching exactly for all 21 applied migrations (`000`–`004`, `006`–`022`; `005` and the `019` rollback are relocated out of the scanned path on both sides).
- **Existing data confirmed synthetic:** staging has 2 household rows. One is the hardcoded placeholder every environment gets from migration `004_backfill_default_household.sql` (`default-household@homecallguard.internal`) — its email/phone/Twilio-number match production's own copy of the same migration exactly, which is expected and not a data leak. The other has zero field overlap with any production household (checked: email, phone number, Twilio number, Stripe customer ID — compared in-memory, no raw values logged or displayed). Neither row was modified or deleted by this pass.

## How to read this checklist

- `[x]` — supported by evidence cited alongside it (a test count, commit hash, PR reference, or file). Only items that can be pointed at concrete evidence are checked.
- `[ ]` — not yet verified. In particular, everything requiring live Stripe, live Twilio, live email delivery, a physical/simulated mobile device, or production infrastructure is left unchecked here regardless of how the underlying code looks, because none of that has actually been exercised yet.

---

## Code quality

- [x] TypeScript strict compile clean — `npx tsc --noEmit` (`mobile/tsconfig.json`), exit 0
- [x] Full automated test suite passing — 450/450 checks across 15 test files (`npm test`, repo root), exit 0 — up from 383 after reconciling with main's SECURITY DEFINER grant test coverage (commit `6affdc9`)
- [x] Regression tests added for every hardening fix found this pass — commit `629c06f`, `tests/mobile-app.test.mjs` (+121 lines, 12 new checks covering `looksLikePhoneNumber`, `contactsStillNeedingSave`, `describeSaveFailure`)
- [ ] Lint / static analysis — not run as part of this pass
- [ ] Component/integration test harness (Jest/React Native Testing Library) — does not exist; see **Deferred items**

## Authentication

- [x] Bearer-token verified server-side via `supabase.auth.getUser()`, never decoded/trusted client-side — code review, `middleware/requireAuthApi.js`
- [x] Household scoping derived server-side (`req.household.id`), never accepted from client input — code review, `middleware/requireAuthApi.js`, `middleware/requireEntitlement.js`
- [x] Cross-user data-leak race fixed: an in-flight dashboard request from a previous session could resolve after a sign-out/sign-in-as-different-user and briefly show the wrong user's data — commit `629c06f`, `mobile/app/(tabs)/index.tsx` (`loadId` generation guard)
- [ ] Live sign-up / login / password-reset flow exercised on a real device — requires mobile-device testing
- [ ] Session refresh/expiry behaviour (return to exact prior screen after re-auth) — code reviewed only (`mobile/lib/AuthContext.tsx`), not live-tested this pass

## Subscription and payments

- [x] Checkout flow always re-verifies real server-side entitlement after the Stripe Checkout browser session closes, never trusts the browser redirect alone — code review, `mobile/app/(setup)/subscribe.tsx`
- [x] `already_active` (409) handled as a normal, expected outcome rather than an error — code review, `subscribe.tsx` + `routes/mobileApi.js`
- [x] Unmounted-component guard added around the checkout browser round trip (can stay open for minutes) — commit `629c06f`, `subscribe.tsx`
- [ ] Live Stripe Checkout end-to-end (real payment, real webhook) — not tested this pass; see **Deferred items**
- [ ] 30-day money-back guarantee / refund path — not tested
- [ ] Legal review of guarantee and "start immediately" consent wording — not performed; see **Deferred items**

## Onboarding

- [x] Guided setup reordered (trusted contacts collected before activation) with resume-at-correct-step logic — `mobile/lib/setupFlow.ts`, 5 checks in `tests/mobile-app.test.mjs` (`resumeSetupAt`, `stepIndexForScreen`, `SETUP_STEPS`)
- [x] Home dashboard "Finish setup" resume-routing edge case reviewed and hardened (missing `"subscribe"` fallback could have called `router.push(undefined)`) — commit `629c06f`, `mobile/app/(tabs)/index.tsx`
- [x] Full onboarding journey exercised via live browser testing (`expo start --web`) against staging earlier this session, surfacing and fixing one real bug (stale `Cache-Control` masking entitlement state) — browser only, not a physical device
- [ ] Full walkthrough on a real iOS/Android device — requires mobile-device testing

## Trusted contacts

- [x] Native single-contact picker only — no bulk address-book access, only the specific people the customer selects — code review, `mobile/app/(setup)/contacts.tsx`
- [x] Re-entrancy guard added on the contact picker (double-tap could open it twice concurrently) — commit `629c06f`
- [x] Batch save parallelized (`Promise.all`) and reviewed for a TOCTOU duplicate-save race — confirmed safe, since the UI dedupes by number before a batch is ever built — commit `629c06f`, `mobile/lib/contactSelection.ts`
- [x] Duplicate-save outcome no longer stuck permanently in the retry list — commit `629c06f`, `tests/mobile-app.test.mjs` (`contactsStillNeedingSave` checks)
- [x] Name-prefix retry-matching bug fixed (e.g. "Jo" / "Jo Smith" misclassification) — commit `629c06f`, regression test in `tests/mobile-app.test.mjs`
- [x] Inline manual-entry phone validation added, catching an obviously malformed number at entry time instead of only after a round trip — commit `629c06f`, `looksLikePhoneNumber` + 5 checks
- [ ] Real device-contact import tested on a physical device — not tested this pass

## Protection and call routing

- [x] Fail-closed protection status: the dashboard can never render "Protected" without backend-confirmed data — `mobile/lib/homeStatus.ts`, 6 checks in `tests/mobile-app.test.mjs` (`deriveLoadOutcome`)
- [x] Activation-instructions logic covered per landline provider (BT, Sky, Virgin, TalkTalk, Plusnet, other) — 17 checks in `tests/activation-instructions.test.mjs`
- [x] **Activation-verification flow exercised end-to-end against staging**, 2026-08-01 — real Supabase auth user created, signed in, bootstrapped via `POST /api/v1/me/bootstrap`, a synthetic "recent call" row inserted, `POST /api/v1/activation/verify` called for real over HTTP against the running backend (not a direct RPC/unit test): returned `verified: true` with a real `activation_verified_at` timestamp; called again, confirmed idempotent (identical timestamp returned, not a new one). Every synthetic artifact (auth user, household, call row) was deleted afterward — staging's household count confirmed back at 2, matching its pre-test state.
- [ ] Live call-forwarding activation verified against a real Twilio number / real carrier dial — requires live Twilio; see **Deferred items**
- [ ] Actual AI call-screening behaviour tested live — not exercised in this pass

## Dashboard and account

- [x] Home dashboard `load()` race condition fixed — overlapping focus/pull-to-refresh calls could apply a stale response over fresh state — commit `629c06f`, `mobile/app/(tabs)/index.tsx`
- [x] Stale-data / offline banner logic covered by tests — `tests/mobile-app.test.mjs` (`deriveLoadOutcome` stale-data checks)
- [ ] Account / billing-portal live flow — not tested this pass

## Emails

- [ ] No email-related testing performed as part of this pass — transactional emails (signup, password reset, receipts) not exercised for the mobile flows

## Security

- [x] Server-side bearer-token verification confirmed — no client-supplied identity ever trusted — code review, `middleware/requireAuthApi.js`
- [x] Contact duplicate-check confirmed household-scoped — no cross-household data leak possible via the "duplicate" outcome — code review, `routes/mobileApi.js`
- [x] `Cache-Control: no-store` fix confirmed present on the mobile API router — verified via `grep` this session, `routes/mobileApi.js`
- [x] CORS wildcard (`Access-Control-Allow-Origin: *`) reviewed — accepted as low-risk given bearer-token-only auth (no ambient browser credentials to ride); flagged to revisit if the auth model ever changes
- [x] **Every `SECURITY DEFINER` function's grants verified against staging**, 2026-08-01 — `node scripts/verify-security-definer-grants.js` (linked to `tigwgmayeuisrxjjykqd`): all 11 functions (including `mark_household_activation_verified`) have `service_role`-only `EXECUTE` (no `PUBLIC`/`anon`/`authenticated`), a pinned empty `search_path`, and `postgres` ownership; the schema's default privileges for future functions are confirmed fail-closed. This closes a real gap found while staging was first provisioned — Supabase's platform default originally granted `EXECUTE` on new functions directly to `anon`/`authenticated` (not via `PUBLIC`, so `revoke all from public` alone never caught it) — fixed by migration `022_lock_down_security_definer_execute_grants.sql`. Production was separately confirmed (2026-07-31, on `main`) to never have had this exposure — its default privileges predate whatever introduced this Supabase platform default. Full detail: `docs/engineering/MIGRATION_RECOVERY_PLAN.md` on `main`.
- [ ] Rate limiting on `/api/v1/contacts` and `/api/v1/activation/verify` — not reviewed; see **Deferred items**
- [ ] External penetration test / security audit — not performed

## Accessibility

- [x] `accessibilityRole="header"` added to every screen title across setup and the Home dashboard (previously missing everywhere) — commit `629c06f`
- [x] Contrast checked against WCAG AA across onboarding screens — computed earlier this session via a manual luminance/contrast script, all combinations passed
- [x] Reviewed for dynamic-type/text-scaling clipping — no hardcoded height/line-height clamps found on text-bearing containers — code review this session
- [ ] VoiceOver / TalkBack tested on a real device — requires mobile-device testing

## Browser and device testing

- [x] Web preview (`expo start --web`) exercised for the onboarding journey against staging, surfacing and fixing one real bug (`Cache-Control`) — earlier this session
- [ ] iOS physical or simulator device testing — not performed
- [ ] Android physical or simulator device testing — not performed
- [ ] Expo Go compatibility confirmed only via package-version alignment (SDK 54, matching the App Store's Expo Go cap) — not confirmed via an actual device install/run this pass

## Production configuration

- [ ] Production Stripe keys/webhook configuration verified — not checked this pass
- [ ] Production Twilio configuration verified — not checked this pass
- [ ] Production `EXPO_PUBLIC_API_BASE_URL` value confirmed — not checked this pass
- [x] Migration `021_household_activation_verified.sql` applied status on **staging** — **confirmed applied and fully verified**, 2026-08-01. `supabase migration list --linked` shows local/remote history matching exactly; `households.activation_verified_at` exists; `mark_household_activation_verified` exists and behaves correctly (idempotent, raises for a nonexistent household, denies `authenticated` role, confirmed both via direct RPC call and via the full HTTP activation-verify flow — see **Protection and call routing** above).
- [x] Migration `022_lock_down_security_definer_execute_grants.sql` applied status on **staging** — confirmed applied and verified (see **Security** above).
- [ ] Migrations 021/022 applied status on **production** — **confirmed NOT applied**, deliberately. Live-verified 2026-07-31/2026-08-01 (read-only, two independent ways: column/function existence checks both fail as expected). A complete, ready-to-execute runbook already exists on `main` (`docs/engineering/PRODUCTION_MIGRATION_RUNBOOK_021_022.md`) — pre-flight checklist, exact execution sequence, post-deployment verification, and rollback strategy — but has never been run and requires separate, explicit approval before it is. See **Release decision**.

## Rollback and monitoring

- [ ] Rollback plan for this release — not defined
- [ ] Monitoring/alerting for the new `/api/v1/*` routes — not defined
- [ ] Error tracking (e.g. Sentry) wired for the mobile client — not verified

## Deferred items

These are already listed in PR #2 and remain open:

- Legal review of consent and guarantee wording (`subscribe.tsx`'s "start immediately" checkbox and founding-member/guarantee terms) not yet performed
- **RESOLVED 2026-08-01 — staging environment now exists and migrations 021/022 are applied and verified there.** History: on 2026-08-01 this checklist incorrectly claimed live testing had exercised migration 021 against "staging" when no such project was known to this branch; that was corrected the same day to "no staging environment exists, migration 021 not applied anywhere." Both corrections are now superseded — a real staging project (`tigwgmayeuisrxjjykqd`, created 2026-07-30) was found to already exist via parallel work on `main`, and has been reconciled into this branch (commit `6affdc9`). See **Staging environment** above for full detail. The one item that remains genuinely open is applying 021/022 to **production** — see **Release decision**.
- Live Stripe flow not fully tested in this pass (staging config now uses Stripe **test-mode** keys, but no live Checkout session has been run against it yet)
- Live Twilio flow not fully tested in this pass (activation-verification was tested via a synthetic database row, not a real Twilio call — deliberately, per this task's own scope)
- No component-test harness (Jest/RNTL) exists — mobile tests are pure-logic-extraction only
- Rate limiting on the mobile API still requires review, particularly now that contact saves fire in parallel rather than sequentially

## Release decision

- [ ] **Approved to merge PR #2 into `main`** — not yet decided; requires explicit sign-off from the repo owner after the items above requiring live Stripe, Twilio, email, device, and production-configuration testing are resolved or explicitly accepted as known launch risks.

**Current recommendation: not ready to merge or deploy.** Code-level correctness, races, accessibility, and security have been reviewed and hardened with automated-test coverage, and migrations 021/022 are now fully applied and verified on a real staging environment, including a full end-to-end activation-verification test. What remains is applying 021/022 to production and everything requiring live payment processing, live call forwarding, a real device, or production configuration.

**Remaining launch blocker (updated 2026-08-01):** migrations 021 and 022 must still be applied to production before the mobile app's activation-verification flow can work for a real customer — `POST /api/v1/activation/verify` will still 500 on production today. This is no longer blocked by "nowhere safe to test it" (staging now exists and both migrations are verified there) — it is now purely a deliberate go/no-go decision on executing the already-written `docs/engineering/PRODUCTION_MIGRATION_RUNBOOK_021_022.md` (on `main`), which requires separate, explicit approval per this project's own standing convention for production changes. Not executed as part of this task, and not implied by anything above.
