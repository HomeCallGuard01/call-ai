-- Rollback for 051_financial_ledger_and_telephony_usage.sql.
--
-- DESTRUCTIVE: drops every ledger row. Export financial_entries and
-- telephony_call_legs first if any production data exists. Nothing else
-- depends on these objects at the database level (dashboard 050's
-- manual_cost_schedules only posts into financial_entries from code), so
-- the rollback touches no other table. After running it, record the
-- rollback in the CLI history: supabase migration repair --status reverted 051
begin;

drop view if exists public.finance_monthly_contribution;
drop view if exists public.finance_household_monthly;
drop view if exists public.finance_monthly_summary;
drop view if exists public.finance_entries_reporting;
drop table if exists public.financial_entries;
drop table if exists public.telephony_call_legs;

commit;
