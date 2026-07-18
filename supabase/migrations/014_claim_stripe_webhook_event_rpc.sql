-- Stripe Integration: SECURITY DEFINER RPC for claiming a webhook event
--
-- STATUS: APPLIED
--
-- Purpose: implements, as a callable function, the exact claim-then-process
-- dedup statement already documented in
-- 011_create_subscriptions_and_entitlements.sql's own stripe_webhook_events
-- comment (search that file for "The handler expresses all four cases in
-- one statement"). That comment describes application code issuing this
-- SQL directly — but Supabase's REST layer (PostgREST, what supabase-js
-- actually talks to) has no raw-SQL execution endpoint, and its fluent
-- query builder cannot express a conditional
-- "ON CONFLICT ... DO UPDATE ... WHERE ... RETURNING". A callable function
-- is the only way to run this exact statement through supabase-js, so this
-- migration wraps it verbatim rather than approximating it with a plain
-- upsert (which would silently break the "processed/ignored is terminal,
-- never reprocess" guarantee 011 was specifically designed to provide).
--
-- Same hardening as 013's two functions: SECURITY DEFINER, set search_path
-- = '' (search_path-hijack resistance), fully schema-qualified references,
-- EXECUTE revoked from PUBLIC and granted only to service_role — so
-- PostgREST never lets an authenticated/anon caller invoke this directly.
--
-- Run this AFTER:
-- 011_create_subscriptions_and_entitlements.sql
-- 012_service_role_stripe_billing_privileges.sql

begin;

-- ------------------------------------------------------------
-- claim_stripe_webhook_event
-- ------------------------------------------------------------
--
-- Returns true if this call legitimately claimed the event (first attempt,
-- or a valid retry of a 'failed' or stale 'received' row) and the caller
-- should proceed to process it. Returns false if another attempt already
-- owns it or it has already reached a terminal status ('processed' /
-- 'ignored') — the caller should do nothing further and return 200 to
-- Stripe either way, exactly as 011's comment specifies.

create or replace function public.claim_stripe_webhook_event(
  p_stripe_event_id text,
  p_event_type text,
  p_stripe_customer_id text,
  p_household_id uuid,
  p_payload jsonb
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_claimed_id text;
begin
  insert into public.stripe_webhook_events
    (stripe_event_id, event_type, stripe_customer_id, household_id,
     payload, status, attempt_count, last_attempt_at, processing_started_at)
  values
    (p_stripe_event_id, p_event_type, p_stripe_customer_id, p_household_id,
     p_payload, 'received', 1, now(), now())
  on conflict (stripe_event_id) do update
    set attempt_count = stripe_webhook_events.attempt_count + 1,
        last_attempt_at = now(),
        processing_started_at = now()
    where stripe_webhook_events.status = 'failed'
       or (
         stripe_webhook_events.status = 'received'
         and stripe_webhook_events.processing_started_at
           < now() - interval '2 minutes'
       )
  returning stripe_event_id into v_claimed_id;

  return v_claimed_id is not null;
end;
$$;

revoke all on function public.claim_stripe_webhook_event(
  text, text, text, uuid, jsonb
) from public;
grant execute on function public.claim_stripe_webhook_event(
  text, text, text, uuid, jsonb
) to service_role;

commit;
