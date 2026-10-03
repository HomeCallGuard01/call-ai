-- Rollback for 066_telephony_abuse_shared_state.sql (integration 2026-10-03).
-- STATUS: DRAFT — NOT APPLIED. Export public.abuse_decisions first if it holds
-- data worth keeping (audit trail). Afterwards the abuse layer's counters,
-- cooldowns, holds and incident flag revert to process-local state.
begin;
drop function if exists public.claim_number_provisioning(uuid, integer);
drop function if exists public.abuse_hit(text, integer);
drop table if exists public.number_provisioning_claims, public.abuse_household_holds,
  public.abuse_incident_state, public.abuse_cooldowns, public.abuse_counters, public.abuse_decisions;
commit;
