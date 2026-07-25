-- DIAGNOSTIC variant of 019_subscription_event_ordering_guard.sql
--
-- Not a tracked migration — lives outside supabase/migrations/ deliberately
-- (see 016_twilio_repair.sql and siblings in this same directory for the
-- established precedent of one-off diagnostic/repair scripts kept apart
-- from the numbered migration chain the pglite test suite auto-applies).
--
-- Purpose: two prior runs of 019 in the Supabase SQL Editor each reported
-- a successful commit, but neither the column nor the new function
-- overload actually existed afterwards (confirmed via direct
-- information_schema.columns / pg_proc queries). The most recent version
-- of 019 added a single assertion at the very end that fails loudly if
-- the end state is wrong — but it does not say WHERE in the script things
-- went wrong if it does fail, or silently succeed if it doesn't.
--
-- This version prints a RAISE NOTICE after every major step. Postgres
-- sends NOTICE messages to the client as soon as they're raised, not
-- buffered until COMMIT — so even if this transaction later aborts and
-- is rolled back, every notice already printed before that point remains
-- visible in the SQL Editor's output. Whichever notice is the LAST one
-- you see is the last step that actually ran; the step immediately after
-- it is where to look for the problem.
--
-- Run this instead of 019 itself for this troubleshooting pass. Once the
-- real cause is found and fixed, apply the real (non-diagnostic)
-- 019_subscription_event_ordering_guard.sql as the actual tracked
-- migration — this file's only job is to localize the failure.

begin;

do $$ begin raise notice '[019-diag] STEP 0: transaction started (BEGIN reached)'; end $$;

-- Ownership check, added after the first diagnostic pass. DROP FUNCTION
-- and CREATE OR REPLACE FUNCTION on an existing function both require
-- the calling role to either own that function or be a superuser —
-- there is no separate grantable "DROP"/"REPLACE" privilege for
-- functions the way there is for table DML. 013's own header comment
-- notes these functions are SECURITY DEFINER, executing with their
-- OWNER's privileges, not the caller's — so who owned the original
-- 8-argument function (whoever ran 013/015) matters here. If this SQL
-- Editor session's role is not that same owner and not a superuser, the
-- DROP FUNCTION statement below would raise a real permission-denied
-- error — printing this now, before that statement runs, so the owner
-- and current role are on record regardless of what happens next.
do $$
declare
  v_current_user text;
  v_session_user text;
  v_fn_owner text;
begin
  select current_user, session_user into v_current_user, v_session_user;

  select r.rolname into v_fn_owner
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  join pg_roles r on r.oid = p.proowner
  where n.nspname = 'public'
    and p.proname = 'process_stripe_webhook_event'
    and p.pronargs = 8;

  raise notice '[019-diag] STEP 0.5: current_user=%, session_user=%, existing 8-arg function owner=%',
    v_current_user, v_session_user, coalesce(v_fn_owner, '<no 8-arg function found>');
end $$;

alter table public.subscriptions
  add column if not exists stripe_event_created timestamptz;

do $$
declare
  v_exists boolean;
begin
  select exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'subscriptions'
      and column_name = 'stripe_event_created'
  ) into v_exists;

  if v_exists then
    raise notice '[019-diag] STEP 1 OK: ALTER TABLE ran, stripe_event_created column now visible inside this transaction';
  else
    raise exception '[019-diag] STEP 1 FAILED: ALTER TABLE appeared to run but stripe_event_created is still not visible — stop here, this is the failure point';
  end if;
end $$;

drop function if exists public.process_stripe_webhook_event(
  text, uuid, text, text, text, text, timestamptz, boolean
);

do $$
declare
  v_old_count integer;
begin
  select count(*) into v_old_count
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'process_stripe_webhook_event'
    and p.pronargs = 8;

  raise notice '[019-diag] STEP 2 OK: DROP FUNCTION ran, old 8-argument overload count is now %', v_old_count;
end $$;

create or replace function public.process_stripe_webhook_event(
  p_stripe_event_id text,
  p_household_id uuid,
  p_stripe_customer_id text,
  p_stripe_subscription_id text,
  p_stripe_price_id text,
  p_subscription_status text,
  p_current_period_end timestamptz,
  p_cancel_at_period_end boolean,
  p_stripe_event_created timestamptz default now()
)
returns text
language plpgsql
security definer
set search_path = ''
as $func$
declare
  v_actual_customer_id text;
  v_qualifies boolean;
  v_rows_affected integer;
