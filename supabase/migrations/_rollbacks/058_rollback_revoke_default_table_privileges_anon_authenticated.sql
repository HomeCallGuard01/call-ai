-- Rollback for 058_revoke_default_table_privileges_anon_authenticated.sql.
--
-- WARNING: restores the unsafe staging default under which every new
-- public table/sequence implicitly grants anon/authenticated full
-- privileges. Only use if 058 is proven to break a migration that
-- genuinely needs those grants — and fix that migration with an explicit
-- GRANT instead as soon as possible.

begin;

alter default privileges for role postgres in schema public
  grant all on tables to anon, authenticated;

alter default privileges for role postgres in schema public
  grant all on sequences to anon, authenticated;

commit;
