-- iPhone households keep their carrier (2026-09-30, iOS technical parity).
--
-- STATUS: DRAFT — NOT APPLIED to any database. Renumber at integration if
-- the sequence has moved (060 = call_delivery_events on
-- readiness/android-call-delivery; 058/059 = security remediation).
--
-- Why: set_household_carrier_compatibility (041, redefined by 043) forces
-- carrier_provider_key/carrier_tariff_type to NULL for device_type 'iphone'.
-- evaluateHouseholdCheckoutEligibility (services/providerPolicy.js) then
-- falls through to evaluateProviderCompatibility(NULL) = 'unverified' once
-- IOS_COMING_SOON is off, so NO iPhone customer could ever reach payment —
-- the documented "set IOS_COMING_SOON=false" removal step could not work.
-- The existing payment-safety test only passed because it evaluated a
-- household shape ({iphone, o2}) this function could never write.
--
-- Change: 'iphone' now stores the provider/tariff it is given, like
-- 'mobile'. The coming-soon waiting-list path still passes NULL (so still
-- stores NULL), 'landline' behaviour is unchanged, and the IOS_COMING_SOON
-- checkout block still applies before any carrier check.
--
-- Based on the latest definition (043). Same signature, security definer,
-- empty search_path and grants.

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
        -- 'iphone' now stores what it is given (NULL from the coming-soon
        -- path). 'landline' persists provider, clears tariff (043,
        -- unchanged). 'mobile' unchanged.
        carrier_provider_key = p_provider_key,
        carrier_tariff_type = case when p_device_type = 'landline' then null else p_tariff_type end,
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
