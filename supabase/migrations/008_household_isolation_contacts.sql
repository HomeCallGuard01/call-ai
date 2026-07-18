-- Sprint 9: Complete Household Isolation — contacts RLS
--
-- STATUS: DRAFT — NOT APPLIED
--
-- Purpose: remove the two confirmed permissive development policies on
-- public.contacts (verified via live pg_policies query — exact names:
-- "Allow development insert" and "Allow development select", both
-- scoped to anon, both unrestricted) and replace them with
-- household-scoped policies for authenticated, so a signed-in user can
-- only ever see or modify their own household's contacts.
--
-- This mirrors the already-reviewed contacts policies drafted in
-- 005_household_rls.sql (still frozen/unapplied) — same design, written
-- fresh here rather than un-freezing that file, since 005 also bundles
-- unrelated calls-table policy work this migration intentionally keeps
-- separate.
--
-- Pre-check performed before writing this migration: 0 contacts rows
-- have a null household_id, so no existing row becomes orphaned/invisible
-- as a result of this change.

begin;

alter table public.contacts enable row level security;

-- Remove the exact, named legacy development policies only — not a
-- dynamic drop-everything loop. These are the two real policy names
-- confirmed via a live query, not guessed.
drop policy if exists "Allow development insert" on public.contacts;
drop policy if exists "Allow development select" on public.contacts;

-- Minimum required grants for authenticated. anon's existing grants are
-- revoked — anon should have no access to contacts at all going forward.
revoke insert, select on public.contacts from anon;
grant select, insert, update, delete on public.contacts to authenticated;

-- SELECT: a user may only ever see contacts belonging to their own household.
create policy contacts_select_own_household
  on public.contacts
  for select
  to authenticated
  using (
    household_id in (
      select id from public.households where auth_user_id = auth.uid()
    )
  );

-- INSERT: a user may only ever insert a contact naming their own household.
create policy contacts_insert_own_household
  on public.contacts
  for insert
  to authenticated
  with check (
    household_id in (
      select id from public.households where auth_user_id = auth.uid()
    )
  );

-- UPDATE: a user may only ever update a contact that already belongs to
-- their own household, and may never move it to a different household.
create policy contacts_update_own_household
  on public.contacts
  for update
  to authenticated
  using (
    household_id in (
      select id from public.households where auth_user_id = auth.uid()
    )
  )
  with check (
    household_id in (
      select id from public.households where auth_user_id = auth.uid()
    )
  );

-- DELETE: a user may only ever delete a contact belonging to their own household.
create policy contacts_delete_own_household
  on public.contacts
  for delete
  to authenticated
  using (
    household_id in (
      select id from public.households where auth_user_id = auth.uid()
    )
  );

commit;
