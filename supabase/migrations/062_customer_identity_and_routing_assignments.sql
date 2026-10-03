-- Permanent customer identity + carrier-neutral routing assignments
-- (2026-10-03) — feature/customer-identity-carrier-abstraction.
--
-- STATUS: DRAFT — NOT APPLIED to any database (not staging, not production).
--
-- PROVISIONAL NUMBER. 062 is simply the first number not claimed by any
-- branch on 2026-10-03 (046, 055, 060 and 061 are each claimed twice on
-- different branches; 057–061 from security/supabase-staging-remediation
-- are applied to STAGING). Per the agreed rule, migration numbers are
-- assigned at merge/application time — renumber this file (and its
-- _rollbacks/ twin) to the next free number when it is actually merged.
-- Nothing in this file depends on 047–061; it applies on top of main (046).
--
-- Why
-- ---
-- Today a customer's identity is effectively their Twilio number:
-- households.twilio_number is the only routing record, inbound calls are
-- matched to a household by scanning that column
-- (database/households.js getHouseholdByTwilioNumber), and clearing it
-- (release) loses the number's history entirely. Moving carrier, porting
-- a number, or giving a customer a replacement number would therefore
-- either lose history or look like a different customer.
--
-- What this adds (purely additive — no existing column, function, policy
-- or row is changed apart from the backfilled account_number):
--
--   1. households.account_number — a permanent, human-readable,
--      non-secret HCG account number, e.g. HCG-00010017:
--        "HCG-" + 7-digit serial (zero padded) + 1 Luhn check digit.
--      * generated server-side from a sequence (never reused — Postgres
--        sequences never hand out the same value twice, even when the
--        transaction that drew it rolls back);
--      * a BEFORE INSERT/UPDATE trigger ALWAYS overrides any client value,
--        so a customer (authenticated holds table-wide INSERT/UPDATE on
--        households since migration 006) can never choose or forge one;
--      * immutable once set;
--      * recorded in hcg_account_numbers, an append-only registry that is
--        never deleted from, so even a hard-deleted household's number can
--        never be issued to anyone else.
--      It is NOT authentication. Knowing an account number grants nothing.
--
--   2. telephony_providers — provider codes (seeded: twilio only; other
--      carriers are added as rows when contracted, no schema change).
--
--   3. routing_assignments — household -> protection service -> provider
--      -> provider resource id -> public E.164 number, with an explicit
--      lifecycle state (requested, provisioning, active, port_pending,
--      replacement_pending, releasing, released, failed, quarantined).
--      Multiple rows per household: current, overlap during migration,
--      and every previous number.
--
--   4. routing_assignment_events — append-only audit trail of every
--      creation, state change, primary change and resource-id fill-in.
--
--   5. Service-role RPCs for the lifecycle (create, compare-and-set
--      transition, make primary, complete port, roll back replacement)
--      and two idempotent backfills.
--
--   6. A best-effort LEGACY MIRROR: triggers on households.twilio_number
--      and twilio_number_quarantine keep routing_assignments in step with
--      the existing Twilio code paths, which are NOT changed. A mirror
--      failure is recorded in customer_identity_sync_anomalies and never
--      blocks the legacy write.
--
-- What this does NOT do: inbound routing still reads
-- households.twilio_number; nothing calls a provider; nothing changes
-- billing. See docs/architecture/CUSTOMER_IDENTITY_AND_CARRIER_ABSTRACTION.md.
--
-- DECISION REQUIRED before application: account serial START value
-- (1001 here, so the first account is HCG-00010017 and the number does
-- not reveal "customer #3"). It cannot be lowered after numbers are issued.
--
-- Side effect to know about: the account-number backfill UPDATEs every
-- household row once, so households_set_updated_at bumps updated_at on
-- every existing household (nothing in the app reads households.updated_at
-- as an activity signal on 2026-10-03).

begin;

-- ------------------------------------------------------------------
-- 1. Account numbers
-- ------------------------------------------------------------------

create sequence if not exists public.hcg_account_serial_seq
  as bigint
  start with 1001
  minvalue 1
  no cycle;

revoke all on sequence public.hcg_account_serial_seq from public, anon, authenticated;
grant usage, select on sequence public.hcg_account_serial_seq to service_role;

-- Luhn check digit for the serial's decimal digits (the same algorithm as
-- services/customerIdentity/accountNumber.js — parity is tested).
create or replace function public.hcg_account_check_digit(p_serial bigint)
returns integer
language plpgsql
immutable
strict
set search_path = ''
as $$
declare
  v_digits text := p_serial::text;
  v_sum integer := 0;
  v_digit integer;
  v_double boolean := true;
  i integer;
begin
  if p_serial < 1 then
    raise exception 'hcg_account_check_digit: serial must be positive';
  end if;
  for i in reverse length(v_digits)..1 loop
    v_digit := substr(v_digits, i, 1)::integer;
    if v_double then
      v_digit := v_digit * 2;
      if v_digit > 9 then
        v_digit := v_digit - 9;
      end if;
    end if;
    v_sum := v_sum + v_digit;
    v_double := not v_double;
  end loop;
  return (10 - (v_sum % 10)) % 10;
