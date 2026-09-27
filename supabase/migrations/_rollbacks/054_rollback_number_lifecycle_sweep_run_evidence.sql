-- Rollback for 054_number_lifecycle_sweep_run_evidence.sql.
--
-- Drops the new table only. No other change to reverse. Safe to run
-- even while the scheduler code is still deployed: a write to a
-- now-missing table fails, but per this migration's own code-side
-- caller (services/numberLifecycleSweepScheduler.js), that failure is
-- caught and logged, never allowed to crash the sweep itself or block
-- the real household actions it already completed.

begin;

drop table if exists public.number_lifecycle_sweep_runs;

commit;

-- Read-only verification — run after commit.
do $$
begin
  if to_regclass('public.number_lifecycle_sweep_runs') is not null then
    raise exception 'MIGRATION 054 ROLLBACK VERIFICATION FAILED: public.number_lifecycle_sweep_runs still exists';
  end if;
end
$$;
