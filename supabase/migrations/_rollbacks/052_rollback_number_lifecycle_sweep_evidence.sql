-- Rollback for 052_number_lifecycle_sweep_evidence.sql.
-- STATUS: not applied anywhere. Drops the new table and the three new
-- households columns. No other data changes. After rollback, the daily
-- sweep's 14-day warning can no longer track idempotency durably, and
-- release-attempt failures are no longer recorded durably — both revert
-- to log-only visibility, same as before this migration.

drop function if exists public.record_twilio_release_attempt(uuid, text);
drop function if exists public.record_entitlement_expiry_warning_sent(uuid, uuid);
drop function if exists public.expire_lapsed_entitlement(uuid);

alter table public.households
  drop column if exists twilio_release_last_attempt_at,
  drop column if exists twilio_release_last_error,
  drop column if exists twilio_release_attempt_count;

drop table if exists public.entitlement_expiry_warnings_sent;