end;
$$;

create or replace function public.hcg_format_account_number(p_serial bigint)
returns text
language sql
immutable
strict
set search_path = ''
as $$
  -- lpad() truncates longer input, so only pad serials shorter than 7 digits.
  select 'HCG-'
      || case when length(p_serial::text) >= 7 then p_serial::text else lpad(p_serial::text, 7, '0') end
      || public.hcg_account_check_digit(p_serial)::text;
$$;

revoke all on function public.hcg_account_check_digit(bigint) from public, anon, authenticated;
revoke all on function public.hcg_format_account_number(bigint) from public, anon, authenticated;
grant execute on function public.hcg_account_check_digit(bigint) to service_role;
grant execute on function public.hcg_format_account_number(bigint) to service_role;

alter table public.households
  add column if not exists account_number text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'households_account_number_key'
  ) then
    alter table public.households
      add constraint households_account_number_key unique (account_number);
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'households_account_number_format'
  ) then
    alter table public.households
      add constraint households_account_number_format
      check (account_number is null or account_number ~ '^HCG-[0-9]{8,}$');
  end if;
end;
$$;

-- Append-only registry: one row per number ever issued. Never deleted, so
-- a number is never re-issued even if the household row is hard-deleted.
create table if not exists public.hcg_account_numbers (
  account_number text primary key
    check (account_number ~ '^HCG-[0-9]{8,}$'),
  serial bigint not null unique,
  household_id uuid
    references public.households(id)
    on delete set null,
  issued_at timestamptz not null default now()
);

create unique index if not exists hcg_account_numbers_household_id_key
  on public.hcg_account_numbers (household_id)
  where household_id is not null;

alter table public.hcg_account_numbers enable row level security;
revoke all on public.hcg_account_numbers from public, anon, authenticated;
grant select on public.hcg_account_numbers to service_role;

create or replace function public.hcg_account_numbers_block_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- The only permitted UPDATE is the FK's own ON DELETE SET NULL.
  if tg_op = 'UPDATE'
     and new.account_number = old.account_number
     and new.serial = old.serial
     and new.issued_at = old.issued_at
     and new.household_id is null then
    return new;
  end if;
  raise exception 'hcg_account_numbers is append-only (% refused)', tg_op;
end;
$$;

revoke all on function public.hcg_account_numbers_block_mutation() from public, anon, authenticated;
grant execute on function public.hcg_account_numbers_block_mutation() to service_role;

drop trigger if exists hcg_account_numbers_append_only on public.hcg_account_numbers;
create trigger hcg_account_numbers_append_only
  before update or delete on public.hcg_account_numbers
  for each row execute function public.hcg_account_numbers_block_mutation();

-- Assigns (INSERT, or UPDATE of a not-yet-numbered row) and freezes
-- (UPDATE of a numbered row) households.account_number. Whatever value a
-- caller supplies is ignored: the number always comes from the sequence.
create or replace function public.households_assign_account_number()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_serial bigint;
begin
  if tg_op = 'UPDATE' and old.account_number is not null then
    if new.account_number is distinct from old.account_number then
      raise exception 'households.account_number is permanent and cannot be changed';
    end if;
    return new;
  end if;

  v_serial := nextval('public.hcg_account_serial_seq');
  new.account_number := public.hcg_format_account_number(v_serial);
  return new;
end;
$$;

revoke all on function public.households_assign_account_number() from public, anon, authenticated;
grant execute on function public.households_assign_account_number() to service_role;

create or replace function public.households_register_account_number()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.account_number is not null
     and (tg_op = 'INSERT' or old.account_number is null) then
    insert into public.hcg_account_numbers (account_number, serial, household_id)
    values (
      new.account_number,
      substr(new.account_number, 5, length(new.account_number) - 5)::bigint,
      new.id
    );
  end if;
  return null;
end;
$$;

revoke all on function public.households_register_account_number() from public, anon, authenticated;
grant execute on function public.households_register_account_number() to service_role;

drop trigger if exists households_account_number_assign on public.households;
create trigger households_account_number_assign
  before insert or update of account_number on public.households
  for each row execute function public.households_assign_account_number();

-- A plain UPDATE that doesn't name account_number can't change it, but the
-- column-scoped trigger above won't see the backfill's own UPDATE either
-- unless it names the column — the backfill below always does.
drop trigger if exists households_account_number_register on public.households;
create trigger households_account_number_register
  after insert or update of account_number on public.households
  for each row execute function public.households_register_account_number();

-- Idempotent, deterministic backfill: oldest household first (created_at,
-- then id as a tie-break). Re-running it numbers only rows still lacking
-- a number, so a retry never issues a second number to anyone.
create or replace function public.backfill_household_account_numbers()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row record;
  v_count integer := 0;
begin
  for v_row in
    select h.id
      from public.households h
     where h.account_number is null
     order by h.created_at, h.id
     for update
  loop
    -- The value written here is discarded by households_assign_account_number.
    update public.households
       set account_number = 'pending'
     where id = v_row.id
       and account_number is null;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

