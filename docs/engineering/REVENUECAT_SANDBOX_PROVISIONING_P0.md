# P0: RevenueCat sandbox/TestFlight transactions could provision real Twilio numbers

**Investigated and fixed 2026-09-27 (overnight autonomous session), on branch `fix/revenuecat-sandbox-environment-guard`. Not deployed — awaiting review/approval.**

## Finding, confirmed factually (not assumed)

Traced the complete path Apple sandbox/TestFlight purchase → RevenueCat webhook → entitlement → Twilio provisioning by reading every file in it:
`services/revenuecatWebhook.js`, `routes/mobileApi.js` (`POST /api/v1/billing/apple/revenuecat-webhook`), `database/billing.js` (`upsertActiveEntitlementFromRevenueCat`), `services/twilioProvisioning.js` (`updateTwilioNumberForEntitlementChange` → `ensureTwilioNumberProvisioned`), and `mobile/lib/purchases.ts`.

**Before this fix, none of them ever read RevenueCat's own `environment` field** (`'SANDBOX'` or `'PRODUCTION'`, present on every RevenueCat webhook event — confirmed present on a real captured payload already in this codebase's own test fixture, `tests/revenuecat-webhook.test.mjs`'s `REAL_TRANSFER_EVENT`, `environment: 'SANDBOX'`, captured 2026-08-31). A SANDBOX-environment event reached the exact same code path as a real purchase:
- Same `entitlement_type: 'paid_subscription'`, same `source: 'apple_revenuecat'` — structurally indistinguishable from a genuine purchase once written.
- The webhook route unconditionally called `updateTwilioNumberForEntitlementChange(household, true)` on any grant-classified event, which provisions a **real** Twilio number against the **real** Twilio account (`services/twilioProvisioning.js`'s `ensureTwilioNumberProvisioned`, real REST client by default, no environment awareness anywhere in that function either).

This is a plausible root cause of the test-number accumulation Finance flagged: any TestFlight tester, any App Review cycle, any local sandbox testing session making an IAP purchase would each provision a real, recurring-cost Twilio number, indistinguishable from a genuine customer's.

## Google/Android equivalent risk

Checked `mobile/lib/purchases.ts` directly — it is explicitly iOS-only (`if (Platform.OS !== "ios") return;` on `configurePurchases`). Its own header comment: "Android and web keep the existing Stripe Checkout/Billing Portal path entirely unchanged." **Android has no RevenueCat/IAP integration today** — confirmed by absence, not assumed — so there is currently no live Google-side equivalent of this vulnerability. This will need the identical fix applied when Play Billing via RevenueCat is added (a separate, already-tracked piece of future work) — flagged explicitly here so it isn't rediscovered from scratch.

## How App Review/TestFlight keeps working without this gap

Checked how Apple App Review currently actually exercises the app: `docs/launch/APP_REVIEW_RESUBMISSION_2026-09-09.md` confirms the reviewer signs in to a **pre-provisioned account carrying an active complimentary entitlement** (`households.id = ccae29b4-bbf1-4469-837d-1b81236e9f01`, granted via `admin_manual`, not RevenueCat) — "the reviewer lands straight in the fully-entitled app state, no payment screen, no card required." Apple's review of the app's core protection functionality does not depend on a live RevenueCat sandbox purchase provisioning a real number. Skipping real Twilio provisioning for a genuine sandbox purchase does not block this established review path.

## The fix

Three files changed, one migration added, all additive:

1. **`supabase/migrations/053_entitlements_revenuecat_environment.sql`** — new nullable `entitlements.revenuecat_environment` column (`'sandbox' | 'production' | null`, CHECK-constrained). Purely additive: no existing column, constraint, or grant touched. Deliberately *not* a new `entitlement_type` value (that column has an exhaustive CHECK constraint consumed by revenue/classification logic elsewhere — no reason to touch or risk it) and deliberately *not* auto-written to `account_classifications` (that table's own design, per its migration 031 header and `routes/adminBusiness.js`'s own comment, is "explicit and manually maintained" — a human decision this fix should surface evidence for, not silently automate around).

2. **`services/revenuecatWebhook.js`** — new pure, directly-tested function `resolveEventIsSandbox(event)`. **Fails closed toward "don't spend real money"**: only a confirmed `'PRODUCTION'` (case-insensitive) is ever treated as safe to provision for. `'SANDBOX'`, missing, null, or any unrecognised future value are all treated as sandbox-equivalent. The asymmetry is deliberate — see the function's own comment for the full reasoning — and matches this codebase's existing fail-closed conventions elsewhere (e.g. migration 047's entitlement guard treating a lookup error as "entitled").

3. **`database/billing.js`** — `upsertActiveEntitlementFromRevenueCat` gains an `environment` parameter, recorded on both grant and renewal (a renewal can genuinely flip environment — e.g. a sandbox subscription's own accelerated renewal cadence — so the stored value always tracks the most recent event, never frozen at first grant). Entitlement is granted identically either way; this function makes no decision based on the value, only preserves it.

4. **`routes/mobileApi.js`** — the webhook's grant branch now computes `isSandbox` before upserting, records it, and only calls real Twilio provisioning in the non-sandbox branch. A sandbox grant is logged (`console.warn`) for visibility. **The revoke (EXPIRATION) branch is deliberately untouched and unconditional** — releasing/deprovisioning a number is never a cost or safety concern in that direction, so it must keep working identically regardless of environment (verified by a dedicated structural test, not just left alone by omission).

## Testing

All in `tests/revenuecat-webhook.test.mjs` (extended, not replaced):
- 9 new unit checks on `resolveEventIsSandbox` covering SANDBOX/PRODUCTION in both cases, missing, null, empty object, unrecognised value, non-string value — every one of the fail-closed branches.
- A new integration scenario (Scenario 4) using the file's existing fake-Supabase-client + fake-Twilio-client fixture: a SANDBOX `INITIAL_PURCHASE` grants an entitlement (proving StoreKit/RevenueCat's own purchase acknowledgement still works) but genuinely never calls Twilio's purchase API; a control PRODUCTION purchase for a different household in the same fixture still provisions a real number exactly as before (proving the fix is environment-specific, not a blanket regression); a subsequent SANDBOX `RENEWAL` confirms the guard holds across renewals, not just the initial grant.
- Structural (source-string) assertions confirming the grant branch genuinely gates on `resolveEventIsSandbox` and the revoke branch genuinely does not.
- Full existing test suite re-run: only pre-existing, unrelated failures remain (`android-full-screen-intent-permission.test.mjs` / `android-incoming-call-notification-visibility.test.mjs`, both requiring `mobile/node_modules` that aren't installed in this environment — a known, pre-existing environment gap, not caused by this change).
- `tests/migrations.pglite.test.mjs` (applies every migration in order against a real in-memory Postgres) confirms 053 applies cleanly on top of the full existing chain.

## Not done as part of this fix (deliberately out of scope tonight)

- **Retroactive cleanup of any Twilio numbers already accumulated from past sandbox purchases before this fix existed.** This is a real, separate, read-only-investigation-first task (see Priority 2 of tonight's own directive — the "two entitled households with no number" and related reconciliation work) and involves real Twilio numbers, which this session's hard boundaries explicitly prohibit touching without approval.
- **Auto-classifying a sandbox-origin household in `account_classifications`.** Left as a human decision per that table's own established design intent; the new `revenuecat_environment` column makes such a household discoverable for whoever does that review.
- **Deploying this fix.** Migration + code both await the same review/approval process as every other P0 fix from tonight.

## Numbering

Migration 053. At the time this was written, 047/050/051/052 were all already claimed on other branches (see `docs/engineering/TOMORROW_INTEGRATION_PLAN.md`, PR #46, for the full reconciled picture) — 053 is the next free slot above all of them. Re-run `scripts/check-migration-numbering.js` before merging in case anything has moved again.
