# Production deploy, migration, backup and rollback procedure: 2026-10-09

**Status: PROCEDURE ONLY. Nothing here has been executed. Every step marked 🔴 needs Andrew's explicit GO at the moment of execution.**

**Updated 2026-10-10 after the WS1–WS4 integration: the file set is now 047, 051–077 (28 files).** This supersedes `2026-10-05-PRODUCTION-DEPLOYMENT-RUNBOOK.md` for the **file set** and the **deploy mechanism**. That runbook's stop table and its rules for "never roll back X once Y" still apply and are repeated in §8.

## 0. Facts this procedure depends on

| Fact | Consequence |
|---|---|
| **Railway auto-deploys `main`.** Production `eb43368` = `origin/main` | **Merging to `main` IS the deploy.** Migrations must be applied *before* the merge, never after |
| The website, terms and guides are served by the same app | **The deploy publishes £5.99** in 20 places (`public/index.html`, `public/terms.html`, 14 guides). **Deploy GO = price-cutover GO.** They can't be separated without a code change. Sales are paused (§1) so no one can buy at a price that differs from the page |
| Checkout text in the candidate is read from the Stripe Price (`services/subscriptionPricing.js`). The offer is unavailable unless the Price is GBP, monthly and **tax-inclusive** | Until the new £5.99 Price is set, checkout shows "unavailable". That is fail-safe |
| Production schema = 000…046 (046 history repaired 2026-09-27) | Pending: **047, 051–077 = 28 files** in numeric order (076 continuity reserve + allowance state, 077 top-up revenue bound, both WS2). No `--include-all` is needed |
| Staging = 000…074 (074 applied 2026-10-06) | **075–077 must be applied to staging first** (step S0) |
| The candidate is backward-compatible: `eb43368` runs on the new schema (2026-10-05 runbook §0) | Backend rollback = redeploy `eb43368`. Migrations stay |
| The primary checkout `/Users/ad/call-ai` is **linked to production** | Never run any command there. Use a dedicated clean worktree (P2) |

## 1. Before the window (Andrew, console; also P0 containment)

1. 🔴 **Pause public sales now:**
   - Stripe: archive the live £4.99 Price and deactivate any Payment Links;
   - App Store Connect: remove the IAP from sale, if iOS is excluded from the cohort.
2. 🔴 Apply the "do now" items in `2026-10-09-PROVIDER-CONTAINMENT-CHECKLIST.md`:
   - OpenAI project hard limit;
   - Twilio auto-recharge off with a low balance;
   - SMS geo-permissions UK only;
   - voice geo-permissions off;
   - `<Reject/>` fallback URL on every number;
   - usage triggers.
3. Decisions recorded (see the report): the Fortress profile values (`2026-10-09-COST-LIMITS-RECOMMENDATION.md`), the cohort emails, the support phone number, and the Android payment route.

## 2. Staging first (S0–S3; Claude, after GO)

| # | Step | Pass |
|---|---|---|
| S0 🔴 | In a staging-linked worktree, `supabase db push --linked --dry-run`. Expect **exactly 075, 076, 077** | Only 075–077 listed |
| S1 🔴 | Push. Then `node scripts/verify-table-grants.js` and `node scripts/verify-security-definer-grants.js` (staging) | Both pass; `hcg_record_support_forwarding_proof` is `service_role`-only |
| S2 | Staging server at the pinned SHA. `check-launch-config` gives **START**, with `HCG_SUPPORT_VERIFICATION_CALLERS` set | START; the `support_verification_callers` warning is gone |
| S3 | Android handset plan (`2026-10-09-ANDROID-HANDSET-VERIFICATION-PLAN.md`), including H9, the support-verified proof on staging | All MUST rows PASS |

## 3. Preflight against production (read-only; Claude, after read-access GO)

| # | Command / check | Pass condition (anything else → STOP) |
|---|---|---|
| P1 | Pin the SHA. The full suite is green at that SHA (inert env, no Stripe key) | 0 failures, except the known symlink-only `expo prebuild` case |
| P2 | `git worktree add /Users/ad/call-ai-prod-deploy-<date> <SHA>` (path checked as free first); `supabase link --project-ref psbzynxplxfbyrbdidmn` **in that worktree only** | `supabase/.temp/project-ref` = `psbz…` |
| P3 | `node scripts/verify-migration-history.js --expect-project psbzynxplxfbyrbdidmn` | Remote = 000…046 exactly. Local-only = 047, 051–077 (28). No remote-only rows |
| P4 | Objects must not already exist: `to_regclass('public.fc_reservations')`, `to_regclass('public.forwarding_proof_audit')`, `households.account_number`, `households.forwarding_proven_at`, `entitlements.revenuecat_environment`, `entitlements.store_will_renew` | None present |
| P5 | Fingerprint: row counts and newest timestamps for households, entitlements, subscriptions, calls, contacts, `stripe_webhook_events` and `auth.users`. Saved to the backup directory | Saved |
| P6 | `supabase db push --linked --dry-run` | Exactly the 28 files, in order. No `--include-all` prompt |
| P7 | The production env is prepared in Railway (§5) but **not yet deployed**. Run `node scripts/check-launch-config.js` locally against a copy with the production values | **START**, 0 fatal |

