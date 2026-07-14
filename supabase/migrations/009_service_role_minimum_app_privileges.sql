-- Sprint 9: Complete Household Isolation — service_role minimum privileges
--
-- STATUS: DRAFT — NOT APPLIED
--
-- Purpose: grant service_role exactly the table privileges its currently
-- reachable code paths actually use — nothing more. Discovered during
-- Sprint 9 verification: after rotating SUPABASE_SERVICE_ROLE_KEY to a
-- genuinely valid service_role JWT (confirmed by decoding its payload —
-- role: service_role, correct project ref), every supabaseAdmin query
-- still failed with "permission denied for table X" on households,
-- user_roles, contacts, and calls. These four tables were created via
-- raw SQL migrations rather than the Supabase Table Editor, which is why
-- they never received the default grants Table-Editor-created tables get
-- automatically — service_role was simply never granted anything on them.
--
-- Why service_role still needs table grants even though it bypasses RLS:
-- BYPASSRLS and table GRANTs are two independent layers. BYPASSRLS only
-- skips row-level policy evaluation — it says nothing about whether the
-- role may run a given operation on the table at all. That's what GRANT
-- controls, and Postgres checks it first, before RLS is ever considered.
-- A role can have BYPASSRLS and still get "permission denied" if it was
-- never granted the base privilege — which is exactly what was happening
-- here.
--
-- Least-privilege rationale: this grant set was derived from an explicit
-- audit of every supabaseAdmin call site in the codebase (server.js,
-- database/households.js, database/contacts.js), function by function,
-- checking both the SQL operation performed and whether that code path
-- is actually reachable from a live route today. Two functions
-- (claimOrCreateHousehold, setUserRole in database/households.js) are
-- exported but never called anywhere — dead code, superseded by
-- ensureHouseholdAndRole() in server.js, which uses the signed-in user's
-- own scoped session instead of supabaseAdmin for exactly this reason.
-- Because those two functions are unreachable, no live code path
-- inserts or updates households or user_roles via supabaseAdmin — both
-- only need SELECT. contacts and calls each have exactly one reachable
-- insert path (CSV upload; call logging via ON CONFLICT DO NOTHING,
-- which does not require UPDATE) alongside their read paths, so both
-- need SELECT and INSERT only. No reachable code path updates or
-- deletes any of these four tables via supabaseAdmin, so UPDATE,
-- DELETE, TRUNCATE, TRIGGER, and REFERENCES are deliberately not
-- granted here.

grant select on public.households to service_role;
grant select on public.user_roles to service_role;
grant select, insert on public.contacts to service_role;
grant select, insert on public.calls to service_role;
