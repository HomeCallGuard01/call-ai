-- Stripe Integration: SECURITY DEFINER RPC functions for billing writes
--
-- STATUS: APPLIED
--
-- Purpose: two narrow, service_role-only RPC functions that perform the
-- privileged writes the future checkout/webhook code needs, without
-- widening service_role's own direct table grants beyond what migration
-- 012 already provides (SELECT/INSERT/UPDATE on subscriptions/
-- entitlements/stripe_webhook_events; nothing on households at all).
-- Both functions are SECURITY DEFINER, so they execute with their
-- owner's privileges (this migration's runner — full table access),
-- not the caller's. That is exactly why each one is written to do only
-- the one specific, bounded thing described below, with set search_path
-- = '' and fully schema-qualified references throughout: a SECURITY
-- DEFINER function is a privilege-escalation point, and an unqualified
-- reference inside one is a classic search_path hijack vector (a caller
-- able to influence search_path could otherwise redirect an unqualified
-- table/function name to a same-named object they control, executed
-- with the definer's elevated privileges).
--
-- Both functions REVOKE EXECUTE from PUBLIC before granting it only to
-- service_role. This step is not optional cleanup: Postgres grants
-- EXECUTE on every newly created function to PUBLIC by default (unlike
-- tables, which get no implicit grants) — without the explicit revoke,
-- PostgREST would let any authenticated (or even anon) caller invoke
-- these privilege-escalating functions directly via the REST RPC
-- endpoint, completely bypassing the service_role-only intent.
--
-- Run this AFTER:
-- 011_create_subscriptions_and_entitlements.sql
-- 012_service_role_stripe_billing_privileges.sql

begin;

-- ------------------------------------------------------------
-- 1. set_household_stripe_customer_id
-- ------------------------------------------------------------
--
-- The one and only sanctioned way to write households.stripe_customer_id.
-- Deliberately not a direct service_role UPDATE grant on households (per
-- explicit decision): households otherwise stays SELECT-only for
-- service_role (migration 009), and this function is the single,
-- narrow exception — it can set exactly one column, under exactly the
-- rules below, and nothing else about a household row.
--
-- Semantics:
--   existing value is null            -> set it, success
--   existing value equals the new one -> no-op, success (idempotent —
--                                        a retried checkout-session
--                                        creation attempt must not error)
--   existing value differs            -> reject. A household should
--                                        never legitimately be re-pointed
--                                        at a different Stripe Customer;
--                                        seeing this happen means
--                                        something upstream resolved the
--                                        wrong household, which must
--                                        surface as a loud failure, not
--                                        silently overwrite a real
--                                        customer link.
--
-- `for update` takes a row lock on the target household for the
-- duration of this call, so two concurrent attempts to set a
-- household's stripe_customer_id for the first time can't race past
-- each other and both "succeed" with different values — the second
-- caller blocks until the first commits, then correctly sees the
-- now-existing value and either no-ops (same value) or rejects
-- (different value).

create or replace function public.set_household_stripe_customer_id(
  p_household_id uuid,
  p_stripe_customer_id text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing text;
  v_found boolean;
begin
  select h.stripe_customer_id, true
    into v_existing, v_found
    from public.households h
    where h.id = p_household_id
    for update;

  if not v_found then
    raise exception 'set_household_stripe_customer_id: household % does not exist', p_household_id;
  end if;

  if v_existing is null then
    update public.households
      set stripe_customer_id = p_stripe_customer_id
      where id = p_household_id;
    return;
  end if;

  if v_existing = p_stripe_customer_id then
    -- Identical value already set: idempotent success, no write needed.
    return;
  end if;

  raise exception
    'set_household_stripe_customer_id: household % already has stripe_customer_id % — refusing to replace with %',
    p_household_id, v_existing, p_stripe_customer_id;
end;
$$;

revoke all on function public.set_household_stripe_customer_id(uuid, text) from public;
grant execute on function public.set_household_stripe_customer_id(uuid, text) to service_role;

-- ------------------------------------------------------------
-- 2. process_stripe_webhook_event
-- ------------------------------------------------------------
--
-- Atomically applies one already-claimed webhook event's business
-- effects: upserts the subscription row, transitions the household's
-- entitlement, and marks the event processed — all as one transaction,
-- so "processed" can never be recorded unless the subscription/
-- entitlement writes actually committed too.
--
-- This function does not decide *whether* to process an event — the
-- claim-then-process dedup (insert ... on conflict ... where ...
-- returning, documented in 011_create_subscriptions_and_entitlements.sql)
-- happens in the application layer before this is ever called. Nor does
-- it resolve *which* household an event belongs to for Checkout events
-- (cross-checking client_reference_id / Checkout session metadata /
-- Stripe Customer metadata against each other is multi-source logic
-- over the raw Stripe event object, which belongs in the webhook
-- handler that actually receives that object) — this function receives
-- an already-resolved p_household_id and performs exactly one further,
-- narrower defensive check: that the household passed in actually owns
-- the stripe_customer_id the event claims, per households.stripe_customer_id.
-- A mismatch here means the caller's resolution was wrong (or the two
-- have drifted), and is refused and durably recorded rather than
-- applied — this is the same "resolve defensively, fail safely, and
-- record it" principle applied at the one point this function can
-- verify independently.
--
-- Entitlement activation is decided here, from p_subscription_status
-- alone, never from the mere existence of a checkout.session.completed
-- event: only 'trialing', 'active', or 'past_due' qualify (the exact
-- same "retain access during Stripe's retries, never suspend on the
-- first invoice.payment_failed" set agreed earlier) — every other
-- status (canceled/unpaid/incomplete/incomplete_expired/paused)
-- expires any existing active entitlement instead.
--
-- Failure handling: the inner begin/exception block is what makes
-- "never mark processed if business-state updates fail" actually true.
-- PL/pgSQL implicitly takes a savepoint at the start of that block; if
-- any statement inside raises (the identity mismatch, a constraint
-- violation such as two concurrent events racing on
-- entitlements_one_active_per_household, anything else), Postgres rolls
-- back to that savepoint — undoing the subscriptions/entitlements
-- writes from this call, but not the failure record written fresh
-- afterward in the exception handler. The function itself always
-- returns normally ('processed' or 'failed') rather than letting the
-- exception propagate — a raised, uncaught exception here would abort
-- the whole call including the failure record we specifically want to
-- keep, which is exactly the "processed" vs. "recorded but not silently
-- lost" distinction this exists to guarantee. The caller (the future
-- webhook handler) reads this return value to decide whether to
-- respond to Stripe with 200 or a non-2xx (prompting Stripe's own
-- retry, on top of this app's own failed-event retry eligibility from
-- 011's claim query).

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

    -- Qualifying-state check happens here, in the database, so it can
    -- never be silently skipped by an application-layer bug — see the
    -- function's own header comment.
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
        where e.household_id = p_household_id and e.status = 'active';
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
