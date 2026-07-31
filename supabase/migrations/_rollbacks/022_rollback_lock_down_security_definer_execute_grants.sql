-- Rollback for 022_lock_down_security_definer_execute_grants.sql
--
-- STATUS: ROLLBACK SCRIPT — not part of the forward migration chain, kept
-- for reference only. Only run this if 022 needs to be reversed after
-- being applied to a real Supabase project.
--
-- Restores the pre-022 state: anon/authenticated EXECUTE on the 11
-- functions 022 locked down, and the permissive default privileges for
-- new functions created by postgres in public. Written in advance of
-- production deployment (docs/engineering/PRODUCTION_MIGRATION_RUNBOOK_021_022.md)
-- rather than reactively, matching this project's "every migration ships
-- its own rollback from day one" convention (019, 021 already do this).
--
-- Whether this is ever actually desirable is a separate question from
-- whether it's safe: reverting to a state where anon/authenticated can
-- directly invoke service-role-only RPCs (bypassing the application-layer
-- ownership checks those RPCs were always assumed to sit behind) recreates
-- the exact exposure 022 exists to close. Only run this if something
-- about 022 itself is found to be wrong — not as a casual undo.

begin;

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
      raise notice 'Skipping %: function does not exist on this database.', target.signature;
      continue;
    end if;

    execute format('grant execute on function %s to anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end
$$;

alter default privileges for role postgres in schema public
  grant execute on functions to anon;

alter default privileges for role postgres in schema public
  grant execute on functions to authenticated;

alter default privileges for role postgres in schema public
  grant execute on functions to service_role;

commit;
