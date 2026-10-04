-- 073_rollback_entitlements_store_subscription_state.sql
--
-- STATUS: DRAFT — NOT APPLIED. Reverses 073_entitlements_store_subscription_state.sql.
-- Refuses (raises) if any store lifecycle state has been recorded: that is
-- customer billing history. Export it first if a rollback is really needed:
--   select id, household_id, store_will_renew, store_cancel_reason,
--          store_billing_issue_at, store_grace_period_expires_at,
--          store_refunded_at, store_state_event_at
--   from public.entitlements where store_state_event_at is not null;
-- The application code tolerates the columns being absent (it then behaves
-- exactly as before 073), so rolling back the schema needs no code rollback.

begin;

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'entitlements' and column_name = 'store_state_event_at'
  ) and exists (select 1 from public.entitlements where store_state_event_at is not null) then
    raise exception 'rollback 073: % entitlement(s) carry recorded store lifecycle state — export first',
      (select count(*) from public.entitlements where store_state_event_at is not null);
  end if;
end;
$$;

alter table public.entitlements drop constraint if exists entitlements_store_cancel_reason_check;
alter table public.entitlements
  drop column if exists store_state_event_at,
  drop column if exists store_refunded_at,
  drop column if exists store_grace_period_expires_at,
  drop column if exists store_billing_issue_at,
  drop column if exists store_cancel_reason,
  drop column if exists store_will_renew;

commit;
