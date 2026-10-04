# Apple / RevenueCat subscription lifecycle: migration 073 (2026-10-05)

**Status: implemented and tested locally. Migration 073 is a DRAFT, NOT APPLIED to staging or production.** Closes the gap in `docs/integration/2026-10-04-FINAL-UI-INTEGRATION.md` §3.

## Problem

The RevenueCat webhook acknowledged `CANCELLATION` and `BILLING_ISSUE` without recording them. The membership read model only knew Stripe (the `subscriptions` table is Stripe-only). So an Apple customer who turned off auto-renew, or whose payment failed, still looked "Active" to the app, the web dashboard and admin until `EXPIRATION`.

## What changed

| Piece | File | Behaviour |
|---|---|---|
| Schema | `supabase/migrations/073_entitlements_store_subscription_state.sql` (+ `_rollbacks/073_…`) | Adds six nullable columns to `entitlements`: `store_will_renew`, `store_cancel_reason` (CHECK: UPPER_SNAKE), `store_billing_issue_at`, `store_grace_period_expires_at`, `store_refunded_at`, `store_state_event_at`. Purely additive and idempotent. The rollback refuses while any state is recorded. |
| Event → state | `services/storeSubscriptionState.js` | Mapping: `CANCELLATION` → won't renew (+ reason). `CANCELLATION`/`CUSTOMER_SUPPORT` → also refunded. `BILLING_ISSUE` → billing problem + grace end. `UNCANCELLATION` → renews. `RENEWAL` and `INITIAL_PURCHASE` → recovery (clears the problem). Everything else: nothing. No event changes `status` or `ends_at`. |
| Apply | `database/billing.js` `applyRevenueCatStoreState` | Updates only the row with the **same household, Apple source, same original transaction and same RevenueCat environment**, so a sandbox/TestFlight event can never touch a production row. Ordering guard on `store_state_event_at`: older or replayed events are ignored. Missing columns (073 not applied) → `{applied:false}`, no error. |
| Webhook | `routes/mobileApi.js` | `CANCELLATION`/`BILLING_ISSUE` → recorded (`action: store_state_recorded`). A DB error → 500 → RevenueCat retries. A refund → `revenuecat_refund_recorded` support alert. Grants record recovery best-effort, which never changes the grant. |
| Read model | `services/membershipStatus.js` (used by `/dashboard-data` and `/api/v1/me/dashboard`) | Apple: billing problem → `payment_issue`; refunded or auto-renew off → `cancelled` with `accessUntil = ends_at`; else `active`. No invented billing date. **Stripe logic byte-for-byte unchanged** (tested over 15 combinations). |
| Admin | `services/businessControl/definitions.js`, shared loader in `householdCommercialIndex.js` | `cancellingAtPeriodEnd`, `paymentIssue` and `storeRefunded` include Apple. Loaders step down 073 → 053 → base when columns are missing. |

## Guarantees (tested: `tests/apple-store-lifecycle.test.mjs`, `tests/migration-073-store-state.pglite.test.mjs`)

- **Cancellation never removes protection before the paid-through date.** Only `EXPIRATION` ends access (unchanged).
- **Billing problems are shown truthfully** ("Payment needs attention"; the Apple "Update payment details" link already exists in the Membership tab).
- **Sandbox/TestFlight events never alter production rows.** Sandbox purchases are still never genuine (unchanged classifier and purchase guard).
- No call, provisioning or Fortress path reads these columns.

## Decision for Andrew

**D-A1: Apple refund policy.** Today a refund is recorded and alerted, and access continues until `EXPIRATION` or support acts. Options:
- (a) keep this (recommended for a tiny cohort; support reviews each one);
- (b) end access automatically on refund (needs a revoke path and a test).

## Deployment

- 073 can be applied **before or after** the backend: the code tolerates its absence.
- Recommended: apply it with the other production migrations, before the backend that uses it (see the production deployment runbook).
- After applying, re-run `scripts/verify-table-grants.js`. No anon/authenticated grant is added.
