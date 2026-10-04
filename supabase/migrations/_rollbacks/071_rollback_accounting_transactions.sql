-- 071_rollback_accounting_transactions.sql
--
-- STATUS: DRAFT — NOT APPLIED. Reverses 071_accounting_transactions.sql.
-- Refuses (raises) if anything has been POSTED to Xero, because dropping the
-- sub-ledger would lose the only link between Xero documents and provider
-- transactions. Export the tables first if they hold anything you need.

begin;

do $$
begin
  if to_regclass('public.accounting_postings') is not null
     and exists (select 1 from public.accounting_postings where status = 'posted') then
    raise exception 'rollback 071: % posting(s) already in Xero — export accounting_* tables and reconcile in Xero first',
      (select count(*) from public.accounting_postings where status = 'posted');
  end if;
end;
$$;

drop function if exists public.acc_claim_source_event(text, text, text, text, text);
drop function if exists public.acc_complete_source_event(uuid, text, text, uuid[]);
drop function if exists public.acc_list_source_events();
drop function if exists public.acc_insert_transaction(jsonb);
drop function if exists public.acc_update_transaction(uuid, jsonb);
drop function if exists public.acc_get_transaction(uuid);
drop function if exists public.acc_find_transaction_by_key(text);
drop function if exists public.acc_find_transactions_by_ref(text, text);
drop function if exists public.acc_list_transactions(jsonb);
drop function if exists public.acc_raise_exception(jsonb);
drop function if exists public.acc_resolve_exception(text, text, text, text);
drop function if exists public.acc_list_exceptions(jsonb);
drop function if exists public.acc_enqueue_posting(jsonb);
drop function if exists public.acc_claim_due_postings(timestamptz, integer, integer);
drop function if exists public.acc_update_posting(uuid, jsonb);
drop function if exists public.acc_find_posting_by_key(text);
drop function if exists public.acc_list_postings(jsonb);
drop function if exists public.acc_upsert_settlement(jsonb);
drop function if exists public.acc_update_settlement(uuid, jsonb);
drop function if exists public.acc_list_settlements();

drop table if exists public.accounting_postings;
drop table if exists public.accounting_exceptions;
drop table if exists public.accounting_transactions;
drop table if exists public.accounting_source_events;
drop table if exists public.accounting_settlements;
drop function if exists public.accounting_transactions_guard();
drop function if exists public.accounting_postings_guard();

commit;
