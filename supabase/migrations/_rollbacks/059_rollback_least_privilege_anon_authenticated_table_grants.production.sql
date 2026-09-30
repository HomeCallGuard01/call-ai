-- Rollback for 059_least_privilege_anon_authenticated_table_grants.sql —
-- PRODUCTION (psbzynxplxfbyrbdidmn) ONLY.
--
-- Generated 2026-09-30 from a read-only aclexplode() snapshot of this
-- project's public-schema ACLs taken BEFORE 059 was applied, so it restores
-- the exact pre-059 anon/authenticated/PUBLIC grants — not a guess. The two
-- projects started from different ACLs, so never run this file against the
-- other project. terms_acceptances is omitted: its ACL is owned by 057.


begin;

revoke insert (auth_user_id, email, status) on table public.households from authenticated;
revoke update (auth_user_id, email) on table public.households from authenticated;
revoke insert (auth_user_id, role) on table public.user_roles from authenticated;

grant MAINTAIN, REFERENCES, TRIGGER, TRUNCATE on table public.acquisition_events to anon;
grant MAINTAIN, REFERENCES, TRIGGER, TRUNCATE on table public.acquisition_events to authenticated;
grant MAINTAIN, REFERENCES, TRIGGER, TRUNCATE on table public.calls to anon;
grant MAINTAIN, REFERENCES, TRIGGER, TRUNCATE on table public.calls to authenticated;
grant MAINTAIN, REFERENCES, TRIGGER, TRUNCATE on table public.complimentary_invites to anon;
grant MAINTAIN, REFERENCES, TRIGGER, TRUNCATE on table public.complimentary_invites to authenticated;
grant MAINTAIN, REFERENCES, TRIGGER, TRUNCATE on table public.contacts to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.contacts to authenticated;
grant MAINTAIN, REFERENCES, TRIGGER, TRUNCATE on table public.entitlements to anon;
grant MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE on table public.entitlements to authenticated;
grant MAINTAIN, REFERENCES, TRIGGER, TRUNCATE on table public.households to anon;
grant INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.households to authenticated;
grant MAINTAIN, REFERENCES, TRIGGER, TRUNCATE on table public.stripe_webhook_events to anon;
grant MAINTAIN, REFERENCES, TRIGGER, TRUNCATE on table public.stripe_webhook_events to authenticated;
grant MAINTAIN, REFERENCES, TRIGGER, TRUNCATE on table public.subscriptions to anon;
grant MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE on table public.subscriptions to authenticated;
grant MAINTAIN, REFERENCES, TRIGGER, TRUNCATE on table public.twilio_number_quarantine to anon;
grant MAINTAIN, REFERENCES, TRIGGER, TRUNCATE on table public.twilio_number_quarantine to authenticated;
grant MAINTAIN, REFERENCES, TRIGGER, TRUNCATE on table public.user_roles to anon;
grant INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE on table public.user_roles to authenticated;
grant MAINTAIN, REFERENCES, TRIGGER, TRUNCATE on table public.voice_client_registration_events to anon;
grant MAINTAIN, REFERENCES, TRIGGER, TRUNCATE on table public.voice_client_registration_events to authenticated;

commit;
