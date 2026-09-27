# Tomorrow's integration plan — PR #45/#46/#47/#49 (+ Finance's #51 ledger, Dashboard's draft)

**Prepared 2026-09-27 (overnight autonomous session), updated same night after a second pass once Finance and Dashboard's concurrent work was discovered. Nothing in this plan has been executed except the migration renumbering described below — the rest is the ordered sequence for Andrew to review and authorise.**

## Current migration ownership (reconciled 2026-09-27, late pass)

Four branches now hold four distinct, non-colliding migration numbers. Verified by listing `supabase/migrations/` in every locally-known worktree, not just open PRs — most of tonight's work is local/unpushed and wouldn't show up from GitHub alone.

| # | Branch | File | Status |
|---|--------|------|--------|
| 047 | `fix/number-lifecycle-entitlement-guard` (PR #45) | `047_number_release_entitlement_guard.sql` | Staging-validated (full #8 replay). Not in production. |
| 050 | `feature/admin-business-control` (Dashboard, no PR seen) | `050_manual_cost_schedules.sql` | Dashboard's own file. Its header still references "financial_entries (migration 048)" — i.e. it was written against Finance's *old* pre-renumbering scheme and will need its own rework once it integrates against the real 051 ledger. Not mine to fix; flagging for whoever picks up Dashboard's branch. |
| 051 | `feature/provider-neutral-billing-ledger` (Finance, no PR seen) | `051_financial_ledger_and_telephony_usage.sql` | File header still says "DRAFT — NOT APPLIED" but this is stale documentation: independently verified tonight via `to_regclass()` against live staging that `telephony_call_legs`, `financial_entries`, and `finance_entries_reporting` all physically exist. **Genuinely applied to staging**, contrary to what its own header currently claims. Worth a one-line heads-up to Finance to update their header, not urgent. |
| 052 | `feature/number-lifecycle-sweep` (PR #49) | `052_number_lifecycle_sweep_evidence.sql` | Renumbered from 050 tonight (see below). Staging-validated under the old 050 filename/number (identical SQL content); tracking-table relabel to "052" is bookkeeping-only and one step short of complete (see below). |

**No further collisions in this picture.** 050 and 052 are different branches now; 051 is untouched and confirmed locked.

### The 050→052 renumbering (what happened, and what's still open)

This plan originally shipped Step 2 as migration "050". Overnight, two independent things happened elsewhere:
- Dashboard's `feature/admin-business-control` independently claimed 050 for its own, unrelated migration (`050_manual_cost_schedules.sql`).
- Finance's ledger branch, discovering the same collision from its side, renumbered itself from 048 to 051 (documented in its own file header) rather than contest the slot.

Rather than make Dashboard renumber (their branch, not mine to touch), Step 2's migration was renumbered 050 → 052 — the next free slot above Finance's now-locked 051. This was a pure rename: `git mv` on the migration file, its rollback file, and its dedicated PGlite test file, plus updating internal comments/log strings/the STATUS header and `package.json`'s test script reference. **No SQL logic changed.** Full test suite (37+12+14 checks across the sweep decision function, the runner, and the PGlite migration test) re-run and passing after the rename. Committed as `055621f` on `feature/number-lifecycle-sweep`, pushed — PR #49 now reflects "052" on GitHub.

**One step of this is not yet complete**: staging's own tracking table (`supabase_migrations.schema_migrations`) had a row for "050" from tonight's earlier live validation (before the collision was discovered). `supabase migration repair --status reverted 050 --linked` has been run (succeeded). The matching `supabase migration repair --status applied 052 --linked` — relabelling the same already-applied content under its new number — was blocked by Claude Code's own permission system (a shared-resource write requiring live, in-the-moment approval) and needs one more explicit go-ahead to finish. This is bookkeeping only; the physical schema on staging is correct and unaffected either way (the migration's own DDL is idempotent — `create table if not exists`, `create or replace function` — so even an accidental future re-push of 052 would no-op safely, not corrupt anything). **Action needed from Andrew**: approve one more `supabase migration repair --status applied 052 --linked` call.

## Why order matters here

PR #49 (Step 2, now migration 052) is *built on top of* PR #45 (047) — it targets that branch, not `main`, and cannot be merged independently. PR #47 (admin dashboard) will need a small follow-up once #49's migration lands, to actually surface the new durable release-attempt evidence. #46 (tooling) is fully independent and can move any time. Merging out of order either fails outright (Step 2 can't merge without 047) or leaves the admin dashboard unable to show data that doesn't exist yet (harmless, just incomplete) — nothing here is dangerous if done out of order, but doing it in order avoids rework.

Finance's 051 and Dashboard's 050 are **not** part of this plan's merge sequence — they belong to their own owners' plans. They're listed above purely so this plan's own numbering decisions are made with full current information, per the explicit instruction to reconcile ownership before proposing merges.

## Sequence

### Stage 0 — no dependencies, merge any time
**PR #46** (migration safety tooling). Pure scripts/docs, zero runtime risk. Recommend merging first regardless of everything else, since `scripts/check-migration-numbering.js` should be run against every other PR's migration file before it merges. Note this script only checks a single working directory's own `supabase/migrations/` — it does **not** see other worktrees or branches. Tonight's four-way (047/050/051/052) reconciliation was done manually by listing every known worktree's migrations directory side by side; that manual cross-worktree check is not something #46's tooling currently automates, which is itself a gap worth a follow-up in #46 at some point (not done tonight — out of scope for this pass).

### Stage 1 — production migration + code (047)
1. Run `scripts/check-migration-numbering.js` (from #46, once merged) to reconfirm 047 doesn't clash with anything newly merged elsewhere.
2. Apply migration 047 to **production**, following the exact sequence in `docs/engineering/MIGRATION_047_DEPLOYMENT_SEQUENCE.md` (PR #45) — pre-flight drift check, dry-run, apply, verify. **Requires Andrew's explicit go-ahead**; this is the one production-database step in the whole plan.
3. Merge PR #45 to `main` (only after step 2 — the Node code fails closed if deployed first, but the correct order avoids even that transient pause).
4. Confirm Railway deploy succeeds, `/health` green.

### Stage 2 — Step 2 (migration 052, renumbered from 050 — see above)
5. Re-target PR #49 from `fix/number-lifecycle-entitlement-guard` to `main` (now that #45 is merged into it).
6. Finish the staging tracking-table relabel described above (`migration repair --status applied 052 --linked`) if not already done by the time this stage starts.
7. Apply migration 052 to production, same discipline as 047: pre-flight, dry-run confirming exactly one migration proposed, apply, verify all 3 new RPCs + table + columns exist and match.
8. Merge PR #49.
9. Wire the actual daily invocation — `runNumberLifecycleSweep` currently has no caller anywhere in `server.js`/a scheduled job. **This is a real gap to close before Step 2 does anything in production**: decide whether it joins the existing `setInterval`-based daily pattern already used for `runTwilioNumberReleaseCheck`/`runQuarantinedNumberReleaseCheck` (server.js), or a separate schedule. See the scheduling design being produced as part of tonight's Priority 4 work.
10. **DECISION REQUIRED, unresolved from tonight**: how a test/reviewer account holder is actually notified of the 14-day pre-expiry warning (SMS/email/ops-only). The runner defaults to an ops-only alert until this is decided.

### Stage 3 — admin dashboard follow-up (PR #47 extension)
11. Once migration 052 is live, extend `services/adminNumberLifecycleReconciliation.js` (PR #47) to also read `twilio_release_last_attempt_at`/`twilio_release_last_error`/`twilio_release_attempt_count` and surface a `failedReleaseAttemptCount`-style anomaly. **Not done tonight on purpose**: adding these column references to PR #47 before migration 052 exists in a database would break that endpoint with a live "column does not exist" error the moment it's queried against one that doesn't have 052 yet.
12. Merge PR #47 (independently mergeable before or after this follow-up — the follow-up is additive to it, not a prerequisite for the base endpoint working).
13. Build the `admin-business.html` UI panel for the reconciliation endpoint (backend from #47 is complete and tested; this is a smaller, separate frontend task, explicitly out of tonight's scope — Dashboard ownership stays with whoever owns that UI, per the explicit instruction not to build a competing dashboard).

### Not part of this plan, flagged for the owning teams
- Dashboard's 050 (`manual_cost_schedules.sql`) references Finance's old pre-renumbering "048" — will need updating against the real 051 before Dashboard's branch can integrate cleanly.
- Finance's 051 file header should be corrected from "DRAFT — NOT APPLIED" to reflect that it's genuinely live on staging (independently verified tonight), so the next person reading that file isn't misled the way this plan almost was.

## Rollback points

- **047**: `supabase/migrations/_rollbacks/047_rollback_number_release_entitlement_guard.sql` — tested end-to-end tonight (PGlite), genuinely reintroduces pre-047 behaviour on rollback (by design — a rollback is a real revert, not a partial one).
- **052**: `supabase/migrations/_rollbacks/052_rollback_number_lifecycle_sweep_evidence.sql` — drops the 3 new RPCs, the warning table, and the 3 new households columns. No data loss beyond the evidence itself (which is additive, not depended on by anything else). Content identical to the old 050 rollback, just renamed/relabelled.
- **Code (PR #45/#49)**: standard Railway redeploy of the previous commit. Both fail closed if their RPCs are missing (047's Node guard treats an error as "entitled"; the sweep runner skips warnings and logs errors per-household without aborting), so a rollback ordering mistake pauses functionality rather than causing unsafe behaviour.

## Staging checks already complete (tonight)

- 047: the real #8 incident replayed and confirmed fixed; upcoming-entitlement, genuinely-lapsed-lifecycle, and new-entitlement-cancels-pending-release all confirmed; rollback tested.
- 052 (as 050 at the time): all 3 new RPCs confirmed against live staging, including the full "complimentary expires → lifecycle begins" scenario end to end. All synthetic data cleaned up, zero residue. Content unchanged by the later rename.
- 051 (Finance's, independently, not by me): confirmed physically present on staging (`telephony_call_legs`, `financial_entries`, `finance_entries_reporting` all exist via `to_regclass`), despite the file's own header still claiming DRAFT.

## Explicitly not covered by this plan

- Actually wiring the sweep into a scheduled job (Stage 2, step 9) — a real, not-yet-closed gap, being designed tonight as a separate item.
- The customer-notification channel decision (Stage 2, step 10).
- The `complete.tsx`/Home-tab Android-consolidated reconciliation (separate, unrelated to this plan — see the earlier tonight handover).
- Dashboard's and Finance's own branches reaching production — those are each team's own plan, not this one's.
- Any Android/iOS build, App Store/Play submission, pricing, or website change.
