-- Rollback for 049_number_release_entitlement_guard.sql.
-- STATUS: not applied anywhere. Restores the three function bodies exactly as
-- migration 017 defined them and removes the 049 guard function and trigger.
-- No data changes. After rollback the #8 failure mode (a stale cancellation
-- releasing an entitled household's number) is possible again.

drop trigger if exists entitlements_cancel_pending_number_release on public.entitlements;
drop function if exists public.entitlements_cancel_pending_number_release();

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
  -- Uses FOUND rather than a manually-selected boolean — see the
  -- identical fix and full explanation in assign_household_twilio_number
  -- (016_household_twilio_provisioning.sql /
  -- docs/engineering/sql/016_twilio_assign_function_fix.sql). The
  -- original pattern here had the same bug: on zero matching rows,
  -- PL/pgSQL sets every SELECT INTO target to NULL, so a manually
  -- selected "found" flag is NULL (not false), `not v_found` is also
  -- NULL under three-valued logic, and the exception below would never
  -- have fired for a nonexistent household.
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
  -- FOUND, not a manually-selected boolean — same fix/reasoning as
  -- assign_household_twilio_number and mark_household_twilio_number_pending_release.
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
  -- FOUND, not a manually-selected boolean — same fix/reasoning as
  -- assign_household_twilio_number and the two functions above.
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

drop function if exists public.household_blocks_number_release(uuid);
