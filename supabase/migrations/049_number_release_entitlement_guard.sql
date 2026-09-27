-- Number-release entitlement guard (2026-09-27) — Step 1 of the provider-
-- number lifecycle work.
--
-- STATUS: DRAFT — NOT APPLIED to any database (staging or production).
--
-- NUMBERING: 049. On 2026-09-27 the highest migration on any branch or
-- worktree was 048 (feature/provider-neutral-billing-ledger); 047 is
-- reserved for the monitored-minute allowance migration's documented
-- renumber (it currently collides with main's 046). If this migration is
-- applied before 047/048 exist in a database, those later files are
-- out-of-order for `supabase db push` (needs --include-all); applying by
-- hand in number order is unaffected.
--
-- The real failure this closes (production household 30f01a7a, 2026-09-23):
--   22 Aug  Stripe test subscription starts; HCG number assigned.
--   23 Aug  Subscription cancelled → mark_household_twilio_number_pending_release
--           schedules release for 22 Sep.
--   27 Aug  Open-ended complimentary entitlement granted through a path that
--           did not cancel the pending release (the admin grant endpoint
--           that does was only added on 5 Sep).
--   23 Sep  Daily release job → release_household_twilio_number, which
--           checked only "number matches and grace has passed", removed the
--           number from an ENTITLED household and it was quarantined as
--           "subscription_grace_expired".
--
-- Fix, in three independent layers so no single missed code path can
-- repeat it:
--   1. household_blocks_number_release(): the single definition of "this
--      household must keep its number" — any entitlement that is active or
--      scheduled and has not ended (current OR upcoming; deliberately
--      broader than "active right now", so an about-to-start membership is
--      protected too).
--   2. Every release step re-reads it inside the same transaction, under
--      the household row lock, immediately before acting:
--        mark_household_twilio_number_pending_release   → refuses to schedule
--        release_household_twilio_number                → refuses, and clears
--                                                         the stale schedule
--        release_household_twilio_number_immediately    → refuses
--      A historical cancellation can therefore never override a newer or
--      current entitlement, whatever order events arrive in.
--   3. A trigger on entitlements: whenever an entitlement becomes active or
--      scheduled (insert or update, from ANY path — API, admin endpoint,
--      invite redemption, webhook or hand-written SQL), any pending release
--      for that household is cancelled at once.
--
-- Provider-neutral: nothing here knows about Twilio; the column/function
-- names are historical (migration 017).
--
-- Rollback: re-run the three function bodies from migration 017 and drop
-- the trigger, trigger function and household_blocks_number_release (see
-- supabase/migrations/_rollbacks/049_rollback_number_release_entitlement_guard.sql).
-- No data is changed by this migration.

-- 1. The single definition ------------------------------------------------

create or replace function public.household_blocks_number_release(p_household_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.entitlements e
     where e.household_id = p_household_id
       and e.status in ('active', 'scheduled')
       and (e.ends_at is null or e.ends_at > now())
  );
$$;

revoke all on function public.household_blocks_number_release(uuid) from public, anon, authenticated;
grant execute on function public.household_blocks_number_release(uuid) to service_role;

-- 2a. Scheduling a release -------------------------------------------------

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

  -- 049: a cancellation of ONE entitlement must not schedule a release
  -- while another (e.g. complimentary) entitlement still covers the household.
  if public.household_blocks_number_release(p_household_id) then
    return false;
  end if;

  update public.households
    set twilio_number_pending_release_at = now() + p_grace_period
    where id = p_household_id;

  return true;
end;
$$;

-- 2b. Grace-period release (the path that failed for 30f01a7a) -------------

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

  -- 049: re-read the CURRENT entitlement state under the row lock. A
  -- schedule left over from an older cancellation is stale if the household
  -- is entitled now: cancel it and keep the number.
  if public.household_blocks_number_release(p_household_id) then
    update public.households
      set twilio_number_pending_release_at = null
      where id = p_household_id;
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

-- 2c. Immediate release (account deletion) --------------------------------

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

  -- 049: account deletion revokes the household's entitlement before
  -- calling this; if one is still in force, refuse (the caller checks the
  -- same guard first and alerts, so this can't fail silently).
  if public.household_blocks_number_release(p_household_id) then
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

-- Grants unchanged from 017/022 (create or replace keeps them); restated
-- so this file is self-describing.
revoke all on function public.mark_household_twilio_number_pending_release(uuid, interval) from public, anon, authenticated;
grant execute on function public.mark_household_twilio_number_pending_release(uuid, interval) to service_role;
revoke all on function public.release_household_twilio_number(uuid, text) from public, anon, authenticated;
grant execute on function public.release_household_twilio_number(uuid, text) to service_role;
revoke all on function public.release_household_twilio_number_immediately(uuid) from public, anon, authenticated;
grant execute on function public.release_household_twilio_number_immediately(uuid) to service_role;

-- 3. Any entitlement grant cancels a pending release -----------------------

create or replace function public.entitlements_cancel_pending_number_release()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status in ('active', 'scheduled')
     and (new.ends_at is null or new.ends_at > now()) then
    update public.households
      set twilio_number_pending_release_at = null
      where id = new.household_id
        and twilio_number_pending_release_at is not null;
  end if;
  return new;
end;
$$;

revoke all on function public.entitlements_cancel_pending_number_release() from public, anon, authenticated;
-- Project convention (022): SECURITY DEFINER functions grant service_role
-- explicitly. A trigger function can't be invoked directly anyway; it must
-- be SECURITY DEFINER because service_role has no UPDATE on households.
grant execute on function public.entitlements_cancel_pending_number_release() to service_role;

drop trigger if exists entitlements_cancel_pending_number_release on public.entitlements;
create trigger entitlements_cancel_pending_number_release
  after insert or update of status, starts_at, ends_at on public.entitlements
  for each row
  execute function public.entitlements_cancel_pending_number_release();
