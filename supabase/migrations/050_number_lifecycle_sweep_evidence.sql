-- Number-lifecycle sweep durable evidence (2026-09-27) — Step 2 of the
-- provider-number lifecycle work, built on top of 047's entitlement
-- guard.
--
-- STATUS: DRAFT — NOT APPLIED to any database (staging or production).
--
-- NUMBERING: 050 is a PLACEHOLDER, not yet confirmed. 048 is reserved
-- for the paused billing-ledger branch. The monitored-minute allowance
-- branch is expected to take the next free number when it is rebased
-- (per 047's own header) — likely 049. This file must be renumbered at
-- integration time if either of those lands first, following this
-- project's own established convention (047 itself was renumbered from
-- 049). Run scripts/check-migration-numbering.js (fix/migration-safety-
-- tooling, PR #46) before merging to confirm no clash.
--
-- Purpose: two small, additive pieces of durable state the daily
-- reconciliation sweep (services/numberLifecycleSweep.js) needs, neither
-- of which exists anywhere in this schema today:
--
--   1. entitlement_expiry_warnings_sent — idempotency for the 14-day
--      pre-expiry warning sent to test/reviewer/internal memberships.
--      Without this, a warning has no durable "already sent" marker, so
--      a repeated sweep run (the daily job re-running, or two overlapping
--      runs) would either re-send it every day until expiry or need to
--      infer "already warned" from something indirect and unreliable.
--      One row per (entitlement_id) that has been warned — existence of
--      a row IS the idempotency check, mirroring this project's own
--      established pattern for the exact same problem
--      (acquisition_events' external_event_id partial unique index,
--      migration 032; stripe_webhook_events' claim-once RPC).
--
--   2. households.twilio_release_last_attempt_at /
--      twilio_release_last_error / twilio_release_attempt_count — durable
--      evidence of a release ATTEMPT and its outcome, so a failure isn't
--      only ever visible as a transient log line (Railway's own log
--      retention is itself an open, unresolved question — see ADR-0019
--      and docs/security/SECURITY_OVERVIEW.md risk #8). Mirrors the
--      already-established twilio_provisioning_last_error pattern
--      (migration 016) exactly, applied to the release side instead of
--      the provisioning side. This is the "minimum durable database
--      evidence" the admin reconciliation dashboard (PR #47,
--      services/adminNumberLifecycleReconciliation.js) needs so a failed
--      release doesn't have to be inferred forever — it is deliberately
--      NOT a new UI, NOT a new dashboard (Dashboard ownership stays with
--      PR #47/admin-business.html), just the data those surfaces read.
--
-- No data is changed by this migration; both additions are nullable/
-- empty by default. No existing table, column, function, or grant is
-- altered. household_is_currently_entitled/household_has_upcoming_
-- entitlement/household_blocks_number_release (047) are untouched —
-- this migration adds evidence AROUND the release lifecycle, it does not
-- change what is or isn't allowed to release a number. Rollback: drop
-- the new table and the three new households columns; see
-- supabase/migrations/_rollbacks/050_rollback_number_lifecycle_sweep_evidence.sql.

begin;

create table if not exists public.entitlement_expiry_warnings_sent (
  entitlement_id uuid primary key
    references public.entitlements(id)
    on delete cascade,
  household_id uuid not null
    references public.households(id)
    on delete cascade,
  sent_at timestamptz not null default now()
);

create index if not exists entitlement_expiry_warnings_sent_household_id_idx
  on public.entitlement_expiry_warnings_sent (household_id);

alter table public.entitlement_expiry_warnings_sent enable row level security;
-- Same access model as every other operational table in this project —
-- service_role only, no anon/authenticated policy.
grant select, insert on public.entitlement_expiry_warnings_sent to service_role;

alter table public.households
  add column if not exists twilio_release_last_attempt_at timestamptz,
  add column if not exists twilio_release_last_error text,
  add column if not exists twilio_release_attempt_count integer not null default 0;

-- Narrow, purpose-built RPCs, matching this project's established
-- convention (every mutation goes through a SECURITY DEFINER function,
-- never a blanket UPDATE grant) — service_role has no direct UPDATE
-- grant on entitlements or the new columns above; these three are the
-- only write path.

-- Transitions ONE entitlement from 'active' to 'expired' — but only if
-- its own end date has genuinely passed. Re-checks the condition itself
-- rather than trusting the caller (the sweep's pure decision function
-- proposes candidates; this is the safety net if that logic is ever
-- wrong). A no-op (returns false), never an error, for a row that
-- doesn't qualify — the sweep runs daily and must never be surprised by
-- an exception on a row that simply isn't ready yet.
create or replace function public.expire_lapsed_entitlement(p_entitlement_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_updated boolean;
begin
  update public.entitlements
    set status = 'expired'
    where id = p_entitlement_id
      and status = 'active'
      and ends_at is not null
      and ends_at <= now()
    returning true into v_updated;

  return coalesce(v_updated, false);
end;
$$;

revoke all on function public.expire_lapsed_entitlement(uuid) from public, anon, authenticated;
grant execute on function public.expire_lapsed_entitlement(uuid) to service_role;

-- Idempotent by construction: ON CONFLICT DO NOTHING on the primary key
-- means a repeated sweep run (or two overlapping runs) can call this
-- for the same entitlement any number of times and only the first
-- actually records anything — exactly the property the sweep's own
-- idempotency requirement needs, enforced at the database level, not
-- just in application logic (same principle as migration 033's
-- single-use invite redemption).
create or replace function public.record_entitlement_expiry_warning_sent(
  p_entitlement_id uuid,
  p_household_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inserted boolean;
begin
  insert into public.entitlement_expiry_warnings_sent (entitlement_id, household_id)
  values (p_entitlement_id, p_household_id)
  on conflict (entitlement_id) do nothing
  returning true into v_inserted;

  return coalesce(v_inserted, false);
end;
$$;

revoke all on function public.record_entitlement_expiry_warning_sent(uuid, uuid) from public, anon, authenticated;
grant execute on function public.record_entitlement_expiry_warning_sent(uuid, uuid) to service_role;

-- Records a release ATTEMPT and its outcome (error text, or null for
-- success) — durable evidence for the admin reconciliation dashboard
-- (PR #47), independent of Railway's own log retention (unresolved, see
-- ADR-0019 / SECURITY_OVERVIEW.md risk #8). Never itself releases or
-- blocks a release — purely observational, called by the sweep runner
-- immediately after every real release attempt, success or failure.
create or replace function public.record_twilio_release_attempt(
  p_household_id uuid,
  p_error text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.households
    set twilio_release_last_attempt_at = now(),
        twilio_release_last_error = p_error,
        twilio_release_attempt_count = twilio_release_attempt_count + 1
    where id = p_household_id;

  if not found then
    raise exception 'record_twilio_release_attempt: household % does not exist', p_household_id;
  end if;
end;
$$;

revoke all on function public.record_twilio_release_attempt(uuid, text) from public, anon, authenticated;
grant execute on function public.record_twilio_release_attempt(uuid, text) to service_role;

commit;

-- Read-only verification — run after commit.
do $$
begin
  if to_regclass('public.entitlement_expiry_warnings_sent') is null then
    raise exception 'MIGRATION 050 VERIFICATION FAILED: public.entitlement_expiry_warnings_sent does not exist';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'households'
      and column_name = 'twilio_release_last_attempt_at'
  ) then
    raise exception 'MIGRATION 050 VERIFICATION FAILED: households.twilio_release_last_attempt_at missing';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'households'
      and column_name = 'twilio_release_attempt_count' and column_default is not null
  ) then
    raise exception 'MIGRATION 050 VERIFICATION FAILED: households.twilio_release_attempt_count missing or has no default';
  end if;
end
$$;
