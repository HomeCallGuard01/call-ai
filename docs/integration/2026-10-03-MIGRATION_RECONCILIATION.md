# Migration reconciliation — Launch Fortress integration (2026-10-03)

**Nothing in this document has been applied to any database.** No production or staging query was made.
Numbers here are the integration branch's proposal. They become real only when Andrew approves
an apply plan (see `2026-10-03-STAGING_VALIDATION_PLAN.md`).

## 1. Sources

- `git ls-tree` across every local and remote ref (`tests/launch-gate/migration-inventory.mjs --min 046`, 205 refs).
- Applied-state evidence (no DB queried by this session):
  - `security/supabase-staging-remediation:docs/engineering/SUPABASE_SECURITY_REMEDIATION_2026-09-30.md` —
    "production has 000–046. Staging has 000–046, then 047, 051 and 057 (plus 058 and 059)";
    050-numbered sweep objects exist on staging with **no** history row.
  - `…/SUPABASE_PRODUCTION_RUNBOOK_057-061.md` — 060 and 061 applied to **staging** 2026-09-30 20:09Z.
  - `test/launch-gate-adversarial:docs/launch-gate/MIGRATION_INVENTORY.md` (same evidence, consolidated).
  - Each workstream handover (Fortress, Fraud, Allowance, Identity, Admin).

## 2. Rule

> **An already-applied migration keeps its identity.** Unapplied drafts may be renumbered.
> A unique, unapplied number is kept unless moving it buys safety (it does not here).
> Burned numbers 048–050 are never reused.

## 3. Every collision and how it is resolved

