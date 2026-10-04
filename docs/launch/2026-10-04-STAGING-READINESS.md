# Staging readiness (2026-10-04)

Candidate: `integration/soft-launch-candidate-2026-10-04`. Read with `../integration/2026-10-04-SOFT-LAUNCH-CANDIDATE-FINAL.md`, `../integration/2026-10-03-STAGING_VALIDATION_PLAN.md`, `../release/2026-10-04-SOFT_LAUNCH_READINESS.md` §6 and `../security/STAGING_HANDSET_TEST_PLAN_MOTOROLA.md`.

**What was done for this document:**
- **Read-only** staging probes: `select … limit 0` against the staging Supabase project (no rows read).
- The launch-config validator, run against the existing staging configuration and against the template.
- **Prepared, not executed:** the staging scripts in `scripts/staging/`.

Nothing was deployed or applied. No Twilio, Stripe, RevenueCat, store or customer change was made.

Classification key: **READY** · **NEEDS CONFIGURATION** · **NEEDS ANDREW APPROVAL** · **EXTERNAL BLOCKER** · **NOT REQUIRED FOR STAGING**

## 1. What exists today

Staging is **not a hosted service**. It is a local staging server (port 3099), exposed through the reserved ngrok domain `ferret-augmented-distrust.ngrok-free.dev`, against the **staging Supabase project** `tigwgmayeuisrxjjykqd`. That is how the 2026-10-01 real-call run and the 2026-10-03 Motorola Phase A run worked. Both runs were stopped and restored afterwards.

