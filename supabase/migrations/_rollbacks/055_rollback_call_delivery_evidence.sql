-- Rollback for 055_call_delivery_evidence.sql. Drops only the three
-- evidence columns and their index; no existing column or data is
-- touched. Safe to run once the application code that writes these
-- columns has been reverted (the writes fail open, so running this
-- first only produces logged write errors, not failed calls).

begin;

drop index if exists public.calls_dial_call_sid;

alter table public.calls
  drop column if exists push_failure_at,
  drop column if exists push_failure,
  drop column if exists dial_call_sid;

commit;