begin
  begin
    select h.stripe_customer_id
      into v_actual_customer_id
      from public.households h
      where h.id = p_household_id;

    if v_actual_customer_id is null or v_actual_customer_id <> p_stripe_customer_id then
      raise exception
        'process_stripe_webhook_event: household % does not match stripe_customer_id % (household has %)',
        p_household_id, p_stripe_customer_id, coalesce(v_actual_customer_id, '<null>');
    end if;

    insert into public.subscriptions (
      household_id, stripe_subscription_id, stripe_price_id, status,
      current_period_end, cancel_at_period_end, stripe_event_created
    )
    values (
      p_household_id, p_stripe_subscription_id, p_stripe_price_id, p_subscription_status,
      p_current_period_end, p_cancel_at_period_end, p_stripe_event_created
    )
    on conflict (stripe_subscription_id) do update
      set stripe_price_id = excluded.stripe_price_id,
          status = excluded.status,
          current_period_end = excluded.current_period_end,
          cancel_at_period_end = excluded.cancel_at_period_end,
          stripe_event_created = excluded.stripe_event_created,
          updated_at = now()
      where public.subscriptions.stripe_event_created is null
         or excluded.stripe_event_created >= public.subscriptions.stripe_event_created;

    get diagnostics v_rows_affected = row_count;

    if v_rows_affected = 0 then
      update public.stripe_webhook_events
        set status = 'ignored', processed_at = now()
        where stripe_event_id = p_stripe_event_id;

      return 'processed';
    end if;

    v_qualifies := p_subscription_status in ('trialing', 'active', 'past_due');

    if v_qualifies then
      if not exists (
        select 1 from public.entitlements e
        where e.household_id = p_household_id and e.status = 'active'
      ) then
        insert into public.entitlements (
          household_id, entitlement_type, status, source, external_reference
        )
        values (
          p_household_id, 'paid_subscription', 'active', 'stripe', p_stripe_subscription_id
        );
      end if;
    else
      update public.entitlements e
        set status = 'expired', ends_at = now()
        where e.household_id = p_household_id
          and e.status = 'active'
          and e.external_reference = p_stripe_subscription_id;
    end if;

    update public.stripe_webhook_events
      set status = 'processed', processed_at = now()
      where stripe_event_id = p_stripe_event_id;

    return 'processed';

  exception when others then
    update public.stripe_webhook_events
      set status = 'failed',
          error = sqlerrm,
          last_attempt_at = now()
      where stripe_event_id = p_stripe_event_id;

    return 'failed';
  end;
end;
$func$;

do $$
declare
  v_new_count integer;
begin
  select count(*) into v_new_count
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'process_stripe_webhook_event'
    and p.pronargs = 9;

  if v_new_count = 1 then
    raise notice '[019-diag] STEP 3 OK: CREATE OR REPLACE FUNCTION ran, exactly 1 nine-argument overload now exists';
  else
    raise exception '[019-diag] STEP 3 FAILED: expected exactly 1 nine-argument overload after CREATE OR REPLACE, found % — stop here, this is the failure point', v_new_count;
  end if;
end $$;

revoke all on function public.process_stripe_webhook_event(
  text, uuid, text, text, text, text, timestamptz, boolean, timestamptz
) from public;

do $$ begin raise notice '[019-diag] STEP 4 OK: REVOKE ALL FROM public ran'; end $$;

grant execute on function public.process_stripe_webhook_event(
  text, uuid, text, text, text, text, timestamptz, boolean, timestamptz
) to service_role;

do $$ begin raise notice '[019-diag] STEP 5 OK: GRANT EXECUTE TO service_role ran'; end $$;

-- Final full assertion, same as the real 019 — if every step above
-- printed OK, this should be a formality, but it's kept as the
-- last-line-of-defence in case something changed state without going
-- through one of the checkpoints above.
do $$
declare
  v_column_exists boolean;
  v_old_fn_count integer;
  v_new_fn_count integer;
begin
  select exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'subscriptions'
      and column_name = 'stripe_event_created'
  ) into v_column_exists;

  select count(*) into v_old_fn_count
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'process_stripe_webhook_event' and p.pronargs = 8;

  select count(*) into v_new_fn_count
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'process_stripe_webhook_event' and p.pronargs = 9;

  if not v_column_exists or v_old_fn_count <> 0 or v_new_fn_count <> 1 then
    raise exception '[019-diag] STEP 6 FAILED: final state wrong — column_exists=%, old_overloads=%, new_overloads=%',
      v_column_exists, v_old_fn_count, v_new_fn_count;
  end if;

  raise notice '[019-diag] STEP 6 OK: final assertion passed — column exists, 0 old overloads, 1 new overload';
end $$;

do $$ begin raise notice '[019-diag] STEP 7: about to COMMIT'; end $$;

-- Informational output alongside the notices above.
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public' and table_name = 'subscriptions'
  and column_name = 'stripe_event_created';

select
  p.pronargs as arg_count,
  pg_get_function_identity_arguments(p.oid) as identity_arguments,
  pg_get_function_arguments(p.oid) as arguments_with_defaults
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'process_stripe_webhook_event'
order by p.pronargs;

commit;

do $$ begin raise notice '[019-diag] STEP 8: COMMIT statement issued (this notice printing does NOT itself prove the commit succeeded — check the SQL Editor''s own status/command-tag for this statement, and re-query after the fact to be sure)'; end $$;
