-- Sprint 7: Household Identity — real per-household RLS
--
-- STATUS: REVIEWED DRAFT — NOT APPLIED
-- Frozen after Sprint 7 for MVP launch; revisit post-launch (Phase 2).
-- Do not run against production until explicitly re-approved.
--
-- Run this AFTER:
-- 002_create_households_and_roles.sql
-- 003_add_household_id_ownership.sql
-- 004_backfill_default_household.sql (verified run)
--
-- Purpose:
-- Replace contacts' current permissive anon-key policies (Decision 007's
-- known technical debt) and add read access on calls, so that a logged-in
-- household can only ever see/modify its own rows. households/user_roles
-- already got correct auth.uid()-scoped policies in migration 002 and are
-- intentionally left unchanged here.
--
-- NOT included: NOT NULL on contacts.household_id / calls.household_id.
-- logCall() (server.js) never sets calls.household_id on insert, and the
-- CSV upload route never sets contacts.household_id either — adding NOT
-- NULL now would make those inserts start failing. Deferred to migration
-- 006 once server.js is updated to set household_id on every write.
--
-- Companion code change required (not part of this migration):
-- server.js's getContacts() and its CSV-upload insert use the anon-key
-- `supabase` client with no user session and no household filter. Once
-- this migration removes contacts' permissive policies, those two call
-- sites will start returning/inserting nothing, since auth.uid() is null
-- for anon requests. They need to move to `supabaseAdmin`, scoped by
-- req.household.id, mirroring database/contacts.js.
--
-- Also note (not fixed by this migration): server.js's getCallsToday()
-- and getRecentCalls() query `calls` via supabaseAdmin with no household
-- filter at all. Service-role bypasses RLS by design, so this is an
-- application-layer gap RLS cannot close — tracked separately.

begin;

-- ------------------------------------------------------------
-- Contacts: replace permissive anon/authenticated policies
-- ------------------------------------------------------------

-- Policy names for the current permissive policies aren't in any tracked
-- migration (the table predates this migration set), so drop whatever
-- exists on public.contacts by inspecting pg_policies rather than by name.
do $$
declare
  pol record;
begin
  for pol in
    select policyname
    from pg_policies
    where schemaname = 'public'
      and tablename = 'contacts'
  loop
    execute format('drop policy if exists %I on public.contacts', pol.policyname);
  end loop;
end
$$;

-- public.contacts should already have RLS enabled; enforced again here
-- defensively so this migration is correct even if that ever changes.
alter table public.contacts enable row level security;

create policy contacts_select_own_household
  on public.contacts
  for select
  to authenticated
  using (
    household_id in (
      select id from public.households where auth_user_id = auth.uid()
    )
  );

create policy contacts_insert_own_household
  on public.contacts
  for insert
  to authenticated
  with check (
    household_id in (
      select id from public.households where auth_user_id = auth.uid()
    )
  );

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

create policy contacts_delete_own_household
  on public.contacts
  for delete
  to authenticated
  using (
    household_id in (
      select id from public.households where auth_user_id = auth.uid()
    )
  );

-- No anon policy: anon key gets zero access to contacts, matching the
-- access model Decision 007 already chose for calls.

-- ------------------------------------------------------------
-- Calls: add household-scoped read access
-- ------------------------------------------------------------

-- calls currently has RLS enabled with zero policies (Decision 007/008:
-- deliberate default-deny, service-role only). Adding select-only access
-- for the owning household; writes remain service-role-only since only
-- the Twilio webhook ever creates call rows.

create policy calls_select_own_household
  on public.calls
  for select
  to authenticated
  using (
    household_id in (
      select id from public.households where auth_user_id = auth.uid()
    )
  );

-- No insert/update/delete policy for authenticated: calls remain
-- writable only via the service-role client, unchanged from Decision 007.

-- ------------------------------------------------------------
-- households / user_roles: no changes
-- ------------------------------------------------------------
--
-- households_select_own and user_roles_select_own (migration 002) already
-- scope reads to auth_user_id = auth.uid(), and neither table has an
-- authenticated write policy today. That already satisfies "a household
-- cannot read or modify another household's row" for both tables, so
-- nothing is added or changed here.

commit;
