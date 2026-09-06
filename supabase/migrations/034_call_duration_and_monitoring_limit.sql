-- Call-monitoring cost-protection safeguard (V1 launch scope) — minimum
-- schema needed for: real call/monitored duration capture, the per-call
-- AI/live-monitoring safety limit, and its audit trail.
--
-- Renumbered from an earlier draft (032_call_duration_and_household_usage.sql)
-- that was never applied to staging or production and collided with the
-- real, already-applied 032_acquisition_events.sql — that draft is
-- superseded by this file and must not be reused. This migration also
-- deliberately narrows that draft's scope: the household-monthly-usage
-- table and its accumulate_household_monitored_seconds RPC are deferred
-- to V1.1 (the per-call limit below already bounds worst-case per-call
-- cost exposure; the monthly view is a real improvement, not a launch
-- blocker) — this migration adds only the three `calls` columns needed
-- for V1.
--
-- Closes a real data gap: `calls` has never recorded call duration in
-- any form, for any call, Known or Unknown. Note there is already a
-- `call_duration` column (migration 001) — it has never been written to
-- by any application code and is not reused here to avoid conflating a
-- long-dead column with this new, actually-wired-up one; a future
-- cleanup migration may drop it separately.
--
-- duration_seconds: the real, Twilio-reported duration of the dialled
-- leg (DialCallDuration from the <Dial> action callback — server.js's
-- /call-delivery-failed and the new /call-status route), covering
-- normal completion, either party hanging up, no-answer/busy/failed. A
-- red-line-terminated call (services/liveMonitoring/callTermination.js)
-- redirects the call away from its <Dial> before that action callback
-- can fire, so for that one case the application falls back to using
-- monitored_duration_seconds as a reasonable approximation (see
-- database/calls.js's recordMonitoringOutcome) — never left null when a
-- real duration estimate is available.
--
-- monitored_duration_seconds: how long services/liveMonitoring actually
-- ran AI transcription/scoring for this call — 0/null for every Known-
-- contact call (server.js's /voice never calls attachLiveMonitoring for
-- Known callers, so this column simply never applies to them) and for
-- any Unknown-caller call, populated once monitoring genuinely stops
-- (natural end-of-call, red-line termination, or the
-- monitoring_limit_reached cutoff below).
--
-- monitoring_limit_reached: true only when the configurable per-call
-- monitoring safety limit (services/liveMonitoring/monitoringLimit.js,
-- default 30 minutes) was hit — the call itself was never disconnected
-- when this happens, only the AI/Media-Streams pipeline stopped for the
-- remainder of that call. Kept as its own boolean (not inferred from
-- monitored_duration_seconds alone) so this specific, financially-
-- relevant event is directly queryable without a >= comparison against a
-- threshold that may itself change later.
--
-- Purely additive: no existing column altered, no existing row touched.

begin;

alter table public.calls
  add column if not exists duration_seconds integer,
  add column if not exists monitored_duration_seconds integer,
  add column if not exists monitoring_limit_reached boolean not null default false;

-- Read-only self-verification, matching this codebase's established
-- migration convention.
do $$
begin
  if to_regclass('public.calls') is null then
    raise exception 'MIGRATION 034 VERIFICATION FAILED: public.calls does not exist';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'calls'
      and column_name = 'duration_seconds' and data_type = 'integer'
  ) then
    raise exception 'MIGRATION 034 VERIFICATION FAILED: calls.duration_seconds missing or wrong type';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'calls'
      and column_name = 'monitored_duration_seconds' and data_type = 'integer'
  ) then
    raise exception 'MIGRATION 034 VERIFICATION FAILED: calls.monitored_duration_seconds missing or wrong type';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'calls'
      and column_name = 'monitoring_limit_reached' and data_type = 'boolean'
  ) then
    raise exception 'MIGRATION 034 VERIFICATION FAILED: calls.monitoring_limit_reached missing or wrong type';
  end if;
end
$$;

commit;
