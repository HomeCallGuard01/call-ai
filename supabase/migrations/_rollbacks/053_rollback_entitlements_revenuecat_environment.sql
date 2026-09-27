-- Rollback for 053_entitlements_revenuecat_environment.sql.
--
-- Drops the new column and its partial index. No other change to
-- reverse — this migration never altered an existing column, constraint,
-- or grant. Reverting this does NOT revert the Node-side behavioural fix
-- (routes/mobileApi.js / database/billing.js) by itself; if this
-- rollback runs while that code is still deployed, the code's own
-- `environment` parameter will simply have nowhere to persist and the
-- INSERT will fail on the (now missing) column reference — deploy order
-- matters the same way it does for every other migration/code pairing in
-- this project (see MIGRATION_047_DEPLOYMENT_SEQUENCE.md for the
-- established discipline: code that depends on a column must never be
-- deployed before the migration that adds it, and a rollback must never
-- run while dependent code is still live).

begin;

drop index if exists public.entitlements_revenuecat_environment_idx;

alter table public.entitlements
  drop column if exists revenuecat_environment;

commit;

-- Read-only verification — run after commit.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'entitlements'
      and column_name = 'revenuecat_environment'
  ) then
    raise exception 'MIGRATION 053 ROLLBACK VERIFICATION FAILED: entitlements.revenuecat_environment still exists';
  end if;
end
$$;
