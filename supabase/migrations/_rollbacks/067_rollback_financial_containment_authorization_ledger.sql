-- Rollback for 067_financial_containment_authorization_ledger.sql (was supabase/provisional/financial_containment_authorization_ledger.sql)
-- STATUS: PROVISIONAL DRAFT — NOT APPLIED ANYWHERE.
-- Drops every fc_* object. Destroys the authorisation ledger: export
-- fc_ledger / fc_reservations / fc_events first if any of it matters.
begin;
drop function if exists public.fc_authorize_call(uuid, text, boolean, boolean, boolean, timestamptz, timestamptz, timestamptz, jsonb);
drop function if exists public.fc_settle_call(text, integer, integer, text, timestamptz);
drop function if exists public.fc_mark_monitoring_started(text);
drop function if exists public.fc_renew_lease(text, timestamptz, jsonb);
drop function if exists public.fc_due_leases(timestamptz, integer);
drop function if exists public.fc_record_termination(text, boolean, text, timestamptz);
drop function if exists public.fc_note_provider_check(text, text, timestamptz);
drop function if exists public.fc_adopt_degraded_call(uuid, text, timestamptz, integer, timestamptz, timestamptz, timestamptz);
drop function if exists public.fc_authorize_spend(text, uuid, text, integer, timestamptz, timestamptz, timestamptz, jsonb);
drop function if exists public.fc_record_actual(text, text, text, text, numeric, timestamptz);
drop function if exists public.fc_admin_adjust(uuid, numeric, text, text, text, text, timestamptz, timestamptz, timestamptz);
drop function if exists public.fc_set_kill_switch(boolean, text, text);
drop function if exists public.fc_reset_breaker(text, text);
drop function if exists public.fc_set_policy(jsonb, text, text);
drop function if exists public.fc_set_budget_profile(text, numeric, numeric, text, numeric, boolean, text, text);
drop function if exists public.fc_refresh_entitled_count(timestamptz);
drop function if exists public.fc_household_status(uuid, timestamptz);
drop function if exists public.fc_global_status(timestamptz);
drop function if exists public.fc_check_invariants();
drop function if exists public.fc_settle_locked(public.fc_reservations, integer, integer, text, timestamptz);
drop function if exists public.fc_global_gate(jsonb, timestamptz, numeric, numeric, boolean, uuid, text);
drop function if exists public.fc_account(uuid, timestamptz, timestamptz, timestamptz, jsonb);
drop function if exists public.fc_resolve_profile(uuid, timestamptz);
drop function if exists public.fc_window_sums(timestamptz);
drop function if exists public.fc_global_caps(jsonb, public.fc_global_state, timestamptz);
drop function if exists public.fc_effective_policy(jsonb);
drop function if exists public.fc_event(text, text, uuid, text, jsonb);
drop function if exists public.fc_bump_minute(timestamptz, numeric, numeric, numeric, numeric, integer, numeric);
drop function if exists public.fc_minute(timestamptz);
drop function if exists public.fc_call_cost(integer, numeric, numeric, integer, boolean, integer, numeric, numeric);
drop table if exists public.fc_ledger;
drop table if exists public.fc_events;
drop table if exists public.fc_reservations;
drop table if exists public.fc_budget_accounts;
drop table if exists public.fc_spend_minutes;
drop table if exists public.fc_global_state;
drop table if exists public.fc_policy_audit;
drop table if exists public.fc_budget_profiles;
drop table if exists public.fc_policy;
commit;
