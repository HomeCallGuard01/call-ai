-- Household anonymisation for inactive test/cleanup accounts
--
-- STATUS: DRAFT — NOT APPLIED — proposed for review, not yet run against
-- any real database.
--
-- Purpose: the earlier test-data cleanup round (real customer deletion,
-- Phase 1/2) established that `households` cannot be truly DELETEd
-- (service_role has SELECT only, migration 009 — deliberate), and that
-- subscriptions/entitlements/stripe_webhook_events cannot be deleted
-- either (no DELETE grant, migration 012 — deliberate audit trail).
-- Deleting a household's subscription/entitlement history just to make
-- the row disappear was never the right move anyway — those rows are
-- real financial/audit history, not customer-identifying data. What
-- actually needs removing is the household row's own PII: email, and
-- any live pointer that could let someone log in, reach the customer by
-- phone, or reuse a still-real Stripe/Twilio resource.
--
-- This adds one narrow, single-purpose SECURITY DEFINER RPC —
-- anonymize_inactive_household — matching this codebase's established
-- pattern for every other households write (set_household_stripe_customer_id
-- in 013, the Twilio lifecycle functions in 016/017): a purpose-built
-- function with its own guardrails, not a broad UPDATE grant on
-- households for service_role. It intentionally does NOT touch
-- subscriptions, entitlements, or stripe_webhook_events at all — those
-- stay exactly as they are, satisfying "preserve subscriptions" /
-- "preserve entitlements" / "preserve stripe_webhook_events" by simply
-- never being in scope.
--
-- Two hard refusals, not just documentation:
--   1. Refuses if the household still has an active entitlement —
--      anonymising an account that's still genuinely protected would be
--      a real defect, not cleanup. Entitlement status (not subscription
--      status) is the source of truth here, per Decision 009.
--   2. Refuses if twilio_number is still set — a DB-only anonymisation
--      cannot itself release the number from Twilio's side (that needs
--      a real Twilio API call, which this pure-SQL function cannot
--      make). The caller must release the number first via the
--      existing releaseTwilioNumberImmediately() (services/
--      twilioProvisioning.js, already used for exactly this in the
--      recent cleanup round), then anonymise. Anonymising with a number
--      still attached would silently orphan a real, still-billing
--      Twilio resource with nothing left pointing at it.
--
-- The replacement email is deterministic and per-household
-- (anonymized-<household id>@deleted.homecallguard.internal) so it
-- satisfies households.email's NOT NULL UNIQUE constraint (002) without
-- collisions across multiple anonymised rows, and doubles as the marker
-- for "this row has been anonymised" — no new column added for that,
-- consistent with keeping this migration minimal. status is set to
-- 'cancelled' (an existing, valid households.status value, 002) so
-- anonymised rows are also trivially distinguishable in any status-based
-- query, not just by email pattern.
--
-- Run this AFTER:
-- 017_household_twilio_number_lifecycle.sql

begin;

create or replace function public.anonymize_inactive_household(
  p_household_id uuid,
  p_reason text default 'test data cleanup'
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_twilio_number text;
  v_active_entitlement_count integer;
begin
  select h.twilio_number
    into v_twilio_number
    from public.households h
    where h.id = p_household_id;

  if not found then
    raise exception 'anonymize_inactive_household: household % does not exist', p_household_id;
  end if;

  if v_twilio_number is not null then
    raise exception
      'anonymize_inactive_household: household % still has an assigned Twilio number (%) — release it first (releaseTwilioNumberImmediately), then anonymise',
      p_household_id, v_twilio_number;
  end if;

  select count(*) into v_active_entitlement_count
    from public.entitlements e
    where e.household_id = p_household_id and e.status = 'active';

  if v_active_entitlement_count > 0 then
    raise exception
      'anonymize_inactive_household: household % still has an active entitlement, refusing to anonymise a genuinely protected account',
      p_household_id;
  end if;

  update public.households
    set email = 'anonymized-' || p_household_id || '@deleted.homecallguard.internal',
        phone_number = null,
        auth_user_id = null,
        stripe_customer_id = null,
        twilio_number = null,
        twilio_number_pending_release_at = null,
        twilio_provisioning_status = 'pending',
        twilio_provisioning_attempts = 0,
        twilio_provisioning_last_error = null,
        status = 'cancelled',
        updated_at = now()
    where id = p_household_id;

  raise notice 'anonymize_inactive_household: household % anonymised (%)', p_household_id, p_reason;
end;
$$;

revoke all on function public.anonymize_inactive_household(uuid, text) from public;
grant execute on function public.anonymize_inactive_household(uuid, text) to service_role;

commit;
