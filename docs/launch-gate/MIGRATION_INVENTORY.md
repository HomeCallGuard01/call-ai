# Central Migration Inventory (046+)

**As of:** 2026-10-03. Assembled read-only (`git ls-tree` across 199 local and remote refs, plus migration headers and the docs on each branch). **No database was queried. Nothing was renumbered or applied.**

Reproduce or refresh it with `node tests/launch-gate/migration-inventory.mjs --min 046` (add `--json` for machine-readable output). The tool is read-only and exits 1 if any number maps to more than one filename.

Environments: production `psbzynxplxfbyrbdidmn`, staging `tigwgmayeuisrxjjykqd`.

**Primary source for applied status:** `security/supabase-staging-remediation:docs/engineering/SUPABASE_SECURITY_REMEDIATION_2026-09-30.md:54-59`:
> "production has 000–046. Staging has 000–046, then 047, 051 and 057 (plus 058 and 059 from this work)… staging has drifted from its own history: the objects from the 050 number-lifecycle sweep … exist on staging with **no** `schema_migrations` row."

That document predates 060/061 being applied to staging. `SUPABASE_PRODUCTION_RUNBOOK_057-061.md:3-5` on the same branch records 060 and 061 as applied to staging on 2026-09-30 (20:09Z). Where a migration's own header disagrees with the audit (for example, 047's header still says "NOT APPLIED anywhere"), **trust the audit**.

## Inventory

