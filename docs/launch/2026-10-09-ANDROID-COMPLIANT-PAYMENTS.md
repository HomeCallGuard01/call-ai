# Android: a Play-compliant way to take payment (2026-10-09)

**Status:** research and design only. No code, console, RevenueCat, Google or Stripe changes have been made. All policy pages below were read on **2026-10-09**.
**Replaces:** the "Internal track + in-app Stripe, with written risk acceptance" route (L-1 / B8 in `2026-10-09-LAUNCH-GO-NO-GO.md`, A-1 in `docs/releases/2026-10-05-ANDROID-RELEASE-PREP.md` §1). That route is **not compliant** and does not need to be accepted.

## Recommendation (the decision for Andrew)

1. **Now, for the ≤5-person invite cohort: Option C, a consumption-only Android app.** Remove every way to buy from the Android app. Invitees pay on the website by Stripe (invite link sent by email), then sign in on Android. This is compliant, keeps 100% of Stripe economics (about £4.63 net per month), needs no Play/RevenueCat console setup, and takes about **1.5–2 days** including a handset test.
2. **Before Android is opened to the public or promoted beyond Internal testing: Option A, Google Play Billing via the existing RevenueCat project.** About **4–5 working days**, plus up to 36 h for Google credentials to activate. Net is about £4.24 per month.
3. **Do not pursue Option B** (UK billing choice: Stripe alongside Play). It needs all of A *plus* a choice screen and transaction reporting, and it nets **less** than A at £5.99.

**Decision required:** "Approve C for the cohort build (vc ≥ 23), and start A in parallel (Play Console subscription and RevenueCat Android app); or skip C and wait about a week for A." Separately, **check Play Console for any live track (Production or testing) that still ships in-app Stripe** (B-13). Any such build is non-compliant today, whichever option is chosen.

## 1. What Google Play policy requires (evidence)

