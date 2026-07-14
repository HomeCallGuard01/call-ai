-- Sprint 7: Household Identity — household_id ownership columns
--
-- Run this AFTER:
-- 002_create_households_and_roles.sql
--
-- Purely additive:
-- - adds household_id to contacts
-- - adds foreign-key ownership constraints
-- - adds household lookup indexes
--
-- Existing rows remain unchanged until migration 004 backfills them.

-- ------------------------------------------------------------
-- Contacts ownership
-- ------------------------------------------------------------

alter table public.contacts
  add column if not exists household_id uuid;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'contacts_household_id_fkey'
      and conrelid = 'public.contacts'::regclass
  ) then
    alter table public.contacts
      add constraint contacts_household_id_fkey
      foreign key (household_id)
      references public.households(id)
      on delete set null;
  end if;
end
$$;

-- ------------------------------------------------------------
-- Calls ownership
-- ------------------------------------------------------------

-- calls.household_id was introduced in migration 001,
-- but did not yet have a household foreign-key constraint.

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'calls_household_id_fkey'
      and conrelid = 'public.calls'::regclass
  ) then
    alter table public.calls
      add constraint calls_household_id_fkey
      foreign key (household_id)
      references public.households(id)
      on delete set null;
  end if;
end
$$;

-- ------------------------------------------------------------
-- Ownership indexes
-- ------------------------------------------------------------

create index if not exists contacts_household_id_idx
  on public.contacts (household_id);

create index if not exists calls_household_id_idx
  on public.calls (household_id);
  