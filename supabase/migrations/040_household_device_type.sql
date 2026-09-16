-- Household device/protection type — the missing authoritative signal
-- for "is this household mobile or landline", closing the launch-
-- blocking defect found during PR #39 staging acceptance testing
-- (2026-09-16): evaluateHouseholdCheckoutEligibility() had no way to
-- distinguish a genuine landline household from a mobile household that
-- simply hadn't completed the carrier-selection step yet — both have
-- carrier_provider_key = null — so every landline customer was
-- incorrectly blocked at checkout by the mobile carrier-compatibility
-- gate.
--
-- STATUS: APPLIED to staging (tigwgmayeuisrxjjykqd) 2026-09-16. NOT
-- applied to production.
--
-- device_type is deliberately the COARSE mobile/landline distinction
-- that matches the pre-payment "What are we protecting?" radio choice
-- — NOT the mobile app's separate, finer-grained DeviceType
-- (iphone/android/landline) used only for activation-code copy, which
-- is unrelated and unaffected by this migration.
--
-- Backfill policy (read-only staging investigation, 2026-09-16 —
-- see that investigation's own findings): only households with an
-- already-populated carrier_provider_key can be safely, deterministically
-- backfilled as 'mobile' — that field could only ever have been written
-- by the mobile carrier-selection flow. No signal exists anywhere in
-- this schema that reliably indicates landline (households.phone_number
-- is "where safe calls should ring", not necessarily the protected
-- device's own number — see migration 028's own comment on why that
-- distinction is deliberately never inferred), so landline is
-- deliberately NOT backfilled. Every other legacy/unclassified household
-- is left NULL, which the application layer (services/providerPolicy.js)
-- treats identically to "mobile, not yet classified" — blocked, never
-- assumed landline.
--
-- carrier_provider_key/carrier_tariff_type are cleared atomically in the
-- SAME write as device_type = 'landline' (see the updated
-- set_household_carrier_compatibility below) — a household can never
-- end up landline with stale mobile carrier data still attached, and a
-- household switching back to mobile always requires a fresh, real
-- carrier selection before it can proceed to payment again.
--
-- NAME COLLISION, NOT A REVIVAL: a differently-scoped households.device_type
-- (three-value iphone/android/landline, intended to drive PSTN call-
-- delivery routing) was designed, then deliberately deferred and never
-- applied to any database — see docs/mobile-app/
-- APP_DECISION_008_call_delivery_architecture.md's 2026-09-08 update for
-- why (Twilio's ForwardedFrom parameter cannot prove landline loop
-- safety in this account). THIS column is unrelated: two-value
-- (mobile/landline) domain, read only by services/providerPolicy.js for
-- checkout eligibility. services/callRouting.js must not be changed to
-- read it without independently redoing that loop-safety analysis —
-- see that doc's 2026-09-16 update.

begin;

alter table public.households
  add column if not exists device_type text
    check (device_type is null or device_type in ('mobile', 'landline'));

-- Safe, evidence-based backfill only — see header. Never touches
-- device_type for a household that already has one set (idempotent on
-- re-run), and never guesses landline.
update public.households
  set device_type = 'mobile'
  where carrier_provider_key is not null and device_type is null;

-- Replaces migration 038's 3-argument function with a 4-argument one
-- (device_type is now required) — the old signature is dropped first
-- since `create or replace` only replaces a function with the exact
-- same argument list; leaving both around would create an ambiguous
-- overload. This function is called only from this codebase's own
-- backend (database/households.js), never by an external client
-- directly, so changing its signature is safe as long as every caller
-- is updated in the same change (see routes/billing.js, routes/mobileApi.js).
drop function if exists public.set_household_carrier_compatibility(uuid, text, text);

create function public.set_household_carrier_compatibility(
  p_household_id uuid,
  p_device_type text,
  p_provider_key text,
  p_tariff_type text default null
)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result timestamptz;
begin
  if p_device_type is null or p_device_type not in ('mobile', 'landline') then
    raise exception 'set_household_carrier_compatibility: invalid device_type %', p_device_type;
  end if;

  update public.households
    set device_type = p_device_type,
        -- Atomic clear on landline: never leaves a stale mobile
        -- provider/tariff behind, regardless of what was passed in —
        -- defensive even against a future caller bug that might
        -- accidentally still send provider/tariff alongside landline.
        carrier_provider_key = case when p_device_type = 'landline' then null else p_provider_key end,
        carrier_tariff_type = case when p_device_type = 'landline' then null else p_tariff_type end,
        carrier_compatibility_captured_at = now()
    where id = p_household_id
    returning carrier_compatibility_captured_at into v_result;

  if not found then
    raise exception 'set_household_carrier_compatibility: household % does not exist', p_household_id;
  end if;

  return v_result;
end;
$$;

revoke all on function public.set_household_carrier_compatibility(uuid, text, text, text) from public;
grant execute on function public.set_household_carrier_compatibility(uuid, text, text, text) to service_role;

commit;

-- Read-only verification — run after commit.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'households'
      and column_name = 'device_type' and data_type = 'text'
  ) then
    raise exception 'MIGRATION 040 VERIFICATION FAILED: households.device_type missing or wrong type';
  end if;

  -- pronargs (total parameter count, including any with defaults) is
  -- used here rather than matching a full pg_get_function_identity_arguments
  -- string — that string's exact format (whether parameter names are
  -- included) is not consistent across every Postgres-compatible engine
  -- this migration is verified against, but the argument count alone is
  -- unambiguous per function name and is exactly what distinguishes the
  -- dropped 3-arg signature from the new 4-arg one.
  if exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'set_household_carrier_compatibility'
      and p.pronargs = 3
  ) then
    raise exception 'MIGRATION 040 VERIFICATION FAILED: the old 3-argument set_household_carrier_compatibility still exists (drop did not take effect)';
  end if;

  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'set_household_carrier_compatibility'
      and p.pronargs = 4
  ) then
    raise exception 'MIGRATION 040 VERIFICATION FAILED: the new 4-argument set_household_carrier_compatibility does not exist';
  end if;
end
$$;
