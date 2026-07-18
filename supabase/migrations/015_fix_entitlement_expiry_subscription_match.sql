-- Stripe Integration: fix entitlement expiry to check subscription identity
--
-- STATUS: APPLIED
--
-- Purpose: process_stripe_webhook_event's non-qualifying branch (013) expires
-- *any* active entitlement for the household when *any* of its subscriptions
-- transitions to a non-qualifying status, without checking that the
-- terminating subscription is the one the entitlement is actually tied to.
--
-- Concretely discovered via: a household ended up with two subscriptions
-- (an accidental duplicate checkout) but only the newer one ever backed the
-- active entitlement (entitlements.external_reference). Cancelling the
-- unrelated duplicate fired a customer.subscription.deleted event for it —
-- and under the original logic, processing that event would have expired
-- the household's genuine, paid, active entitlement, even though the real
-- subscription behind it was never touched.
--
-- Fix: only expire an active entitlement when its own external_reference
-- matches the subscription this event is actually about. A household with
-- multiple historical subscriptions (upgrades, retries, duplicates) should
-- only lose access when the *specific* subscription backing its current
-- entitlement stops qualifying — never as a side effect of some other
-- subscription on the same account changing state.
--
-- Run this AFTER:
-- 013_stripe_billing_rpc_functions.sql

begin;

create or replace function public.process_stripe_webhook_event(
  p_stripe_event_id text,
  p_household_id uuid,
  p_stripe_customer_id text,
  p_stripe_subscription_id text,
  p_stripe_price_id text,
  p_subscription_status text,
  p_current_period_end timestamptz,
  p_cancel_at_period_end boolean
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actual_customer_id text;
  v_qualifies boolean;
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
      current_period_end, cancel_at_period_end
    )
    values (
      p_household_id, p_stripe_subscription_id, p_stripe_price_id, p_subscription_status,
      p_current_period_end, p_cancel_at_period_end
    )
    on conflict (stripe_subscription_id) do update
      set stripe_price_id = excluded.stripe_price_id,
          status = excluded.status,
          current_period_end = excluded.current_period_end,
          cancel_at_period_end = excluded.cancel_at_period_end,
          updated_at = now();

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
      -- Only expire the entitlement that this specific subscription backs —
      -- see this migration's header for why household_id alone isn't enough.
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
$$;

revoke all on function public.process_stripe_webhook_event(
  text, uuid, text, text, text, text, timestamptz, boolean
) from public;
grant execute on function public.process_stripe_webhook_event(
  text, uuid, text, text, text, text, timestamptz, boolean
) to service_role;

commit;
