-- 055_rollback_account_classification_history.sql
--
-- STATUS: DRAFT — NOT APPLIED. Reverses 055_account_classification_history.sql.
-- Refuses (raises) if any account is already classified
-- 'other_non_customer', because 031's check cannot hold that value —
-- reclassify those accounts first. The audit history is DROPPED: export
-- account_classification_events first if it must be kept.

begin;

do $$
begin
  if exists (select 1 from public.account_classifications where classification = 'other_non_customer') then
    raise exception 'rollback 055: % account(s) are classified other_non_customer — reclassify them first',
      (select count(*) from public.account_classifications where classification = 'other_non_customer');
  end if;
end;
$$;

drop function if exists public.set_account_classification(uuid, text, text, uuid, text, text);
drop trigger if exists account_classification_events_no_update on public.account_classification_events;
drop table if exists public.account_classification_events;
drop function if exists public.account_classification_events_append_only();

alter table public.account_classifications
  drop constraint if exists account_classifications_classification_check;
alter table public.account_classifications
  add constraint account_classifications_classification_check
  check (classification in ('genuine_customer', 'internal_test', 'admin', 'reviewer', 'qa_automation'));

commit;
