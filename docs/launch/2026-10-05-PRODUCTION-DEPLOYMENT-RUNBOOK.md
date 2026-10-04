# Production deployment runbook: migrations 047 → 073 + backend (prepared 2026-10-05)

**Status: PLAN ONLY. Nothing here has been executed. Every production step needs Andrew's explicit GO at the moment of execution.**

- Candidate: `integration/soft-launch-candidate-2026-10-04` (pin the exact SHA at GO time).
- Rollback target for the backend: current production `eb43368`.
- Production Supabase: `psbzynxplxfbyrbdidmn`. Staging: `tigwgmayeuisrxjjykqd`.

---

## 0. Migration state and collision analysis (resolved)

| Fact | Evidence |
|---|---|
| **Production is at 046** (`046_voice_client_registration_history`). Its 046 history drift was repaired 2026-09-27. | `docs/integration/2026-10-03-MIGRATION_RECONCILIATION.md` §4 |
| Pending for production: **047, 051–073** (048–050 are burned numbers, never used). **24 files.** | `ls supabase/migrations` on the candidate |
| **Candidate sequence is collision-free:** one file per number 046–073 (`tests/migration-allocation.test.mjs`); 073 was verified free on every branch and worktree on 2026-10-05. | `scripts/check-migration-numbering.js`: 69 files, no duplicates |
| The cross-branch inventory reports collisions at 046/055/058/060/061. **All are on superseded side branches** (old numbers before renumbering, e.g. `060_call_delivery_events` → candidate **064**, `061_household_iphone_carrier` → **065**, admin `055_account_classification_history` → **069**, wip `046_monitoring_usage…` never integrated). None will be applied. | `node tests/launch-gate/migration-inventory.mjs --min 046` |
| **Order:** applying 047 → 073 in plain numeric order is monotonic above production's 046, so **no `--include-all` is needed**. That is this runbook's recommendation; it replaces option (b) of B-4, which applied 057–061 first and therefore required `--include-all`. | Reconciliation §4 |
| Staging rehearsal: 052 → 072 were applied to staging 2026-10-04, with a forward and rollback rehearsal on a restored copy. **073 has not yet been applied to staging.** | STAGING-READINESS §7 |
| **Old backend compatibility during the gap** (migrations applied, `eb43368` still running): **070 keeps the exact signature** of 027's `process_stripe_webhook_event` (diffed 2026-10-05); 053/062/064/065/073 only add nullable columns or tables; 057–061 only tighten anon/authenticated grants (the backend uses the service role); 062's account-number trigger fills new households automatically. **The gap is safe, but keep it short** (same window). | Diff of 027:33–45 vs 070:22–34 |

**Pre-condition (open): apply 073 to staging first** (Andrew GO), then re-run the staging schema verifier and the full staging smoke test.

---

## 1. Preflight (read-only; Claude can run once Andrew approves read access)

| # | Check | Pass condition |
|---|---|---|
| P1 | The candidate SHA is pinned; the full suite is green at that SHA; `node tests/launch-gate/run.mjs` reviewed | 0 failures. The gate may still say CLOSED for an unrestricted launch; what matters is that the cohort gate (C-items) is GREEN |
| P2 | **A dedicated clean worktree** for production work. Never `/Users/ad/call-ai` (its link state has been production). `supabase link --project-ref psbzynxplxfbyrbdidmn` | `supabase/.temp/project-ref` = `psbz…` |
| P3 | `node scripts/verify-migration-history.js --expect-project psbzynxplxfbyrbdidmn` | Remote = 000…046 exactly. LOCAL-ONLY = 047, 051–073. No REMOTE-ONLY rows. **Anything else → STOP.** |
| P4 | For every LOCAL-ONLY migration, check its objects do **not** already exist (STAGING_TO_PRODUCTION_MIGRATION_PROCESS §3), e.g. `to_regclass('public.fc_reservations')`, `information_schema.columns` for `households.account_number`, `entitlements.revenuecat_environment`, `entitlements.store_will_renew` | None present. Partial presence → STOP |
| P5 | Production row counts and newest timestamps (households, entitlements, subscriptions, calls, contacts) saved as the **baseline fingerprint** | Saved |
| P6 | `supabase db push --linked --dry-run` | The proposed list is **exactly** 047, 051, 052, …, 073 (**24 files**) in order. **No `--include-all` prompt.** Anything else → STOP |
| P7 | Production environment prepared but not yet deployed. `node scripts/check-launch-config.js` with the production env → **START** | 0 fatal. Required: `HCG_DEPLOYMENT=production`, `TRUST_PROXY_HOPS`, `ABUSE_AUDIT_HASH_SECRET`, `SAFETY_CALLER_KEY_SECRET`, `TWILIO_VOICE_PUSH_CREDENTIAL_SID_IOS`, Fortress/abuse policies, `PROCESS_ROUTE_ENABLED` off, accounting capture **off**, ops email per decision |

