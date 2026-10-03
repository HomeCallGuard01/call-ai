-- Rollback for 061_global_default_revoke_function_execute_from_public.sql.
-- Valid for both projects (neither had a global function default before).
-- Restores the built-in PUBLIC EXECUTE default for new functions postgres
-- creates — i.e. re-opens the gap 061 closes. Existing functions unaffected.

begin;

alter default privileges for role postgres
  grant execute on functions to public;

commit;
