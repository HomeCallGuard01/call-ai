-- Production repair record — applied 2026-07-21 to fix a real bug in the
-- originally-deployed assign_household_twilio_number(): the original body
-- selected a literal `true` into a second target variable (`v_found`) to
-- detect whether the household row existed. When the SELECT INTO matched
-- zero rows, PL/pgSQL set v_found to NULL rather than false, so
-- `if not v_found then raise exception ...` never fired (NULL is not
-- true under three-valued logic) — a nonexistent household id silently
-- fell through to a no-op UPDATE and returned `true` as if it had
-- succeeded. Confirmed directly: calling the deployed function with id
-- 00000000-0000-0000-0000-000000000000 returned `true` with no error
-- instead of raising. Fixed by using Postgres's built-in FOUND variable
-- instead of a manually-selected flag. Re-running the same probe after
-- this fix correctly raises "assign_household_twilio_number: household
-- 00000000-0000-0000-0000-000000000000 does not exist". This file is the
-- exact SQL that was deployed to fix it; the tracked source of truth is
-- supabase/migrations/016_household_twilio_provisioning.sql, updated to
-- match.

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