revoke all on function public.backfill_household_account_numbers() from public, anon, authenticated;
grant execute on function public.backfill_household_account_numbers() to service_role;

select public.backfill_household_account_numbers();

alter table public.households
  alter column account_number set not null;

-- ------------------------------------------------------------------
-- 2. Providers
-- ------------------------------------------------------------------

create table if not exists public.telephony_providers (
  code text primary key
    check (code ~ '^[a-z][a-z0-9_]{1,31}$'),
  display_name text not null,
  status text not null default 'inactive'
    check (status in ('active', 'inactive', 'retired')),
  created_at timestamptz not null default now()
);

alter table public.telephony_providers enable row level security;
revoke all on public.telephony_providers from public, anon, authenticated;
grant select on public.telephony_providers to service_role;

insert into public.telephony_providers (code, display_name, status)
values ('twilio', 'Twilio', 'active')
on conflict (code) do nothing;

-- ------------------------------------------------------------------
-- 3. Routing assignments
-- ------------------------------------------------------------------

create table if not exists public.routing_assignments (
  id uuid primary key default gen_random_uuid(),

  -- Nullable only so a hard-deleted household's TERMINAL history survives
  -- (same ON DELETE SET NULL as twilio_number_quarantine); the check below
  -- refuses the delete while any of its numbers is still held.
  household_id uuid
    references public.households(id)
    on delete set null,

  -- Which protected line this routing serves. 'primary' today; a future
  -- second protected line (e.g. landline + mobile) is another value, not
  -- another schema.
  protection_service text not null default 'primary'
    check (protection_service ~ '^[a-z][a-z0-9_]{0,31}$'),

  provider_code text not null
    references public.telephony_providers(code),

  -- The provider's own handle (Twilio: IncomingPhoneNumber SID). Opaque
  -- to everything outside the provider adapter.
  provider_resource_id text,

  e164_number text
    check (e164_number is null or e164_number ~ '^\+[1-9][0-9]{6,14}$'),

  state text not null
    check (state in (
      'requested', 'provisioning', 'active', 'port_pending',
      'replacement_pending', 'releasing', 'released', 'failed', 'quarantined'
    )),

  is_primary boolean not null default false,

  acquisition text not null
    check (acquisition in ('purchased', 'ported_in', 'legacy_backfill', 'legacy_mirror')),

  -- Port: the assignment whose number is being moved here (same E.164).
  -- Replacement: the assignment this new number replaces (different E.164).
  replaces_assignment_id uuid
    references public.routing_assignments(id),

  last_error text,

  -- Provider-specific detail. Never read outside the provider boundary.
  provider_metadata jsonb not null default '{}'::jsonb,

  state_changed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint routing_assignments_primary_only_when_active
    check (not is_primary or state = 'active'),
  constraint routing_assignments_number_required
    check (
      e164_number is not null
      or state in ('requested', 'provisioning', 'failed')
    ),
  constraint routing_assignments_household_required_while_held
    check (household_id is not null or state in ('released', 'failed')),
  constraint routing_assignments_not_self_replacing
    check (replaces_assignment_id is null or replaces_assignment_id <> id)
);

-- Only one assignment may answer a given public number at a time.
create unique index if not exists routing_assignments_one_active_per_number
  on public.routing_assignments (e164_number)
  where state = 'active';

-- A provider's resource id identifies one live resource at that provider.
-- Different providers may legitimately use the same string.
create unique index if not exists routing_assignments_live_provider_resource
  on public.routing_assignments (provider_code, provider_resource_id)
  where provider_resource_id is not null and state not in ('released', 'failed');

create unique index if not exists routing_assignments_one_primary_per_service
  on public.routing_assignments (household_id, protection_service)
  where is_primary;

create index if not exists routing_assignments_household_id_idx
  on public.routing_assignments (household_id);

create index if not exists routing_assignments_e164_idx
  on public.routing_assignments (e164_number);

drop trigger if exists routing_assignments_set_updated_at on public.routing_assignments;
create trigger routing_assignments_set_updated_at
  before update on public.routing_assignments
  for each row execute function public.hcg_set_updated_at();

alter table public.routing_assignments enable row level security;
revoke all on public.routing_assignments from public, anon, authenticated;
grant select on public.routing_assignments to service_role;

create table if not exists public.routing_assignment_events (
  id bigint generated always as identity primary key,
  assignment_id uuid not null
    references public.routing_assignments(id),
  household_id uuid
    references public.households(id)
    on delete set null,
  event_type text not null
    check (event_type in ('created', 'state_changed', 'primary_changed', 'resource_updated')),
  from_state text,
  to_state text,
  is_primary boolean,
  actor text not null,
  reason text,
  details jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);

create index if not exists routing_assignment_events_assignment_idx
  on public.routing_assignment_events (assignment_id, id);
create index if not exists routing_assignment_events_household_idx
  on public.routing_assignment_events (household_id, id);

alter table public.routing_assignment_events enable row level security;
revoke all on public.routing_assignment_events from public, anon, authenticated;
grant select on public.routing_assignment_events to service_role;

create table if not exists public.customer_identity_sync_anomalies (
  id bigint generated always as identity primary key,
  source text not null,
  household_id uuid
    references public.households(id)
    on delete set null,
  e164_number text,
  detail text not null,
  occurred_at timestamptz not null default now()
);