## 4. Backup and restore proof (🔴 Andrew GO; Claude executes)

Same mechanism as the staging rehearsal, which passed on 2026-10-04 (`2026-10-04-STAGING-READINESS.md` §7).

1. **PITR mark:** Supabase dashboard → Database → Backups. Record the UTC time and confirm PITR is enabled on the plan. If PITR is not available, the logical dump below is the **only** restore point. Say so before continuing.
2. **Logical dump** with `pg_dump` 18.x (Homebrew `libpq`) through the CLI login role (`cli_login_postgres.psbzynxplxfbyrbdidmn`):
   - destination `/Users/ad/hcg-prod-backups/<date>-pre-047-077/` (mode 700, outside the repo);
   - files: `roles.sql`, `schema.sql` (public), `auth-schema.sql`, `data.sql` (public + auth);
   - record the SHA-256 of each;
   - **one CLI call at a time**, because each `supabase` call rotates the login password;
   - delete any temporary credential file afterwards.
3. **Restore proof** (about 20 min) into a throwaway local PostgreSQL 18, with the Supabase roles, vault and realtime stubbed:
   - every table's row count matches P5;
   - apply **047 → 077** in order; `select public.fc_check_invariants()` returns ok;
   - run the rollbacks **077 → 047** in reverse (kill switch on before 067), then confirm the counts match again;
   - **any failure → STOP.** Production is untouched at this point.

## 5. Production environment (set in Railway before the merge; 🔴)

Required by `check-launch-config`:
- `HCG_DEPLOYMENT=production`
- `TRUST_PROXY_HOPS` (1–3, matching Railway)
- `ABUSE_AUDIT_HASH_SECRET`, plus `SAFETY_CALLER_KEY_SECRET` (at least 32 characters, and different from the audit secret)
- live Stripe keys (`sk_live_…`) and the live webhook secret
- `REVENUECAT_WEBHOOK_AUTHORIZATION` (at least 16 characters)
- Twilio SID, token and Voice SDK keys
- `TWILIO_VOICE_PUSH_CREDENTIAL_SID_IOS`
- `OPENAI_API_KEY`
- the ops email setting
- `NUMBER_PROVISIONING_MODE` not `fake`
- `FC_DEGRADED_MODE` not `bounded`
- `PROCESS_ROUTE_ENABLED` unset (off)
- `TWILIO_WEBHOOK_AUTH_MODE` not `report`

Set explicitly for the cohort:

| Variable | Value |
|---|---|
| `NEW_SUBSCRIPTIONS_ALLOWLIST` | the invited emails (comma separated) |
| `NEW_SUBSCRIPTIONS_PAUSED` | `false` only after step D9. **Keep `true` at the merge** |
| `ALLOWANCE_SOURCE` | `fortress` |
| `HCG_SUPPORT_VERIFICATION_CALLERS` | `+44…` (the support phone) |
| `HCG_SUPPORT_VERIFICATION_MAX_AGE_MINUTES` | `60` |
| `TWILIO_VOICE_FALLBACK_URL` | the `<Reject/>` URL |
| `PROVIDER_USAGE_ALERT_TRIP_TRIGGER_SIDS` | the Twilio trigger SIDs |
| `OPS_EVENTS_SCHEDULE_ENABLED` | `true` |
| `HCG_ECONOMICS_PRICE_INC_VAT_GBP` | `5.99` |
| `FINANCE_STRIPE_LIVE_PRICES` | JSON map of live Price ids → price, e.g. `{"price_…599":5.99,"price_…499":4.99}` (WS2 profitability; without it Stripe revenue shows as not counted, never guessed) |

Keep **off**:
- `ALLOWANCE_TOPUPS_ENABLED`
- accounting capture
- Xero posting
- the lifecycle sweep
- `HCG_CONFIG_ACKNOWLEDGE` (never used to silence a fatal rule)

Keep a **single instance**.

## 6. The window (one sitting, about 90 minutes; every row 🔴)

