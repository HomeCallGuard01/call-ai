-- Rollback for 038_household_carrier_compatibility.sql
--
-- STATUS: ROLLBACK SCRIPT — not part of the forward migration chain, kept
-- for reference only. Only run this if 038 needs to be reversed after
-- being applied to a real Supabase project.
--
-- RELOCATED, matching the established convention (019/021/022/037's own
-- rollbacks): kept out of supabase/migrations/ so it can never be
-- accidentally swept up by a mechanical `supabase db push`.
--
-- 038 is purely additive — three new nullable columns and one new
-- SECURITY DEFINER RPC, zero existing column altered or dropped. This
-- rollback drops the function first (it references the columns), then
-- the columns themselves. This DESTROYS any already-captured
-- carrier/tariff selections — do not run this against a project with
-- real captured households you need to keep that data for, without
-- exporting it first.
--
-- Application-code note: services/providerPolicy.js's
-- evaluateHouseholdCheckoutEligibility reads household.carrier_provider_key/
-- carrier_tariff_type (both simply undefined/null once dropped, which
-- getProviderPolicy already handles safely — falls back to
-- PROVIDER_POLICY.other, 'unverified', blocked — so this rollback alone
-- does not crash the checkout gate; it just makes every household look
-- unverified again, exactly as before 038 existed). routes/billing.js,
-- routes/mobileApi.js, and database/households.js's carrier-related
-- functions still expect set_household_carrier_compatibility to exist —
-- reverting the application code from the same batch alongside this
-- script is still recommended, not strictly required for the checkout
-- gate to fail safely, but required for the onboarding capture endpoint
-- to keep working at all.

begin;

drop function if exists public.set_household_carrier_compatibility(uuid, text, text);

alter table public.households
  drop column if exists carrier_provider_key,
  drop column if exists carrier_tariff_type,
  drop column if exists carrier_compatibility_captured_at;

commit;
