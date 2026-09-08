-- Adds households.voice_client_registered_at: the last time this
-- household's mobile app genuinely completed Twilio Voice SDK
-- registration (client-side voice.register() resolving, reported back
-- server-side via the new POST /api/v1/voice/registered — see
-- mobile/lib/voiceClient.ts's performRegistration()). This is a
-- reachability signal, not a proof of delivery — see migration 036 for
-- the separate, stronger "an approved call actually connected" evidence.
--
-- STATUS: DRAFT — NOT APPLIED.
--
-- Closes a real gap: decideCallDeliveryPlan has never had any way to know
-- whether a self-protecting-mobile household's Voice SDK client is
-- actually reachable before choosing client-only delivery — true for one
-- internal test device, false (and unknowable) for every real household,
-- per the 2026-08-30/2026-09-07 production incidents recorded in
-- docs/mobile-app/APP_DECISION_008_call_delivery_architecture.md. This
-- column, together with isVoiceClientReachable() (services/
-- callRouting.js), lets decideCallDeliveryPlan tell the difference
-- between "reachable now" (client-only) and "not currently reachable"
-- (self-protecting-unreachable — still never PSTN, but honestly
-- alertable instead of a silent dead <Dial>).
--
-- Scope note (2026-09-08): a separate households.device_type column and
-- an explicitly-classified-landline PSTN delivery path were designed
-- alongside this one, then deferred before release — see this migration
-- series' own docs/mobile-app/APP_DECISION_008_call_delivery_architecture.md
-- update for the full evidence (Twilio's ForwardedFrom parameter, the
-- only live signal available for proving landline loop safety, carries no
-- usable information in this account's real call history). This
-- migration is unaffected — voice_client_registered_at exists purely to
-- support the mobile self-protecting reachability gate above, independent
-- of whatever a future landline delivery path ends up needing.
--
-- Deliberately NOT idempotent-once, unlike mark_household_activation_
-- verified (021): every real registration event should move this
-- timestamp forward, since staleness (not "was it ever true") is
-- exactly the signal isVoiceClientReachable checks — a token expires
-- roughly hourly and the app is expected to re-register well before
-- then (mobile/lib/voiceClient.ts's own scheduleRefresh), so a
-- household that stops actively registering must naturally age out of
-- "reachable" rather than staying permanently marked as such from one
-- registration weeks ago.

begin;

alter table public.households
  add column if not exists voice_client_registered_at timestamptz;

create or replace function public.mark_household_voice_client_registered(
  p_household_id uuid
)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result timestamptz;
begin
  update public.households
    set voice_client_registered_at = now()
    where id = p_household_id
    returning voice_client_registered_at into v_result;

  if not found then
    raise exception 'mark_household_voice_client_registered: household % does not exist', p_household_id;
  end if;

  return v_result;
end;
$$;

revoke all on function public.mark_household_voice_client_registered(uuid) from public;
grant execute on function public.mark_household_voice_client_registered(uuid) to service_role;

commit;

-- Read-only verification — run after commit.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'households'
      and column_name = 'voice_client_registered_at' and data_type = 'timestamp with time zone'
  ) then
    raise exception 'MIGRATION 035 VERIFICATION FAILED: households.voice_client_registered_at missing or wrong type';
  end if;

  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'mark_household_voice_client_registered'
  ) then
    raise exception 'MIGRATION 035 VERIFICATION FAILED: mark_household_voice_client_registered function missing';
  end if;
end
$$;