alter table public.customer_identity_sync_anomalies enable row level security;
revoke all on public.customer_identity_sync_anomalies from public, anon, authenticated;
grant select on public.customer_identity_sync_anomalies to service_role;

-- The lifecycle, as data (services/customerIdentity/routingLifecycle.js
-- holds the same table; parity is tested). active -> released is only
-- reachable through routing_assignment_complete_port (the number moved to
-- another provider); every other release goes via releasing/quarantined.
create or replace function public.routing_assignment_transition_allowed(
  p_from text,
  p_to text,
  p_via_port_completion boolean default false
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case p_from
    when 'requested' then p_to in ('provisioning', 'port_pending', 'failed')
    when 'provisioning' then p_to in ('active', 'replacement_pending', 'failed')
    when 'port_pending' then p_to in ('active', 'failed')
    when 'replacement_pending' then p_to in ('active', 'releasing', 'failed')
    when 'active' then p_to in ('releasing', 'quarantined')
                       or (p_to = 'released' and coalesce(p_via_port_completion, false))
    when 'quarantined' then p_to in ('active', 'releasing', 'released')
    when 'releasing' then p_to in ('active', 'quarantined', 'released')
    else false
  end;
$$;

revoke all on function public.routing_assignment_transition_allowed(text, text, boolean) from public, anon, authenticated;
grant execute on function public.routing_assignment_transition_allowed(text, text, boolean) to service_role;

-- Integrity guard for every write, including direct service_role writes:
-- lifecycle-only state changes, immutable identity columns, set-once
-- number/resource id, and no number held by two households at once.
create or replace function public.routing_assignments_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_other_household uuid;
begin
  if tg_op = 'UPDATE' then
    if new.household_id is distinct from old.household_id
       and not (new.household_id is null and old.state in ('released', 'failed')) then
      raise exception 'routing_assignments.household_id cannot change';
    end if;
    if new.provider_code <> old.provider_code
       or new.acquisition <> old.acquisition
       or new.protection_service <> old.protection_service
       or new.replaces_assignment_id is distinct from old.replaces_assignment_id
       or new.created_at <> old.created_at then
      raise exception 'routing_assignments identity columns cannot change';
    end if;
    if old.e164_number is not null and new.e164_number is distinct from old.e164_number then
      raise exception 'routing_assignments.e164_number is set once';
    end if;
    if old.provider_resource_id is not null
       and new.provider_resource_id is distinct from old.provider_resource_id then
      raise exception 'routing_assignments.provider_resource_id is set once';
    end if;
    if new.state <> old.state then
      if not public.routing_assignment_transition_allowed(
        old.state, new.state,
        current_setting('hcg.routing_port_completion', true) = 'on'
      ) then
        raise exception 'routing assignment transition % -> % is not allowed', old.state, new.state;
      end if;
      new.state_changed_at := now();
    end if;
    if new.state = 'replacement_pending' and new.replaces_assignment_id is null then
      raise exception 'replacement_pending requires replaces_assignment_id';
    end if;
  end if;

  if new.e164_number is not null and new.state not in ('released', 'failed') then
    -- Serialise every writer of this number so two households can never
    -- both pass this check concurrently.
    perform pg_advisory_xact_lock(hashtextextended('hcg.routing.' || new.e164_number, 0));
    select ra.household_id
      into v_other_household
      from public.routing_assignments ra
     where ra.e164_number = new.e164_number
       and ra.id <> new.id
       and ra.state not in ('released', 'failed')
       and ra.household_id is distinct from new.household_id
     limit 1;
    if found then
      raise exception 'number is already held by another household';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.routing_assignments_guard() from public, anon, authenticated;
grant execute on function public.routing_assignments_guard() to service_role;

drop trigger if exists routing_assignments_guard on public.routing_assignments;
create trigger routing_assignments_guard
  before insert or update on public.routing_assignments
  for each row execute function public.routing_assignments_guard();

create or replace function public.routing_assignments_record_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor text := coalesce(nullif(current_setting('hcg.actor', true), ''), 'unknown');
  v_reason text := nullif(current_setting('hcg.reason', true), '');
begin
  if tg_op = 'INSERT' then
    insert into public.routing_assignment_events
      (assignment_id, household_id, event_type, from_state, to_state, is_primary, actor, reason, details)
    values
      (new.id, new.household_id, 'created', null, new.state, new.is_primary, v_actor, v_reason,
       jsonb_build_object('provider_code', new.provider_code, 'acquisition', new.acquisition,
                          'replaces_assignment_id', new.replaces_assignment_id));
    return null;
  end if;

  if new.state <> old.state then
    insert into public.routing_assignment_events
      (assignment_id, household_id, event_type, from_state, to_state, is_primary, actor, reason, details)
    values
      (new.id, new.household_id, 'state_changed', old.state, new.state, new.is_primary, v_actor, v_reason,
       case when new.last_error is distinct from old.last_error and new.last_error is not null
            then jsonb_build_object('last_error', new.last_error) else '{}'::jsonb end);
  end if;
  if new.is_primary <> old.is_primary then
    insert into public.routing_assignment_events
      (assignment_id, household_id, event_type, from_state, to_state, is_primary, actor, reason)
    values
      (new.id, new.household_id, 'primary_changed', new.state, new.state, new.is_primary, v_actor, v_reason);
  end if;
  if new.e164_number is distinct from old.e164_number
     or new.provider_resource_id is distinct from old.provider_resource_id then
    insert into public.routing_assignment_events
      (assignment_id, household_id, event_type, from_state, to_state, is_primary, actor, reason, details)
    values
      (new.id, new.household_id, 'resource_updated', new.state, new.state, new.is_primary, v_actor, v_reason,
       jsonb_build_object('number_set', new.e164_number is not null,
                          'resource_id_set', new.provider_resource_id is not null));
  end if;
  return null;
end;
$$;

revoke all on function public.routing_assignments_record_event() from public, anon, authenticated;
grant execute on function public.routing_assignments_record_event() to service_role;

drop trigger if exists routing_assignments_record_event on public.routing_assignments;
create trigger routing_assignments_record_event
  after insert or update on public.routing_assignments
  for each row execute function public.routing_assignments_record_event();

create or replace function public.routing_history_block_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_table_name = 'routing_assignment_events'
     and tg_op = 'UPDATE'
     and new.household_id is null
     and old.household_id is not null
     and (to_jsonb(new) - 'household_id') = (to_jsonb(old) - 'household_id') then
    return new; -- the FK's own ON DELETE SET NULL
  end if;
  raise exception '% is history and cannot be modified (% refused)', tg_table_name, tg_op;
end;
$$;

revoke all on function public.routing_history_block_mutation() from public, anon, authenticated;
grant execute on function public.routing_history_block_mutation() to service_role;

drop trigger if exists routing_assignment_events_append_only on public.routing_assignment_events;
create trigger routing_assignment_events_append_only
  before update or delete on public.routing_assignment_events
  for each row execute function public.routing_history_block_mutation();

drop trigger if exists routing_assignments_never_deleted on public.routing_assignments;
create trigger routing_assignments_never_deleted
  before delete on public.routing_assignments
  for each row execute function public.routing_history_block_mutation();

-- ------------------------------------------------------------------
-- 4. Lifecycle RPCs (service_role only)
-- ------------------------------------------------------------------

create or replace function public.hcg_set_audit_context(p_actor text, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_actor is null or btrim(p_actor) = '' then
    raise exception 'an actor is required for routing changes';
  end if;
  perform set_config('hcg.actor', p_actor, true);
  perform set_config('hcg.reason', coalesce(p_reason, ''), true);
end;
$$;

revoke all on function public.hcg_set_audit_context(text, text) from public, anon, authenticated;
grant execute on function public.hcg_set_audit_context(text, text) to service_role;

create or replace function public.routing_assignment_create(
  p_household_id uuid,
  p_provider_code text,
  p_state text,
  p_acquisition text,
  p_actor text,
  p_reason text default null,
  p_e164_number text default null,
  p_provider_resource_id text default null,
  p_replaces_assignment_id uuid default null,
  p_protection_service text default 'primary'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_provider_status text;
  v_replaced public.routing_assignments%rowtype;
  v_id uuid;
begin
  perform public.hcg_set_audit_context(p_actor, p_reason);

  if not exists (select 1 from public.households where id = p_household_id) then
    raise exception 'routing_assignment_create: household % does not exist', p_household_id;
  end if;

  select status into v_provider_status
    from public.telephony_providers where code = p_provider_code;
  if v_provider_status is null then
    raise exception 'routing_assignment_create: unknown provider %', p_provider_code;
  end if;
  if v_provider_status <> 'active' then
    raise exception 'routing_assignment_create: provider % is not active', p_provider_code;
  end if;

  if p_acquisition not in ('purchased', 'ported_in') then
    raise exception 'routing_assignment_create: acquisition % is reserved for backfill/mirror', p_acquisition;
  end if;
  if p_state not in ('requested', 'provisioning', 'port_pending') then
    raise exception 'routing_assignment_create: a new assignment cannot start in state %', p_state;
  end if;

  if p_replaces_assignment_id is not null then
    select * into v_replaced
      from public.routing_assignments
     where id = p_replaces_assignment_id
     for update;
    if not found or v_replaced.household_id is distinct from p_household_id then
      raise exception 'routing_assignment_create: replaced assignment does not belong to this household';
    end if;
    if v_replaced.protection_service <> p_protection_service then
      raise exception 'routing_assignment_create: replaced assignment serves a different protection service';
    end if;
  end if;

  if p_acquisition = 'ported_in' then
    if p_state not in ('requested', 'port_pending') then
      raise exception 'routing_assignment_create: a port starts as requested or port_pending';
    end if;
    if p_replaces_assignment_id is null or v_replaced.state <> 'active' then
      raise exception 'routing_assignment_create: a port must replace a currently active assignment';
    end if;
    if p_e164_number is distinct from v_replaced.e164_number then
      raise exception 'routing_assignment_create: a port keeps the same number';
    end if;
    if p_provider_code = v_replaced.provider_code then
      raise exception 'routing_assignment_create: a port must move to a different provider';
    end if;
  elsif p_state = 'port_pending' then
    raise exception 'routing_assignment_create: port_pending is only for ported_in assignments';
  end if;

  insert into public.routing_assignments (
    household_id, protection_service, provider_code, provider_resource_id,
    e164_number, state, acquisition, replaces_assignment_id
  ) values (
    p_household_id, p_protection_service, p_provider_code, p_provider_resource_id,
    p_e164_number, p_state, p_acquisition, p_replaces_assignment_id
  )
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.routing_assignment_create(uuid, text, text, text, text, text, text, text, uuid, text) from public, anon, authenticated;
grant execute on function public.routing_assignment_create(uuid, text, text, text, text, text, text, text, uuid, text) to service_role;

-- Compare-and-set: returns false (and changes nothing) when the row is not
-- in p_expected_state, so a retried or racing caller can never apply a
-- transition twice. Leaving 'active' always drops primary.
create or replace function public.routing_assignment_transition(
  p_assignment_id uuid,
  p_expected_state text,
  p_to_state text,
  p_actor text,
  p_reason text default null,
  p_e164_number text default null,
  p_provider_resource_id text default null,
  p_last_error text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.routing_assignments%rowtype;
begin
  perform public.hcg_set_audit_context(p_actor, p_reason);

  select * into v_row
    from public.routing_assignments
   where id = p_assignment_id
   for update;
  if not found then
    raise exception 'routing_assignment_transition: assignment % does not exist', p_assignment_id;
  end if;
  if v_row.state <> p_expected_state then
    return false;
  end if;

  if p_e164_number is not null and v_row.e164_number is not null
     and p_e164_number <> v_row.e164_number then
    raise exception 'routing_assignment_transition: number differs from the one already recorded';
  end if;
  if p_provider_resource_id is not null and v_row.provider_resource_id is not null
     and p_provider_resource_id <> v_row.provider_resource_id then
    raise exception 'routing_assignment_transition: provider resource id differs from the one already recorded';
  end if;

  update public.routing_assignments
     set state = p_to_state,
         is_primary = case when p_to_state = 'active' then is_primary else false end,
         e164_number = coalesce(e164_number, p_e164_number),
         provider_resource_id = coalesce(provider_resource_id, p_provider_resource_id),
         last_error = coalesce(p_last_error, last_error)
   where id = p_assignment_id;

  return true;
end;
$$;

revoke all on function public.routing_assignment_transition(uuid, text, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.routing_assignment_transition(uuid, text, text, text, text, text, text, text) to service_role;

create or replace function public.routing_assignment_make_primary(
  p_assignment_id uuid,
  p_actor text,
  p_reason text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.routing_assignments%rowtype;
begin
  perform public.hcg_set_audit_context(p_actor, p_reason);

  select * into v_row
    from public.routing_assignments
   where id = p_assignment_id
   for update;
  if not found then
    raise exception 'routing_assignment_make_primary: assignment % does not exist', p_assignment_id;
  end if;
  if v_row.state <> 'active' then
    raise exception 'routing_assignment_make_primary: only an active assignment can be primary';
  end if;
  if v_row.is_primary then
    return;
  end if;

  update public.routing_assignments
     set is_primary = false
   where household_id = v_row.household_id
     and protection_service = v_row.protection_service
     and is_primary;

  update public.routing_assignments
     set is_primary = true
   where id = p_assignment_id;
end;
$$;

revoke all on function public.routing_assignment_make_primary(uuid, text, text) from public, anon, authenticated;
grant execute on function public.routing_assignment_make_primary(uuid, text, text) to service_role;

-- Port success: atomically retire the source assignment (number left that
-- provider) and activate the target one, carrying primary across. The
-- number never has two active assignments, and never has none mid-way
-- inside the transaction's visible result.
create or replace function public.routing_assignment_complete_port(
  p_assignment_id uuid,
  p_actor text,
  p_reason text default null,
  p_provider_resource_id text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_new public.routing_assignments%rowtype;
  v_old public.routing_assignments%rowtype;
begin
  perform public.hcg_set_audit_context(p_actor, p_reason);

  select * into v_new from public.routing_assignments where id = p_assignment_id for update;
  if not found or v_new.acquisition <> 'ported_in' or v_new.state <> 'port_pending' then
    raise exception 'routing_assignment_complete_port: assignment is not a pending port';
  end if;
  select * into v_old from public.routing_assignments where id = v_new.replaces_assignment_id for update;
  if not found or v_old.state <> 'active' then
    raise exception 'routing_assignment_complete_port: source assignment is not active';
  end if;

  perform set_config('hcg.routing_port_completion', 'on', true);
  update public.routing_assignments
     set state = 'released', is_primary = false
   where id = v_old.id;
  perform set_config('hcg.routing_port_completion', 'off', true);

  update public.routing_assignments
     set state = 'active',
         provider_resource_id = coalesce(provider_resource_id, p_provider_resource_id),
         is_primary = v_old.is_primary
   where id = v_new.id;
end;
$$;

revoke all on function public.routing_assignment_complete_port(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.routing_assignment_complete_port(uuid, text, text, text) to service_role;

-- Roll back a replacement: the replaced (old) assignment must still be
-- active (it is kept active through the overlap window precisely so this
-- is possible). It becomes primary again; the new number goes to
-- releasing (into the normal quarantine/release path), never straight to
-- released.
create or replace function public.routing_assignment_rollback_replacement(
  p_new_assignment_id uuid,
  p_actor text,
  p_reason text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_new public.routing_assignments%rowtype;
  v_old public.routing_assignments%rowtype;
begin
  perform public.hcg_set_audit_context(p_actor, p_reason);

  select * into v_new from public.routing_assignments where id = p_new_assignment_id for update;
  if not found or v_new.replaces_assignment_id is null or v_new.acquisition <> 'purchased' then
    raise exception 'routing_assignment_rollback_replacement: not a replacement assignment';
  end if;
  if v_new.state not in ('replacement_pending', 'active') then
    raise exception 'routing_assignment_rollback_replacement: replacement is %, nothing to roll back', v_new.state;
  end if;
  select * into v_old from public.routing_assignments where id = v_new.replaces_assignment_id for update;
  if not found or v_old.state <> 'active' then
    raise exception 'routing_assignment_rollback_replacement: the previous number is no longer active — rollback window closed';
  end if;

  update public.routing_assignments
     set state = 'releasing', is_primary = false
   where id = v_new.id;

  update public.routing_assignments
     set is_primary = true
   where id = v_old.id
     and not is_primary;
end;
$$;

revoke all on function public.routing_assignment_rollback_replacement(uuid, text, text) from public, anon, authenticated;
grant execute on function public.routing_assignment_rollback_replacement(uuid, text, text) to service_role;

-- ------------------------------------------------------------------
-- 5. Legacy mirror (households.twilio_number, twilio_number_quarantine)
-- ------------------------------------------------------------------

create or replace function public.hcg_record_identity_anomaly(
  p_source text,
  p_household_id uuid,
  p_e164 text,
  p_detail text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.customer_identity_sync_anomalies (source, household_id, e164_number, detail)
  values (p_source, p_household_id, p_e164, left(p_detail, 500));
end;
$$;

revoke all on function public.hcg_record_identity_anomaly(text, uuid, text, text) from public, anon, authenticated;
grant execute on function public.hcg_record_identity_anomaly(text, uuid, text, text) to service_role;

create or replace function public.households_mirror_twilio_number()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old text := case when tg_op = 'UPDATE' then nullif(btrim(old.twilio_number), '') end;
  v_new text := nullif(btrim(new.twilio_number), '');
  v_existing public.routing_assignments%rowtype;
  v_id uuid;
begin
  if v_old is not distinct from v_new then
    return null;
  end if;

  begin
    perform set_config('hcg.actor', 'legacy_mirror', true);
    perform set_config('hcg.reason', 'households.twilio_number changed', true);

    if v_old is not null then
      update public.routing_assignments
         set state = 'releasing', is_primary = false
       where household_id = new.id
         and provider_code = 'twilio'
         and e164_number = v_old
         and state = 'active';
    end if;

    if v_new is not null then
      if v_new !~ '^\+[1-9][0-9]{6,14}$' then
        perform public.hcg_record_identity_anomaly('households.twilio_number', new.id, null,
          'twilio_number is not E.164; not mirrored');
        return null;
      end if;

      select * into v_existing
        from public.routing_assignments
       where household_id = new.id
         and provider_code = 'twilio'
         and e164_number = v_new
         and state not in ('released', 'failed')
       order by created_at desc
       limit 1;

      if found then
        if v_existing.state in ('releasing', 'quarantined') then
          update public.routing_assignments set state = 'active' where id = v_existing.id;
        end if;
        v_id := v_existing.id;
      else
        insert into public.routing_assignments
          (household_id, provider_code, e164_number, state, acquisition)
        values
          (new.id, 'twilio', v_new, 'active', 'legacy_mirror')
        returning id into v_id;
      end if;

      if not exists (
        select 1 from public.routing_assignments
         where household_id = new.id and protection_service = 'primary' and is_primary
      ) then
        update public.routing_assignments
           set is_primary = true
         where id = v_id and state = 'active';
      end if;
    end if;
  exception when others then
    perform public.hcg_record_identity_anomaly('households.twilio_number', new.id, v_new, sqlerrm);
  end;

  return null;
end;
$$;

revoke all on function public.households_mirror_twilio_number() from public, anon, authenticated;
grant execute on function public.households_mirror_twilio_number() to service_role;

drop trigger if exists households_mirror_twilio_number on public.households;
create trigger households_mirror_twilio_number
  after insert or update of twilio_number on public.households
  for each row execute function public.households_mirror_twilio_number();

create or replace function public.twilio_quarantine_mirror()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_number text := nullif(btrim(new.twilio_number), '');
begin
  if new.household_id is null or v_number is null then
    return null;
  end if;

  begin
    perform set_config('hcg.actor', 'legacy_mirror', true);

    if tg_op = 'INSERT' then
      perform set_config('hcg.reason', 'twilio_number_quarantine: ' || new.release_reason, true);
      update public.routing_assignments
         set state = 'quarantined',
             is_primary = false,
             provider_resource_id = coalesce(provider_resource_id, nullif(new.twilio_sid, ''))
       where household_id = new.household_id
         and provider_code = 'twilio'
         and e164_number = v_number
         and state in ('active', 'releasing');
    end if;

    if new.released_at is not null
       and (tg_op = 'INSERT' or old.released_at is null) then
      perform set_config('hcg.reason', 'twilio_number_quarantine released', true);
      update public.routing_assignments
         set state = 'released',
             provider_resource_id = coalesce(provider_resource_id, nullif(new.twilio_sid, ''))
       where household_id = new.household_id
         and provider_code = 'twilio'
         and e164_number = v_number
         and state in ('quarantined', 'releasing');
    end if;
  exception when others then
    perform public.hcg_record_identity_anomaly('twilio_number_quarantine', new.household_id, v_number, sqlerrm);
  end;

  return null;
end;
$$;

revoke all on function public.twilio_quarantine_mirror() from public, anon, authenticated;
grant execute on function public.twilio_quarantine_mirror() to service_role;

drop trigger if exists twilio_quarantine_mirror on public.twilio_number_quarantine;
create trigger twilio_quarantine_mirror
  after insert or update of released_at on public.twilio_number_quarantine
  for each row execute function public.twilio_quarantine_mirror();

-- Idempotent backfill of today's numbers and quarantine history. Safe to
-- re-run: a number already represented for that household is skipped.
create or replace function public.backfill_routing_assignments_from_legacy()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row record;
  v_count integer := 0;
  v_number text;
begin
  perform set_config('hcg.actor', 'legacy_backfill', true);
  perform set_config('hcg.reason', 'initial backfill from legacy Twilio columns', true);

  -- Historical numbers first (oldest first), so the current number below
  -- is the household's newest row.
  for v_row in
    select q.*
      from public.twilio_number_quarantine q
     where q.household_id is not null
     order by q.quarantined_at, q.id
  loop
    v_number := nullif(btrim(v_row.twilio_number), '');
    if v_number is null or v_number !~ '^\+[1-9][0-9]{6,14}$' then
      perform public.hcg_record_identity_anomaly('backfill.quarantine', v_row.household_id, v_number,
        'quarantine number missing or not E.164; skipped');
      continue;
    end if;
    -- Idempotency key: the quarantine row this history entry came from.
    if exists (
      select 1 from public.routing_assignments ra
       where ra.acquisition = 'legacy_backfill'
         and ra.provider_metadata ->> 'legacy_quarantine_id' = v_row.id::text
    ) or exists (
      select 1 from public.routing_assignments ra
       where ra.household_id = v_row.household_id
         and ra.e164_number = v_number
         and ra.state not in ('released', 'failed')
    ) then
      continue;
    end if;
    insert into public.routing_assignments
      (household_id, provider_code, e164_number, provider_resource_id, state, acquisition,
       provider_metadata, created_at, state_changed_at)
    values
      (v_row.household_id, 'twilio', v_number, nullif(v_row.twilio_sid, ''),
       case when v_row.released_at is null then 'quarantined' else 'released' end,
       'legacy_backfill', jsonb_build_object('legacy_quarantine_id', v_row.id),
       v_row.quarantined_at, coalesce(v_row.released_at, v_row.quarantined_at));
    v_count := v_count + 1;
  end loop;

  for v_row in
    select h.id, h.twilio_number, coalesce(h.twilio_provisioning_updated_at, h.created_at) as since
      from public.households h
     where nullif(btrim(h.twilio_number), '') is not null
     order by h.created_at, h.id
  loop
    v_number := btrim(v_row.twilio_number);
    if v_number !~ '^\+[1-9][0-9]{6,14}$' then
      perform public.hcg_record_identity_anomaly('backfill.households', v_row.id, null,
        'twilio_number is not E.164; skipped');
      continue;
    end if;
    if exists (
      select 1 from public.routing_assignments ra
       where ra.household_id = v_row.id
         and ra.e164_number = v_number
         and ra.state not in ('released', 'failed')
    ) then
      continue;
    end if;
    begin
      insert into public.routing_assignments
        (household_id, provider_code, e164_number, state, is_primary, acquisition, created_at, state_changed_at)
      values
        (v_row.id, 'twilio', v_number, 'active',
         not exists (select 1 from public.routing_assignments p
                      where p.household_id = v_row.id and p.protection_service = 'primary' and p.is_primary),
         'legacy_backfill', v_row.since, v_row.since);
      v_count := v_count + 1;
    exception when unique_violation or raise_exception then
      perform public.hcg_record_identity_anomaly('backfill.households', v_row.id, v_number, sqlerrm);
    end;
  end loop;

  return v_count;
end;
$$;

revoke all on function public.backfill_routing_assignments_from_legacy() from public, anon, authenticated;
grant execute on function public.backfill_routing_assignments_from_legacy() to service_role;

select public.backfill_routing_assignments_from_legacy();

commit;
