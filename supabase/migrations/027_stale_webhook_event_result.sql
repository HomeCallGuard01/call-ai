-- Distinguishes a stale/out-of-order webhook event from a genuinely
-- applied one in process_stripe_webhook_event's return value — closes
-- the residual risk flagged alongside the 2026-08-22 webhook
-- provisioning-race fix (services/twilioProvisioning.js's
-- handleWebhookProvisioningDecision, routes/billing.js's webhook
-- handler). Both outcomes previously returned the literal string
-- 'processed' (019_subscription_event_ordering_guard.sql), so
-- routes/billing.js had no way to tell "this event's state change is
-- real, safe to act on" apart from "019's ordering guard correctly
-- discarded this event as superseded by a newer one — its
-- subscription.status must not be acted on."
--
-- STATUS: NOT YET APPLIED to staging (tigwgmayeuisrxjjykqd) or
-- production (psbzynxplxfbyrbdidmn) — created 2026-08-22, application
-- code (routes/billing.js, services/twilioProvisioning.js) updated in
-- the same change, but this migration has not been run against either
-- Supabase project yet. Until it is applied to staging, the deployed
-- RPC still returns 'processed' for both outcomes — a live webhook-
-- driven Twilio provisioning attempt should not be treated as proof of
-- the stale-event guard until this migration has actually been applied
-- and the corresponding code deployed against it.
--
-- Same 9-argument signature as 019 — a plain `create or replace` is
-- sufficient (no signature change), unlike 019's own drop-and-recreate
-- (needed there because 019 changed the argument count from 015's
-- 8-argument version). Only the ordering-guard branch's return value
-- changes, from 'processed' to 'ignored_stale'. v_qualifies, the
-- subscriptions upsert, and the entitlements insert/expire logic are
-- byte-for-byte unchanged from 019.

begin;

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
      -- resurrect an entitlement a newer "canceled" event already
      -- expired). Returns a distinct value (2026-08-22 change, was
      -- 'processed') so the caller can tell this apart from a genuine
      -- apply and correctly skip acting on this event's own
      -- subscription status for Twilio provisioning too.
      update public.stripe_webhook_events
        set status = 'ignored', processed_at = now()
        where stripe_event_id = p_stripe_event_id;

      return 'ignored_stale';
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
$$;

revoke all on function public.process_stripe_webhook_event(
  text, uuid, text, text, text, text, timestamptz, boolean, timestamptz
) from public;
grant execute on function public.process_stripe_webhook_event(
  text, uuid, text, text, text, text, timestamptz, boolean, timestamptz
) to service_role;

commit;
