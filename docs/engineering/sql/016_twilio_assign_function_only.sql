create or replace function public.assign_household_twilio_number(
  p_household_id uuid,
  p_twilio_number text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing text;
begin
  select h.twilio_number
    into v_existing
    from public.households h
    where h.id = p_household_id
    for update;

  if not found then
    raise exception 'assign_household_twilio_number: household % does not exist', p_household_id;
  end if;

  if v_existing is null then
    update public.households
      set twilio_number = p_twilio_number,
          twilio_provisioning_status = 'active',
          twilio_provisioning_last_error = null,
          twilio_provisioning_updated_at = now()
      where id = p_household_id;
    return true;
  end if;

  if v_existing = p_twilio_number then
    return true;
  end if;

  return false;
end;
$$;
