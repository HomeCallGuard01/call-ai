-- Diagnostic instrumentation (2026-09-24) — closes the two remaining
-- gaps found tracing a real production failed call:
--
-- 1. households.app_version / app_build_version / app_platform: this app
--    has never reported its own installed version anywhere. Support
--    could not confirm what a real customer was running (see this
--    session's own investigation — the question "has he actually
--    updated to 1.0.1?" was genuinely unanswerable from this database).
--    Piggybacks on the existing POST /api/v1/voice/registered call
--    (mobile/lib/voiceClient.ts's registerForIncomingCalls, already
--    fired on every app open/foreground) — no new network round-trip.
--
-- 2. calls.client_invite_received_at / client_outcome: the backend
--    already knows a <Dial><Client> was ATTEMPTED (dial_call_status,
--    migration 044) but has no visibility at all into what happened on
--    the device itself. Reported by the Twilio Voice SDK's own
--    CallInvite lifecycle events (mobile/lib/voiceClient.ts) via new,
--    authenticated (requireAuthApi) endpoints — never the existing
--    unauthenticated /debug/voice-beacon pattern already present
--    elsewhere in this file (that one is a separate, pre-existing,
--    explicitly-temporary diagnostic left untouched by this change).
--    Together with dial_call_status, this narrows a future failure to
--    one of: never reached the client at all (dial attempted,
--    client_invite_received_at stays null — push/SDK-level failure);
--    reached the client but never resolved (received, no outcome —
--    likely a UI-presentation failure or the ring simply timing out);
--    or a real customer action (client_outcome accepted/rejected, or
--    cancelled if the caller hung up first).
--
-- STATUS: DRAFT — NOT APPLIED.
--
-- Deliberately plain columns, not a new table: both are per-row/per-
-- household facts read alongside data these tables already hold, and
-- this project's established convention (activation_verified_at,
-- voice_client_registered_at, delivery_verified_at, dial_call_status)
-- is always a plain column on the row it describes.

begin;

alter table public.households
  add column if not exists app_version text,
  add column if not exists app_build_version text,
  add column if not exists app_platform text;

alter table public.calls
  add column if not exists client_invite_received_at timestamptz,
  add column if not exists client_outcome text;

-- App-version reporting is genuinely low-stakes (a version string, not
-- protection-critical state) but still goes through the same
-- SECURITY DEFINER RPC discipline every other households write in this
-- codebase uses — no direct service_role UPDATE grant is assumed or
-- required beyond what already exists for the other RPCs.
create or replace function public.mark_household_app_version(
  p_household_id uuid,
  p_app_version text,
  p_app_build_version text,
  p_app_platform text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.households
    set app_version = p_app_version,
        app_build_version = p_app_build_version,
        app_platform = p_app_platform
    where id = p_household_id;

  if not found then
    raise exception 'mark_household_app_version: household % does not exist', p_household_id;
  end if;
end;
$$;

revoke all on function public.mark_household_app_version(uuid, text, text, text) from public;
grant execute on function public.mark_household_app_version(uuid, text, text, text) to service_role;

commit;

-- Read-only verification — run after commit.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'households' and column_name = 'app_version'
  ) then
    raise exception 'MIGRATION 045 VERIFICATION FAILED: households.app_version missing';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'calls' and column_name = 'client_invite_received_at'
  ) then
    raise exception 'MIGRATION 045 VERIFICATION FAILED: calls.client_invite_received_at missing';
  end if;
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'mark_household_app_version'
  ) then
    raise exception 'MIGRATION 045 VERIFICATION FAILED: mark_household_app_version function missing';
  end if;
end
$$;
