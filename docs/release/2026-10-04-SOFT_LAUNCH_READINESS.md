# Soft-launch readiness: staging, mobile and release (2026-10-04)

> **Audit and plan only. Nothing here was executed.** No deploy, no store submission,
> no migration applied, and no change to staging, production or any provider
> setting. Every step needs Andrew's explicit approval.

| | |
|---|---|
| Branch | `release/launch-readiness-2026-10-04` |
| Worktree | `/Users/ad/call-ai-launch-readiness` |
| Base | `origin/integration/launch-fortress-2026-10-03` @ `2011ab6` (the latest integration branch; 156 commits ahead of `main` `eb43368`) |
| Production today | backend `eb43368` (main, PR #44); database at migration **046**; iOS **1.0.1 (Build 14)** live, built from code `1f24483`; Android **Build 19** (1.0.1, versionCode 19) on Play **Internal Testing** only |
| Staging today | Supabase `tigwgmayeuisrxjjykqd`: 000–046, 047, 051, 057–061 (and 052 objects with no history row). It shares the **production Twilio account** |

## 0. Classification key

| Label | Meaning |
|---|---|
| **READY** | Code-complete and test-proven locally. No further proof is needed before staging. |
| **NEEDS STAGING PROOF** | Built, but staging or a real device has to show it works before production. |
| **NEEDS BUSINESS DECISION** | Waiting on an Andrew decision (commercial, policy, legal or ordering). |
| **EXTERNAL WAIT** | Waiting on a third party: Twilio, Apple, Google, Stripe, RevenueCat or a lawyer. |
| **BLOCKED** | Cannot proceed until something else is built, fixed or produced. |

## 1. Bottom line

1. **Backend candidate: `2011ab6`.**
   - Local tests pass (see §2.1).
   - It is deployed nowhere.
   - Its migrations are applied nowhere.
   - The launch gate is **CLOSED**: 0 of the registry items are PROVEN. That is correct, because nothing has been run on staging yet.
2. **Next mobile release candidate (Android and iOS): one commit, `2011ab6`.**
   - The mobile tree at `2011ab6` is `release/ios-1.0.2` (`cb710dd`) plus the allowance meter (5 files, +179/−7).
   - **Both platforms need a new build.** See §4 for why. This is not because the old builds are old: specific fixes landed after them.
3. **Fastest safe route to a controlled soft launch:**
   1. Andrew's decisions (§8).
   2. LEVEL 4 provider containment evidence (§3, item B1).
   3. The staging sequence in §6.
   4. New Android and iOS builds pointed at staging, then tested on real handsets.
   5. The production sequence in §7.
   6. Then the store submissions in §9.
4. **What stops a launch today:**
   - Provider-level hard containment is unproven (RED R3).
   - No migration is applied on staging (R1).
   - Production signature validation is unproven (R7).
   - The commercial values are undecided (R5).
   - Android has no Play Billing, which blocks Play Production.
   - The iOS screenshots must be replaced.
   - Real-handset proof does not exist yet.

## 2. Integrated backend

| # | Item | Status | Evidence / next step |
|---|---|---|---|
| 2.1 | Automated tests on `2011ab6` | **READY** | Re-run in this worktree on 2026-10-04: see the §2.1 note below. Mobile `tsc --noEmit` also passes (0 errors). The handover recorded 178/178 files and 7,694 checks. |
| 2.2 | Real-PostgreSQL concurrency suites (`FC_REALPG_MODULES`) | **READY** (per handover) | Not re-run here (the opt-in module directory isn't set in this worktree): `financial-containment-realpg` 15/15, `launch-fortress-realpg` 10/10 |
| 2.3 | Launch-gate judge (`tests/launch-gate/run.mjs --enforce`) | **NEEDS STAGING PROOF** | Exits 1 by design. Probes: 10 PASS, PR-07 deliberate FAIL, PR-11 static-grep FAIL. Financial contract: 7 PASS, FC-3 model FAIL. Promoting anything needs evidence from manual tests M-01…M-17. |
| 2.4 | Inbound pipeline (signature → … → Fortress reservation → `<Dial timeLimit>`) | **NEEDS STAGING PROOF** | `docs/integration/2026-10-03-SAFETY_PIPELINE.md` |
| 2.5 | D3 = REJECT, latching breaker, household hold, destination policy | **READY** (code) / **NEEDS STAGING PROOF** | Decided 2026-10-04 and implemented in `eac6c40` and `2011ab6` |
| 2.6 | Actual provider cost feed (`fc_record_actual` not wired; R2) | **BLOCKED** (not built) | Every budget is an estimate. A soft launch with small caps is still possible if Andrew accepts estimate-only (decision B-7). |
| 2.7 | Abuse shared state across instances (066 has no adapters; R6) | **NEEDS BUSINESS DECISION** | Run a **single Railway instance** for the soft launch (recommended), or build the adapters first |
| 2.8 | Carrier batch-1 work (`p0-batch1-carrier-policy-quarantine` 91f9577) | **READY** | Already an ancestor of `2011ab6` |
| 2.9 | Workstreams NOT in the candidate | n/a | Voice-provider portability, research/*, website/marketing branches, staging-safety-hardening, transcription-no-overlap (`8d5e439`, unit-economics memory). Check whether transcription-no-overlap should join before launch: **NEEDS BUSINESS DECISION** (B-12) |
| 2.10 | Parallel sessions | info | Branches `feature/customer-lifecycle-automation`, `finance/unit-economics-v1`, `research/provider-financial-containment` and `feature/accounting-automation` sit at `2011ab6` with no commits yet. If any of them lands before staging, re-pin the candidate SHA. |

**§2.1 test run (this worktree, `2011ab6`, 2026-10-04):**
- **Plain `npm test` with no environment:** 178 files, **162 passed, 16 failed**; 7,244 checks passed, 0 failed.
  - All 16 failures were `supabaseUrl is required` at import time. No assertion failed.
- **The same 16 files re-run with dummy offline values** (`SUPABASE_URL=http://127.0.0.1:1`, dummy anon, service and Stripe keys): **16/16 pass**, exit 0.
- **Result: 178/178.** The handover reported the same count.
- **Runner gap:** `scripts/run-all-tests.mjs` passes `process.env` through but does not set the offline dummy environment itself. Anyone re-running needs to know this. It's a low-priority fix.
- **Real-PostgreSQL suites:** `*-realpg` report ✓0 ✗0 without `FC_REALPG_MODULES`, meaning they were skipped, not proven, in this run.
- **Mobile:** `npx tsc --noEmit` passes with 0 errors.

## 3. Security and financial launch blockers carried from integration

| # | Item | Status | Next |
|---|---|---|---|
| B1 | **LEVEL 4 provider containment.** Master Twilio token in the backend; 0 usage triggers; no confirmed hard ceiling; one account with no sub-accounts; SMS geographic permissions and auto-recharge pending; no OpenAI hard budget. | **EXTERNAL WAIT** (Twilio's written answers) + **NEEDS BUSINESS DECISION** (residual exposure) | `docs/integration/2026-10-04-PROVIDER_FINANCIAL_CONTAINMENT.md` §3–§5. Questions are drafted, not sent. |
| B2 | Twilio fallback URL on every HCG number set to a static `<Reject>` (R4) | **NEEDS BUSINESS DECISION** (Console change) → **NEEDS STAGING PROOF** | Prove it first on a staging test number |
| B3 | Production signature validation on the real host (R7) | **NEEDS STAGING PROOF** | A mismatch between `APP_URL` and the host would reject every call. Prove it on the staging Railway host, then with `TWILIO_WEBHOOK_ALLOWED_HOSTS` on production. |
| B4 | RLS hardening 057–061 is on staging but **not production** (a live exposure) | **NEEDS BUSINESS DECISION** (apply order a/b/c) | The launch-gate plan recommends option (b): apply 057–061 to production now and accept `--include-all` later |
| B5 | Historical pre-fix Railway logs containing transcripts | **NEEDS BUSINESS DECISION** | Still open from the privacy finding. It doesn't block a soft launch, but it must be recorded. |
| B6 | Staging shares the production Twilio account. The provisioning guard therefore **refuses number purchases on staging** unless `PRODUCTION_TWILIO_ACCOUNT_SID` differs. | **BLOCKED** for the staging provisioning step | A staging Twilio sub-account is needed, which is the same action as B1 item 6. Until then, staging uses the existing test numbers (…1883) and checks provisioning only through the failure-path tests. |
| B7 | Screened-call quality gate (screened calls must match trusted-call quality) | **NEEDS STAGING PROOF** | Run in the handset tests (§6 step 13). It is a memory-recorded gate for broad advertising, not for an invite-only soft launch. |
| B8 | Landline delivery hold | **BLOCKED** (by design) | The candidate keeps landline as "In development". Don't promote it. |

## 4. Mobile: which build becomes the next release candidate

### 4.1 What is in each existing build

| Build | Source | Where it is | Reusable as RC? |
|---|---|---|---|
| iOS 1.0.1 Build 14 | code `1f24483` (= the Build 12 code). **Not an ancestor** of `2011ab6`: the mobile tree was re-imported at `1f8c2e6`. | App Store, live | **No** |
| Android 1.0.1 vc 19 | `a1fcede` (release/android-consolidated); EAS `78b3e124`. The `698bc58` submit config is committed. | Play Internal Testing (2026-09-26) | **No.** Keep it as the internal baseline. |
| Android staging APK 1.0.1 vc 21 | `a1fcede`, profile `staging` (uncommitted, in `/Users/ad/call-ai-staging-handset`); EAS `28111eb5`; **the artifact expires 2026-10-16** | Motorola tests only | Staging diagnostics only |
| Android v10 | `871f6a4` | Rejected by Play (`USE_FULL_SCREEN_INTENT`) | No |

There is no record of any Android **Play Production** release. Its production state is **unknown**. Check it in Play Console (§8, B-13).

### 4.2 What changed after the builds (`a1fcede` → `2011ab6`, mobile/: 35 files, +1640/−84)

**Fixes that require a new build:**
- **Sign-out privacy:** Voice SDK unregister on sign-out. On old builds the previous household keeps ringing on the phone.
- **Call readiness:** device readiness and microphone permission banner; 31401 handling; foreground re-registration when overdue or the push token rotated; wrong-household invites rejected.
- **giffgaff/Three:** forwarding-number fix (`forwardingNumber.ts`).
- **Pricing:** dynamic price from the server (Android) or StoreKit (iOS) instead of hard-coded copy.
- **iPhone signup path and 2.3.10 wording:** iOS only. Approved on 2 Oct.
- **Allowance honesty:** `AllowanceMeter` and allowance-aware Home copy. Old builds keep saying "You're protected" when Fortress has paused monitoring.

For iOS (`1f24483` → `2011ab6`: 77 files, +5055/−763) the list also includes the full Android-line redesign, the carrier gate and Terms, the coming-soon flags and VAT pricing.

### 4.3 Backend versus already-shipped builds (eb43368 → 2011ab6)

| Effect on old builds | Items |
|---|---|
| **Still works** | Voice token and identity unchanged (`voiceAccessToken.js` untouched); token and registration are rate-limited to 60/h per household; invite reports have only additive fields; the `/voice` client-origin and signature guards don't touch the app; dashboard fields are additive. |
| **Degraded** | Old builds ignore `customerAllowance`, so they show a misleading "protected" state once enforcement is live. The sign-out ringing bug remains. There's no readiness telemetry. Contact add/sync of premium numbers now returns 400, which old builds show as a generic error. |
| **Broken** | None found |

**Order:** the backend can be deployed **before** the new apps. The new apps need the new backend (`/voice/device-readiness`, `customerAllowance`).

### 4.4 Recommendation

| Platform | Candidate | Version | Status |
|---|---|---|---|
| Android | `2011ab6` (or `cb710dd` if the allowance meter is held back) | 1.0.2, versionCode **≥ 22** (remote autoIncrement; vc 21 is already used) | **NEEDS STAGING PROOF** (build a staging APK, then a production AAB) |
| iOS | `2011ab6` (same commit) | 1.0.2, Build 15 | **NEEDS STAGING PROOF** (TestFlight) |

**Before either build:**
- **Allowance meter:** include it with the flags off (recommended, because it is inert until `ALLOWANCE_*` is enabled), or build from `cb710dd`. **NEEDS BUSINESS DECISION** (B-9).
- **EAS remote environment variables:** confirm `EXPO_PUBLIC_API_BASE_URL`, `EXPO_PUBLIC_SUPABASE_URL`/`_ANON_KEY` and `EXPO_PUBLIC_REVENUECAT_API_KEY_IOS` per environment. None are in the repo (`eas.json` has no `env` blocks). **NEEDS STAGING PROOF.**
- **Staging profile:** commit a `staging` profile, or keep it uncommitted as now. **NEEDS BUSINESS DECISION** (low).

## 5. Area-by-area status

| Area | Item | Status |
|---|---|---|
| Staging migrations | Repair the 052 history row, then 053→054→055→056→062→…→070 with `--include-all` | **NEEDS BUSINESS DECISION** (approval, repair) → **NEEDS STAGING PROOF** |
| Production migrations | 047→070 in number order, apart from the 057–061 decision (B4) | **NEEDS BUSINESS DECISION** |
| Rollback files | `_rollbacks/` holds 047, 051–070 (059 split into production and staging variants) | **READY** (files) / **NEEDS STAGING PROOF** (rehearsal: §6 step 16) |
| Irreversible migrations | 062 once an account number has been shown; 063 after a real top-up; 067 only with the kill switch on | **NEEDS BUSINESS DECISION** (accept) |
| £5.99 / pricing | There is no single source of truth. Stripe uses `STRIPE_PRICE_ID` (live Price unverified); iOS IAP `co.uk.homecallguard.app.monthly` is £4.99; the website, 12 guides and the terms hard-code £4.99. **The Fortress economics default to £5.99** (`services/containment/economicPolicy.js:27`), so the boot margin check is optimistic unless `HCG_ECONOMICS_PRICE_INC_VAT_GBP` is set. | **NEEDS BUSINESS DECISION** (£4.99 vs £5.99) |
| iOS IAP / RevenueCat | SDK `react-native-purchases ^10.8.1`, iOS only; entitlement `hcg_protected`, offering `default`; the webhook fails closed if `REVENUECAT_WEBHOOK_AUTHORIZATION` is unset; sandbox is unfunded and gets no number (053); canonical entitlement 070 is draft. Minor: the header compare isn't constant-time. | **NEEDS STAGING PROOF** |
| £5.99 store product | A price change needs App Store Connect and RevenueCat changes and a new Stripe Price | **NEEDS BUSINESS DECISION** → **EXTERNAL WAIT** |
| Android purchase | Stripe Checkout in an in-app browser; no Play Billing, no Android RevenueCat key | **BLOCKED** for Play Production (policy). Internal and closed testing can continue. |
| Store metadata: iOS | `IOS_102_STORE_LISTING_2026-10-01.md` is a draft (no price, guarantee or landline claim). All 5 live screenshots must be replaced (they show £4.99, the withdrawn 30-day guarantee, a sandbox dialog and a TestFlight bar). Only frame 01 has been generated. The iOS section of `STORE_LISTING_COPY.md` still claims landline. | **BLOCKED** (assets) + **NEEDS BUSINESS DECISION** (copy approval) |
| Store metadata: Play | The live set is untracked `marketing/play-store/final/01-08`; frames 02/04/06/07/08 show the old navy UI | **NEEDS BUSINESS DECISION** (refresh now or after launch) |
| Terms | `public/terms.html` (25 Aug) hard-codes £4.99 and has a vague price-change clause. The draft `TERMS_BILLING_DRAFT_2026-10-01.md` has `[PRICE]`/`[NOTICE PERIOD]` placeholders and §3.5/§9 pending. | **NEEDS BUSINESS DECISION** + **EXTERNAL WAIT** (legal review) |
| Website copy | The homepage says "in development"; 12 guides say "coming soon"; website launch branch `44e2d55` is not deployed | **NEEDS BUSINESS DECISION** |
| Environment configuration | About 110 new environment variables. **Must be set explicitly:** `TRUST_PROXY_HOPS` (unset turns per-IP auth rate limits off); `ABUSE_AUDIT_HASH_SECRET` and `SAFETY_CALLER_KEY_SECRET` (unset falls back to the **hard-coded** secrets `'hcg-abuse-audit'`/`'hcg-caller-key'`, i.e. it fails open); `HCG_ECONOMICS_PRICE_INC_VAT_GBP`; `TWILIO_WEBHOOK_ALLOWED_HOSTS`; `Resend_API_Key` (alerts are silent without it). **Must stay unset or off:** `TWILIO_WEBHOOK_AUTH_MODE`, `FC_DEGRADED_MODE`, `FC_ALLOW_BOUNDED_DEGRADED_MODE`, `ENABLE_NUMBER_LIFECYCLE_SWEEP_SCHEDULE`, `ALLOWANCE_TOPUPS_ENABLED`. **Gap:** none of the new variables is in `REQUIRED_IN_PRODUCTION`. | **NEEDS STAGING PROOF**. Recommended code follow-up: make the two hash secrets and `TRUST_PROXY_HOPS` required in production (not done here; this branch is audit-only). |
| Version / build numbers | `version` 1.0.2 (`mobile/app.config.js:17`); EAS `appVersionSource: remote` with autoIncrement; Android next is ≥ 22; iOS next is Build 15 | **READY** |
| Voice SDK / call delivery | `@twilio/voice-react-native-sdk` 2.0.0-preview.2 is unchanged across Build 14, Build 19 and the candidate; the Android `VISIBILITY_PUBLIC` patch is present; push config is unchanged | **NEEDS STAGING PROOF** (on device) |
| Android lock screen | `USE_FULL_SCREEN_INTENT` is blocked; the lock-screen banner collapses after about 5–6 s; this has never been accepted | **NEEDS BUSINESS DECISION** (accept for soft launch or fix) |
| Handset testing | Motorola Phase A is done (staging APK verified, unsigned `/voice` returns 403, restored). Phases B–E are not run. **No 1.0.2 build has ever been on a device.** No iPhone test exists. | **NEEDS STAGING PROOF** |
| Monitoring / alerts | Resend email to support@ (deduplicated in memory for 30 min); a read-only admin Fortress overview; delivery health. **No Sentry.** `/webhooks/provider-usage-alert` records the event but **sends no email**. Twilio usage triggers are not created (`scripts/provider-usage-triggers.js` not run). | **NEEDS STAGING PROOF** + **NEEDS BUSINESS DECISION** (create triggers; add an email on the usage alert) |
| Customer lifecycle | Signup → checkout → number → forwarding → cancel → number quarantine → deletion (029). Lifecycle sweep is opt-in and environment-guarded. | **NEEDS STAGING PROOF** (§6 step 15) |
| Backend rollback | Redeploy `eb43368` on Railway. That's safe only while the migrations are additive and the old code ignores new tables (true for 047–066 and 069). **Not** true for 070 (it replaces `process_stripe_webhook_event`): roll back 070 before or with the code. | **NEEDS STAGING PROOF** (§6 step 16) |

## 6. Staging sequence (exact order: PLAN, not executed)

**Rules for every step:**
- Record the date, operator, SHA, request and response, DB rows before and after, and Twilio SIDs.
- Stop and restore if any rollback condition in the staging validation plan §1 occurs.
- Staging uses the **production Twilio account**: never touch a production number. Test numbers only.

| # | Step | Detail | Pass criterion | Status |
|---|---|---|---|---|
| 0 | Decisions | B-1…B-9 in §8 recorded, at least the staging placeholders | written decision | **NEEDS BUSINESS DECISION** |
| 1 | **Backup** | Supabase staging PITR point or `pg_dump` of `public` + `auth.users`; **test the restore** into a scratch DB | restore produces the same row counts | **NEEDS STAGING PROOF** |
| 2 | **Migrations** | `supabase migration repair --status applied 052`, then 053 → 054 → 055 → 056 → 062 → 063 → 064 → 065 → 066 → 067 → 068 → 069 → 070 (`--include-all` or per file with history rows). After each: `scripts/verify-table-grants.js`; after 067: `select public.fc_check_invariants();` | every file applies; invariants ok; `schema_migrations` matches | **NEEDS STAGING PROOF** |
| 3 | **Configuration** | Staging-only Railway service. Set `NODE_ENV=production` so the guards behave as in production (or `staging` per guard design; decide B-10), `APP_ENV=staging`, the environment variables in §5 including both hash secrets and `TRUST_PROXY_HOPS`, `FC_REQUIRE_SIGNED_VOICE=true`, `HCG_ECONOMICS_PRICE_INC_VAT_GBP`, and small staging budget profiles via `fc_set_budget_profile` | boot log shows no commercial-config errors and a non-production environment guard | **NEEDS STAGING PROOF** |
| 4 | **Backend candidate** | Deploy `2011ab6` (or the re-pinned SHA) to the staging service; health check; unsigned POST `/voice` → 403 | 200 health; 403 unsigned | **NEEDS STAGING PROOF** |
| 5 | **Payment sandbox** | Stripe **test mode**: subscribe, renew, cancel, duplicate event, refund, complimentary → Stripe. RevenueCat **sandbox** purchase from the 1.0.2 iOS TestFlight build: entitlement `revenuecat_environment='sandbox'`, **no number**, `fc_resolve_profile`=`sandbox`; replayed and out-of-order events | staging validation plan §9 | **NEEDS STAGING PROOF** |
| 6 | **Number provisioning** | Blocked by B6 for real purchases. Do the double-click, assign-failure, DB-unreadable and adoption paths with the guard in refuse mode, plus the existing …1883 assignment | one purchase at most; no production number touched | **BLOCKED** (B6) / partial **NEEDS STAGING PROOF** |
| 7 | **Signed call** | Real call to the …1883 test number: signed `/voice` → 200 + `<Dial timeLimit>`; replay → same TwiML, one `fc_reservations` row | §4 of the staging plan | **NEEDS STAGING PROOF** |
| 8 | **Trusted call** | Trusted contact …2700 → …1883: bypass, no stream, rings the app | delivered and answered on the handset | **NEEDS STAGING PROOF** |
| 9 | **Monitored call** | Unknown caller: announcement, stream, transcription, warning and red-line phrases; caller hangs up during the announcement (056 slot freed) | heard by ear; DB rows; slot freed | **NEEDS STAGING PROOF** |
| 10 | **Allowance exhaustion** | `fc_admin_adjust` negative on the test household mid-call; then a new unknown call; then a trusted call (reserve) | call ends at lease end; unknown refused; trusted delivered within the reserve; app 1.0.2 shows an honest state | **NEEDS STAGING PROOF** |
| 11 | **Household hold** | Admin route hold during a live call; then trusted, unknown, SMS and number-purchase attempts; release; audit rows including a refused automatic release | staging plan §13.1 | **NEEDS STAGING PROOF** |
| 12 | **Global breaker** | Lower the hourly floor, then a storm of short calls → latch; restore the floor → still refused; admin reset → resumes; audit row. Plus the kill switch: live calls end within one lease | staging plan §6.2–6.3, §13.2 | **NEEDS STAGING PROOF** |
| 13 | **Handset tests** | Android: new 1.0.2 staging APK (not vc 21) on the Motorola, Phases B–E (`~/hcg-staging-handset-test/README.md`). iOS: 1.0.2 TestFlight build pointed at staging on an iPhone. Cover delivery, answer, lock screen, sign-out (old household stops ringing), the microphone banner, giffgaff/Three copy, the premium-contact 400, and screened-call quality versus trusted (B7) | screen recordings + Twilio logs | **NEEDS STAGING PROOF** (needs builds) |
| 14 | Premium contacts | Try adding 09/087/070/076 contacts from web and app | refused server-side | **NEEDS STAGING PROOF** |
| 15 | **Customer lifecycle** | New staging signup → terms → checkout (test mode) → number → forwarding verification → trusted contacts → cancel → entitlement end → quarantine (no release while entitled; 047) → account deletion (029 deletes contacts and calls); account number never reissued | each transition evidenced | **NEEDS STAGING PROOF** |
| 16 | **Rollback test** | Kill switch on → redeploy the previous staging build → reverse rollbacks 070 → 053 on a **restored copy** (or restore the step 1 snapshot) → verify `schema_migrations` → re-apply forward | rollback and re-apply clean; app still works on the old build | **NEEDS STAGING PROOF** |
| 17 | Gate re-run | Record M-01…M-17 evidence in `docs/launch-gate/`; re-run `run.mjs --enforce` | registry promoted only on real evidence | **NEEDS STAGING PROOF** |

## 7. Production sequence (after staging passes: for approval, not executed)

1. LEVEL 4 evidence complete (B1), the fallback `<Reject>` set (B2), and usage triggers created.
2. Production backup: PITR point and `pg_dump`; note the restore point.
3. Migrations in the approved order (B4). Default recommendation (b): 057–061 first (already staging-proven), then 047, 051–056, 062–070 with `--include-all`. Check `fc_check_invariants()` and the grants.
4. Set the production environment variables (§5 list) **before** the deploy. Set the Fortress budget profiles to the decided values.
5. Deploy `2011ab6` (or the re-pinned SHA), keeping `eb43368` as the rollback target. Watch the first signed call: if it is rejected, roll back immediately (R7).
6. Run a soft-launch smoke test on Andrew's own production household (Motorola …6063): trusted call and unknown call.
7. Keep a **single Railway instance** (R6), and keep `ALLOWANCE_TOPUPS_ENABLED` off.
8. Mobile (§9): Android AAB to **Internal → Closed testing** for invited users; iOS 1.0.2 to App Review after TestFlight. Hold a phased release until the backend is stable.
9. Soft-launch cohort: invite-only. Watch daily spend against the Fortress overview, and watch alerts.

## 8. Decisions needed from Andrew (none taken here)

| # | Decision | Recommendation |
|---|---|---|
| B-1 | D1 £ budgets, reserve, essential (placeholders £0.50/£0.25/£0.10) and the included-minutes copy | Small staging placeholders now; production values before step 7.4 |
| B-2 | Launch price: £4.99 or £5.99 | Set `HCG_ECONOMICS_PRICE_INC_VAT_GBP` to whatever is decided. If £5.99: new Stripe Price, an App Store price change, terms notice. |
| B-3 | Automatic-hold threshold (£5 per 24 h default) and whether holds block essential callers | Keep the defaults for staging |
| B-4 | Production apply order 057–061 (a/b/c) | (b) |
| B-5 | LEVEL 4 residual exposure acceptance; send the Twilio questions | Send the questions now; they can run in parallel with staging |
| B-6 | Staging Twilio sub-account (unblocks B6) | Yes |
| B-7 | Soft launch with an estimate-only cost model (no actual feed) | Acceptable only with a small cohort and daily manual Twilio usage review |
| B-8 | Android Play Production: Play Billing via RevenueCat versus staying on testing tracks | Soft launch on Closed testing; build Play Billing before Production |
| B-9 | Include the allowance meter in 1.0.2 | Include (inert while the flags are off) |
| B-10 | Staging `NODE_ENV` value | `production` with `APP_ENV=staging` (the environment guard is driven by `APP_URL` and the Supabase ref) |
| B-11 | Android lock-screen banner collapse (full-screen intent) | Accept for a closed soft launch, with it recorded; fix before Play Production |
| B-12 | Include transcription-no-overlap (`8d5e439`) | Evaluate. It is a cost fix and isn't in the candidate. |
| B-13 | Confirm the Play Production track state in Play Console | Andrew to check |
| B-14 | Store copy, screenshots and terms approval | Approve the 1.0.2 listing draft; commission the remaining frames |

## 9. Store-release checklist (DO NOT SUBMIT: for use after approval)

### Android (Play)

- [ ] Staging handset tests (§6 step 13) passed on a 1.0.2 build from the RC commit
- [ ] EAS `production` environment variables verified against the production backend and Supabase (`psbzynxplxfbyrbdidmn`)
- [ ] `eas build -p android --profile production` from the RC commit; record the versionCode (≥ 22), the EAS build ID and the AAB SHA-256; signing matches 8/9/10/19
- [ ] Production AAB smoke test on the Motorola (production account)
- [ ] `USE_FULL_SCREEN_INTENT` still blocked (Play policy); B-11 recorded
- [ ] Data safety form unchanged or updated (microphone, contacts, call logs, account number)
- [ ] Release notes written; listing screenshots decided (B-14)
- [ ] Track: Internal → Closed testing. **Production only after Play Billing (B-8).**
- [ ] `eas submit` (currently track `internal`, `releaseStatus: completed`): **Andrew runs or approves explicitly**

### iOS (App Store)

- [ ] 1.0.2 Build 15 from the RC commit; TestFlight on an iPhone with production backend variables
- [ ] RevenueCat **sandbox** purchase checked as unfunded (no number); production entitlement flow understood for review
- [ ] App Review notes for 1.0.2 (`IOS_102_STORE_LISTING_2026-10-01.md` §139-141) and a demo account that does **not** rely on a sandbox purchase producing a number
- [ ] All 5 screenshots replaced (6.5" and 6.9"); no £ price, no guarantee, no TestFlight bar
- [ ] Description per the 1.0.2 draft; remove the landline claim from `STORE_LISTING_COPY.md` iOS section
- [ ] IAP price matches B-2; the subscription group and display name are checked
- [ ] Privacy nutrition label checked (microphone, contacts)
- [ ] Phased release on; **submit only on Andrew's explicit instruction**

### Shared

- [ ] The backend candidate is in production **before** the apps are released
- [ ] Website, terms and guides consistent with the price and the availability wording
- [ ] Support inbox monitored; Resend alerts verified
- [ ] Rollback: previous Railway deploy pinned; app releases can be halted (Play halt rollout, App Store pause phased release)

## 10. Rollback summary

| Layer | Mechanism | Limits |
|---|---|---|
| Backend | Railway redeploy `eb43368` | Roll back 070 first or with it; Fortress tables stay inert under the old code |
| Database | `_rollbacks/` reverse order 070 → 047 | 067 only with the kill switch on and no live calls; 063 never after a real top-up (export first); 062 never after an account number has been shown |
| Android | Halt the Play rollout; testers can reinstall the previous track build | A versionCode can't go down; a fix needs a new build |
| iOS | Pause the phased release; remove from sale in an emergency | Can't revert to Build 14 for users who already updated |
| Provider | Kill switch (Fortress), Twilio fallback `<Reject>`, Console suspension | Level 4 unproven (B1) |
