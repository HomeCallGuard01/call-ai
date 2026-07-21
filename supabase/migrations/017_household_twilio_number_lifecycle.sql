-- Twilio number lifecycle — cancellation grace period + immediate release
--
-- STATUS: NOT YET APPLIED to the real database (2026-07-21). This file
-- was written and pglite-verified earlier in the same session, but
-- direct probes (pg_proc / information_schema.routines / column checks)
-- confirmed all five objects in this file (the column and all four
-- functions) are missing from the real database — the same silent
-- non-persistence failure diagnosed for migration 016 (see
-- docs/engineering/sql/ and
-- docs/engineering/016_017_migration_incident_notes.md). Three of the
-- four functions (mark_household_twilio_number_pending_release,
-- release_household_twilio_number,
-- release_household_twilio_number_immediately) also carried the same
-- FOUND-vs-manually-selected-boolean bug fixed in
-- assign_household_twilio_number (016) — fixed here too, in the same
-- pass. The fixes below are reflected in this source file and confirmed
-- via the local pglite test suite, but the real-database repair itself
-- (staged, statement-by-statement, via docs/engineering/sql/017_stage1..5)
-- has not yet been run or verified. Update this header to APPLIED only
-- once that staged repair is confirmed against the real database.
--
-- Purpose: companion to 016_household_twilio_provisioning.sql. That
-- migration solves *acquiring* a number; this one solves *releasing* one,
-- for two distinct cases with two distinct policies:
--
-- 1. Subscription cancellation (genuine termination, not just
--    cancel_at_period_end scheduled while still active/paid-through) —
--    RELEASE AFTER A GRACE PERIOD (30 days), not immediately. Reasoning,
--    recorded here rather than only in docs/launch/, since it's the
--    justification for this schema:
--
--    This product's model is "keep your existing home phone number" —
--    customers set up call forwarding FROM their real landline TO the
--    Twilio number assigned to their household. If that number were
--    released and Twilio handed it to a different customer right away, a
--    churned customer who forgot to remove their forwarding rule would
--    have their calls silently start ringing a stranger's household
--    instead — a misdirected-calls problem, not just a cost question.
--    A grace period also lets "cancel then quickly resubscribe" (buyer's
--    remorse, an accidental cancellation, Stripe Portal reactivation
--    before period end) keep the *same* number rather than being forced
--    onto a new one. The ~£1/month Twilio cost of holding an idle number
--    for 30 days is small and bounded; the misdirection risk of
--    releasing instantly is not.
--
-- 2. Account deletion — RELEASE IMMEDIATELY, no grace period. A deletion
--    request is explicit and deliberate, not something to protect against
--    being accidental the way a subscription lapse might be, and
--    retaining a number tied to a deleted account serves no purpose
--    (consistent with data-minimisation expectations). No account
--    deletion feature exists in this codebase yet — this migration adds
--    the release primitive a future one should call
--    (release_household_twilio_number_immediately), it does not add a
--    deletion feature itself.
--
-- Column added:
--   twilio_number_pending_release_at   set when a genuinely-terminated
--                                      subscription's household still
--                                      has a number; cleared on
--                                      reactivation before the deadline.
--
-- Run this AFTER:
-- 016_household_twilio_provisioning.sql

begin;

alter table public.households
  add column if not exists twilio_number_pending_release_at timestamptz;

-- ------------------------------------------------------------
-- 1. mark_household_twilio_number_pending_release
-- ------------------------------------------------------------
--
-- Called when a household's entitlement has just genuinely expired
-- (not merely scheduled to, via cancel_at_period_end) and it still holds
-- a number. Idempotent in the way that matters here: a second call while
-- a deadline is already pending does NOT push the deadline further out —
-- Stripe can and does redeliver/re-send subscription events, and this
-- must not let a household's number linger forever just because more
-- than one non-qualifying event arrived after the first.
--
-- Returns true if a new deadline was set, false if there was nothing to
-- protect (no number) or a deadline was already pending.

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

revoke all on function public.mark_household_twilio_number_pending_release(uuid, interval) from public;
grant execute on function public.mark_household_twilio_number_pending_release(uuid, interval) to service_role;

-- ------------------------------------------------------------
-- 2. cancel_household_twilio_number_pending_release
-- ------------------------------------------------------------
--
-- Called when a household becomes entitled again (reactivation, a fresh
-- subscription) before its grace-period deadline arrives — the household
-- keeps the same number it already had, uninterrupted. Idempotent no-op
-- if nothing was pending; no row lock needed, a plain UPDATE clearing a
-- single column to null is safe under concurrent calls.

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

-- ------------------------------------------------------------
-- 3. release_household_twilio_number
-- ------------------------------------------------------------
--
-- The grace-period release path. Only releases when every one of these
-- holds, checked atomically under a row lock:
--   - the household's current number matches p_expected_number (it was
--     not reassigned to something else in between, e.g. by a fresh
--     provisioning attempt this function's own caller doesn't know about)
--   - a pending-release deadline is actually set
--   - that deadline has actually passed
--
-- Returns true (and clears the number, resets provisioning state back to
-- 'pending' so a future resubscription provisions a fresh number cleanly)
-- only when all three hold; false otherwise — the Node caller is
-- expected to only release the number via Twilio's API when this returns
-- true, so a premature or mismatched call never releases a number that's
-- still legitimately in use.

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

revoke all on function public.release_household_twilio_number(uuid, text) from public;
grant execute on function public.release_household_twilio_number(uuid, text) to service_role;

-- ------------------------------------------------------------
-- 4. release_household_twilio_number_immediately
-- ------------------------------------------------------------
--
-- The account-deletion path — unconditional, no grace period, no
-- deadline check. Returns the number that was released (so the Node
-- caller can release it via Twilio's API) or null if the household had
-- none. Not called from anywhere in this codebase yet: no account
-- deletion feature exists today. Added so that when one is built, the
-- release primitive it needs already exists, is tested, and follows the
-- same locked, atomic pattern as every other write to these columns.

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

revoke all on function public.release_household_twilio_number_immediately(uuid) from public;
grant execute on function public.release_household_twilio_number_immediately(uuid) to service_role;

commit;
