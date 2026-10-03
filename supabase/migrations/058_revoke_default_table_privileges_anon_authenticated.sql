-- Stop future public-schema tables and sequences from implicitly granting
-- anon/authenticated full privileges.
--
-- STATUS: APPLIED to staging (tigwgmayeuisrxjjykqd) 2026-09-30T19:26:29Z
-- via `supabase db query --linked -f` + `supabase migration repair --status
-- applied 058`; verified live (scripts/verify-table-grants.js all-clear).
-- NOT applied to production (psbzynxplxfbyrbdidmn) — awaiting Andrew's
-- explicit approval; see docs/engineering/SUPABASE_SECURITY_REMEDIATION_2026-09-30.md.
--
-- Why: staging (created 2026-07-30) has Supabase's newer default ACL
-- template. Read-only introspection on 2026-09-30 found, for objects that
-- `postgres` creates in public:
--   tables    {postgres, anon, authenticated, service_role = arwdDxtm}
--   sequences {postgres, anon, authenticated, service_role = rwU}
-- so every migration-created table silently grants anon/authenticated ALL,
-- and RLS is the only thing standing between those grants and PostgREST.
-- That is exactly how terms_acceptances (039, no RLS) became anon
-- read/write on staging — fixed by 057. Migration 022 already corrected
-- this same default for functions; it never covered tables or sequences.
--
-- Scope (deliberately minimal):
--   - Changes DEFAULTS ONLY: affects tables/sequences created AFTER this
--     runs. It does NOT revoke anything from existing tables — 15 existing
--     staging tables still carry implicit anon/authenticated grants (all
--     RLS-protected). Removing those is a separate, per-table change,
--     because some grants are genuinely load-bearing (006/007/008/011
--     grant authenticated access to households/user_roles/contacts/
--     subscriptions/entitlements explicitly, and on staging those explicit
--     grants are indistinguishable from the implicit ones).
--   - anon/authenticated only. service_role's default is left in place:
--     server-side writes via supabaseAdmin rely on it for tables whose
--     migrations never granted service_role explicitly, and revoking it
--     would break the next such table silently on staging only.
--   - Only `for role postgres` (the role migrations run as). Defaults owned
--     by supabase_admin cover platform-created objects and cannot be
--     altered from a migration.
--
-- Consequence for future migrations: any new table that anon/authenticated
-- must reach needs an explicit GRANT (already this codebase's convention —
-- see 006/007/008/011), plus RLS policies.
--
-- Production (read-only catalog check 2026-09-30): its default ACL is
--   tables    {postgres=arwdDxtm, anon=Dxtm, authenticated=Dxtm, service_role=Dxtm}
--   sequences {postgres=rwU}
-- so this is NOT a pure no-op there: it removes the default TRUNCATE/
-- REFERENCES/TRIGGER/MAINTAIN that new tables currently hand anon and
-- authenticated. Nothing uses those. Rollbacks are per-project
-- (_rollbacks/058_*.sql and 058_*.production.sql).

begin;

alter default privileges for role postgres in schema public
  revoke all on tables from anon;

alter default privileges for role postgres in schema public
  revoke all on tables from authenticated;

alter default privileges for role postgres in schema public
  revoke all on sequences from anon;

alter default privileges for role postgres in schema public
  revoke all on sequences from authenticated;

commit;

-- Read-only verification — run after commit.
do $$
declare
  v_acl text;
begin
  for v_acl in
    select d.defaclacl::text
    from pg_default_acl d
    where d.defaclrole = 'postgres'::regrole
      and d.defaclnamespace = 'public'::regnamespace
      and d.defaclobjtype in ('r', 'S')
  loop
    if v_acl ~ '(^|[{,])(anon|authenticated)=' then
      raise exception 'MIGRATION 058 VERIFICATION FAILED: public default ACL still grants anon/authenticated: %', v_acl;
    end if;
  end loop;
end
$$;