| Question | Answer | Source (read 2026-10-09) |
|---|---|---|
| Is Play Billing required for a subscription used in the app? | **Yes.** Section 2: Play-distributed apps "requiring or accepting payment for access to in-app features or services" must use Play Billing unless Section 3, 8 or 9 applies. The listed examples include subscription services. Section 3's exemptions are physical goods, physical services (transport, cleaning), peer-to-peer payments, donations and similar. A call-screening service delivered into the app is not exempt | [Payments policy](https://support.google.com/googleplay/android-developer/answer/9858738) |
| Anti-steering | Section 4: apart from Sections 3/8/9, apps may not lead users to another payment method through the **Play listing**, in-app promotions, "**in-app webviews, buttons, links, messaging**… or other calls to action", or "**in-app user interface flows, including account creation or sign-up flows**". In-app Stripe Checkout breaches both Section 2 and Section 4 | same |
| UK alternatives (Sections 8 and 9) | The UK is eligible for **user choice billing** (an alternative billing system *alongside* Play), not for alternative-only billing (EEA only). Since **30 Jun 2026** the UK is in the **billing choice program**: either alternative billing or external web links, always **offered alongside Play Billing**, after enrolling in Play Console, using a choice screen, **reporting every transaction within 24 h**, and providing support, refunds and subscription management. External links must go to your own offer, be disclosed before the user leaves the app, and be declared in Play Console | [Eligible regions](https://support.google.com/googleplay/android-developer/answer/13821247); [Billing choice program](https://support.google.com/googleplay/android-developer/answer/17161464); [Android Developers Blog, 24 Jun 2026](https://android-developers.googleblog.com/2026/06/play-expanded-billing.html) |
| Fees (UK, from 30 Jun 2026) | Recurring subscriptions: **10% service fee + 5% billing fee** when Play Billing is used (15% total). Alternative billing or external links: **10%** service fee, no billing fee. Google charges and remits UK VAT on Play sales, and UK prices are **tax-inclusive** | [Lower service fees](https://support.google.com/googleplay/android-developer/answer/16954621); [Tax rates/VAT](https://support.google.com/googleplay/android-developer/answer/138000) |
| Consumption-only route | "Google Play allows any app to be consumption-only, even if it is part of a paid service." Consumption-only means "any product(s) or service(s)… **cannot be purchased from within the app**". Such apps "may choose to provide additional information about purchasing options **without direct links**". Google's example: "Head to our website to purchase more." Account, privacy and help pages may be linked only "as long as the web page does not eventually lead to" a prohibited payment method. Communication outside the app is unrestricted | [Payments policy FAQ](https://support.google.com/googleplay/android-developer/answer/10281818?hl=en-GB) |
| Are Internal or Closed tracks exempt? | **No exemption is stated anywhere.** Google says internal tests "**might not** be subject to standard Play policy or security reviews". That is a lighter review, not a waiver. Non-tester users on test tracks make **real** purchases (internal and draft releases have spend limits) | [Test tracks](https://support.google.com/googleplay/android-developer/answer/9845334); [Testing Play Billing](https://developer.android.com/google/play/billing/test) |

The UK CMA's proposed steering conduct requirement (consultation dated 30 Jun 2026) is **not final** and changes nothing today ([CMA case page](https://www.gov.uk/cma-cases/sms-investigation-into-googles-mobile-platform)).

## 2. Options compared

Net figures are per month at £5.99 incl. VAT. VAT (1/6) = £1.00, so £4.99 ex-VAT. Stripe = 1.5% + 20p (standard UK card) + 0.7% Billing, plus 0.5% Stripe Tax *if* enabled (unknown) ([Stripe UK pricing](https://stripe.com/gb/pricing)). Store fees are calculated on the ex-VAT price (Google remits the VAT). Figures exclude the 2% leakage placeholder used in `docs/finance/HCG_UNIT_ECONOMICS_V1.md`.

| | Compliant | Fees | Net/month | Build time | Customer friction |
|---|---|---|---|---|---|
| **Stripe (web / today)** | Web yes; **in-app on Android no** | £0.33–0.36 | **£4.63–4.66** (premium card ≈ £4.55) | — | — |
| **A. Play Billing via RevenueCat** | **Yes** | 15% × £4.99 = £0.75 | **£4.24** | 4–5 days + up to 36 h credential wait | Lowest: native Google sheet, saved card, cancel in Play |
| **B. UK billing choice (Stripe + Play)** | Yes, if enrolled | 10% × £4.99 + Stripe ≈ £0.86 | **≈ £4.13** | A + choice screen + 24 h reporting API + enrolment (≈ 8–10 days) | Extra choice screen |
| **C. Consumption-only (buy on web)** | **Yes** (FAQ above) | Stripe only | **£4.63–4.66** | **1.5–2 days** | Must pay on the web first. Fine for invited users; poor for Play-store discovery |

B is dominated: it costs more than A to build and nets less. Whether Google's B fee base excludes VAT has not been verified, but B loses either way. RevenueCat support for billing-choice reporting has also not been verified.

## 3. Option C: exactly what the Android app may and may not do

**Must remove or hide on Android** (`Platform.OS === "android"`):
- `mobile/app/(setup)/subscribe.tsx`: `handleSubscribeStripe`/`createCheckoutSession` (~L152–178) and any price or "Subscribe" button. Replace the screen with an informational state: "This account doesn't have an active membership yet." Optionally add *plain text, not a link*: "Membership is set up on our website, homecallguard.co.uk." **No** button, tappable URL, QR code, "cheaper on web" wording or price.
- `mobile/app/(tabs)/membership.tsx`: the Stripe Billing Portal button (`createPortalSession`, ~L69). The portal can take a new card, so it "leads to" a payment method. Show text instead: "Your membership is billed through our website. To change or cancel it, email support@homecallguard.co.uk."
- Any future top-up purchase UI (none exists on mobile today) stays web-only.

**Allowed:** sign-in; sign-up *only* if it ends on the informational state with no payment hand-off; the Terms/Privacy links; `mailto:` support; emails to invitees containing the web checkout link (outside the app).

**Residual risk to close (applies to A as well):** the in-app Terms/Privacy pages (`public/terms.html`, `privacy.html`) link to `/` and `/login.html`, which lead on to the web sign-up and checkout. That is the "eventually leads to" clause. Fix it with an `?app=1` variant that hides site navigation (a small website change), or render the legal text in the app.

**Play listing:** no website-purchase or price wording (the listing is itself a steering channel under Section 4). The cohort is invited via the Internal track, so the tester email list *is* the allowlist. The web checkout is still gated by `NEW_SUBSCRIPTIONS_ALLOWLIST` (`services/acquisitionGate.js`).

**Test:** an Android 1–8 PASS/FAIL checklist. (1) No Stripe or portal UI reachable. (2) Web-paid invitee signs in and gets protection. (3) No-membership account sees only the informational text. (4) Legal pages have no route to checkout. (5)–(8) Call-delivery regression as in the existing device plan.

## 4. Option A: implementation plan against this code

**Backend (≈ 1.5 days, with tests)**
- `database/billing.js`: `upsertActiveEntitlementFromRevenueCat`, the expire path (~L482/519) and `applyRevenueCatStoreState` (~L556–570) hard-code `source: "apple_revenuecat"`. **Verified: every store purchase is recorded as Apple today.** Add a `source` argument derived from `event.store`: `PLAY_STORE` → `google_revenuecat`, `APP_STORE` → `apple_revenuecat`. Any other or missing value (`TEST_STORE`, `PROMOTIONAL`, …) is acknowledged, alerted and **not granted** (fail closed). Lookups match `.in("source", ["apple_revenuecat","google_revenuecat"])` so TRANSFER and parallel-channel logic keep working. No schema change is needed: `entitlements.source` has no CHECK constraint. Migration 053/073 columns are store-agnostic.
- `routes/mobileApi.js` webhook (`/api/v1/billing/apple/revenuecat-webhook`, ~L1435–1650): pass `source`; `syncPlanCode` source; make the parallel-paid alert text store-neutral. The URL can stay; the same RevenueCat project posts both stores' events to it.
- Sandbox guard: `services/revenuecatWebhook.js` `resolveEventIsSandbox` already fails closed. Play licence-tester purchases arrive as `environment: SANDBOX` (to be confirmed in test 2 below), so they get **no Twilio number**. `commercialStatus.js` already classifies `google_revenuecat` (`STORE_SANDBOX` / genuine only when production).
- Store-neutral follow-ons: `services/membershipStatus.js`, `subscriptionPricing.js` ("Billed by Google Play"), `accountDeletion.js` (Google branch: revoke HCG access, tell the customer to cancel in Play), `accounting/reconciliation.js` (`google_revenuecat` ↔ `PLAY_STORE`), `businessControl/definitions.js` + `controlOverview.js` (store_* flags for Google), `routes/adminBusiness.js` (`.eq` → `.in`).
- Lifecycle: `SUBSCRIPTION_PAUSED` is acknowledged, not revoked (RevenueCat's rule); access ends on `EXPIRATION`. **Turn pausing off** on the base plan. `BILLING_ISSUE` → grace period then account hold; Google's defaults are acceptable. Refund = `CANCELLATION` with `cancel_reason=CUSTOMER_SUPPORT`, then `EXPIRATION` ([RevenueCat event fields](https://www.revenuecat.com/docs/integrations/webhooks/event-types-and-fields)).
- **Allowlist/pause gate:** Play purchases never reach `create-checkout-session`, so `decideNewSubscription` can't block them. Add `GET /api/v1/billing/eligibility` returning `decideNewSubscription(...)`. The app shows the Play purchase button **only** when it returns allowed, and otherwise shows "Membership isn't open to new customers yet." This also fixes the same gap on iOS. Backstop: a production grant for a non-allowlisted or paused household **still grants** (they paid) and fires `sendCriticalAlert`, so support can refund. For the cohort, the Internal-track tester list is a second gate.

**Mobile (≈ 1.5 days)**
- `mobile/lib/purchases.ts`: add `EXPO_PUBLIC_REVENUECAT_API_KEY_ANDROID`; drop the `Platform.OS !== "ios"` early returns in `configurePurchases`/`resetPurchasesIdentity` (choose the key by platform). Keep entitlement `hcg_protected`, offering `default`, package `$rc_monthly`. `react-native-purchases ^10.8.1` is already a dependency; confirm the BILLING permission is in the merged manifest.
- `subscribe.tsx`: Android uses the store path (`handleSubscribeIOS`, renamed `handleSubscribeStore`), with the price from the Play product. `handleSubscribeStripe` is never reachable on Android. Store-neutral copy, and Restore on Android.
- `membership.tsx`, `account/delete-account.tsx`, `lib/types.ts`: a `google_revenuecat` branch with a "Manage in Google Play" link (`https://play.google.com/store/account/subscriptions?package=co.uk.homecallguard.app`). Stripe-billed users get the Option C text, not the portal.

**Play Console / RevenueCat (Andrew only; ≈ 0.5 day + up to 36 h wait)**
1. Confirm the payments/merchant profile is linked, and that an uploaded build carries the billing library (required before products can be created).
2. Monetise › Subscriptions: create e.g. `hcg_standard`, base plan `monthly` (auto-renewing, 1 month, **UK only, £5.99**: UK Play prices are VAT-inclusive), no trial or offers, pause off, marked backwards-compatible ([RevenueCat Android products](https://www.revenuecat.com/docs/getting-started/entitlements/android-products)).
3. Google Cloud service account: enable the Play Android Developer + Reporting APIs and grant the Play permissions (view financial data, manage orders/subscriptions, …). Upload the JSON to a new **Play Store app in the existing RevenueCat project**. Set up RTDN via Pub/Sub ([RevenueCat credentials](https://www.revenuecat.com/docs/service-credentials/creating-play-service-credentials)).
4. Attach `hcg_standard:monthly` to `hcg_protected` / `default` / `$rc_monthly`. Put the Android public SDK key in the EAS env (staging and production, following the iOS sandbox-isolation approach in `IOS_102_REVENUECAT_SANDBOX_RISK_2026-10-02.md`).
5. Settings › License testing: add the test Google accounts.

**Test plan (licence testers, no charges.** Test payment methods "avoid charging the testers real money"; monthly renews every 5 min, up to 6 times. Testers must also opt in to the test track ([Google](https://developer.android.com/google/play/billing/test), [RevenueCat sandbox](https://www.revenuecat.com/docs/test-and-launch/sandbox/google-play-store)).**
1. Purchase with "Test card, always approves" → webhook → `google_revenuecat`. 2. `revenuecat_environment=sandbox`, commercial `store_sandbox`, **no Twilio number provisioned**. 3. Accelerated renewals → RENEWAL rows, then EXPIRATION → access revoked. 4. Cancel in Play → `store_will_renew=false`, access to period end. 5. "Always declines" on renewal → BILLING_ISSUE, grace period. 6. Refund in Play Console order management → `store_refunded_at`. 7. Reinstall + Restore; sign out and sign in as another household → no entitlement leak. 8. Non-allowlisted account → no buy button. 9. Stripe-web customer on Android → access, no Stripe UI. 10. iOS purchase regression.
The production grant-and-provision path cannot be proven with licence testers. It needs **one real £5.99 purchase by Andrew on a non-tester account, then a refund**, done only with his explicit approval.

**Effort:** about 4–5 working days of engineering and testing, plus the credential wait. That is roughly one calendar week to an Internal-track build.

## 5. Unknowns to confirm

- What is live on each Play track today (B-13).
- Whether Stripe Tax and premium-card mix apply (they move the Stripe net by ±£0.10).
- Whether Play licence-tester events are labelled SANDBOX by RevenueCat (test 2).
- Whether Option B's fee is calculated on the ex-VAT price.
