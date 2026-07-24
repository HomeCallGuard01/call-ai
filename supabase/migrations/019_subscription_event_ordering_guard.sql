-- Stripe Integration: guard against out-of-order webhook delivery
--
-- STATUS: DRAFT — NOT APPLIED
--
-- Purpose: Stripe does not guarantee webhook delivery order (documented
-- Stripe behaviour, not this app's assumption). process_stripe_webhook_event
-- (013, patched by 015) previously applied whatever the latest-ARRIVING
-- event said, unconditionally — nothing compared it against the latest-
-- GENERATED event already applied. In the narrow case where two different,
-- genuinely state-changing events for the same subscription (e.g. "went
-- past_due" then "recovered to active") are delivered out of sequence, the
-- older one arriving second could transiently overwrite the correct newer
-- state, and could incorrectly re-activate an entitlement that a newer
-- event had already correctly expired.
--
-- Fix: store the real Stripe event's own `created` timestamp alongside
-- each subscription, and only apply an incoming event's subscription state
-- (and any entitlement consequence) when it is at least as recent as what's
-- already stored for that subscription. An event determined to be stale is
-- still marked 'ignored' on stripe_webhook_events (not 'failed' — nothing
-- went wrong, the event was correctly evaluated and correctly not applied)
-- rather than reusing 'processed', so a stale-but-harmless event is
-- distinguishable later from one that actually changed state — useful for
-- the same audit/dispute-resolution purpose 011 already documented for
-- this table.
--
-- p_stripe_event_created defaults to now() so every existing call site
-- (the real webhook handler, the reconcile-session fallback, and every
-- existing test in tests/migrations.pglite.test.mjs) continues to work
-- unmodified — only call sites that want ordering protection need to pass
-- a real value. The real webhook handler is updated in the same commit as
-- this migration to always pass the genuine event.created value; the
-- reconcile-session fallback passes the current time (a live GET straight
-- from Stripe's API is always at least as fresh as any past webhook).
--
-- Run this AFTER:
-- 015_fix_entitlement_expiry_subscription_match.sql

begin;

alter table public.subscriptions
  add column if not exists stripe_event_created timestamptz;

-- CREATE OR REPLACE only replaces a function with the exact same parameter
-- signature — adding a new (even defaulted) parameter creates a distinct
-- overload instead, leaving 015's original 8-parameter version callable
-- alongside it. Postgres would then prefer an exact 8-argument match over
-- the new 9-parameter-with-default version, silently keeping the
-- unguarded old behaviour for every real call site. The old signature is
-- dropped explicitly so there is only ever one version of this function.
drop function if exists public.process_stripe_webhook_event(
  text, uuid, text, text, text, text, timestamptz, boolean
);

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
as $$
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
      -- The ordering guard itself. A null stored value means this row
      -- predates this column (or was written by an older code path) —
      -- treated as "no ordering information yet", so the incoming event
      -- always applies rather than being blocked by a comparison against
      -- nothing.
      where public.subscriptions.stripe_event_created is null
         or excluded.stripe_event_created >= public.subscriptions.stripe_event_created;

    get diagnostics v_rows_affected = row_count;

    if v_rows_affected = 0 then
      -- Stale/out-of-order: an equal-or-newer event has already been
      -- applied to this subscription. Deliberately does NOT touch
      -- entitlements here — acting on stale data is exactly what this
      -- guard exists to prevent (e.g. an old "active" event must never
      -- resurrect an entitlement a newer "canceled" event already expired).
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
      -- Only expire the entitlement that this specific subscription backs
      -- — see 015's header for why household_id alone isn't enough.
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
  text, uuid, text, text, text, text, timestamptz, boolean, timestamptz
) from public;
grant execute on function public.process_stripe_webhook_event(
  text, uuid, text, text, text, text, timestamptz, boolean, timestamptz
) to service_role;

commit;
