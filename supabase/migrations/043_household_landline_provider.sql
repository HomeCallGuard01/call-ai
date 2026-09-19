-- Landline provider is now persisted server-side and gates checkout —
-- closing a real gap found during launch review (2026-09-19): neither
-- the web nor the mobile onboarding flow ever sent the landline provider
-- to the backend before this migration. setHouseholdLandline() took no
-- provider argument at all; migrations 040/041 atomically CLEARED
-- carrier_provider_key to null for device_type = 'landline', on the
-- (correct, at the time) assumption that no landline-specific policy
-- question existed yet. It now does: "Other/not sure" — and any
-- unaudited/unsupported landline provider — must fail closed before
-- payment, exactly like an unsupported mobile carrier already does,
-- rather than silently being handed BT's default forwarding codes and
-- being allowed to pay on the unproven assumption they'll work.
--
-- STATUS: NOT YET APPLIED to any database. Prepared alongside the
-- Android/landline launch work (2026-09-19).
--
-- Reuses carrier_provider_key for the landline provider (bt/sky/virgin/
-- talktalk/plusnet/other) rather than adding a parallel column —
-- services/providerPolicy.js's evaluateHouseholdCheckoutEligibility
-- already branches on device_type FIRST, before ever interpreting
-- carrier_provider_key, so there is no ambiguity even though a handful
-- of keys ("sky") are valid identifiers in both the mobile
-- PROVIDER_POLICY and the landline LANDLINE_SUPPORTED_PROVIDERS
-- namespaces — which one applies is decided entirely by device_type,
-- never guessed from the key's spelling.
--
-- carrier_tariff_type remains cleared for landline (and iphone) — tariff
-- is a mobile-only concept (Vodafone PAYG vs Pay Monthly); it never
-- applies to a landline or to the not-yet-available iPhone path.

begin;

create or replace function public.set_household_carrier_compatibility(
  p_household_id uuid,
  p_device_type text,
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
  if p_device_type is null or p_device_type not in ('mobile', 'landline', 'iphone') then
    raise exception 'set_household_carrier_compatibility: invalid device_type %', p_device_type;
  end if;

  update public.households
    set device_type = p_device_type,
        -- 'iphone' still clears both — no provider/tariff concept
        -- applies there. 'landline' now PERSISTS the provider (the
        -- actual fix this migration makes) but still clears tariff,
        -- which never applies to a landline. 'mobile' is unchanged.
        carrier_provider_key = case when p_device_type = 'iphone' then null else p_provider_key end,
        carrier_tariff_type = case when p_device_type in ('landline', 'iphone') then null else p_tariff_type end,
        carrier_compatibility_captured_at = now()
    where id = p_household_id
    returning carrier_compatibility_captured_at into v_result;

  if not found then
    raise exception 'set_household_carrier_compatibility: household % does not exist', p_household_id;
  end if;

  return v_result;
end;
$$;

revoke all on function public.set_household_carrier_compatibility(uuid, text, text, text) from public;
grant execute on function public.set_household_carrier_compatibility(uuid, text, text, text) to service_role;

commit;

-- Read-only verification — run after commit.
do $$
begin
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'set_household_carrier_compatibility'
      and p.pronargs = 4
  ) then
    raise exception 'MIGRATION 043 VERIFICATION FAILED: the 4-argument set_household_carrier_compatibility does not exist';
  end if;
end
$$;
