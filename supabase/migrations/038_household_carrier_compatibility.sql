-- Household mobile-carrier capture — the missing input to
-- services/providerPolicy.js's evaluateProviderCompatibility /
-- evaluateHouseholdCheckoutEligibility. Continuation of P0 Batch 1
-- (providerPolicy.js, migration 037's Twilio number quarantine): that
-- work built the compatibility POLICY (which carriers are safe) and the
-- SAFE-RELEASE mechanism (quarantine), but had no way to know which
-- carrier a given household is actually on — the carrier-compatibility
-- audit (2026-09-11) found evaluateProviderCompatibility had zero
-- callers anywhere in the app as a direct result. This migration adds
-- only the storage; the gating logic itself stays entirely in
-- providerPolicy.js, never duplicated here.
--
-- STATUS: DRAFT — NOT APPLIED.
--
-- Deliberately stores only the household's RAW carrier/tariff selection,
-- never a derived compatibility verdict (no "status" or "can_pay" column
-- here). services/providerPolicy.js's evaluateHouseholdCheckoutEligibility
-- is the only place a verdict is ever computed, and it is computed fresh
-- every time — once at onboarding capture (for the immediate "works with
-- your provider" / "isn't compatible" response) and again at checkout
-- time (the actual payment gate) — so a later correction to
-- PROVIDER_POLICY's data (e.g. a carrier's status upgraded after physical
-- testing) takes effect for every already-captured household immediately,
-- with no backfill migration ever required. This mirrors this codebase's
-- existing "single source of truth in application code, not SQL" pattern
-- for provider data (see providerPolicy.js's own header on LANDLINE_PROVIDERS).
--
-- carrier_provider_key is deliberately NOT constrained to a fixed set of
-- values (no check constraint, no enum) — PROVIDER_POLICY's key set is
-- expected to grow over time (see the carrier-compatibility audit's
-- proposed additions), and an unrecognised key here is already handled
-- safely by getProviderPolicy's fallback to PROVIDER_POLICY.other
-- ('unverified', blocked) rather than a database error. Validating
-- membership belongs to the same single source of truth as everything
-- else about providers — providerPolicy.js, not a SQL constraint that
-- would need updating in lockstep with it.
--
-- carrier_compatibility_captured_at is set every time this RPC runs, not
-- idempotent-once — matching voice_client_registered_at (035) and
-- delivery_verified_at (036)'s precedent: a customer can change their
-- selection (corrected a mistake, actually switched carrier), and the
-- most recent capture is what matters, not the first.

begin;

alter table public.households
  add column if not exists carrier_provider_key text,
  add column if not exists carrier_tariff_type text,
  add column if not exists carrier_compatibility_captured_at timestamptz;

create or replace function public.set_household_carrier_compatibility(
  p_household_id uuid,
  p_provider_key text,
  p_tariff_type text default null
)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result timestamptz;
begin
  update public.households
    set carrier_provider_key = p_provider_key,
        carrier_tariff_type = p_tariff_type,
        carrier_compatibility_captured_at = now()
    where id = p_household_id
    returning carrier_compatibility_captured_at into v_result;

  if not found then
    raise exception 'set_household_carrier_compatibility: household % does not exist', p_household_id;
  end if;

  return v_result;
end;
$$;

revoke all on function public.set_household_carrier_compatibility(uuid, text, text) from public;
grant execute on function public.set_household_carrier_compatibility(uuid, text, text) to service_role;

commit;

-- Read-only verification — run after commit.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'households'
      and column_name = 'carrier_provider_key' and data_type = 'text'
  ) then
    raise exception 'MIGRATION 038 VERIFICATION FAILED: households.carrier_provider_key missing or wrong type';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'households'
      and column_name = 'carrier_tariff_type' and data_type = 'text'
  ) then
    raise exception 'MIGRATION 038 VERIFICATION FAILED: households.carrier_tariff_type missing or wrong type';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'households'
      and column_name = 'carrier_compatibility_captured_at' and data_type = 'timestamp with time zone'
  ) then
    raise exception 'MIGRATION 038 VERIFICATION FAILED: households.carrier_compatibility_captured_at missing or wrong type';
  end if;

  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'set_household_carrier_compatibility'
  ) then
    raise exception 'MIGRATION 038 VERIFICATION FAILED: set_household_carrier_compatibility function missing';
  end if;
end
$$;
