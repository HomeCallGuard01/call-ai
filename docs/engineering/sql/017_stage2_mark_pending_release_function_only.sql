create or replace function public.mark_household_twilio_number_pending_release(
  p_household_id uuid,
  p_grace_period interval default interval '30 days'
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
    raise exception 'mark_household_twilio_number_pending_release: household % does not exist', p_household_id;
  end if;

  if v_number is null or v_pending is not null then
    return false;
  end if;

  update public.households
    set twilio_number_pending_release_at = now() + p_grace_period
    where id = p_household_id;

  return true;
end;
$$;

revoke all on function public.mark_household_twilio_number_pending_release(uuid, interval) from public;
grant execute on function public.mark_household_twilio_number_pending_release(uuid, interval) to service_role;