| Item | What exists | Status |
|---|---|---|
| Staging Supabase project | `tigwgmayeuisrxjjykqd`. Credentials in the primary checkout's `.env.staging.local` (staging only). | READY |
| Staging migration state | **Applied 2026-10-04 (§7):** 052 → 072 on staging, 68 history rows, verifier 17/17, grants verifier passed, `fc_check_invariants` ok. | **READY** |
| Staging backend host | Local server + ngrok (reserved domain); no Railway staging service | NEEDS CONFIGURATION (a start-up per test window; `scripts/staging/start-staging-server.sh`) |
| Staging URL | `https://ferret-augmented-distrust.ngrok-free.dev`. The existing `.env.staging.local` has `APP_URL=http://192.168.1.237:3099` (http, LAN) and `NODE_ENV=development`, which the validator rejects for staging. | NEEDS CONFIGURATION |
| Staging environment file | `.env.staging` (used on 2026-10-01 and 03) **no longer exists**. Only `.env.staging.local` (6 values) remains. The template is `scripts/staging/staging.env.template`. | NEEDS CONFIGURATION |
| Twilio for staging | **The production Twilio account is shared** (no subaccount). Staging can be made unable to buy, release or modify numbers: `NUMBER_PROVISIONING_MODE=fake`; the provider-mutation guard refuses non-production on the production account. | READY with conditions (§4); subaccount = EXTERNAL / B-6 |
| Staging phone number | **`…1883`** (production account, no household in production; staging household `ffc4cfe1`). Its Voice URL is **empty** between tests. It was pointed at staging during tests and reset afterwards. Last call 2026-10-01. | READY. Pointing it at staging is a Twilio change: NEEDS ANDREW APPROVAL each window |
| Test handset | Motorola (Andrew's production account `…6063` lives on it). Phase A done 2026-10-03; Phases B–E paused (`~/hcg-staging-handset-test/README.md`, outside the repo). Trusted test caller `…2700`. | NEEDS ANDREW APPROVAL (Andrew operates the handset) |
| Android staging build | EAS `28111eb5…`, 1.0.1 vc 21 from `a1fcede` (Build 19 source) with staging URLs pinned. **The artifact expires 2026-10-16.** **It does not contain this candidate's mobile changes** (Account-tab fix, allowance meter, readiness/sign-out). | **Owned by the separate Mobile 1.0.2 workstream** (not built here). Staging needs a 1.0.2 **staging-pinned** APK from it before the handset window |
| iOS / TestFlight | Live 1.0.1 = Build 14. No 1.0.2 build exists. TestFlight builds point at **production**; a sandbox purchase there reaches the **production** RevenueCat webhook. Production has no environment guard, so it **buys a real number** (the 28 Sep case). | EXTERNAL BLOCKER for iOS purchase tests until the candidate is in production, **or** a staging-pinned iOS build exists |
| OpenAI | No staging key in the staging configuration. Spend inside HCG is bounded by Fortress monitoring caps (30-minute per-call cap, household and global £ caps). An OpenAI **project** spend limit is external. | NEEDS CONFIGURATION (key) + EXTERNAL (project limit, recommended) |
| Stripe test mode | Test keys exist (production `.env` holds `STRIPE_TEST_*`). There is **no test-mode webhook endpoint pointing at staging** and no staging `STRIPE_WEBHOOK_SECRET`. | NEEDS CONFIGURATION (Stripe Dashboard, test mode: add the endpoint; Andrew) |
| RevenueCat / store test | No RevenueCat credential. RevenueCat's webhook points at production. | NOT REQUIRED for Android staging. For iOS: EXTERNAL (see iOS row) |
| Webhook signatures | Twilio signature enforcement is the default (`TWILIO_WEBHOOK_AUTH_MODE` unset); admission requires signature. Proven on staging on 2026-10-01 (unsigned `/voice` → 403). | READY |
| Required secrets / config | The validator against the current `.env.staging.local`: **9 fatal** (APP_URL https; ABUSE_AUDIT_HASH_SECRET; SAFETY_CALLER_KEY_SECRET; TRUST_PROXY_HOPS; Stripe ×3; RevenueCat auth; Twilio core; Voice SDK; OpenAI). Against the filled template (dummy values): **would START**, with 2 expected warnings. | NEEDS CONFIGURATION |
| TRUST_PROXY_HOPS | Not set. ngrok is one hop, so the template sets `1`. Verify that `req.ip` is the caller during step 4. | NEEDS CONFIGURATION |
| Financial containment (067) | **Applied on staging.** Kill switch off, breaker closed, 6 seeded profiles; policy = register defaults. Small staging budget profiles (`fc_set_budget_profile`, for example £0.30 per household per period) are still to set before the first call window. | READY (schema); NEEDS CONFIGURATION (staging budgets) |
| Global kill switch / latching breaker | In 067 (`fc_set_kill_switch`, `fc_reset_breaker`), plus the admin routes in `routes/adminFortress.js` | READY in code; needs 067 |
| Per-household holds | 067 `fc_set_household_hold` + admin route | READY in code; needs 067 |
| Signed call delivery | `<Dial timeLimit>` from the Fortress reservation; egress guard; `<Reject/>` on errors | READY in code; needs 067 + a signed real call |
| App staging configuration | The staging APK pins the staging API and Supabase; the EAS `staging` profile is **uncommitted** in `/Users/ad/call-ai-staging-handset` | NEEDS ANDREW APPROVAL (commit the profile or keep it local; release doc B-10/low) |
| Alerts in staging | Critical alerts go to the hard-coded support inbox. **Now labelled `[HCG ALERT STAGING]`** (this change). Recommended: leave `Resend_API_Key` unset in staging. | READY |
| Operational events (072) | **Applied on staging**; 0 events; delivery OFF | READY |
| Accounting (071) | **Applied on staging** (inert: capture OFF, 0 transactions). Applied now because `db push` applies in order and 072 follows it; the full apply and rollback chain was rehearsed. | READY (capture stays OFF until gate item G20) |
| Production isolation of the staging process | `start-staging-server.sh` refuses if a `.env` is present in the working directory. The primary checkout's `.env` is **production**, and `server.js`'s dotenv would fill any missing staging value from it. Run only from the candidate worktree. | READY (script) |

## 2. Staging migration plan

**Rule:** staging rehearses the **exact production order**, so staging applies every migration production will get. "Required" below says why the candidate needs each one; nothing is applied because it merely exists.

| # | Purpose | Depends on | Staging state | Staging needs it? | Rollback / recovery |
|---|---|---|---|---|---|
| 052 | number-lifecycle sweep evidence | 047 | objects present, **history row missing** | yes. **Repair the history row only**: `supabase migration repair --status applied 052` | none needed |
| 053 | `entitlements.revenuecat_environment` | 011 | absent | **YES.** The commercial classifier, the number-purchase provenance guard and "sandbox can't buy a number" all depend on it. | additive column; rollback drops it |
| 054 | sweep run evidence | 052 | absent | yes (production order; the sweep is off) | additive |
| 055 | call delivery evidence (`calls.dial_call_sid` …) | 044 | absent | **YES** (delivery evidence in `/call-delivery-failed`) | additive |
| 056 | financial safety: allowance + admission (Layer B) | 051 | absent | **YES.** 063, 067 and the SMS ceiling build on it | additive; rollback file exists |
| 062 | permanent HCG account numbers + routing assignments | 046 | absent | **YES** (account numbers in events and the runbook) | **irreversible once an account number has been shown to anyone.** On staging that's acceptable, but don't show staging numbers to customers |
| 063 | allowance credits + notices | 056 | absent | yes (068 needs it) | **irreversible after a real top-up** (none on staging) |
| 064 | call delivery events | 046 | absent | yes | additive |
| 065 | iPhone carrier capture | 040 | function-only: verify | yes | function replace |
| 066 | abuse shared state + **number purchase claim** | — | absent | **YES.** The backend **holds purchases without it** (fail closed) | additive |
| 067 | **Financial Fortress** ledger, breaker, holds, kill switch | 011 | absent | **YES** (core) | rollback **only with the kill switch on**; rehearse in staging step 16 |
| 068 | allowance ↔ Fortress credit bridge | 063, 067 | absent | yes | replaces `credit_allowance` |
| 069 | account classification history | 040s | absent | yes (classification audit) | replaces a constraint |
| 070 | canonical Stripe entitlement decision (replaces `process_stripe_webhook_event`) | 027 | function-only: verify | **YES** (F-03 path, canonical entitlement) | **must be rolled back together with the code** if the old backend returns |
| 071 | accounting sub-ledger | 011 | absent | not for the first pass; **yes** before the accounting-isolation gate item | rollback refuses if anything was posted to Xero (nothing will be) |
| 072 | operational events + notifications | 002 | absent | **YES** for the alert gate items | rollback refuses while event history exists |

**Exact sequence (staging only; `scripts/staging/apply-staging-migrations.sh`; EXECUTED 2026-10-04, see §7):**

0. **Andrew approval + backup.** Take a staging PITR point or `pg_dump` of `public` + `auth.users`, and **test the restore** into a scratch database.
1. `supabase link --project-ref tigwgmayeuisrxjjykqd` (prompts for the staging DB password).
2. `scripts/staging/apply-staging-migrations.sh`. This is a **dry run**: it lists pending migrations.
3. `APPLY=yes CONFIRM_STAGING_REF=tigwgmayeuisrxjjykqd BACKUP_RESTORE_TESTED=yes scripts/staging/apply-staging-migrations.sh`. It pushes 052 → 072 in number order (`--include-all`). 052 is applied normally rather than history-repaired: the rehearsal proved it re-runs cleanly over its existing objects.
4. `node scripts/staging/verify-staging-schema.js`: all marker objects present. In the SQL editor, run `select public.fc_check_invariants();` and the grants check.
5. Set small staging budget profiles (`fc_set_budget_profile`) and confirm `fc_global_status`.

The script refuses if the CLI is linked to production (`psbzynxplxfbyrbdidmn`) or to anything other than staging.

## 3. Configuration safety: can staging accidentally…

| Risk | Answer | Mechanism / evidence |
|---|---|---|
| provision production customer resources | **No** | `NUMBER_PROVISIONING_MODE=fake` (enforced by the start script) means no provider purchase. Non-production on the production account is refused by `decideNumberPurchase` even in `auto`/`live`. The provenance guard applies on top. |
| charge a real customer / create a real paid subscription | **No** | The validator refuses a live Stripe key in staging (`stripe_key_mode_staging`). The start script also requires `sk_test_`/`rk_test_`. |
| send production notifications | **No** | `OPS_NOTIFY_EMAIL_ENABLED` is off (start script). Critical alerts are labelled STAGING, or nothing is sent if `Resend_API_Key` is unset. |
| email genuine customers | **No** | HCG has no customer email path. Supabase Auth emails go only to staging users of the staging project. |
| affect production Supabase | **No**, if started via the script | The script refuses a non-staging `SUPABASE_URL` and refuses to start where a `.env` exists (the production `.env` could leak in through dotenv). The validator would also flag a **mixed** environment as production. |
| affect production Stripe | **No** | test mode only |
| affect production RevenueCat entitlements | **No from staging.** But **TestFlight purchases with production-pinned iOS builds hit production** (no environment guard there) | Staging Android uses Stripe test mode. iOS purchase testing must wait (see §1). |
| release or purchase production numbers | **No** | `decideTelephonyMutation` refuses non-production `.remove()`/`.update()` on the production account. Lifecycle jobs are off (`NUMBER_LIFECYCLE_JOBS=disabled`). |
| route production customer calls | **No** | Only `…1883` is ever pointed at staging. Production households' numbers point at production. Staging cannot `.update()` a number. |
| consume uncontrolled Twilio spend | **Bounded, not provider-capped.** | Inbound only (no outbound path exists; the egress guard rejects PSTN/SIP). Every call needs a Fortress reservation with a `timeLimit`; the kill switch is available. **Residual:** the staging process holds the **production master Twilio token**. A staging host compromise is a production-account compromise, so run staging only in **attended windows** and stop it afterwards. |
| consume uncontrolled OpenAI spend | **Bounded inside HCG** | Monitoring only on admitted calls; 30-minute per-call cap; household and global £ caps; 45 requests per minute per household. An OpenAI project limit is recommended (external). |

**One safety change made here:** alert emails are labelled by deployment (`[HCG ALERT STAGING]`), because staging runs with `NODE_ENV=production`. See `services/alerting.js` and `tests/alerting.test.mjs`.

## 4. Staging telephony with existing resources (no new subaccount)

**Verdict: it can be done safely within tight bounds, with Andrew operating the Twilio change and the handset in attended windows.**

```
test caller …2700 (Andrew) ─PSTN─► …1883 (prod Twilio acct; Voice URL → staging ONLY during the window)
    └► ngrok (reserved domain) ─► staging server (candidate HEAD, NUMBER_PROVISIONING_MODE=fake)
           ├─ Fortress (staging 067, small budget profile, kill switch) ─► <Dial timeLimit> <Client> staging household ffc4cfe1
           └─ Media Stream ─► Whisper (bounded) ─► SMS warning (Fortress + 056 explicit authorisation)
Motorola: 1.0.2 STAGING APK (new build from this candidate) logged in as the staging test user
```

**Window procedure** (extends the Motorola plan Phases B–E):
1. Andrew approves the window.
2. Start the staging server with the script.
3. Point `…1883` Voice URL at `https://<reserved ngrok>/voice` and read it back. **Twilio change: Andrew.**
4. Run the tests.
5. Reset `…1883` to an empty Voice URL and stop the server and ngrok.

**Bounds:**
- Inbound minutes are paid by HCG at about £0.0086/min (trusted) or £0.0172/min (monitored). For example, 20 test calls × 3 min ≈ **£1 or less**.
- No outbound path. Fortress staging budget per household of £0.30, plus a global hourly floor. The kill switch is tested in the window.

**Why not unattended:** the staging process carries the production master token, and `…1883` has no `<Reject>` fallback while the server is down. Calls to it would then be answered by Twilio with an application error, at a few pence each, until the Voice URL is reset.

**Do NOT** release or re-purpose `…1883`. It is the only staging number.

## 5. Price / allowance decision table (economics register v1.0.0, `scripts/hcg-unit-economics.js 4.99|5.99`)

Expected (billed) costs: **trusted £0.0086/min, monitored £0.0172/min**. The Fortress enforcement basis is 1.56× and 1.33× higher. Fixed allocation is £1.16 per customer per month (number + infrastructure). Target margin is 40%, with a 15% reserve and a £0.10 overrun.

| | **A. £4.99 incl VAT** | **B. £5.99 incl VAT** |
|---|---|---|
| Net of VAT | £4.16 | £4.99 |
| **Stripe (web/Android today)**: after fees and 2% leakage | £3.74 | £4.53 |
| — safe variable budget at 40% | **£0.68** | **£1.07** |
| — trusted-only / monitored-only / at 75% trusted (min/month) | 78 / 39 / 62 | 123 / 61 / 99 |
| **Apple or Google 15%**: after fees | £3.45 | £4.14 |
| — safe variable budget at 40% | **£0.43** | **£0.74** |
| — trusted-only / monitored-only / at 75% trusted | 50 / 25 / 40 | 85 / 42 / 68 |
| Apple standard 30% (not on the Small Business Program) | £0.00 budget (no usage affordable) | £0.10 (11 trusted min) |
| "Typical" household (150 trusted + 40 unknown min), margin Stripe / 15% store | **12% / 5%** ✗ | **26% / 18%** ✗ |
| "Light" household (60 + 15), margin Stripe / 15% store | 43% / 36% | 51% / 43% |
| Heavy family (400 + 80) | −57% / −64% | −32% / −40% |
| **Trusted calls stay on Twilio (today)** | 150 trusted minutes alone exceed the 40% budget on every channel | the same: 150 trusted minutes exceed it on every channel |
| **If trusted calls are routed upstream** (AQL/MVNO network-side; trusted cost about £0): typical margin Stripe / 15% | 49% / 42% | 56% / 49% |
| …and with free inbound plus self-hosted delivery (Magrathea-type; hypothetical) | 68% / 61% | 73% / 65% |

**What the table says:**
- **Neither price reaches 40% for a typical household while HCG pays for trusted calls on Twilio.** At £4.99 a typical household is close to break-even on store channels.
- £5.99 roughly doubles the safe budget on store channels (£0.43 → £0.74).
- Upstream routing of trusted calls is worth far more than the £1 price difference: it moves typical margins from 12–26% to about 49–56%.
- Every figure is ESTIMATED from register rates. **There is no real usage data yet.**

**DECIDED (Andrew, 2026-10-04): £5.99/month including VAT** is the launch price, including for the first five customers. It is no longer an open decision.

Consequences recorded here (nothing customer-facing has been changed):
- **Fortress budget profile (D1)** comes from the £5.99 columns: Stripe safe variable budget **£1.07** expected (≈ **£1.54** Fortress basis); 15% store **£0.74** (≈ £1.06 Fortress basis). The 067 seed (£0.50 / £0.25 / £0.10) is more conservative and stays until D1 is set.
- **Boot economics** already default to £5.99 (register `priceIncVatGbp`). Do **not** set `HCG_ECONOMICS_PRICE_INC_VAT_GBP` lower.
- **Live surfaces still say £4.99** (website, terms §4, 11 guides, the live iOS product, and the live Stripe price behind `STRIPE_PRICE_ID`). The £5.99 transition (new Stripe Price, App Store Connect / RevenueCat product price, store listings, terms notice, website copy) is **coordinated by the Mobile 1.0.2 / store workstream** and is **not** done here.
- For staging, the Stripe **test-mode** price should be £5.99, so staging matches the launch price.

## 6. Number cleanup recommendation (prepared, NOT executed)

10 numbers, ≈ £8.69/month. **Release nothing until ownership and classification are confirmed.** Every release goes through the existing manual quarantine confirmation.

| Number | Belongs to | Recommendation | Pre-condition |
|---|---|---|---|
| `…883` | staging test number | **KEEP** | — |
| `…288` | reviewer (`rev…@homecallguard.co.uk`) | KEEP while App Review needs it | — |
| `…653`, `…533` | internal test (`t-w…`, `p_d…`) | KEEP while staging and handset testing continue; review after soft launch | Andrew confirms they're in use |
| `…063` | Andrew (`ad_…`, complimentary to 7 Oct) | KEEP (Andrew's production household on the Motorola) | Extend its complimentary entitlement (it ends 7 Oct; Andrew's decision) |
| `…494` | `gar…@gmail.com` (complimentary to 7 Oct, active tester) | KEEP while testing; classify | Andrew confirms the tester |
| `…151` | `sim…` (ex-customer, refunded per Andrew) | **RELEASE** after it reaches quarantine (about 9 Oct) | Confirm the refund in Stripe; Twilio shows no calls since 9 Sep |
| `…513` | `sni…` (Apple test pattern) | **RELEASE** after quarantine (about 19 Oct) | RevenueCat shows "Sandbox"; classify as test |
| `…647` | `op2…` (Apple test pattern, entitlement ends 5 Oct) | **RELEASE** after it lapses and is quarantined (about 4 Nov), or earlier by admin decision | RevenueCat shows "Sandbox"; classify as test |
| `…510` | orphan, quarantined since 23 Sep (very probably Andrew's original number) | **RELEASE** (confirm the quarantine) | Andrew confirms his phone no longer forwards to it (last call 13 Sep) |

Savings if all four RELEASE rows go ahead: ≈ **£3.48/month**.

## 7. Evidence: staging database preparation (executed 2026-10-04)

Approved by Andrew: "staging backup and staging database preparation ONLY". Nothing else was changed.

| Step | Result |
|---|---|
| 1. Target identity | The Supabase CLI (logged in) lists `tigwgmayeuisrxjjykqd` = **home-call-guard-staging** and `psbzynxplxfbyrbdidmn` = **home-call-guard** (production). The **candidate worktree only** was linked to staging (`supabase/.temp` is git-ignored). **The primary checkout `/Users/ad/call-ai` is linked to PRODUCTION** and was never used for any database command. Every dump and push ran with the CLI login role `cli_login_postgres.tigwgmayeuisrxjjykqd` (tenant = staging ref). |
| 2. Backup | `pg_dump` 18.4 (Homebrew `libpq`, already installed; no Docker) through the CLI's own login role, into `/Users/ad/hcg-staging-backups/2026-10-04-pre-053-072/` (mode 700, outside the repo; contains staging test-user data). Files: `schema.sql` (public, 2,466 lines), `auth-schema.sql`, `data.sql` (public + auth data, 849 lines), `roles.sql`. SHA-256 prefixes: schema `c88ccb44a85df812…`, data `c466fd3c2e4fce08…`, roles `168a95a9c745af5e…`. The temporary credential scripts were deleted. |
| 3. Restore proof | The backup was restored into a **throwaway local PostgreSQL 18** (embedded, temp dir, localhost; Supabase roles, vault and realtime stubbed). **All 18 tables match live staging row counts** (30 households, 45 calls, 17 entitlements, 25 user roles, 26 contacts, 25 Stripe events, 12 subscriptions, 8 terms acceptances, 5 waiting-list rows, 1 classification, 31 auth users; the rest 0). |
| 3b. Rehearsal on the restored copy | **All 16 migrations 052 → 072 applied cleanly** on staging's real schema and data; `fc_check_invariants` ok; households preserved. **All 15 rollbacks 072 → 053 ran cleanly** (kill switch on before 067), and afterwards 18/18 tables still matched the backup. Rollback is viable. |
| 4. Verifier before | 4/17 marker objects; CLI history showed 052–056 and 062–072 not applied |
| 5. Plan shown | `supabase db push --linked --include-all --dry-run`: exactly 052, 053, 054, 055, 056, 062, 063, 064, 065, 066, 067, 068, 069, 070, 071, 072 |
| 6. Applied | `scripts/staging/apply-staging-migrations.sh` with explicit confirmations: **16 migrations applied to staging**, in order, no errors |
| 7. Verifier after | **17/17 marker objects present**; history **68 rows, nothing pending** (065 and 070 recorded) |
| 8. Database checks (read-only transaction, staging) | `scripts/verify-table-grants.js`: **all checks passed** (RLS on every public table; anon holds nothing; authenticated exactly on its allowlist; default ACLs closed). `fc_check_invariants` **ok**; kill switch **off**, breaker **closed**; 6 budget profiles; `fc_policy` = register (0.010718 / 0.008069 £ per min, uplift 1.10, max call 14,400 s, daily £15, hourly £4, 10 purchases per day). **Data preserved:** 30 households, 17 entitlements, 45 calls. **30/30 households have a permanent account number** (registry 30; 11 routing assignments). 0 ops events, 0 accounting transactions. 2 staging Apple grants are environment-unverified (pre-053, as designed). Key functions present (047, 065, 066, 067, 070 canonical body, 071, 072). |
| 9. Production untouched | A read-only production fingerprint was taken before and after (new-migration markers all absent; row counts for households 36, entitlements 38, subscriptions 15, calls 103, contacts 851, Stripe events 27, quarantine 2; latest `updated_at` on households and entitlements): **identical**. |

**Next staging step:** the configuration window (Andrew-provided secrets and approvals; §1 rows marked NEEDS CONFIGURATION):
- the staging environment file from `scripts/staging/staging.env.template`;
- the Stripe **test-mode** webhook endpoint pointing at the staging URL, with a £5.99 test price;
- small staging Fortress budget profiles;
- then `start-staging-server.sh` (health and unsigned-403 checks only, no calls).

The telephony window (pointing `…1883`, handset calls) follows, and needs the Mobile 1.0.2 staging APK.
