-- Rollback for 058_revoke_default_table_privileges_anon_authenticated.sql —
-- PRODUCTION (psbzynxplxfbyrbdidmn) ONLY.
--
-- Production's pre-058 default ACL (read-only snapshot, 2026-09-30) for
-- objects postgres creates in public was:
--   tables    {postgres=arwdDxtm, anon=Dxtm, authenticated=Dxtm, service_role=Dxtm}
--   sequences {postgres=rwU}
-- i.e. anon/authenticated only ever defaulted to TRUNCATE/REFERENCES/
-- TRIGGER/MAINTAIN on tables and nothing on sequences. This restores exactly
-- that. Do NOT use the staging rollback here — it would grant anon ALL.

begin;

alter default privileges for role postgres in schema public
  grant truncate, references, trigger, maintain on tables to anon, authenticated;

commit;
