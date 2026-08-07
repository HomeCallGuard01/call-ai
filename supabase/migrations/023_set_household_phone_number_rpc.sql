-- Adds write support for households.phone_number via a narrow SECURITY
-- DEFINER RPC, matching this codebase's established pattern for every
-- households write (set_household_stripe_customer_id in 013,
-- mark_household_activation_verified in 021) rather than a broad UPDATE
-- grant.
--
-- Closes a real gap found 2026-08-07 while fixing the hardcoded call-
-- forwarding destination in services/callRouting.js: households.phone_
-- number has existed in the schema since 002, but nothing anywhere in
-- this app — web or mobile, registration or setup — has ever written to
-- it. Every real household's trusted/screened-safe calls therefore had
-- no genuine destination on file at all.
--
-- Unlike set_household_stripe_customer_id, this is freely re-settable by
-- its own owner at any time — a household's own phone number is
-- customer-owned data they may legitimately need to correct (changed
-- landline provider, typo, moved house), not an external system identity
-- that must never silently change once set. No idempotency/race handling
-- is needed for the same reason resolveStripeCustomerId's race guard
-- exists: there is no "first writer wins" scenario here, just "the
-- household updates their own number."
--
-- STATUS: DRAFT — NOT APPLIED. Not run against staging or production as
-- part of this change; application code that calls this RPC will fail
-- closed (services/householdPhoneNumber.js surfaces a clear "failed"
-- result) until it's applied.

begin;

create or replace function public.set_household_phone_number(
  p_household_id uuid,
  p_phone_number text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.households
    set phone_number = p_phone_number
    where id = p_household_id;

  if not found then
    raise exception 'set_household_phone_number: household % does not exist', p_household_id;
  end if;
end;
$$;

revoke all on function public.set_household_phone_number(uuid, text) from public;
grant execute on function public.set_household_phone_number(uuid, text) to service_role;

commit;
