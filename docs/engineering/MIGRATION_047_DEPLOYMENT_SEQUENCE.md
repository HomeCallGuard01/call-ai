# Migration 047 — production deployment sequence

**Status: staging-validated, NOT applied to production. Prepared 2026-09-27.**

## What this closes

The real production incident, household `30f01a7a`, 2026-09-23: a Stripe cancellation scheduled a 30-day number release; an open-ended complimentary entitlement was granted four days later through a path that didn't cancel the pending schedule; the daily release job then took the number from an entitled household. Migration 047 closes this with three independent layers — see the migration file's own header for the full design. Comprehensively validated on staging tonight (see `docs/engineering/` session record / conversation history): the exact #8 sequence replayed against live staging data, confirmed fixed; upcoming-entitlement protection confirmed; genuinely-lapsed release lifecycle confirmed still working; rollback tested end-to-end in PGlite.

## Deploy-ordering constraint — read before doing anything else

This change has **two parts that must land in the right order**: the SQL (migration 047) and Node application code (`database/households.js`, `services/twilioProvisioning.js`) that calls the new `household_blocks_number_release` RPC.

**The Node code fails closed if the RPC doesn't exist yet** (`.catch(() => true)`, treating the household as protected on any error) — so deploying the code before the migration can **never** cause a wrongful release. But it **would** temporarily block the account-deletion and quarantine-release paths entirely (every call errors, fails closed, nothing releases) until the migration catches up — not dangerous, but an avoidable operational pause.

**Correct order: migration first, then code deploy.**

## Exact sequence

### 1. Pre-flight (read-only)
- Confirm linked to **production** (`psbzynxplxfbyrbdidmn`), not staging — verify via `cat supabase/.temp/project-ref` before every subsequent step.
- Confirm production's migration history genuinely ends where expected (`supabase migration list --linked`) before touching anything — do not assume; production has previously been found to have tracking-history drift (see tonight's 030/046 investigation). If any drift exists, resolve it exactly the same way — physically verify each object, prove any duplicate/renumbered entries before repairing, never repair a migration that isn't physically confirmed applied.
- Confirm no other pending migrations would be swept in by `db push` — run `--dry-run` first (with `--include-all` if production has the same numeric-ordering situation staging did) and require it to show **only** `047_number_release_entitlement_guard.sql`, or whatever the true minimal truthful set is at that time. **If it proposes anything else, stop and report** — do not assume tonight's staging set (031/032/033/044/045) is still accurate; production's state may differ and must be independently re-verified at deploy time, the same discipline used throughout tonight's staging work.

### 2. Apply the migration
- `supabase db push --linked` (or the equivalent verified-minimal command from step 1).
- Immediately verify: `supabase migration list --linked` shows 047 matched; the 6 new/changed functions and the trigger exist (see the object list in tonight's staging validation — identical names apply to production); the 3 original release functions' bodies now contain the `household_blocks_number_release` guard call (fetch via `pg_get_functiondef` and confirm the guard lines are present, not just that the function exists).

### 3. Live, safe, read-only functional check (no synthetic writes required against production — prefer observation)
- Confirm `household_is_currently_entitled`/`household_has_upcoming_entitlement`/`household_blocks_number_release` can be called successfully against a handful of real, already-known household IDs from tonight's earlier read-only production work (e.g. the `ad_74uk`/`gardenroombuild` households already inspected) and return boolean results consistent with their already-known entitlement state. This avoids creating any synthetic production data at all.
- If a synthetic-data check is preferred instead (matching tonight's staging method exactly), it must go through the same disposable-household create → exercise → delete discipline used on staging tonight, with explicit approval first — not assumed.

### 4. Deploy the Node code
- Merge the PR (branch `fix/number-lifecycle-entitlement-guard`) to `main`.
- Railway auto-deploys from the `main` push — watch the GitHub commit-status check for that merge commit (`success`/`failure`), the same mechanism used for every deploy tonight.
- `GET /health` immediately after — expect `200 {"status":"ok"}`.

### 5. Post-deploy verification
- Trigger nothing manually. Watch for the next natural quarantine-release daily-runner cycle and confirm (via Railway logs, if available, or the `twilio_number_quarantine` table's `released_at`/error columns) that it runs without new `NUMBER RELEASE BLOCKED` errors for households that are genuinely not entitled, and correctly logs a block (not a silent skip) for any household that is.

## Rollback

`supabase/migrations/_rollbacks/047_rollback_number_release_entitlement_guard.sql` — tested end-to-end tonight (PGlite: applies cleanly, removes exactly the 4 new functions and the trigger, restores the 3 original functions, and **confirmed functionally** to genuinely restore pre-047 behaviour, not just remove the objects). Reversing this **reintroduces the #8 failure mode** — only appropriate if 047 itself is found to be wrong in production, never as a routine undo. If the SQL is rolled back, the Node code must also be reverted/redeployed first or in the same window (a deployed Node layer calling a since-removed RPC would fail closed and pause the release lifecycle exactly as described above, not fail dangerously, but should still be avoided).

## Explicitly not covered by 047

No automatic sweep for date-expired memberships yet (a household whose complimentary entitlement's `ends_at` has passed but whose `status` column is still `'active'` is not caught by anything here — confirmed directly in tonight's PGlite regression: `"047 complimentary whose end date has passed (status still 'active') no longer blocks release"` is correct per-row behavior, but nothing yet *schedules* that sweep). This is Priority 2 of tonight's work, prepared separately.
