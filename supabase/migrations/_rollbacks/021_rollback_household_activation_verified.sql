-- Rollback for 021_household_activation_verified.sql
--
-- STATUS: ROLLBACK SCRIPT — not part of the forward migration chain, kept
-- for reference only. Only run this if 021 needs to be reversed after
-- being applied to a real Supabase project.
--
-- RELOCATED (docs/engineering/MIGRATION_RECOVERY_PLAN.md): kept out of
-- supabase/migrations/ from day one, matching the same structural
-- treatment as 019's rollback, so it can never be accidentally applied by
-- a mechanical migration push.
--
-- 021 is purely additive (one nullable column, one SECURITY DEFINER RPC
-- restricted to service_role), so its rollback is simple and low-risk —
-- exactly as anticipated in docs/engineering/STAGING_ENVIRONMENT_PLAN.md
-- §8. Dropping mark_household_activation_verified first, since the
-- column drop alone would leave a dangling function referencing it.

begin;

drop function if exists public.mark_household_activation_verified(uuid);
alter table public.households drop column if exists activation_verified_at;

commit;
