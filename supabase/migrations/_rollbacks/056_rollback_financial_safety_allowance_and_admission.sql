-- Rollback for 056_financial_safety_allowance_and_admission.sql.
-- DESTRUCTIVE to usage counters and safety audit rows: export them first
-- if the application has been writing. Deploy application code that no
-- longer calls these RPCs BEFORE running this.
begin;
drop function if exists public.claim_sms_send(uuid, timestamptz, timestamptz, timestamptz, numeric, jsonb);
drop function if exists public.claim_usage_notification(uuid, timestamptz, text);
drop function if exists public.record_monitoring_progress(text, text, integer, numeric, timestamptz, boolean, text);
drop function if exists public.attach_monitoring_stream(text, text);
drop function if exists public.begin_monitoring_session(uuid, text, timestamptz, timestamptz, timestamptz, integer, boolean, jsonb);
drop function if exists public.end_call(text, timestamptz, text);
drop function if exists public.admit_call(uuid, text, text, boolean, boolean, timestamptz, timestamptz, timestamptz, jsonb);
drop function if exists public.fs_household_exposure(uuid, date, timestamptz, timestamptz);
drop function if exists public.fs_close_call(text, timestamptz, text);
drop function if exists public.fs_add_usage(uuid, timestamptz, timestamptz, timestamptz, integer, numeric, integer, numeric, integer, numeric, integer, integer);
drop table if exists public.financial_safety_state;
drop table if exists public.financial_safety_events;
drop table if exists public.usage_notifications;
drop table if exists public.telephony_call_attempts;
drop table if exists public.telephony_call_sessions;
drop table if exists public.monitoring_sessions;
drop table if exists public.platform_usage_hours;
drop table if exists public.household_usage_days;
drop table if exists public.household_usage_periods;
alter table public.calls drop column if exists monitoring_status;
alter table public.entitlements drop column if exists plan_code;
commit;
