begin;

alter table public.households
  add column if not exists twilio_provisioning_status text not null default 'pending'
    check (twilio_provisioning_status in ('pending', 'active', 'failed')),
  add column if not exists twilio_provisioning_attempts integer not null default 0
    check (twilio_provisioning_attempts >= 0),
  add column if not exists twilio_provisioning_last_error text,
  add column if not exists twilio_provisioning_updated_at timestamptz;

update public.households
  set twilio_provisioning_status = 'active',
      twilio_provisioning_updated_at = now()
  where twilio_number is not null
    and twilio_provisioning_status = 'pending';

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
  v_found boolean;
begin
  select h.twilio_number, true
    into v_existing, v_found
    from public.households h
    where h.id = p_household_id
    for update;

  if not v_found then
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

revoke all on function public.assign_household_twilio_number(uuid, text) from public;
grant execute on function public.assign_household_twilio_number(uuid, text) to service_role;

create or replace function public.record_household_twilio_provisioning_failure(
  p_household_id uuid,
  p_error_message text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.households
    set twilio_provisioning_status = case
          when twilio_number is not null then twilio_provisioning_status
          else 'failed'
        end,
        twilio_provisioning_attempts = twilio_provisioning_attempts + 1,
        twilio_provisioning_last_error = p_error_message,
        twilio_provisioning_updated_at = now()
    where id = p_household_id;
end;
$$;

revoke all on function public.record_household_twilio_provisioning_failure(uuid, text) from public;
grant execute on function public.record_household_twilio_provisioning_failure(uuid, text) to service_role;

commit;
