# Tomorrow's integration plan — PR #45/#46/#47/#49

**Prepared 2026-09-27 (overnight autonomous session). Nothing in this plan has been executed — it is the ordered sequence for Andrew to review and authorise.**

## Why order matters here

PR #49 (Step 2) is *built on top of* PR #45 (047) — it targets that branch, not `main`, and cannot be merged independently. PR #47 (admin dashboard) will need a small follow-up once #49's migration lands, to actually surface the new durable release-attempt evidence. #46 (tooling) is fully independent and can move any time. Merging out of order either fails outright (Step 2 can't merge without 047) or leaves the admin dashboard unable to show data that doesn't exist yet (harmless, just incomplete) — nothing here is dangerous if done out of order, but doing it in order avoids rework.

## Sequence

### Stage 0 — no dependencies, merge any time
**PR #46** (migration safety tooling). Pure scripts/docs, zero runtime risk. Recommend merging first regardless of everything else, since `scripts/check-migration-numbering.js` should be run against every other PR's migration file before it merges — including confirming migration 050's placeholder number in PR #49.

### Stage 1 — production migration + code (047)
1. Run `scripts/check-migration-numbering.js` (from #46, once merged) to reconfirm 047 doesn't clash with anything newly merged elsewhere.
2. Apply migration 047 to **production**, following the exact sequence in `docs/engineering/MIGRATION_047_DEPLOYMENT_SEQUENCE.md` (PR #45) — pre-flight drift check, dry-run, apply, verify. **Requires Andrew's explicit go-ahead**; this is the one production-database step in the whole plan.
3. Merge PR #45 to `main` (only after step 2 — the Node code fails closed if deployed first, but the correct order avoids even that transient pause).
4. Confirm Railway deploy succeeds, `/health` green.

### Stage 2 — Step 2 (049 — re-numbered, see below)
5. Re-target PR #49 from `fix/number-lifecycle-entitlement-guard` to `main` (now that #45 is merged into it).
6. **Before merging**: resolve migration 050's numbering placeholder. Check whether the billing-ledger branch (048, paused) or the monitored-minute allowance branch (049, expected) have moved since tonight; renumber `050_number_lifecycle_sweep_evidence.sql` accordingly if either has claimed a lower number in the meantime. Run `check-migration-numbering.js` again to confirm.
7. Apply the (possibly renumbered) migration to production, same discipline as 047: pre-flight, dry-run confirming exactly one migration proposed, apply, verify all 3 new RPCs + table + columns exist and match.
8. Merge PR #49.
9. Wire the actual daily invocation — `runNumberLifecycleSweep` currently has no caller anywhere in `server.js`/a scheduled job. **This is a real gap to close before Step 2 does anything in production**: decide whether it joins the existing `setInterval`-based daily pattern already used for `runTwilioNumberReleaseCheck`/`runQuarantinedNumberReleaseCheck` (server.js), or a separate schedule. Not built tonight — flagged here explicitly rather than assumed.
10. **DECISION REQUIRED, unresolved from tonight**: how a test/reviewer account holder is actually notified of the 14-day pre-expiry warning (SMS/email/ops-only). The runner defaults to an ops-only alert until this is decided.

### Stage 3 — admin dashboard follow-up (PR #47 extension)
11. Once migration 050 (or its renumbered equivalent) is live, extend `services/adminNumberLifecycleReconciliation.js` (PR #47) to also read `twilio_release_last_attempt_at`/`twilio_release_last_error`/`twilio_release_attempt_count` and surface a `failedReleaseAttemptCount`-style anomaly — the durable evidence these columns provide is exactly what PR #47's own commit message flagged as "not built tonight." **Not done tonight on purpose**: adding these column references to PR #47 before migration 050 exists in either database would break that endpoint with a live "column does not exist" error the moment it's queried against a database that doesn't have 050 yet.
12. Merge PR #47 (independently mergeable before or after this follow-up — the follow-up is additive to it, not a prerequisite for the base endpoint working).
13. Build the `admin-business.html` UI panel for the reconciliation endpoint (backend from #47 is complete and tested; this is a smaller, separate frontend task, explicitly out of tonight's scope — Dashboard ownership stays with whoever owns that UI, per the explicit instruction not to build a competing dashboard).

## Rollback points

- **047**: `supabase/migrations/_rollbacks/047_rollback_number_release_entitlement_guard.sql` — tested end-to-end tonight (PGlite), genuinely reintroduces pre-047 behaviour on rollback (by design — a rollback is a real revert, not a partial one).
- **050**: `supabase/migrations/_rollbacks/050_rollback_number_lifecycle_sweep_evidence.sql` — drops the 3 new RPCs, the warning table, and the 3 new households columns. No data loss beyond the evidence itself (which is additive, not depended on by anything else).
- **Code (PR #45/#49)**: standard Railway redeploy of the previous commit. Both fail closed if their RPCs are missing (047's Node guard treats an error as "entitled"; the sweep runner skips warnings and logs errors per-household without aborting), so a rollback ordering mistake pauses functionality rather than causing unsafe behaviour.

## Staging checks already complete (tonight)

- 047: the real #8 incident replayed and confirmed fixed; upcoming-entitlement, genuinely-lapsed-lifecycle, and new-entitlement-cancels-pending-release all confirmed; rollback tested.
- 050: all 3 new RPCs confirmed against live staging, including the full "complimentary expires → lifecycle begins" scenario end to end. All synthetic data cleaned up, zero residue.

## Explicitly not covered by this plan

- Actually wiring the sweep into a scheduled job (Stage 2, step 9) — a real, not-yet-closed gap.
- The customer-notification channel decision (Stage 2, step 10).
- The `complete.tsx`/Home-tab Android-consolidated reconciliation (separate, unrelated to this plan — see the earlier tonight handover).
- Any Android/iOS build, App Store/Play submission, pricing, or website change.