| No. | Files claiming it | Applied where | Decision | Reason |
|---|---|---|---|---|
| 046 | `046_voice_client_registration_history` (main) vs `046_monitoring_usage_and_financial_safety` (local `wip/…-2026-09-26`) | main's: **prod + staging** | keep main's; wip file **not integrated** | applied; wip superseded by 056 |
| 055 | `055_call_delivery_evidence` (delivery/iOS lineage) vs `055_account_classification_history` (admin #51) | neither | **delivery keeps 055**; admin's → **069** | 4 branches already carry delivery's 055; admin dashboard is not launch-critical and its write path refuses to run without the table, so it goes last |
| 058 | `058_revoke_default_table_privileges…` (security) vs `058_call_delivery_events` (dynamic-pricing / price-audit) | security's: **staging** | security keeps 058; the obsolete copy is not on any integrated head | the obsolete copy was renamed to 060 on the readiness branches |
| 060 | `060_revoke_unused_authenticated_grants…` (security) vs `060_call_delivery_events` (readiness/iOS) | security's: **staging** | security keeps 060; `call_delivery_events` → **064** | applied keeps identity |
| 061 | `061_global_default_revoke_function_execute…` (security) vs `061_household_iphone_carrier` (iOS) | security's: **staging** | security keeps 061; `household_iphone_carrier` → **065** | applied keeps identity |
| 062 | `062_customer_identity_and_routing_assignments` (identity, "provisional") | none | **keeps 062** | unique after the above; its tests/docs/handover name 062; depends only on ≤ 046 |
| 063 | `063_customer_allowance_credits_and_notices` (allowance) | none | **keeps 063** | unique; depends on 056 (< 063) |
| — | `PROVISIONAL_telephony_abuse_controls.sql` (fraud, unnumbered, in `docs/`) | none | → **066** `066_telephony_abuse_shared_state.sql` | must precede adapters that make velocity/cooldowns/holds/incident state cross-instance |
| — | `supabase/provisional/financial_containment_authorization_ledger.sql` (Fortress, unnumbered) | none | → **067** `067_financial_containment_authorization_ledger.sql` | handover: "after 056 and after the telephony-abuse schema (≥ 065)" |
| new | allowance ↔ Fortress economic bridge (this integration) | none | **068** `068_allowance_economic_credit_bridge.sql` | redefines `credit_allowance` so a top-up/adjustment credits the **same £ capacity** Fortress enforces, atomically; must follow both 063 and 067 |

Numbers 047, 051, 052, 053, 054, 056, 057, 059 have no collision and keep their numbers.

## 4. Final proposed sequence (integration branch)

| No. | File | Origin branch | Prod | Staging | Depends on | Status after this integration |
|---|---|---|---|---|---|---|
| 046 | voice_client_registration_history | main | applied | applied | — | unchanged |
| 047 | number_release_entitlement_guard | number-lifecycle | no | **applied** | ≤ 046 | DRAFT for prod |
| 048–050 | — | — | — | 050 objects w/o history row | — | **burned, never reuse** |
| 051 | financial_ledger_and_telephony_usage | ledger / 30d454c | no | **applied** 2026-09-27 | ≤ 046 | DRAFT for prod |
| 052 | number_lifecycle_sweep_evidence | number-lifecycle | no | objects present, **no history row** (pending `migration repair`) | 047 | DRAFT; do not re-apply on staging |
| 053 | entitlements_revenuecat_environment | revenuecat guard | no | no | ≤ 046 | DRAFT |
| 054 | number_lifecycle_sweep_run_evidence | number-lifecycle | no | no | 052 | DRAFT |
| 055 | call_delivery_evidence | delivery lineage | no | no | ≤ 046 | DRAFT |
| 056 | financial_safety_allowance_and_admission | 30d454c | no | no | 051, 031 | DRAFT |
| 057 | terms_acceptances_enable_rls | security | no | **applied** | — | runbook |
| 058 | revoke_default_table_privileges_anon_authenticated | security | no | **applied** | — | runbook |
| 059 | least_privilege_anon_authenticated_table_grants | security | no | **applied** | — | runbook (separate prod/staging rollbacks) |
| 060 | revoke_unused_authenticated_grants_and_pin_trigger_search_path | security | no | **applied** | — | runbook |
| 061 | global_default_revoke_function_execute_from_public | security | no | **applied** | — | runbook |
| 062 | customer_identity_and_routing_assignments | identity | no | no | ≤ 046 (+ 029 deletion path) | DRAFT |
| 063 | customer_allowance_credits_and_notices | allowance | no | no | 056 | DRAFT |
| 064 | call_delivery_events (**was 060**) | delivery lineage | no | no | ≤ 046 | DRAFT |
| 065 | household_iphone_carrier (**was 061**) | iOS parity | no | no | 041/043 | DRAFT |
| 066 | telephony_abuse_shared_state (**was provisional**) | fraud | no | no | households | DRAFT |
| 067 | financial_containment_authorization_ledger (**was provisional**) | Fortress | no | no | households, entitlements (011), account_classifications (031); reads 056 `plan_code` defensively | DRAFT |
| 068 | allowance_economic_credit_bridge (**new**) | this integration | no | no | 063, 067 | DRAFT |
| 069 | account_classification_history (**was admin 055**) | admin #51 | no | no | 031 | DRAFT |
| 070 | stripe_entitlement_canonical_decision (**new**) | this integration | no | no | 027 (replaces its `process_stripe_webhook_event`; 027 is applied, so it is replaced, not edited) | DRAFT |

### Environment ordering consequences

- **Production (at 046):** applying 047 → 069 in numeric order is monotonic. No `--include-all` needed,
  provided 057–061 are **not** applied ahead of 047–056 (launch-gate INTEGRATION_PLAN §5 decision (a)/(b)
  is still Andrew's).
- **Staging (has 047, 051, 057–061; 052 objects without history):** 053, 054, 055, 056 are below the
  highest applied number, so staging needs `supabase db push --include-all` (or per-file apply with a
  history row) **and** the pending 052 history repair first. This is the same accepted drift class as
  option (b). It cannot be avoided without renumbering 053–056, which would instead create
  staging/production divergence for nothing — rejected.

## 5. Rollback order and safety

Roll back strictly in reverse (070 → 047). Rollback files live in `supabase/migrations/_rollbacks/`.

| No. | Rollback safe once customer-visible data exists? | Why |
|---|---|---|
| 070 | yes — restores 027's function exactly | the three canonical-decision fixes are lost (stale rows block Stripe again, complimentary→Stripe customers lose access when the grant ends) |
| 069 | yes (loses classification audit trail only) | admin-only data |
| 068 | **only with traffic stopped**; reverting re-creates 063's minutes-only `credit_allowance` | after rollback, a paid top-up would credit minutes Fortress will not fund |
| 067 | **NO while live calls exist.** Requires the kill switch / maintenance first | drops reservations, leases and the authorisation ledger; code expecting `fc_*` RPCs would fail closed (degraded envelope → refusal) |
| 066 | yes after exporting `abuse_decisions` | shared counters revert to process-local |
| 065 | yes | restores 043's function |
| 064 | yes (loses delivery timeline) | evidence only |
| 063 | **NO after any real top-up** | `allowance_credits` is the audit of paid credit; dropping it destroys refund/revenue evidence. Export first, and only with Andrew's approval |
| 062 | **NO once any account number has been shown to a customer** | numbers must never be reissued; the identity handover forbids it |
| 061–057 | per security runbook (separate prod/staging rollback files for 059) | grants/RLS |
| 056 | only with 063/068/067 rolled back first (FK from 063 to `usage_notifications`) | admission + allowance state |
| 055, 054, 053, 052, 051, 047 | per their own headers; 047 rollback re-allows releasing entitled households' numbers — do not | |

## 6. What this integration changes in the tree

- `git mv` 060/061 delivery/iOS files (and `_rollbacks/` twins) to 064/065; update in-file headers and
  every test/doc reference.
- `git mv` admin 055 (and twin) to 069; update references.
- Move the two provisional files into `supabase/migrations/` as 066/067 (with rollbacks), updating headers
  to "DRAFT — NOT APPLIED — numbered at integration 2026-10-03".
- Add 068 + rollback.
- `tests/migrations.pglite.test.mjs` replays the **whole** sequence in order (it applies every top-level
  `.sql`); `tests/migration-number-uniqueness.test.mjs` (from 30d454c) is in the suite and enforces one
  file per number; a new check asserts the exact allocation in §4 so it cannot drift silently.

## 7. Open decisions (Andrew)

1. Production apply order for 057–061 relative to 047–056 (launch-gate plan §5 a/b/c).
2. Staging `migration repair --status applied 052`.
3. Approval to apply anything at all (this document applies nothing).

## 8. Changes made to drafts after the first version of this document

- **066:** functions now `set search_path = ''` and grant EXECUTE to service_role (repo grants
  check); `abuse_hit` validates its window before dividing (zero window raised division_by_zero).
- **067:** paid profiles' delivery reserve scope `trusted_only` (was `all`; £ unchanged — decision
  flagged); new unfunded `sandbox` profile and `fc_resolve_profile` maps an explicit
  `revenuecat_environment = 'sandbox'` entitlement to it (internal_test classification wins);
  `fc_household_status` exposes `deliveryReserveScope`.
- **056 (draft, edited in place):** household burst is opt-in and never refuses a trusted caller;
  `fs_close_call` ends a monitoring session that never attached a stream.
- **070 (new):** see §4.
- Production ordering is still monotonic (046 → 070). Staging still needs `--include-all` for 053–056.
- `tests/migration-allocation.test.mjs` pins 046–070, burned 048–050, and a rollback for 062–070.
