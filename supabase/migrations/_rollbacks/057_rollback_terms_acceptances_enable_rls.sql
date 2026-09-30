-- Rollback for 057_terms_acceptances_enable_rls.sql.
--
-- WARNING: on any project with the newer Supabase default ACL (staging),
-- this rollback RE-OPENS the anon read/insert/update/delete exposure if the
-- anon/authenticated grants are also restored. It deliberately restores
-- ONLY the RLS flag and service_role's previous privileges — it does not
-- re-grant anything to anon/authenticated. Only use if 057 is proven to
-- break record_terms_acceptance(), and re-apply a fix promptly.

begin;

alter table public.terms_acceptances disable row level security;
grant update, delete on table public.terms_acceptances to service_role;

commit;