| # | Step | Pass / stop |
|---|---|---|
| D1 | Final P3 + P6 re-run (nothing changed since preflight) | Same output |
| D2 | `supabase db push --linked` (no `--include-all`). **Stop at the first error** (§8) | 28 applied |
| D3 | `verify-migration-history.js` → full MATCH 000…077. Run `verify-table-grants.js` and `verify-security-definer-grants.js` | All pass |
| D4 | Verification SQL (read-only): `fc_check_invariants()` ok; `fc_global_status(now())` = kill switch off, breaker closed, policy = enforce; `households where account_number is null` (not deleted) = 0; fingerprint unchanged | All |
| D5 | **Fortress production profile and policy**: the exact `fc_set_policy` / profile statements from `2026-10-09-COST-LIMITS-RECOMMENDATION.md`, run through the audited functions. Read back. **The £25 `global_daily_absolute_max_gbp` is safe only up to about 25 entitled households.** WS2's simulation shows a self-inflicted latching outage beyond that. Raise it per stage to about 0.60 × N (WS2 report D-4) **before** the cohort passes about 20 | Values match the approved doc |
| D6 | **Deploy = merge.** Open the PR candidate → `main` (CI green). Andrew approves the merge. Railway auto-deploys | Deployment SHA = pinned SHA |
| D7 | Within 5 minutes (no calls): `/health` 200; unsigned `POST /voice` → 403; unsigned `POST /process` → 403/404; a WebSocket to `/media-stream` with no token is closed with no OpenAI request (log); the `check-launch-config START` line is in the logs | All. **Any failure → §8 R1** |
| D8 | **Kill switch drill** (admin → Fortress): ON → `fc_global_status` shows on; a signed test call is refused busy → OFF. Uses Andrew's own production number `…6063`. **Live call: needs its own GO** | Refused while on; normal after off |
| D9 | **First signed production calls** to `…6063`: one trusted call (rings, connects; one reservation, released); one unknown call (announced and monitored; reservation released) | Both. **Not delivered → §8 R1** |
| D10 | **Price cutover:** `2026-10-05-PRICE-CUTOVER-CHECKLIST.md` B1–B4 + B9 (new £5.99 tax-inclusive GBP monthly Price; `STRIPE_PRICE_ID`; Stripe Tax UK registration verified; receipts on; Portal at period end). Then `NEW_SUBSCRIPTIONS_PAUSED=false` | `/billing/offer` = £5.99 incl. VAT. An uninvited account's checkout is refused |
| D11 | First invited customer: charge shows VAT £1.00. Ops event `NEW_GENUINE_CUSTOMER` raised | — |
| D12 | Watch for 30 minutes: errors, Fortress overview, Twilio usage, OpenAI usage | Clean |

## 7. After the window

- Relink the deploy worktree to **staging** (resting state).
- Record the dated evidence (SHA, operator, artefacts) in `2026-10-04-FIVE-CUSTOMER-SOFT-LAUNCH-GATE.md` C1–C4 and C12.

## 8. Stop conditions and rollback

| Situation | Action |
|---|---|
| **R1. Backend misbehaves after the merge** (D7/D9 fail, errors, calls not delivered) | Railway → Deployments → **Redeploy `eb43368`**, then revert the merge commit on `main` so the next push can't redeploy the candidate. Keep `NEW_SUBSCRIPTIONS_PAUSED=true`. `eb43368` is compatible with the new schema. **The P0 exposure returns while `eb43368` runs**: keep the provider hard limits on |
| **R2. Migration error mid-push** | The push stops at the failing file; earlier files stay applied. **Do not run rollbacks under pressure.** The old backend keeps running (compatible). Fix forward, or roll back only files with **no** customer data, strictly in reverse order, per their headers |
| **Never roll back** | 062 once an account number has been shown; 063 after a real top-up; 067 while calls are live; 074/075 while any proof is recorded; 076 once any continuity reserve has been spent; 077 after a real top-up (the rollbacks refuse) |
| **Spend anomaly** | Admin → kill switch ON (audited), then `NEW_SUBSCRIPTIONS_PAUSED=true`. Then investigate (`2026-10-05-CONTROLLED-LAUNCH-RUNBOOK.md` §4) |
| **Data damage** | Restore from PITR (§4.1), or from the logical dump into a new project. Last resort: it loses everything after that point |

## 9. What the deploy does NOT change

- Mobile apps: the Android cohort build and iOS are separate releases.
- Twilio number configuration: the fallback URL is a console step in §1.
- Existing subscribers' price: D-P2 recommends they keep £4.99. The Stripe subscriptions stay on the old Price, which archiving does not cancel.
