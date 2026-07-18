-- Stripe Integration: households.stripe_customer_id
--
-- STATUS: DRAFT — NOT APPLIED
--
-- Purpose: adds the column that links a household to its Stripe Customer.
-- One household = one Stripe Customer, created lazily server-side the
-- first time that household starts checkout (never client-supplied).
--
-- Purely additive: no existing column, row, policy, or grant is touched.
-- Nullable because most households will not have started checkout yet;
-- unique because a Stripe Customer must never be shared across two
-- households. Multiple households may simultaneously have a null value —
-- Postgres unique constraints do not treat NULLs as equal to each other,
-- so this does not block more than one un-subscribed household existing
-- at once.
--
-- Run this AFTER:
-- 002_create_households_and_roles.sql

begin;

alter table public.households
  add column if not exists stripe_customer_id text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'households_stripe_customer_id_key'
      and conrelid = 'public.households'::regclass
  ) then
    alter table public.households
      add constraint households_stripe_customer_id_key
      unique (stripe_customer_id);
  end if;
end
$$;

commit;
