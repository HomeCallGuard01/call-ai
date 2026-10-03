-- Durable last-run evidence for the daily number-lifecycle sweep
-- (2026-09-27) — Priority 4 of tonight's directive: the scheduling
-- mechanism "must leave durable last-run evidence... not depend solely
-- on ephemeral Railway logs."
--
-- Confirmed gap before this migration: the sweep (services/
-- numberLifecycleSweep.js + numberLifecycleSweepRunner.js, migration
-- 052) had no production caller at all — nothing loaded households/
-- entitlements/classifications/quarantine rows and actually invoked it.
-- The existing precedent this mirrors (server.js's
-- runTwilioNumberReleaseCheck, 2026-08-23) has the identical gap itself:
-- its only evidence of having run is a console.log line, which Railway's
-- own log retention makes non-durable (see ADR-0019 / SECURITY_OVERVIEW.md
-- risk #8, already flagged tonight by migration 052). Rather than repeat
-- that gap, this migration adds one small table the scheduler writes to
-- unconditionally after every run, success or failure.
--
-- NUMBERING: 054. 053 is independently claimed by
-- fix/revenuecat-sandbox-environment-guard (a different branch, off a
-- fresh origin/main, for an unrelated P0 fix — see that branch's own
-- migration for the full reasoning). This migration is a direct
-- continuation of migration 052's own feature (Step 2 / PR #49) and
-- lives in the same worktree/branch (feature/number-lifecycle-sweep),
-- so it takes the next number in that branch's own sequence. Re-run
-- scripts/check-migration-numbering.js against full current state
-- before merging.
--
-- Purely additive: one new table, no existing table/column/constraint/
-- grant touched.
--
-- Rollback: drop the new table; see
-- supabase/migrations/_rollbacks/054_rollback_number_lifecycle_sweep_run_evidence.sql.

begin;

create table if not exists public.number_lifecycle_sweep_runs (
  id uuid primary key default gen_random_uuid(),

  started_at timestamptz not null,
  completed_at timestamptz,

  -- null completed_at + a row that exists = a run that started but never
  -- finished (crashed, process killed mid-run) — itself durable evidence
  -- worth surfacing on the admin dashboard, not just a happy-path log.
  households_evaluated integer,
  scheduled_count integer,
  expired_count integer,
  warned_count integer,
  alerted_count integer,
  error_count integer,

  -- Small, bounded, structured detail for whoever reviews a failed run —
  -- never raw exception objects/stack traces (same discipline as every
  -- other durable-evidence column this project has added, e.g. migration
  -- 052's twilio_release_last_error). Null on full success.
  fatal_error text,

  created_at timestamptz not null default now()
);

create index if not exists number_lifecycle_sweep_runs_started_at_idx
  on public.number_lifecycle_sweep_runs (started_at desc);

alter table public.number_lifecycle_sweep_runs enable row level security;
-- Same access model as every other operational/evidence table in this
-- project (e.g. migration 052's entitlement_expiry_warnings_sent) —
-- service_role only, no anon/authenticated policy. Admin dashboard reads
-- it via its own service-role client (routes/adminBusiness.js), same as
-- every other reconciliation source.
grant select, insert, update on public.number_lifecycle_sweep_runs to service_role;

-- No RPC wrapper: this table is written by trusted server-side scheduler
-- code only (never reachable from a customer-facing route), and
-- service_role already has direct grants here, matching the pattern this
-- project already uses for its own similarly-scoped evidence writes
-- (e.g. calls.dial_call_status, migration 044 -- a plain grant, not an
-- RPC, because the write path itself has no untrusted caller to guard
-- against). record_entitlement_expiry_warning_sent/
-- record_twilio_release_attempt (migration 052) are RPCs specifically
-- because they enforce idempotency/business rules a plain grant can't;
-- this table has no such rule to enforce, it is a pure append/update log.

commit;

-- Read-only verification — run after commit.
do $$
begin
  if to_regclass('public.number_lifecycle_sweep_runs') is null then
    raise exception 'MIGRATION 054 VERIFICATION FAILED: public.number_lifecycle_sweep_runs does not exist';
  end if;
end
$$;
