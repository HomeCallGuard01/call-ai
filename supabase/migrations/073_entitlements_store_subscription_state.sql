-- 073_entitlements_store_subscription_state.sql
--
-- STATUS: DRAFT — NOT APPLIED ANYWHERE (launch sprint, 2026-10-05).
-- Numbering: 073 verified free on every remote branch, local branch and
-- worktree before creation (2026-10-05). Re-run
-- scripts/check-migration-numbering.js before applying.
--
-- Apple / RevenueCat subscription lifecycle state on the entitlement row.
--
-- Gap closed (FINAL-UI-INTEGRATION §3): the RevenueCat webhook acknowledged
-- CANCELLATION and BILLING_ISSUE without recording anything, and the
-- membership read model only understood Stripe (subscriptions table, which is
-- Stripe-only: stripe_subscription_id NOT NULL). An Apple customer who turned
-- off auto-renew, or whose payment failed, still looked "active" to the app,
-- the web dashboard and admin until EXPIRATION.
--
-- Columns (all nullable; NULL = "the store has not told us", never a guess):
--   store_will_renew              false after CANCELLATION, true after
--                                 UNCANCELLATION / RENEWAL / INITIAL_PURCHASE
--   store_cancel_reason           RevenueCat cancel_reason, as sent
--   store_billing_issue_at        set by BILLING_ISSUE, cleared by RENEWAL /
--                                 UNCANCELLATION / INITIAL_PURCHASE
--   store_grace_period_expires_at RevenueCat grace_period_expiration_at_ms
--   store_refunded_at             CANCELLATION with cancel_reason
--                                 CUSTOMER_SUPPORT (Apple refund). Recorded and
--                                 alerted only; access is NOT cut here (policy
--                                 decision for Andrew).
--   store_state_event_at          event_timestamp_ms of the newest applied
--                                 event: an older or replayed event is ignored
--
-- Behavioural rules (database/billing.js applyRevenueCatStoreState,
-- services/membershipStatus.js):
--   * Cancellation never shortens ends_at: protection continues to the
--     paid-through date; EXPIRATION still ends it (unchanged).
--   * Events only touch the row with the same Apple original transaction AND
--     the same RevenueCat environment, so a sandbox/TestFlight event can never
--     alter a production entitlement (and vice versa).
--   * No column here is read by any call, provisioning or Fortress path.
--
-- Purely additive: no existing column, constraint, grant or row is altered.
-- The service role writes these columns; no anon/authenticated grant is added
-- (re-run scripts/verify-table-grants.js after applying).

begin;

alter table public.entitlements
  add column if not exists store_will_renew boolean,
  add column if not exists store_cancel_reason text,
  add column if not exists store_billing_issue_at timestamptz,
  add column if not exists store_grace_period_expires_at timestamptz,
  add column if not exists store_refunded_at timestamptz,
  add column if not exists store_state_event_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'entitlements_store_cancel_reason_check'
      and conrelid = 'public.entitlements'::regclass
  ) then
    alter table public.entitlements
      add constraint entitlements_store_cancel_reason_check
      check (store_cancel_reason is null or store_cancel_reason ~ '^[A-Z_]{1,40}$');
  end if;
end;
$$;

comment on column public.entitlements.store_will_renew is
  'Store (Apple/RevenueCat) auto-renew state. NULL = not reported. false = cancelled at period end; access continues to ends_at. Migration 073.';
comment on column public.entitlements.store_billing_issue_at is
  'Store billing problem reported (RevenueCat BILLING_ISSUE); cleared on recovery. Migration 073.';
comment on column public.entitlements.store_refunded_at is
  'Store refund (RevenueCat CANCELLATION cancel_reason CUSTOMER_SUPPORT). Recorded + alerted; access not cut automatically. Migration 073.';
comment on column public.entitlements.store_state_event_at is
  'Event time of the newest applied store-state event (ordering guard). Migration 073.';

commit;
