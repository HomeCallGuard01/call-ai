-- Automatic Twilio number provisioning — schema + RPC functions
--
-- STATUS: APPLIED (2026-07-21) — via staged repair, not a single run of
-- this file. Running this file's contents as one bundled transaction was
-- attempted repeatedly and never actually persisted anything (columns
-- and functions alike came back missing every time, despite the SQL
-- Editor reporting success) — root cause never conclusively identified;
-- see docs/engineering/016_017_migration_incident_notes.md. What did
-- work: applying each piece as its own standalone statement (no
-- surrounding BEGIN/COMMIT) — see docs/engineering/sql/
-- 016_twilio_columns_only.sql, 016_twilio_backfill_only.sql,
-- 016_twilio_assign_function_only.sql (as fixed — see below), and the
-- record_household_twilio_provisioning_failure body from this file run
-- standalone the same way. assign_household_twilio_number's originally-
-- shipped body had a real bug (fixed in this file and recorded in
-- docs/engineering/sql/016_twilio_assign_function_fix.sql): it detected
-- "household not found" via a manually-selected boolean that PL/pgSQL
-- sets to NULL (not false) on zero matching rows, so the exception never
-- fired. Verified end-to-end against a real Twilio API call on
-- 2026-07-21 — reached Twilio's real purchase endpoint successfully;
-- blocked only on a required AddressSid for UK numbers, a business
-- decision (registered office address), not a code defect. See
-- docs/launch/KNOWN_ISSUES.md.
--
-- Purpose: closes the Severity 1 launch blocker recorded in
-- docs/launch/KNOWN_ISSUES.md — every household created after the one-time
-- founder claim in claimOrCreateHousehold() (database/households.js) ends
-- up with twilio_number = null and nothing ever assigns one. This adds the
-- columns and the two narrow, service_role-only RPC functions the new
-- services/twilioProvisioning.js orchestrator needs to fix that
-- automatically, following the same pattern as
-- 013_stripe_billing_rpc_functions.sql: households stays without a direct
-- service_role UPDATE grant (migration 012), and these RPCs are the only
-- sanctioned write path for the columns below.
--
-- Columns added to households:
--   twilio_provisioning_status    'pending' | 'active' | 'failed'
--   twilio_provisioning_attempts  count of failed attempts so far
--   twilio_provisioning_last_error  most recent error message, if any
--   twilio_provisioning_updated_at  when the status last changed
--
-- Run this AFTER:
-- 012_service_role_stripe_billing_privileges.sql
-- 013_stripe_billing_rpc_functions.sql

begin;

alter table public.households
  add column if not exists twilio_provisioning_status text not null default 'pending'
    check (twilio_provisioning_status in ('pending', 'active', 'failed')),
  add column if not exists twilio_provisioning_attempts integer not null default 0
    check (twilio_provisioning_attempts >= 0),
  add column if not exists twilio_provisioning_last_error text,
  add column if not exists twilio_provisioning_updated_at timestamptz;

-- Backfill: a household that already has a real twilio_number predates
-- this provisioning system entirely (the one-time founder row claimed by
-- claimOrCreateHousehold) and should read as already active, not pending.
update public.households
  set twilio_provisioning_status = 'active'
  where twilio_number is not null
    and twilio_provisioning_status = 'pending';

-- ------------------------------------------------------------
-- 1. assign_household_twilio_number
-- ------------------------------------------------------------
--
-- The one and only sanctioned way to write households.twilio_number.
--
-- Semantics (mirrors set_household_stripe_customer_id exactly):
--   existing value is null            -> set it, status -> 'active', true
--   existing value equals the new one -> no-op, true (idempotent — a
--                                        retried provisioning attempt
--                                        must not error)
--   existing value differs            -> false, NOT an exception. The
--                                        caller just purchased a real
--                                        Twilio number that lost a race
--                                        against another attempt that
--                                        assigned first; returning false
--                                        (rather than throwing) tells the
--                                        Node caller to release the
--                                        now-redundant number it just
--                                        bought instead of silently
--                                        paying for two.
--
-- `for update` takes a row lock on the target household for the duration
-- of this call, so two concurrent provisioning attempts for the same
-- household can't both "succeed" with different numbers — this is the
-- mechanism that actually guarantees a household is never assigned two
-- numbers, not just an application-level check-then-write.

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
  -- Uses the built-in FOUND variable rather than selecting a literal
  -- `true` into a second target variable: when the SELECT INTO below
  -- matches zero rows, PL/pgSQL sets every target variable to NULL, not
  -- false — so a manually-selected "found" flag is NULL, `not v_found`
  -- is also NULL under three-valued logic, and an IF treats a NULL
  -- condition as not-true, silently skipping the "household does not
  -- exist" branch entirely. FOUND is a real boolean (true/false, never
  -- NULL) reflecting whether the immediately preceding statement matched
  -- any rows, which is what this check actually needs. Discovered via
  -- direct RPC testing against a nonexistent household id — see
  -- docs/engineering/sql/016_twilio_assign_function_fix.sql for the
  -- verification that failed before this fix and passed after it.
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

revoke all on function public.assign_household_twilio_number(uuid, text) from public;
grant execute on function public.assign_household_twilio_number(uuid, text) to service_role;

-- ------------------------------------------------------------
-- 2. record_household_twilio_provisioning_failure
-- ------------------------------------------------------------
--
-- Records a failed provisioning attempt: increments the attempt counter,
-- stores the error, and flags the household 'failed' for administrative
-- attention/retry — except a household that already has a number (status
-- already 'active') is never downgraded by a late/racing failure report,
-- since it is by definition no longer failing.
--
-- No row lock needed: a plain UPDATE ... SET attempts = attempts + 1 is
-- already atomic per row in Postgres, and this function only ever moves
-- state towards 'failed', never away from 'active', so concurrent calls
-- can't produce an inconsistent result.

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
