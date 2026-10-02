# RevenueCat sandbox → production Twilio risk, and the f5a920e + 053 fix (2 Oct 2026)

**Status: documentation only.** Nothing was deployed, migrated or changed in RevenueCat, Supabase or Twilio. The fix lives on `fix/revenuecat-sandbox-environment-guard` `f5a920e` (pushed, unmerged). It is **not** on `release/ios-1.0.2` and not on `origin/main`.

## 1. The risk, today, in production

| Fact | Evidence |
|---|---|
| TestFlight purchases and App Review purchases always use Apple's **sandbox** | Apple platform behaviour |
| The iOS app talks to the **production** backend, and RevenueCat delivers sandbox events to the **same** webhook URL as real ones (`POST /api/v1/billing/apple/revenuecat-webhook`) | One RevenueCat project. Captured sandbox payload `REAL_TRANSFER_EVENT` (31 Aug) in `tests/revenuecat-webhook.test.mjs` shows `environment: "SANDBOX"` |
| The webhook never reads `event.environment`. A sandbox grant runs `upsertActiveEntitlementFromRevenueCat` (a `paid_subscription` entitlement) and then `updateTwilioNumberForEntitlementChange(household, true)` | `routes/mobileApi.js` on `origin/main` `eb43368` and on `release/ios-1.0.2` (no `resolveEventIsSandbox` anywhere) |
| That call **buys a real UK number** on the production Twilio account | `services/twilioProvisioning.js` `ensureTwilioNumberProvisioned` → `availablePhoneNumbers("GB")` → `incomingPhoneNumbers.create` |
| When the sandbox subscription lapses (sandbox renews on an accelerated clock, then stops), the revoke path **quarantines** the number. Quarantine never auto-releases | Twilio number inventory audit, 27 Sep |

**Consequences of one sandbox purchase:**
- A real number at about £0.87/month, recurring until someone releases it by hand.
- A `paid_subscription` entitlement row that looks like a genuine customer in admin and revenue views.
- For a live number, real inbound call cost if anyone calls it.

**Who triggers it:**
- every TestFlight tester who taps Subscribe;
- every App Reviewer who tests the purchase (Apple reviewers routinely do on a subscription app);
- any developer sandbox session.

**Why it matters for 1.0.2 specifically:**
- 1.0.1 keeps reviewers on the pre-provisioned complimentary account.
- 1.0.2 opens the **new-account iPhone signup and purchase path** inside the app, so new-account sandbox purchases become the expected review and testing path.
- §11 of the release prep has TestFlight testers buy on purpose.

## 2. What f5a920e + migration 053 change

| Part | Change | Environment it touches when deployed |
|---|---|---|
| `supabase/migrations/053_entitlements_revenuecat_environment.sql` | Adds a nullable `entitlements.revenuecat_environment` column (`'sandbox' \| 'production' \| null`, CHECK-constrained) and a partial index. Purely additive: no existing column, constraint, grant or row changed. Rollback file included | The Supabase database it is applied to (staging first, then production) |
| `services/revenuecatWebhook.js` | New `resolveEventIsSandbox(event)`. **Fails closed:** only `environment === "PRODUCTION"` (any case) counts as real; SANDBOX, missing, null and unknown values count as sandbox | Backend (Railway) |
| `database/billing.js` | `upsertActiveEntitlementFromRevenueCat` records the environment on grant **and** renewal. It still grants the entitlement either way, so sandbox buyers still see "subscribed" and Restore works | Backend + DB |
| `routes/mobileApi.js` | Grant branch: sandbox → entitlement recorded, `console.warn`, **no Twilio provisioning**. Production → unchanged. Revoke (EXPIRATION) branch deliberately unchanged | Backend |
| Tests | 9 unit checks; an integration scenario (sandbox grant skips Twilio, production control still provisions, sandbox renewal still skips); structural checks that revoke is never gated | — |

It does **not**:
- release numbers already bought by past sandbox purchases (a separate, approval-gated clean-up);
- classify sandbox households in `account_classifications`;
- touch Android (Android has no RevenueCat/IAP today, so the same guard is needed when Play Billing via RevenueCat arrives).

## 3. Deployment constraints (for when you approve it)

1. **The migration must go before the code.** The new code writes `revenuecat_environment` on every Apple grant. If the code runs against a database without the column, **every Apple grant fails, real customers included.** Order: apply 053 to staging → verify → apply to production → deploy the backend.
2. **Numbering:** 053 itself is unique across all branches checked (2 Oct). The release line has **other** collisions that block a backend deploy from `release/ios-1.0.2` (not the guard itself):
   - **060** and **061** are used by both `release/ios-1.0.2` (`060_call_delivery_events`, `061_household_iphone_carrier`) and `security/supabase-staging-remediation` (`060_revoke_unused_…`, `061_global_default_revoke_…`). **Claude C's 060/061 are already applied on staging.**
   - **055** is used by both `p0/call-delivery-resilience` (`055_call_delivery_evidence`, on this line) and `feature/admin-control-centre-v2` (`055_account_classification_history`).
   - Renumber before any backend merge, and re-run `scripts/check-migration-numbering.js` if present on the integration branch.
3. **Smallest safe deploy:** `f5a920e` alone on top of what production runs today (`eb43368`) plus migration 053. It doesn't need the rest of the release line. That lets the guard go live before TestFlight without shipping undeployed iOS-line backend changes.
4. **Verify after deploy:**
   - a sandbox purchase on TestFlight shows the entitlement row with `revenuecat_environment = 'sandbox'`, the log line `SANDBOX-environment grant — … provisioning skipped`, and **no** new Twilio number;
   - production renewals keep provisioning (check the next real renewal's row says `production`).

## 4. Side-effect to plan for in TestFlight and App Review

With the guard, a sandbox buyer is entitled but gets **no number**. From a fresh sandbox account, the activation step then has no number to forward to. Activation instructions are only built from an allocated UK number; without one the app shows its provisioning-pending or retryable-error state, never a code. Exactly which screen a reviewer sees must be confirmed in TestFlight.

This is expected and safe, but a reviewer who buys in sandbox and continues will hit it. Mitigations (pick one; none implemented):
- **A (no code):** in the review notes, tell reviewers to use the provided pre-provisioned account for the set-up and protection screens; the sandbox purchase only demonstrates the paywall. This was drafted in `IOS_102_STORE_LISTING_2026-10-01.md` §6.
- **B (code, later):** a dedicated "test purchase" state on the activation screen for sandbox entitlements, explaining that a real number is assigned only for live subscriptions. Needs your approval. It would be an app + backend change.

## 5. Recommendation

Approve, as a separate production change before any 1.0.2 TestFlight purchase test: **053 (staging → production) then the `f5a920e` backend deploy.** Then a read-only check of the Twilio inventory and entitlements for numbers and rows created by past sandbox purchases. Releasing any of them is its own approval.
