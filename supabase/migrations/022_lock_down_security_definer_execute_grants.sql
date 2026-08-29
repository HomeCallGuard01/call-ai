-- Lock down SECURITY DEFINER function execute grants: service_role only
--
-- STATUS: APPLIED — staging (tigwgmayeuisrxjjykqd) 2026-07-31, production
-- (psbzynxplxfbyrbdidmn) 2026-08-02, confirmed a provable no-op there both
-- times it was checked (2026-07-31 and immediately pre-deployment
-- 2026-08-02) — production's SECURITY DEFINER grants were already clean.
-- See docs/engineering/PRODUCTION_MIGRATION_RUNBOOK_021_022.md.
--
-- Every SECURITY DEFINER RPC in this codebase ends its own migration with
-- `revoke all on function ... from public; grant execute on function ...
-- to service_role;`, intending service_role-only access. That revoke only
-- removes what was granted to the PUBLIC pseudo-role. Supabase's own
-- documented platform default additionally grants EXECUTE directly to
-- anon and authenticated (as named roles, not via PUBLIC) on every new
-- public-schema function —
-- https://supabase.com/docs/guides/api/securing-your-api : "tables
-- created in public receive SELECT, INSERT, UPDATE, and DELETE privileges
-- for anon, authenticated, and service_role by default. Functions receive
-- EXECUTE." Confirmed directly via pg_default_acl on staging
-- (tigwgmayeuisrxjjykqd): all 11 functions below currently have EXECUTE
-- granted to anon and authenticated there.
--
-- Production (psbzynxplxfbyrbdidmn) does not have this exposure today —
-- its pg_default_acl for public-schema functions never included anon/
-- authenticated in the first place, most likely because it predates
-- whenever Supabase started applying this default-privileges template to
-- new projects (staging was created 2026-07-30; the exact date Supabase
-- introduced this default is not confirmed from their changelog). This
-- migration makes the intended state explicit and permanent on both,
-- rather than depending on which platform default a given project
-- happened to be provisioned under — see the GitHub issue Supabase users
-- have raised about exactly this surprise:
-- https://github.com/supabase/supabase/issues/43884.
--
-- Full detail: docs/engineering/MIGRATION_RECOVERY_PLAN.md's Execution
-- Outcome section and the Severity 1 entry it added to
-- docs/launch/KNOWN_ISSUES.md.
--
-- Idempotent and safe to run repeatedly, on both staging and production:
-- REVOKE of a privilege a role doesn't hold, and GRANT of one it already
-- holds, both succeed as no-ops in Postgres — never an error. The
-- existence check in Part 1 means mark_household_activation_verified
-- (migration 021, not yet applied to production) is safely skipped there
-- today rather than erroring the whole migration, and will be picked up
-- automatically once 021 is promoted and this file is reapplied to a
-- fresh environment or rerun.

begin;

-- Part 1: fix every function that already exists today, on whichever
-- environment this runs against. Explicit named list, not a dynamic
-- "every SECURITY DEFINER function" loop — matching this repo's own
-- established preference (018_service_role_contacts_update_delete.sql's
-- own comment: "not a dynamic drop-everything loop... these are the
-- exact... names confirmed via a live query, not guessed") for named,
-- reviewed targets over a sweep that could silently catch something
-- unintended.
do $$
declare
  target record;
  fn regprocedure;
begin
  for target in
    select * from (values
      ('public.anonymize_inactive_household(uuid, text)'),
      ('public.assign_household_twilio_number(uuid, text)'),
      ('public.cancel_household_twilio_number_pending_release(uuid)'),
      ('public.claim_stripe_webhook_event(text, text, text, uuid, jsonb)'),
      ('public.mark_household_twilio_number_pending_release(uuid, interval)'),
      ('public.process_stripe_webhook_event(text, uuid, text, text, text, text, timestamptz, boolean, timestamptz)'),
      ('public.record_household_twilio_provisioning_failure(uuid, text)'),
      ('public.release_household_twilio_number(uuid, text)'),
      ('public.release_household_twilio_number_immediately(uuid)'),
      ('public.set_household_stripe_customer_id(uuid, text)'),
      ('public.mark_household_activation_verified(uuid)')
    ) as t(signature)
  loop
    fn := to_regprocedure(target.signature);

    if fn is null then
      raise notice 'Skipping %: function does not exist on this database yet.', target.signature;
      continue;
    end if;

    execute format('revoke all on function %s from public', fn);
    execute format('revoke all on function %s from anon', fn);
    execute format('revoke all on function %s from authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end
$$;

-- Part 2: fix the default itself, so every SECURITY DEFINER function
-- created by `postgres` after this migration runs — in any migration
-- numbered above this one, on this project or a freshly created one —
-- never inherits anon/authenticated/service_role EXECUTE automatically.
-- This does NOT retroactively affect the functions Part 1 already fixed,
-- and Part 1 does not protect functions created later — both parts are
-- required; see the explanation accompanying this migration for why.
--
-- Matches Supabase's own documented recovery snippet exactly:
-- https://supabase.com/docs/guides/api/securing-your-api . service_role
-- is deliberately included in this revoke too, not left as an implicit
-- default: every migration in this codebase already grants it explicitly
-- and individually per function (the established, reviewed pattern this
-- migration exists to enforce everywhere), so making that grant load-
-- bearing rather than a silent default means a future migration that
-- forgets it fails loudly (permission denied, caught in testing) instead
-- of silently working by accident.
alter default privileges for role postgres in schema public
  revoke execute on functions from public;

alter default privileges for role postgres in schema public
  revoke execute on functions from anon;

alter default privileges for role postgres in schema public
  revoke execute on functions from authenticated;

alter default privileges for role postgres in schema public
  revoke execute on functions from service_role;

commit;
