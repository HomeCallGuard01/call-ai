-- Sprint 8: Least-privilege customer registration
--
-- STATUS: APPLIED AND VERIFIED
-- Applied via Supabase SQL Editor and confirmed against live pg_policies
-- and information_schema.role_table_grants output — see
-- docs/sprints/Sprint_008/README.md ("Verification") for the full record.
--
-- Run this AFTER:
-- 002_create_households_and_roles.sql
-- 003_add_household_id_ownership.sql
-- 004_backfill_default_household.sql (verified run)
--
-- Purpose:
-- Adds ONLY the grants and RLS policies required for a newly authenticated
-- user to create or claim their own household, and create their own
-- user_roles row, entirely on their own authenticated session — no
-- service-role key is used anywhere in the registration/login flow.
--
-- This does not modify, replace, or duplicate anything in
-- 002_create_households_and_roles.sql — households_select_own and
-- user_roles_select_own (both select-only, scoped to auth.uid()) are
-- untouched. It also does not touch contacts or calls in any way; that
-- remains the separate, still-unapplied 005_household_rls.sql draft.
--
-- Confirmed empirically before writing this: with only migration 002
-- applied, an authenticated user's own session cannot insert or update
-- households, and cannot insert user_roles — Postgres denies both at the
-- grant level (anon role tested directly: "permission denied for table
-- households/user_roles") and, independently, at the RLS level (migration
-- 002 defines select-only policies for authenticated on both tables).

begin;

-- ------------------------------------------------------------
-- Table grants
-- ------------------------------------------------------------
-- RLS policies only ever narrow what a role is already granted at the
-- table level. Without these grants, every policy below would be
-- unreachable and every write would fail with "permission denied for
-- table X" before Postgres ever evaluates a policy — confirmed
-- empirically for the anon role, and true for authenticated as well
-- since no insert/update grant was ever issued to it either.

grant insert, update on public.households to authenticated;
grant insert on public.user_roles to authenticated;

-- ------------------------------------------------------------
-- households: let a user create a brand-new household for themselves
-- ------------------------------------------------------------
-- Used whenever there's no pre-existing unclaimed default household left
-- to claim (i.e. every registration after the very first). auth.uid()
-- is read from the verified JWT on the server side, never from anything
-- the client sends, so this policy can only ever let a user insert a row
-- naming themselves as owner — never any other auth_user_id.
--
-- Second condition added on review: the inserted email must also match
-- the authenticated user's own verified JWT email (case-insensitively).
-- Without this, a user could insert a row naming themselves as owner but
-- carrying an arbitrary email address in the email column — auth_user_id
-- would still be correct, but the row's email would be attacker-chosen
-- rather than verified. auth.jwt() ->> 'email' comes from the signed,
-- server-verified token, never from client-supplied form data.

drop policy if exists households_insert_own on public.households;

create policy households_insert_own
  on public.households
  for insert
  to authenticated
  with check (
    auth_user_id = auth.uid()
    and lower(email) = lower(auth.jwt() ->> 'email')
  );

-- ------------------------------------------------------------
-- households: let a user claim the pre-existing default household
-- ------------------------------------------------------------
-- migration 004 created exactly one household with auth_user_id = null:
-- the founder's pre-registration placeholder, identified specifically by
-- email = 'default-household@homecallguard.internal', holding the real
-- phone/twilio numbers.
--
-- Narrowed on review: the `using` clause now matches only that specific
-- row (by its known email), not "any household with auth_user_id is
-- null". This closes off a theoretical future gap where some other
-- unowned household row might exist for an unrelated reason (e.g.
-- created manually, or by a future code path) — such a row could never
-- be claimed via this policy, only the one legacy row it's meant for.
--
-- The `with check` clause now mirrors households_insert_own exactly:
-- auth_user_id must still be the claimant themselves, AND the email
-- being written must match their own verified JWT email. Without the
-- second condition, the claim path (unlike the insert path) could still
-- write an arbitrary email into the legacy row alongside the correct
-- owner — this closes that asymmetry.

drop policy if exists households_claim_default on public.households;

create policy households_claim_default
  on public.households
  for update
  to authenticated
  using (
    auth_user_id is null
    and email = 'default-household@homecallguard.internal'
  )
  with check (
    auth_user_id = auth.uid()
    and lower(email) = lower(auth.jwt() ->> 'email')
  );

-- ------------------------------------------------------------
-- user_roles: let a user create their own role row, HOUSEHOLD only
-- ------------------------------------------------------------
-- The "role = 'household'" clause is load-bearing, not decorative:
-- without it, a user could insert their own row with role = 'admin' or
-- 'support' and self-escalate privileges. With it, this policy can only
-- ever create the one role every new customer is meant to have. Admin
-- and support roles must still only ever be assigned manually or through
-- controlled server-side administration, exactly as documented in
-- 002_create_households_and_roles.sql. No update or delete policy is
-- added — a user can create their own role once, never change it.
--
-- Lowercase 'household' confirmed against the actual deployed constraint
-- in 002_create_households_and_roles.sql (`check (role in ('admin',
-- 'support', 'household'))`, quoted verbatim) — not assumed.

drop policy if exists user_roles_insert_own_household_role on public.user_roles;

create policy user_roles_insert_own_household_role
  on public.user_roles
  for insert
  to authenticated
  with check (auth_user_id = auth.uid() and role = 'household');

commit;
