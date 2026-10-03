-- Rollback for 063_customer_allowance_credits_and_notices.sql.
-- DESTRUCTIVE to the allowance credit audit trail (paid top-up records):
-- export allowance_credits first if anything has been written. Deploy
-- application code that no longer calls these RPCs BEFORE running this.
-- Credits already applied to household_usage_periods.bonus_monitored_seconds
-- (056) are NOT removed by this rollback.
begin;
drop function if exists public.claim_allowance_notice_batch(timestamptz, integer, integer);
drop function if exists public.credit_allowance(uuid, timestamptz, timestamptz, text, integer, text, text, text, text, text, integer, text, text, text, boolean);
drop table if exists public.allowance_notice_deliveries;
drop table if exists public.allowance_credits;
commit;
