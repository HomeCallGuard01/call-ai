-- Sprint 8: Grant authenticated SELECT on households / user_roles
--
-- STATUS: DRAFT — NOT APPLIED
--
-- Purpose:
-- Grants the authenticated role table-level SELECT privilege on
-- public.households and public.user_roles. Diagnosed during first-login
-- testing: the authenticated-user login flow (ensureHouseholdAndRole() in
-- server.js) fails at its very first operation — the household lookup —
-- with "permission denied for table households". Confirmed via
-- information_schema.role_table_grants that SELECT was never granted to
-- authenticated on either table.
--
-- Additive change only:
-- This migration does not create, drop, or alter any RLS policy, table,
-- or column. 002_create_households_and_roles.sql and
-- 006_authenticated_household_self_service.sql are both untouched — this
-- only adds the two GRANT statements that were missing.
--
-- Required because RLS policies do not replace table grants:
-- households_select_own and user_roles_select_own (both from migration
-- 002) already exist and are correctly scoped to auth_user_id =
-- auth.uid(). RLS policies only ever narrow what a role can already see
-- or do at the grant level — they are evaluated only after Postgres
-- confirms the role has the underlying table privilege in the first
-- place. Without SELECT granted here, those two policies are
-- unreachable: every query hits "permission denied for table X" before
-- RLS is ever evaluated, regardless of how correct the policy itself is.
--
-- Run this AFTER:
-- 002_create_households_and_roles.sql
-- 006_authenticated_household_self_service.sql (verified run)

begin;

grant select on public.households to authenticated;
grant select on public.user_roles to authenticated;

commit;
