-- RevenueCat sandbox/production provenance on entitlements (2026-09-27) —
-- P0 fix: this webhook (routes/mobileApi.js POST
-- /api/v1/billing/apple/revenuecat-webhook) previously granted an
-- entitlement identically regardless of whether the underlying RevenueCat
-- event came from Apple's SANDBOX (TestFlight/App Review/local dev) or
-- PRODUCTION environment. RevenueCat's own event payload always carries
-- this distinction (`event.environment`, confirmed against a real
-- captured payload already in this codebase — see
-- tests/revenuecat-webhook.test.mjs's REAL_TRANSFER_EVENT fixture, which
-- shows `environment: 'SANDBOX'` on a genuine delivery record from
-- 2026-08-31) but nothing in this codebase ever read or stored it.
--
-- Confirmed impact before this fix (services/revenuecatWebhook.js,
-- routes/mobileApi.js, database/billing.js all read/grepped tonight):
-- a SANDBOX event reached the exact same code path as a real purchase —
-- same entitlement_type ('paid_subscription'), same
-- updateTwilioNumberForEntitlementChange(household, true) call, which
-- purchases a REAL Twilio number against the REAL Twilio account
-- (services/twilioProvisioning.js's ensureTwilioNumberProvisioned, real
-- client by default, no environment check anywhere in that path either).
-- This is a plausible root cause of the test-number accumulation Finance
-- flagged.
--
-- NUMBERING: 053. At the time this was written, 047 (entitlement guard),
-- 050 (Dashboard's manual_cost_schedules), 051 (Finance's provider-
-- neutral ledger, staging-validated), and 052 (this session's own
-- lifecycle-sweep-evidence, renumbered from 050 after colliding with
-- Dashboard's) were all already claimed on other branches — see
-- docs/engineering/TOMORROW_INTEGRATION_PLAN.md (PR #46) for the full
-- reconciled picture. Re-run scripts/check-migration-numbering.js before
-- merging in case anything has moved again since this was written.
--
-- This migration is purely additive: one new nullable column, no
-- existing column/constraint/grant altered, no data changed. It does not
-- itself fix the vulnerability — see database/billing.js
-- (upsertActiveEntitlementFromRevenueCat's new environment parameter) and
-- routes/mobileApi.js (the webhook route now reads event.environment and
-- skips real Twilio provisioning when it's SANDBOX) for the actual
-- behavioural fix. This column exists so that behavioural fix has
-- somewhere durable to record what it decided, rather than being a
-- one-time in-memory branch with no lasting evidence — same
-- "durable evidence, not just a log line" principle as migration 052.
--
-- Deliberately NOT a new entitlement_type value: entitlement_type has an
-- exhaustive CHECK constraint (migration 011) consumed by revenue/
-- classification logic elsewhere (services/businessMetrics/) that this
-- fix has no reason to touch or risk breaking. 'paid_subscription'
-- remains accurate — RevenueCat did report a real subscription state;
-- revenuecat_environment records the separate, additional fact of which
-- Apple environment reported it. Deliberately NOT auto-written to
-- account_classifications either: that table's own design (migration
-- 031's header, routes/adminBusiness.js's own comment: "explicit and
-- manually maintained") is a deliberate human decision, not something
-- this migration should quietly automate around — a sandbox-environment
-- entitlement is still visible and queryable via this new column for
-- whoever reviews it.
--
-- Rollback: drop the new column; see
-- supabase/migrations/_rollbacks/053_rollback_entitlements_revenuecat_environment.sql.

begin;

alter table public.entitlements
  add column if not exists revenuecat_environment text
    check (revenuecat_environment is null or revenuecat_environment in ('sandbox', 'production'));

comment on column public.entitlements.revenuecat_environment is
  'Only meaningfully populated for source=''apple_revenuecat'' rows: the Apple/RevenueCat environment (SANDBOX vs PRODUCTION, lowercased) that reported this grant, per event.environment on the originating RevenueCat webhook event. Null for every other source (Stripe, admin_manual, ...) and for any apple_revenuecat row granted before this column existed.';

create index if not exists entitlements_revenuecat_environment_idx
  on public.entitlements (revenuecat_environment)
  where revenuecat_environment is not null;

commit;

-- Read-only verification — run after commit.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'entitlements'
      and column_name = 'revenuecat_environment'
  ) then
    raise exception 'MIGRATION 053 VERIFICATION FAILED: entitlements.revenuecat_environment missing';
  end if;
end
$$;