## 2. Backup and restore point (Andrew GO)

1. **PITR:** note the exact UTC timestamp (Supabase dashboard → Database → Backups) immediately before step 3.
2. **Logical backup:** `pg_dump` (Homebrew libpq 18.x, CLI login role; one dump script at a time, since each `supabase` CLI call rotates the login password). Dump `public` schema+data and `auth.users`, into `/Users/ad/hcg-prod-backups/<date>-pre-047-073/` (mode 700). No secrets in filenames.
3. **Restore proof (recommended, about 20 min):** restore the dump into a throwaway local PostgreSQL. Apply 047 → 073 there and check `fc_check_invariants()`, then run the 073 → 047 rollbacks. This is the same rehearsal staging passed, but on production's real data shape. **Do not continue if the rehearsal fails.**

## 3. Apply migrations (Andrew GO; one window, with the backend deploy immediately after)

1. `supabase db push --linked` (no `--include-all`). Watch for errors and **stop at the first one**: the push stops at the failing file, and earlier files stay applied. Then use §6.
2. Immediately: `verify-migration-history.js --expect-project psbz…` → full MATCH 000…073.

## 4. Verification queries (read-only, right after §3)

| Check | Pass condition |
|---|---|
| `select public.fc_check_invariants();` | ok |
| `select * from public.fc_global_status(now());` | kill switch off, breaker closed, policy = approved production values |
| Fortress budget profiles (`fc_budget_profiles`) | **Set to the decided production values (C12) before the backend deploy.** The 067 placeholders are not launch values |
| `node scripts/verify-table-grants.js` (production, read-only) | all checks pass (RLS on every public table; anon nothing; authenticated on its allowlist) |
| `node scripts/verify-security-definer-grants.js` | pass |
| `select count(*) from households where account_number is null and email not like '%@deleted%'` | 0 (062 backfill) |
| `select count(*) from entitlements where store_state_event_at is not null` | 0 (073 fresh) |
| Fingerprint versus P5 | Row counts unchanged (migrations add structure only); 062 adds account numbers |

## 5. Backend deploy (Andrew GO)

1. Set the production env changes (P7) in Railway **before** the deploy. Keep a **single instance** (R6). Keep `ALLOWANCE_TOPUPS_ENABLED` off, accounting capture off, Xero off and the lifecycle sweep off.
2. Deploy the pinned SHA. **Rollback target `eb43368`.**
3. **Within 5 minutes:**
   - `/health` 200;
   - unsigned `/voice` → 403;
   - `check-launch-config` START in the logs;
   - **first signed production call** to Andrew's own production number (`…6063`): trusted call rings and connects; unknown call is announced and monitored; Fortress reservation present.
   - **If a signed call is rejected or not delivered → roll back the backend immediately** (R7). Migrations stay; they're compatible with `eb43368`.
4. Watch for 30 minutes: errors, Fortress overview, Twilio usage, ops-event scan (delivery off unless approved).

## 6. Stop conditions and rollback

| Situation | Action |
|---|---|
| Any preflight STOP | Do nothing. Report. |
| Migration error mid-push | Leave the applied files. Do **not** run rollbacks under pressure. Fix forward, or roll back only files with **no** customer data, strictly in reverse order, per their headers. **Never roll back 062 once an account number has been shown, 063 after a real top-up, or 067 while calls are live** (see MIGRATION_RECONCILIATION §5). Old backend stays up (compatible). |
| Backend misbehaves | Redeploy `eb43368` (compatible with the new schema). |
| Spend anomaly | `fc_set_kill_switch(true, …)` via the audited admin route; then investigate. |
| Data damage | Restore from PITR (point noted in §2). This is a last resort and loses everything after that point. |

## 7. After deployment

- Relink the production worktree to **staging** as the resting state.
- Update `docs/launch/2026-10-04-FIVE-CUSTOMER-SOFT-LAUNCH-GATE.md` C1–C4 with dated evidence.
- The **price cutover** (`2026-10-05-PRICE-CUTOVER-CHECKLIST.md`) happens with or after this deploy, **never before it**: the old backend hard-codes £4.99 in the checkout text.
