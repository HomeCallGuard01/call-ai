-- Voice SDK registration HISTORY (2026-09-27) — P0-3, HCG launch hardening.
--
-- Why: households.voice_client_registered_at (migration 035) is a single,
-- overwritten timestamp — every new registration replaces it, so nothing
-- in this database can currently distinguish "registered once, months
-- ago, dead ever since" from "registers reliably every few minutes" or
-- "registered once, then never again." A real production case (a paying
-- customer whose Voice SDK client never once successfully registered,
-- across the household's entire three-day subscription) was only
-- diagnosable at all because the household happened to have zero
-- registrations, ever — a household with even one stale registration
-- from weeks ago would have looked identical to one registering
-- healthily today, since only the latest timestamp survives.
--
-- What this adds:
--   * voice_client_registration_events — one append-only row per genuine
--     registration event (never updated or deleted; a full audit trail,
--     not a rolling window). platform/app_version/app_build_version
--     mirror the same optional diagnostic fields migration 045 already
--     added to the single-timestamp path (mobile/lib/voiceClient.ts's
--     performRegistration() already sends these — this captures them
--     per-event instead of only on the household's most recent one).
--   * record_voice_client_registration_event — the ONE new write path:
--     inserts a history row AND updates households.voice_client_registered_at
--     in the same statement, so every existing reader of that column
--     (services/callRouting.js's hasVoiceClientRegistrationHistory,
--     computeProtectionStatus, decideCallDeliveryPlan) is completely
--     unaffected by this change — they keep working exactly as before,
--     unaware history is now also being kept alongside their existing
--     single-timestamp signal.
--
-- The old mark_household_voice_client_registered RPC (migration 035) is
-- left in place, untouched, as a rollback path — this migration adds a
-- new RPC rather than replacing it. database/households.js's
-- markVoiceClientRegistered is updated (application-code change, not
-- part of this migration) to call the new RPC instead; if that ever
-- needs reverting, the old RPC is still there to call.
--
-- STATUS: NOT YET APPLIED to any database.

begin;

create table if not exists public.voice_client_registration_events (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null
    references public.households(id)
    on delete cascade,
  registered_at timestamptz not null default now(),
  app_platform text,
  app_version text,
  app_build_version text
);

create index if not exists voice_client_registration_events_household_recent
  on public.voice_client_registration_events (household_id, registered_at desc);

alter table public.voice_client_registration_events enable row level security;
-- Same access model as every other operational table in this project
-- (households, calls, entitlements): no anon/authenticated policies at
-- all — reachable only via the service_role key, used exclusively by
-- this backend. RLS is enabled specifically so that remains true even if
-- a future migration ever grants anon/authenticated broader schema
-- access by mistake — an explicit, auditable choice, not an oversight.
--
-- Explicit SELECT grant to service_role (mirroring migration 009's own
-- pattern for households/calls) — writes to this table only ever happen
-- through the SECURITY DEFINER RPC below, which needs no separate grant
-- to insert (it runs as its owner, not as the caller), but a future
-- admin-diagnostic feature reading this table directly via
-- supabaseAdmin.from('voice_client_registration_events') needs this
-- grant to exist now, not to be silently missing until that feature is
-- built and fails in a way that looks like an RLS problem instead of a
-- plain missing GRANT.
grant select on public.voice_client_registration_events to service_role;

create or replace function public.record_voice_client_registration_event(
  p_household_id uuid,
  p_app_platform text default null,
  p_app_version text default null,
  p_app_build_version text default null
)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result timestamptz;
begin
  insert into public.voice_client_registration_events (household_id, app_platform, app_version, app_build_version)
  values (p_household_id, p_app_platform, p_app_version, p_app_build_version);

  update public.households
    set voice_client_registered_at = now()
    where id = p_household_id
    returning voice_client_registered_at into v_result;

  if not found then
    raise exception 'record_voice_client_registration_event: household % does not exist', p_household_id;
  end if;

  return v_result;
end;
$$;

revoke all on function public.record_voice_client_registration_event(uuid, text, text, text) from public;
grant execute on function public.record_voice_client_registration_event(uuid, text, text, text) to service_role;

commit;

-- Read-only verification — run after commit.
do $$
begin
  if to_regclass('public.voice_client_registration_events') is null then
    raise exception 'MIGRATION 046 VERIFICATION FAILED: public.voice_client_registration_events does not exist';
  end if;

  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'record_voice_client_registration_event'
      and p.pronargs = 4
  ) then
    raise exception 'MIGRATION 046 VERIFICATION FAILED: record_voice_client_registration_event does not exist';
  end if;

  -- The old RPC (migration 035) must still exist, untouched — this
  -- migration is purely additive, never a replacement.
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'mark_household_voice_client_registered'
  ) then
    raise exception 'MIGRATION 046 VERIFICATION FAILED: the old mark_household_voice_client_registered RPC (migration 035) is missing — this migration must never remove it';
  end if;
end
$$;
