-- Baseline: public.contacts, as it already existed before any tracked
-- migration in this project.
--
-- STATUS: DRAFT — NOT APPLIED — proposed for review, not yet run against
-- any database.
--
-- public.contacts (like the original calls table) was created directly
-- via the Supabase Table Editor, not by a SQL migration — confirmed by
-- 009_service_role_minimum_app_privileges.sql's and
-- 012_service_role_stripe_billing_privileges.sql's own comments, and by
-- 001_create_calls_table.sql's own comment ("to serve `contacts`,
-- unchanged this sprint") showing contacts already existed before 001
-- was written. No file in this project has ever created it from
-- scratch — every existing migration that touches contacts
-- (003, 004, 005, 008, 009, 018) only ALTERs, backfills, or adds
-- grants/policies to a table it assumes is already there.
--
-- This file reconstructs that starting state. Evidence tier for each
-- part, so nothing here is mistaken for a guess:
--   - Columns, types, nullability, defaults, primary key: captured by
--     read-only introspection (information_schema.columns, pg_constraint,
--     pg_indexes) of the live production database (project ref
--     psbzynxplxfbyrbdidmn) on 2026-07-30, then working backward to
--     remove household_id — 003_add_household_id_ownership.sql adds that
--     column itself via `add column if not exists`, so it is deliberately
--     left out here to keep 003 as the one place responsible for it.
--   - The two original RLS policy names and their "unrestricted, anon"
--     scope: taken directly from 008_household_isolation_contacts.sql's
--     own comment ("the two confirmed permissive development policies on
--     public.contacts (verified via live pg_policies query — exact
--     names: 'Allow development insert' and 'Allow development select',
--     both scoped to anon, both unrestricted)") and from
--     008's `drop policy if exists "Allow development insert/select"`
--     statements, which only make sense if those exact policies existed.
--     They no longer exist on production today (008 already dropped them
--     there), so they cannot be re-confirmed by live introspection now —
--     this is the one part of this file sourced from migration comments
--     rather than a live query.
--   - The anon table-level select/insert grant: inferred from
--     008_household_isolation_contacts.sql's
--     `revoke insert, select on public.contacts from anon` — a revoke of
--     a grant that never existed is a harmless no-op either way, so
--     including it here costs nothing if the inference is wrong.
--
-- Must run before 003 (which ALTERs this table) — given the 000 prefix
-- for that reason. Must also run before 001/002 in real chronology, but
-- 001/002 don't reference contacts at all, so exact placement relative
-- to those two doesn't matter functionally.

begin;

create table if not exists public.contacts (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  name text,
  number text,
  customer_id uuid
);

alter table public.contacts enable row level security;

grant select, insert on public.contacts to anon;

create policy "Allow development select"
  on public.contacts
  for select
  to anon
  using (true);

create policy "Allow development insert"
  on public.contacts
  for insert
  to anon
  with check (true);

commit;
