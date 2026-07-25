-- Rollback for 019_subscription_event_ordering_guard.sql
--
-- STATUS: ROLLBACK SCRIPT — not part of the forward migration chain, kept
-- alongside 019 for reference only. Only run this if 019 needs to be
-- reversed after being applied to the real Supabase project.
--
-- Reverts process_stripe_webhook_event to 015's exact 8-argument signature
-- and behaviour (byte-for-byte the same function body as 015 defines).
-- Does NOT drop the stripe_event_created column — dropping it would
-- destroy the ordering data recorded by every event processed while 019
-- was live, and an orphan nullable column is harmless if left in place.
-- If the column genuinely needs removing too, do that as a separate,
-- deliberate follow-up once you've confirmed nothing still reads it.
--
-- Application-code note: routes/billing.js and database/billing.js were
-- updated in the same commit as 019 to pass p_stripe_event_created on both
-- webhook call sites. Rolling back this SQL alone leaves those call sites
-- passing a 9th argument to a function that (after this rollback) only
-- accepts 8 — that application commit must be reverted or redeployed
-- alongside running this script, not independently.

begin;

drop function if exists public.process_stripe_webhook_event(
  text, uuid, text, text, text, text, timestamptz, boolean, timestamptz
);

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
