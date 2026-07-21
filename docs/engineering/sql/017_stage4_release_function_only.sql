create or replace function public.release_household_twilio_number(
  p_household_id uuid,
  p_expected_number text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_number text;
  v_pending timestamptz;
begin
  select h.twilio_number, h.twilio_number_pending_release_at
    into v_number, v_pending
    from public.households h
    where h.id = p_household_id
    for update;

  if not found then
    raise exception 'release_household_twilio_number: household % does not exist', p_household_id;
  end if;

  if v_number is distinct from p_expected_number
     or v_pending is null
     or v_pending > now() then
    return false;
  end if;

  update public.households
    set twilio_number = null,
        twilio_provisioning_status = 'pending',
        twilio_provisioning_attempts = 0,
        twilio_provisioning_last_error = null,
        twilio_number_pending_release_at = null,
        twilio_provisioning_updated_at = now()
    where id = p_household_id;

  return true;
end;
$$;

revoke all on function public.release_household_twilio_number(uuid, text) from public;
grant execute on function public.release_household_twilio_number(uuid, text) to service_role;
