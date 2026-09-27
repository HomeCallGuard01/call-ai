# Ledger 051 — production-readiness review and integration sequence

Reviewed 2026-09-27 at commit 1869f0a (`feature/provider-neutral-billing-ledger`).
**Not applied to production and not deployed.** Staging validation was accepted by Andrew.

## Verdict

**Ready for production once the sequence below is approved.** Three defects were found in this review and fixed (1869f0a):

| Defect | Fix |
|---|---|
| Missing index on `financial_entries(call_id)` | Added. Without it, every call deletion would scan the ledger. |
| No transaction wrapper | `begin`/`commit`, matching 040–046 and 052 |
| Rollback existed only as a comment | Real rollback file, pglite-tested: it drops only the ledger objects, and 051 re-applies cleanly afterwards |

The index was also applied to staging (idempotent), so staging matches the file. The file header now states its real status.

## Review

| Area | Finding |
|---|---|
| **Migration safety** | Additive only: two new tables and four views; no existing table, column, function or grant is altered. Creating FKs to `calls` and `households` takes a brief SHARE ROW EXCLUSIVE lock on those tables (it blocks writes, not reads, for milliseconds at current size). Apply outside a call spike. Idempotent (`if not exists` / `create or replace view`). |
| **Rollback** | `_rollbacks/051_rollback_financial_ledger_and_telephony_usage.sql`. It is **destructive** to ledger rows, so export them first if production has been writing. Nothing else in the database depends on 051. Then `supabase migration repair --status reverted 051`. Code rollback: the ledger writers are not wired into request paths yet (backfill/reconciliation are scripts), so no code depends on the tables at deploy time. |
| **Performance** | Indexes: legs (household, started_at), (reconciliation_status, updated_at), (call_id), (provider, parent); entries (household, occurred_at), (call_id), (leg), (supplier, category, provenance), (entry_class, cost_class, occurred_at), (supplier, period_start), (campaign_ref), (reconciliation_status, updated_at). The views aren't materialised and group over all entries. That's fine to roughly 10⁵–10⁶ rows. At about 1,000 households (~100k legs/month), add a period filter in dashboard queries or a materialised monthly rollup (a later migration). |
| **RLS / access** | RLS enabled with no policies; explicit `revoke all` from public/anon/authenticated inside the same transaction, so Supabase's default ACL never exposes rows; `service_role` only. Views are `security_invoker` (Postgres 15+; **production is 17.6**) and service_role-only. Tested in pglite: anon and authenticated are denied on both tables and all views. Recommend running P0's `scripts/verify-security-definer-grants.js`-style grant check after apply. |
| **Retention / privacy** | No phone numbers or names are stored; links are by id. Deleting a household or call sets the link to null and keeps the amounts. Validated on staging with a privacy-deletion replay. `native_reference` holds provider SIDs (CA…/PN…), which are only personal data joined with Twilio's own records. Retention: financial records ~6 years (UK statutory accounting). **DECISION REQUIRED:** confirm and add to the privacy notice/ROPA. |
| **Reconciliation correctness** | The backfill dry run reconciles to Twilio exactly: ledger £37.93589 = Twilio £37.93589. Provenance never downgrades; a charge appearing after `not_observed` is flagged; a changed final amount is a mismatch; absence is never £0 (DB-enforced). |
| **Dashboard compatibility** | The dashboard reads only the four views (`LEDGER_REPORTING_INTERFACE.md`). Dashboard's `050_manual_cost_schedules.sql` has no DDL dependency on 051, but its header and posting code say "financial_entries (migration 048)" and must be updated to 051 by its owner. |
| **Portability** | Plain Postgres (pglite-tested); supplier/provider are slugs; no Twilio-specific columns; native currency is preserved and never converted. |
| **Numbering** | Production history is 040–046 (046 drift already repaired by P0). Pending: 047 (P0), 050 (Dashboard), 051 (this), 052 (P0 sweep evidence). The CLI applies in ascending order and refuses out-of-order pushes without `--include-all`, so production must receive **047 → 050 → 051 → 052**. If any lands later than a higher number, it must be renumbered above the highest applied (the adopted rule). |

## Production integration sequence (prepared, not executed; each step needs Andrew's approval)

This fits P0's `TOMORROW_INTEGRATION_PLAN.md` (fix/migration-safety-tooling).

1. **Stage 0 (P0):** merge migration-safety tooling (#46), then run `check-migration-numbering.js` from a worktree containing 047, 050, 051 and 052.
2. **Stage 1 (P0):** 047 to production, then merge #45.
3. **Dashboard 050:**
   - Dashboard owner updates its 048 references to 051.
   - Merge to main, then `db push --dry-run`, which must propose exactly 050.
   - If Dashboard isn't ready, **051 must not wait on it forever.** Either 050 renumbers above 052 later (the rule), or Andrew approves 051 first and Dashboard renumbers. DECISION REQUIRED.
4. **Finance 051:**
   - Rebase `feature/provider-neutral-billing-ledger` on main; full suite; PR; merge.
   - Pre-flight in production: `verify-migration-history.js --expect-project psbzynxplxfbyrbdidmn` and `select to_regclass('public.financial_entries')`, which must be null.
   - `supabase db push --linked --dry-run` must propose exactly `051`.
   - Apply.
   - Verify: two tables and four views exist; `relrowsecurity` is true; anon/authenticated have no grants; 12 secondary indexes (4 on legs, 8 on entries); `financial_entries_call_idx` present.
   - Relink the CLI to staging.
5. **Stage 2 (P0):** 052 to production, then merge #49.
6. **Backfill (after 051):**
   - `node scripts/ledger-backfill.js` dry run against production (read-only) and review the report. The script refuses to write to production by design.
   - Enabling a production write needs a code change approved separately (a production-ref allow-list with a confirmation token).
7. **Wiring (later, separate approval):**
   - daily `dailyReconciliation` job;
   - `evaluateSpend` alerts (`PROVIDER_SPEND_PROTECTION.md`);
   - the dashboard reading the views.
8. **Attribution migration:** takes the next free number above the highest applied at the time.

Checklist before step 4:
- Staging 051 content equals the file (index applied);
- the pglite suite passes;
- the full suite shows only the 9 known Android-manifest failures (last run: 111 files, 3,990 passed, 9 failed).
