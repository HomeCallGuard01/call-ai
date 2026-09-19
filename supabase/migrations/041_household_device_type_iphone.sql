-- Widen households.device_type to a third value, 'iphone' — the
-- server-side signal that a household self-declared (via the web
-- device-type picker, or a future mobile build) that the phone being
-- protected is an iPhone.
--
-- STATUS: NOT YET APPLIED to any database. Prepared alongside the
-- Android/landline launch work (2026-09-19) while Apple App Store
-- approval for the iOS app remains pending — see
-- docs/launch/IOS_COMING_SOON_LAUNCH_FLAG.md for the full design.
--
-- Why 'iphone' belongs on device_type rather than a new parallel column:
-- this is exactly the same shape of fact migration 040 already models
-- (mobile vs landline) — "what kind of device is this household
-- protecting" — and evaluateHouseholdCheckoutEligibility already has the
-- established, tested pattern for adding a device_type-driven checkout
-- branch (see the landline branch it added). Reusing the same column and
-- the same RPC keeps exactly one authoritative place for this fact,
-- rather than inventing a second signal that could drift from it.
--
-- 'iphone' is deliberately NOT a synonym for 'mobile' — it does not fall
-- through to the UK mobile-carrier PROVIDER_POLICY gate at all (an
-- iPhone customer is blocked outright by the IOS_COMING_SOON flag,
-- before carrier compatibility would ever matter), and does not attempt
-- to infer which UK mobile network the customer is on. Carrier/tariff
-- are atomically cleared on this transition for the same reason they
-- already are on 'landline' — no stale mobile-carrier data should ever
-- sit on a household this policy branch doesn't apply to.
--
-- Removal note: this migration is NOT what makes iPhone purchasing
-- unavailable — services/featureFlags.js's IOS_COMING_SOON env var does,
-- read by evaluateHouseholdCheckoutEligibility. This migration only adds
-- the *vocabulary* ('iphone' as a valid device_type value) and stays in
-- place permanently; once Apple approves the app and IOS_COMING_SOON is
-- set to "false", a household with device_type = 'iphone' simply falls
-- through to whatever the (at that point, presumably built) iOS purchase
-- path requires — this schema change does not need to be reverted.

begin;

-- The exact auto-generated name Postgres assigns an inline column CHECK
-- added via `add column ... check (...)` (migration 040's own form) is
-- `<table>_<column>_check` — dropped by that exact, well-established
-- name; `if exists` is still a safety net, not a guess, since the
-- verification block below re-checks the actual resulting constraint
-- regardless of what this drop did or didn't find.
alter table public.households
  drop constraint if exists households_device_type_check;

alter table public.households
  add constraint households_device_type_check
    check (device_type is null or device_type in ('mobile', 'landline', 'iphone'));

-- Replaces migration 040's function with an identical 4-argument one,
-- widened only to accept and correctly handle 'iphone' — same atomic-
-- clear-of-carrier-fields treatment as 'landline', since neither has a
-- UK mobile carrier compatibility question that matters.
create or replace function public.set_household_carrier_compatibility(
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
  if p_device_type is null or p_device_type not in ('mobile', 'landline', 'iphone') then
    raise exception 'set_household_carrier_compatibility: invalid device_type %', p_device_type;
  end if;

  update public.households
    set device_type = p_device_type,
        carrier_provider_key = case when p_device_type in ('landline', 'iphone') then null else p_provider_key end,
        carrier_tariff_type = case when p_device_type in ('landline', 'iphone') then null else p_tariff_type end,
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
    select 1 from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    where t.relname = 'households' and c.conname = 'households_device_type_check'
      and pg_get_constraintdef(c.oid) ilike '%iphone%'
  ) then
    raise exception 'MIGRATION 041 VERIFICATION FAILED: households_device_type_check does not permit iphone';
  end if;

  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'set_household_carrier_compatibility'
      and p.pronargs = 4
  ) then
    raise exception 'MIGRATION 041 VERIFICATION FAILED: the 4-argument set_household_carrier_compatibility does not exist';
  end if;
end
$$;
