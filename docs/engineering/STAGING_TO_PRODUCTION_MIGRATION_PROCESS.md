# Staging → production migration process

**Status: documents the process actually used successfully tonight (2026-09-27) to resolve real drift on both staging and production, plus the two new tooling safeguards added alongside this document.** Not a new process — a written-down version of what already worked, plus automation for the parts that previously depended on careful manual repetition.

## Why this exists

Tonight's session found genuine migration-history drift on **both** staging and production — not a one-off. Root causes, confirmed directly (not assumed):
- A file renumbering (`030` → `035`) left a stale duplicate tracking row on both projects.
- Migrations `046` (and, on staging only, `031`/`032`/`033`/`044`/`045`) were applied at various points without the CLI's tracking table being updated to match — sometimes because `supabase db push` was deliberately bypassed (executing a migration file directly via `db query --file`) to avoid also sweeping in unrelated pending migrations.

None of this caused any data-level incident — every case was caught and resolved by physically verifying reality before touching the tracking table. This document exists so that verification discipline doesn't have to be reinvented from scratch (or skipped under time pressure) next time.

## The core rule

**Physical reality is the source of truth. The tracking table is a claim about physical reality, and claims must be checked, not trusted — in either direction.** A tracking-table row that says "applied" doesn't prove the object exists; a tracking-table row that's missing doesn't prove the object doesn't exist.

## Tooling added tonight

- `scripts/check-migration-numbering.js` — local, no-database, static check for duplicate migration version numbers across files (the class of bug that produced the `030`/`035` duplicate). Run any time; safe in CI once one exists.
- `scripts/verify-migration-history.js --expect-project <ref>` — read-only, requires the linked project to match an explicit expectation (refuses loudly on mismatch — the single highest-value guard against the "meant to check staging, was actually linked to production" class of mistake) and reports migration-history drift in the same LOCAL-ONLY/REMOTE-ONLY/MATCH classification used throughout tonight's investigation.
  - **Its output depends on which worktree/branch you run it from** — the Supabase CLI's tracking table is compared against whatever migration files exist locally at that moment, so a worktree that hasn't yet merged a given migration file will correctly report that migration as "remote-only" even if it's genuinely, correctly applied. This is not a bug; always run it from a worktree containing every migration file you expect to already be applied.

Neither tool applies or repairs anything — they only report. Applying/repairing remains a deliberate, separate, explicitly-approved step, exactly as tonight.

## Process

### 1. Before touching anything
- `supabase link --project-ref <ref>` — link explicitly. Never assume a prior session's link state; the CLI's link is a plain local file (`supabase/.temp/project-ref`), not itself protected by anything.
- `node scripts/verify-migration-history.js --expect-project <ref>` — confirms the link and reports drift in one step.

### 2. For each REMOTE-ONLY entry (a tracking row with no local file)
Do not assume it's a harmless historical renumbering. Prove it:
```sql
select version, name from supabase_migrations.schema_migrations where version = '<N>';
```
Compare the `name` column against every local migration file's own name. If — and only if — another local file's `name` matches exactly (tonight's `030`/`035` case, both named `household_voice_client_registered_at`), that's direct evidence of a renumbering, not an assumption. Cross-check by comparing the live object definitions (`pg_get_functiondef`, `information_schema.columns`) against that local file too. Only then: `supabase migration repair --status reverted <N>`.

### 3. For each LOCAL-ONLY entry (a pending migration)
Do not assume it's simply unapplied. For every object the migration file creates or changes, check physical existence directly:
```sql
select to_regclass('public.<table>');                    -- tables
select 1 from information_schema.columns where ...;        -- columns
select 1 from pg_proc p join pg_namespace n on ... ;        -- functions
```
- **All objects present, matching the current migration file** (compare via `pg_get_functiondef` for anything defining a function) → physically applied, tracking wrong → `supabase migration repair --status applied <N>`.
- **No objects present** → genuinely unapplied. Do not repair; apply it for real (`supabase db push`, possibly with `--include-all` — see below).
- **Some present, some not** → stop and investigate individually; do not guess a blanket classification.

### 4. Before any real `db push`
`supabase db push --linked --dry-run` first, always. If the CLI reports `LegacyDbPushMissingLocalError` (a stray remote-only entry blocking everything) or `LegacyDbPushMissingRemoteError` (local files numbered before the last-applied remote version — tonight's exact situation once `046` was repaired ahead of the still-genuinely-pending `031`–`045`), resolve the underlying cause per steps 2–3 above before retrying, and re-run with `--include-all` only once you've independently confirmed (via the dry-run's own proposed list) that the resulting set is exactly what you expect — never pass `--include-all` blind.

### 5. Apply
`supabase db push --linked` (with `--include-all` only if step 4 required it). Immediately re-run `verify-migration-history.js` to confirm full alignment.

### 6. Relink to staging as the resting state
Every production session tonight ended by relinking back to staging — a deliberate habit, not an accident, so a later session's first action is never silently against production.

## What this document deliberately does not change

No change to the Supabase CLI itself, no new deployment pipeline, no CI system introduced (this repository has none — see `docs/due_diligence/DUE_DILIGENCE/04 Security.md`). Both scripts are opt-in, run manually, additive only.
