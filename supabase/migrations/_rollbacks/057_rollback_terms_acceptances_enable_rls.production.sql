-- Rollback for 057_terms_acceptances_enable_rls.sql —
-- PRODUCTION (psbzynxplxfbyrbdidmn) ONLY.
--
-- Production's pre-057 ACL on public.terms_acceptances (read-only snapshot,
-- 2026-09-30): RLS disabled;
--   {postgres=arwdDxtm, anon=Dxtm, authenticated=Dxtm, service_role=Dxtm}
-- (no SELECT/INSERT/UPDATE/DELETE for anyone but postgres; writes go through
-- the SECURITY DEFINER record_terms_acceptance()). This restores RLS-off and
-- service_role's exact prior privileges. It deliberately does NOT restore
-- anon/authenticated TRUNCATE/REFERENCES/TRIGGER/MAINTAIN — nothing needs
-- them. Only use if 057 is proven to break record_terms_acceptance().

begin;

alter table public.terms_acceptances disable row level security;
revoke select, insert on table public.terms_acceptances from service_role;
grant truncate, references, trigger, maintain on table public.terms_acceptances to service_role;

commit;
