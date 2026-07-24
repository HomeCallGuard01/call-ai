-- Stage 3 (Trusted Contacts): service_role update/delete on contacts
--
-- STATUS: APPLIED (2026-07-24) — via direct grant statement in the
-- Supabase SQL Editor, confirmed working against the real database.
--
-- Migration 009 granted service_role only SELECT and INSERT on
-- public.contacts, since no code path updated/deleted a contact via
-- supabaseAdmin at the time. Stage 3 adds single-contact edit/delete
-- routes that do — confirmed directly (not guessed): attempting either
-- without this grant fails with "permission denied for table contacts"
-- (Postgres error 42501).

grant update, delete on public.contacts to service_role;
