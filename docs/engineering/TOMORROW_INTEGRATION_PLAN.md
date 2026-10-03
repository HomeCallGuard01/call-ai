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
| 053 | `fix/revenuecat-sandbox-environment-guard` (PR #50, new tonight) | `053_entitlements_revenuecat_environment.sql` | New P0 fix branch, off a fresh `origin/main` (only up to 046 there), so unaware of 047/050/051/052 — 053 is the next free slot above all of them. Not staging-validated (this branch was built read-only/local-only, no staging apply attempted). Full reasoning: `docs/engineering/REVENUECAT_SANDBOX_PROVISIONING_P0.md`. |
| 054 | `feature/number-lifecycle-sweep` (PR #49) | `054_number_lifecycle_sweep_run_evidence.sql` | Direct continuation of 052 in the same branch — Priority 4's scheduler run-evidence table. Not staging-validated (PGlite-only). |

**No further collisions in this picture.** Five distinct branches, five distinct numbers.

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
9. Wire the actual daily invocation — **now built tonight** (Priority 4): `services/numberLifecycleSweepScheduler.js` + migration 054's run-evidence table, wired into `server.js` via the exact same `setTimeout`-then-`setInterval` pattern as `runTwilioNumberReleaseCheck`. **Explicitly OFF by default** behind `ENABLE_NUMBER_LIFECYCLE_SWEEP_SCHEDULE=true` — merging/deploying PR #49 does NOT start the schedule; a human must set that env var afterward. Do that only once 052 AND 054 are both live in production and step 7 above is confirmed clean.
10. **DECISION REQUIRED, unresolved from tonight**: how a test/reviewer account holder is actually notified of the 14-day pre-expiry warning (SMS/email/ops-only). The runner defaults to an ops-only alert until this is decided. (Priority 5 separately confirmed tonight that the ops-only path already leaves sufficient durable evidence for a dashboard to surface later — see `docs/engineering/PRIORITY_5_EXPIRY_WARNING_DURABILITY.md` — so this DECISION REQUIRED is only about the *customer-facing* channel, not about durability.)

### Stage 3 — admin dashboard follow-up (PR #47 extension)
11. Once migration 052 is live, extend `services/adminNumberLifecycleReconciliation.js` (PR #47) to also read `twilio_release_last_attempt_at`/`twilio_release_last_error`/`twilio_release_attempt_count` and surface a `failedReleaseAttemptCount`-style anomaly. **Not done tonight on purpose**: adding these column references to PR #47 before migration 052 exists in a database would break that endpoint with a live "column does not exist" error the moment it's queried against one that doesn't have 052 yet.
11a. **New tonight, same category of dependency**: once migration 053 (PR #50) is ALSO live, add `, source, revenuecat_environment` to `database/adminMetrics.js`'s entitlements select (currently commented with this exact instruction at the call site) so `services/adminNumberLifecycleReconciliation.js`'s new `SANDBOX_TEST_PURCHASE_NO_NUMBER` anomaly (added tonight, Priority 7) actually activates in production — without it, a sandbox purchase still safely falls back to the pre-existing `ACTIVE_NO_NUMBER` anomaly (correct but less precise), never a crash. This was found as a genuine cross-PR interaction during tonight's own adversarial audit: PR #50's sandbox fix, combined with this dashboard's pre-existing "unclassified counts as genuine" rule, would otherwise have reproduced the exact false-alarm signal that raised tonight's own Priority 2.
12. Merge PR #47 (independently mergeable before or after this follow-up — the follow-up is additive to it, not a prerequisite for the base endpoint working).
13. Build the `admin-business.html` UI panel for the reconciliation endpoint (backend from #47 is complete and tested; this is a smaller, separate frontend task, explicitly out of tonight's scope — Dashboard ownership stays with whoever owns that UI, per the explicit instruction not to build a competing dashboard).

### Not part of this plan, flagged for the owning teams
- Dashboard's 050 (`manual_cost_schedules.sql`) references Finance's old pre-renumbering "048" — will need updating against the real 051 before Dashboard's branch can integrate cleanly.
- Finance's 051 file header should be corrected from "DRAFT — NOT APPLIED" to reflect that it's genuinely live on staging (independently verified tonight), so the next person reading that file isn't misled the way this plan almost was.

### Stage 4 — RevenueCat sandbox fix (PR #50, new tonight)
14. Migration 053 has no dependency on 047/050/051/052/054 and can apply to production independently, same discipline as every other migration tonight: pre-flight, dry-run, apply, verify.
15. Merge PR #50.
16. Revisit Priority 2/3's underlying question (see below) now that new sandbox purchases can no longer silently provision real numbers — any STILL-unexplained entitled-household-with-no-number after this ships is a stronger signal of a genuine gap, not sandbox noise.

## Blocked tonight, needs Andrew (Priorities 2 & 3)

Both require reading real production data (Finance's own findings are about production, not staging) and both attempts to link/query production tonight were correctly refused by Claude Code's own permission system (shared-resource/production-deploy category, same as the migration-repair calls above) — this is the intended, safe behaviour of that guard, not a bug, and no workaround was attempted. **DECISION REQUIRED**: either grant this session explicit approval to run read-only production queries (`supabase link --project-ref psbzynxplxfbyrbdidmn` then `supabase db query --linked`, both read-only, relinking back to staging afterward per this session's own established discipline), or do this investigation yourself/hand it to whoever has production access. The exact queries needed:
- Priority 2: which households have `getActiveEntitlement()`-qualifying entitlements but `twilio_number IS NULL` — for each, check `twilio_provisioning_status`/`twilio_provisioning_last_error` to classify as failed-provisioning vs. something else. Worth re-checking AFTER PR #50 ships, since some of these may turn out to be exactly the sandbox-purchase pattern PR #50 fixes.
- Priority 3: `#8`'s current row in `twilio_number_quarantine` plus its household's current entitlement state — confirm whether 047 (once live) and Step 2's sweep (once scheduled) together already resolve this going forward, or whether the specific historical row itself needs a one-time manual correction.

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
