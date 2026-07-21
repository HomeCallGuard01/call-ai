create or replace function public.release_household_twilio_number_immediately(
  p_household_id uuid
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_number text;
begin
  select h.twilio_number
    into v_number
    from public.households h
    where h.id = p_household_id
    for update;

  if not found then
    raise exception 'release_household_twilio_number_immediately: household % does not exist', p_household_id;
  end if;

  if v_number is null then
    return null;
  end if;

  update public.households
    set twilio_number = null,
        twilio_provisioning_status = 'pending',
        twilio_provisioning_attempts = 0,
        twilio_provisioning_last_error = null,
        twilio_number_pending_release_at = null,
        twilio_provisioning_updated_at = now()
    where id = p_household_id;

  return v_number;
end;
$$;

revoke all on function public.release_household_twilio_number_immediately(uuid) from public;
grant execute on function public.release_household_twilio_number_immediately(uuid) to service_role;
