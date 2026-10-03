-- Rollback for 065_household_iphone_carrier.sql (drafted as 061): restores migration 043's
-- function body exactly (iphone stores NULL carrier/tariff; landline keeps
-- provider, clears tariff).

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
