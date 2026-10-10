-- 078_number_inventory.sql
--
-- STATUS: DRAFT — NOT APPLIED ANYWHERE (WS6 Magrathea → Twilio BYOC, 2026-10-11).
-- Numbering: 078 allocated to WS6 (Agent 2) by the launch lead.
-- Depends on: households (000…), twilio_number_quarantine (037). Does NOT
-- depend on 062 (draft) and does not register 'magrathea' in 062's
-- telephony_providers: routing_assignments mirroring is a follow-up once 062
-- is applied (docs/launch/2026-10-11-AGENT2-BYOC-REPORT.md).
-- Rollback: _rollbacks/078_rollback_number_inventory.sql (refuses while any
-- inventory number is assigned).
--
-- WHY. With NUMBER_PROVIDER=magrathea, HCG must not BUY a Twilio number per
-- household. Magrathea DDIs are ordered by a human (Magrathea portal), routed
-- by a human to the Twilio BYOC trunk, and then listed here. Provisioning
-- assigns one AVAILABLE DDI from this manually maintained inventory
-- (services/telephony/numberProviders/inventory.js). HCG never calls
-- Magrathea's API (trial REST is number-management only and returns 401).
--
-- RULES (enforced here, not only in the app):
--   1. UK geographic (01/02) or UK-wide 03 numbers only, E.164.
--   2. One inventory number per household at a time; claiming is idempotent
--      (a household that already holds an assigned inventory number gets the
--      SAME number back — the inventory analogue of Twilio friendlyName adopt).
--   3. A number is never handed out while any household holds it in
--      households.twilio_number or it sits in unreleased quarantine.
--   4. A number returned after quarantine waits a cooling-off period before it
--      can be issued again (a previous customer may still forward to it).
--   5. service_role only (no anon/authenticated access to table or functions).

create table if not exists public.number_inventory (
  e164_number text primary key
    check (e164_number ~ '^\+44[123][0-9]{8,9}$'),
  provider_code text not null default 'magrathea'
    check (provider_code ~ '^[a-z][a-z0-9_]{1,31}$'),
  status text not null default 'available'
    check (status in ('available', 'assigned', 'retired')),
  -- ON DELETE SET NULL: a hard-deleted household leaves its number ASSIGNED
  -- with no household (held) until the quarantine release returns it.
  household_id uuid references public.households(id) on delete set null,
  -- Carrier-enforced concurrent channel limit on this DDI, as configured at
  -- Magrathea (documentation; 2 on the trial, 10 standard). Not enforced here.
  channel_limit integer check (channel_limit is null or channel_limit between 1 and 100),
  provider_resource_id text,
  assigned_at timestamptz,
  released_at timestamptz,
  cooling_off_until timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint number_inventory_available_has_no_household
    check (status <> 'available' or household_id is null)
);

create unique index if not exists number_inventory_one_per_household
  on public.number_inventory (household_id)
  where status = 'assigned' and household_id is not null;

create index if not exists number_inventory_claimable_idx
  on public.number_inventory (provider_code, created_at)
  where status = 'available';

alter table public.number_inventory enable row level security;
revoke all on public.number_inventory from public, anon, authenticated;
grant select, insert, update on public.number_inventory to service_role;

-- Claim one DDI for a household. Returns the E.164 number, or null when the
-- inventory has nothing claimable. Idempotent per household.
create or replace function public.claim_inventory_number(p_household_id uuid, p_provider_code text default 'magrathea')
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_number text;
begin
  if p_household_id is null then
    raise exception 'claim_inventory_number: household required';
  end if;
  if not exists (select 1 from public.households h where h.id = p_household_id) then
    raise exception 'claim_inventory_number: unknown household';
  end if;

  select e164_number into v_number
    from public.number_inventory
   where household_id = p_household_id and status = 'assigned' and provider_code = p_provider_code
   limit 1;
  if v_number is not null then
    return v_number;
  end if;

  select i.e164_number into v_number
    from public.number_inventory i
   where i.status = 'available'
     and i.provider_code = p_provider_code
     and (i.cooling_off_until is null or i.cooling_off_until <= now())
     and not exists (select 1 from public.households h where h.twilio_number = i.e164_number)
     and not exists (select 1 from public.twilio_number_quarantine q
                      where q.twilio_number = i.e164_number and q.released_at is null)
   order by i.created_at, i.e164_number
   limit 1
   for update skip locked;
  if v_number is null then
    return null;
  end if;

  update public.number_inventory
     set status = 'assigned', household_id = p_household_id, assigned_at = now(),
         released_at = null, cooling_off_until = null, updated_at = now()
   where e164_number = v_number and status = 'available';
  return v_number;
end;
$$;

-- Undo a claim whose household assignment did NOT happen (the household does
-- not hold the number). Refuses (false) if the household holds it.
create or replace function public.return_unassigned_inventory_number(p_e164 text, p_household_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if exists (select 1 from public.households h where h.twilio_number = p_e164) then
    return false;
  end if;
  update public.number_inventory
     set status = 'available', household_id = null, assigned_at = null, updated_at = now()
   where e164_number = p_e164 and status = 'assigned' and household_id is not distinct from p_household_id;
  get diagnostics v_count = row_count;
  return v_count = 1;
end;
$$;

-- The quarantine release (deactivation confirmed by a human) returns the DDI
-- to the pool after a cooling-off period. Refuses (false) while any household
-- still holds the number.
create or replace function public.release_inventory_number_after_quarantine(p_e164 text, p_cooling_off_days integer default 30)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if p_cooling_off_days is null or p_cooling_off_days < 0 or p_cooling_off_days > 365 then
    raise exception 'release_inventory_number_after_quarantine: cooling-off days must be 0..365';
  end if;
  if exists (select 1 from public.households h where h.twilio_number = p_e164) then
    return false;
  end if;
  update public.number_inventory
     set status = 'available', household_id = null, released_at = now(),
         cooling_off_until = now() + make_interval(days => p_cooling_off_days), updated_at = now()
   where e164_number = p_e164 and status = 'assigned';
  get diagnostics v_count = row_count;
  return v_count = 1;
end;
$$;

revoke all on function public.claim_inventory_number(uuid, text) from public, anon, authenticated;
revoke all on function public.return_unassigned_inventory_number(text, uuid) from public, anon, authenticated;
revoke all on function public.release_inventory_number_after_quarantine(text, integer) from public, anon, authenticated;
grant execute on function public.claim_inventory_number(uuid, text) to service_role;
grant execute on function public.return_unassigned_inventory_number(text, uuid) to service_role;
grant execute on function public.release_inventory_number_after_quarantine(text, integer) to service_role;
