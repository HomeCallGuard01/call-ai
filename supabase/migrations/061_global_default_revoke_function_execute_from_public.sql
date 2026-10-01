-- Make "new functions are not executable by PUBLIC/anon/authenticated" true.
--
-- STATUS: APPLIED to staging (tigwgmayeuisrxjjykqd) 2026-09-30 (060 20:09:31Z, 061 20:09:33Z)
-- via `supabase db query --linked -f` + `migration repair`; verified live. NOT applied to
-- production (psbzynxplxfbyrbdidmn).
--
-- Why: migration 022 ran
--   alter default privileges for role postgres in schema public
--     revoke execute on functions from public;
-- intending new functions to start closed. PostgreSQL documents that
-- per-schema default privileges can only ADD to the global defaults, never
-- remove them, so that statement is a no-op against the built-in "PUBLIC
-- may EXECUTE every new function" rule. Neither project has a global
-- pg_default_acl entry (read-only check 2026-09-30), and a rolled-back
-- canary on staging confirmed: a function created in public gets
-- proacl NULL and has_function_privilege('anon', ..., 'EXECUTE') = true.
-- Nothing is exposed today — every existing RPC revokes PUBLIC explicitly
-- (verified per function) — but one future SECURITY DEFINER migration that
-- forgets that line would be anon-callable via /rest/v1/rpc.
--
-- The global form (no IN SCHEMA) is what actually removes the built-in
-- PUBLIC grant for functions postgres creates. Scope: functions created by
-- postgres from now on, in any schema. Existing functions are unaffected.
-- Every migration in this repo already grants EXECUTE explicitly to the
-- role that needs it (service_role), so nothing relies on the PUBLIC
-- default.
--
-- Rollback: supabase/migrations/_rollbacks/061_rollback_*.sql.

begin;

alter default privileges for role postgres
  revoke execute on functions from public;

commit;

-- Read-only verification — run after commit.
do $$
declare
  v_acl text;
begin
  select d.defaclacl::text into v_acl
  from pg_default_acl d
  where d.defaclrole = 'postgres'::regrole
    and d.defaclnamespace = 0
    and d.defaclobjtype = 'f';

  if v_acl is null or v_acl ~ '(^|[{,])=X' then
    raise exception 'MIGRATION 061 VERIFICATION FAILED: global function default still grants PUBLIC execute: %', coalesce(v_acl, '<no global entry>');
  end if;
end
$$;
