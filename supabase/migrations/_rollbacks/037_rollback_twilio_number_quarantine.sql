-- Rollback for 037_twilio_number_quarantine.sql
--
-- STATUS: ROLLBACK SCRIPT — not part of the forward migration chain, kept
-- for reference only. Only run this if 037 needs to be reversed after
-- being applied to a real Supabase project.
--
-- RELOCATED, matching the established convention (019/021/022's own
-- rollbacks): kept out of supabase/migrations/ so it can never be
-- accidentally swept up by a mechanical `supabase db push`.
--
-- 037 is purely additive — one new table, zero existing table or column
-- altered (see the forward migration's own header: "Dropping this table
-- ... has no effect on any other feature -- nothing else references
-- it"). This rollback is correspondingly simple: drop the table and its
-- indexes go with it automatically. This DESTROYS any quarantine
-- history (which Twilio numbers were held back, why, and whether
-- deactivation was ever confirmed) — do not run this against a project
-- that has real quarantine rows you need to keep, without exporting them
-- first.
--
-- Application-code note: services/twilioProvisioning.js's
-- releaseExpiredTwilioNumber/releaseTwilioNumberImmediately and
-- database/twilioQuarantine.js assume this table exists. Rolling back
-- this SQL alone, without also reverting the application code from the
-- same batch, leaves those functions failing on every call (their
-- `quarantine(...)`/`markReleased(...)` calls would error against a
-- missing table) — that application commit must be reverted or
-- redeployed alongside running this script, not independently.

begin;

drop table if exists public.twilio_number_quarantine;

commit;