| # | filename | branch(es) | purpose | prod | staging | collision | recommended eventual resolution |
|---|---|---|---|---|---|---|---|
| 046 | `046_voice_client_registration_history.sql` | origin/main and ~70 branches | append-only Voice SDK registration history | **applied** (history row repaired 2026-09-27) | applied | **YES** | **Keep.** It is canonical. |
| 046 | `046_monitoring_usage_and_financial_safety.sql` | `wip/monitoring-allowance-financial-safety-2026-09-26` (local only) | early allowance scaffolding | no | no | **YES** | **Retire.** 056 supersedes it (056 header :5-7). Keep the wip branch as a preserved reference and never integrate it. |
| 047 | `047_number_release_entitlement_guard.sql` | fix/number-lifecycle-entitlement-guard (PR #45), feature/number-lifecycle-sweep (PR #49) | stops a number being released while the household is entitled | no | **applied** | no | Apply to production **first**, in order (production must record 046 first, which it now does) |
| 048–050 | — | — | **reserved / burned.** 048 was the ledger's first number (now 051). 049 was the guard's (now 047). 050 was the sweep's (now 052) and collided with the withdrawn `050_manual_cost_schedules` | — | Staging has the **050 objects with no history row** | — | **Never reuse 048–050** |
| 051 | `051_financial_ledger_and_telephony_usage.sql` | feature/provider-neutral-billing-ledger; also in 30d454c (financial-safety-hard-limits / customer-allowance / financial-containment-p0) | provider-neutral ledger and telephony call legs | no | **applied** 2026-09-27 | no | Production order 047 → 051 → 052 |
| 052 | `052_number_lifecycle_sweep_evidence.sql` | feature/number-lifecycle-sweep | release-attempt evidence columns and RPCs | no | **objects present, history row missing** (applied as "050"; that row was reverted) | no | Staging history repair `migration repair --status applied 052` is **pending Andrew's approval**. Do not apply it again |
| 053 | `053_entitlements_revenuecat_environment.sql` | fix/revenuecat-sandbox-environment-guard (PR #50) | sandbox/production provenance column on entitlements | no | no evidence | no | Independent. Validate on staging, then apply. The header has no STATUS line, so add one |
| 054 | `054_number_lifecycle_sweep_run_evidence.sql` | feature/number-lifecycle-sweep | sweep last-run evidence | no | no evidence (PGlite only) | no | After 052 |
| 055 | `055_account_classification_history.sql` | feature/admin-control-centre-v2 (Draft PR #51) | audited account classification | no | no | **YES** | **Renumber** (handover option (a), the cheapest: the admin dashboard is not launch-critical) |
| 055 | `055_call_delivery_evidence.sql` | p0/call-delivery-resilience, readiness/android-call-delivery, readiness/ios-parity, release/ios-1.0.2, feature/ios-102-dynamic-pricing, docs/price-599-release-audit | call-delivery evidence and health | no | no | **YES** | Keep 055 **only if** it integrates before #51. Otherwise renumber. Decide centrally (see the allocation below) |
| 056 | `056_financial_safety_allowance_and_admission.sql` | 30d454c (financial-safety-hard-limits / customer-allowance / financial-containment-p0) | monitored-minute allowance, hard admission, safety state | no | no | no (but the Financial Fortress may still change it) | After 051. Must be **staging-validated with the contract tests bound** before production |
| 057 | `057_terms_acceptances_enable_rls.sql` | fix/terms-acceptances-rls, security/supabase-staging-remediation, fix/staging-default-table-privileges | RLS on terms_acceptances | no | **applied** 2026-09-30 17:56Z | no | Production runbook 057→061 |
| 058 | `058_revoke_default_table_privileges_anon_authenticated.sql` | security/supabase-staging-remediation, fix/staging-default-table-privileges | default ACL: new tables get no anon/authenticated grants | no | **applied** 19:26Z | **YES** | **Keep.** It is applied on staging |
| 058 | `058_call_delivery_events.sql` | feature/ios-102-dynamic-pricing, docs/price-599-release-audit | early copy of call-delivery events | no | no | **YES** | **Obsolete**: renumbered to 060 on the readiness branches. Those two branches are themselves superseded (see the cleanup plan) |
| 059 | `059_least_privilege_anon_authenticated_table_grants.sql` | security/supabase-staging-remediation | least-privilege grants | no | **applied** 19:26Z | no | Runbook. Note it has separate staging and production rollbacks |
| 060 | `060_revoke_unused_authenticated_grants_and_pin_trigger_search_path.sql` | security/supabase-staging-remediation | drop unused grants; pin search_path | no | **applied** 20:09Z | **YES** | **Keep** (applied on staging) |
| 060 | `060_call_delivery_events.sql` | readiness/android-call-delivery, readiness/ios-parity, release/ios-1.0.2 | call-delivery event timeline | no | no (staging PostgREST reported the table absent 2026-10-01) | **YES** | **Renumber** above the highest applied number |
| 061 | `061_global_default_revoke_function_execute_from_public.sql` | security/supabase-staging-remediation | default revoke of EXECUTE from PUBLIC | no | **applied** 20:09Z | **YES** | **Keep** (applied on staging) |
| 061 | `061_household_iphone_carrier.sql` | readiness/ios-parity, release/ios-1.0.2 | iPhone households keep their carrier | no | no | **YES** | **Renumber.** The iOS 1.0.2 morning report already calls this a blocker for any backend merge |

## Collision rule applied

**A number that is already applied to any environment keeps its file. Unapplied drafts move.** This is the 2026-09-27 rule ("numbers follow merge/application order; unmerged branches renumber", commit eb99d00) applied consistently. Under it, the security branch keeps 057–061, and every call-delivery, iOS or admin draft renumbers.

## Proposed central allocation (for approval; nothing is renumbered)

These numbers are proposals. They are allocated in the proposed integration order (see `INTEGRATION_PLAN.md`) and start above every number that is reserved, applied, or in use (≥ 062):

| proposed | current file | from branch |
|---|---|---|
| 062 | `055_call_delivery_evidence.sql` | p0/call-delivery-resilience lineage (via readiness/ios-parity → release/ios-1.0.2) |
| 063 | `060_call_delivery_events.sql` | readiness/android-call-delivery lineage |
| 064 | `061_household_iphone_carrier.sql` | readiness/ios-parity lineage |
| 065+ | new Financial Fortress / Fraud / Identity / Allowance migrations | allocate at integration, in merge order |
| 066+ | `055_account_classification_history.sql` | feature/admin-control-centre-v2 (admin read models come late) |

An alternative is to keep `055_call_delivery_evidence` at 055, because nothing else at 055 is applied. That saves one rename but leaves the admin 055 to move anyway. The trade-off is in the handover.

**Before any renumber:**
1. Freeze the allocation in this file.
2. Rename the file **and** its `_rollbacks/` twin **and** every in-file and doc reference. The pglite test applies files in lexicographic order, so a renumber changes the apply order. Re-run `tests/migrations.pglite.test.mjs` after each one.
3. Never renumber a migration that has a `schema_migrations` row in either environment.

## Detection gaps

- `tests/migrations.pglite.test.mjs` (same on every branch) applies every top-level `.sql` in sorted order and **does not check that numbers are unique**.
- `tests/migration-number-uniqueness.test.mjs` exists only in the 30d454c lineage and the ledger branch. `scripts/check-migration-numbering.js` (PR #46) is manual. Both look at one checkout only.
- **This branch adds** a cross-branch check (`tests/launch-gate/migration-inventory.mjs`) and a single-tree probe (PR-10). At integration, wire the uniqueness test into the main suite.
- Environment drift (applied without a history row: 046 in production before the repair; 031/032/033/044/045 and 050/052 on staging) is only detectable by querying `schema_migrations`. `scripts/verify-migration-history.js` (PR #46) does this. Running it is a **read-only production query and needs Andrew's authorisation.** It was not run here.

## Known stale statements in other docs (do not rely on them)

- `release/ios-1.0.2:docs/launch/RELEASE_BLOCKERS_2026-09-30.md:83` says "046 unrecorded in prod". That was repaired on 2026-09-27.
- `docs/acquisition-readiness:docs/financial/TELEPHONY_BILLING_LEDGER_SPEC.md:157,167` says 046 is "NOT YET APPLIED". That is wrong.
- The 047 header says "NOT APPLIED anywhere". It is applied on staging.
