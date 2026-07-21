create or replace function public.cancel_household_twilio_number_pending_release(
  p_household_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.households
    set twilio_number_pending_release_at = null
    where id = p_household_id;
end;
$$;

revoke all on function public.cancel_household_twilio_number_pending_release(uuid) from public;
grant execute on function public.cancel_household_twilio_number_pending_release(uuid) to service_role;
