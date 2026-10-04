# Android release preparation (2026-10-05)

**Status: prepared, nothing built or uploaded.** vc 22 (staging APK, built before the `e63377f` expo-asset fix; it does contain AssetModule) is untested on a device, because the Motorola install didn't complete. **vc 23 has not been created**, and vc 22 is unchanged.

## 1. Payments and Google Play policy: the decision that shapes the cohort

**Today:** Android users pay **only through Stripe Checkout opened from the app** (`mobile/app/(setup)/subscribe.tsx` → `POST /api/v1/billing/create-checkout-session`). There is **no Play Billing code**. `mobile/lib/purchases.ts` is iOS-only, and there is no Android RevenueCat key variable.

**Repo position (4 Oct docs):** in-app Stripe "very likely" breaches the Play Payments policy, because the service is used in-app. Play Billing (via RevenueCat) is needed before Play **Production** (gate P2). `CURRENT_STATE.md:541` (older) says the opposite and is **superseded** by the 4 Oct docs. **No repo document cites policy text showing testing tracks are exempt.**

| Option | Ready by Thu/Fri? | Assessment |
|---|---|---|
| **A. Internal-testing track, Stripe in-app** (testers added by Google-account email, no Production promotion) | Yes, no code | Policy risk is **not proven exempt**. Testing tracks are still Play distribution, and reviewed releases have been rejected before (vc10). Needs **Andrew's written risk acceptance**. Prefer Internal over Closed (less review surface) |
| **B. Web sign-up only, app as companion** | No | The "reader app" concept doesn't fit a protection service. Making the app honestly purchase-free needs a new build plus a device test |
| **C. Play Billing via RevenueCat** | No (2–4 days + handset test) | The only clean route to Play Production. **Start now** |
| D. Production-endpoint APK outside Play | Technically | Unsuitable for older customers (unknown sources, Play Protect, no updates) |

**Backend gaps to close for option C** (found in the audit; not changed tonight):
- The RevenueCat webhook ignores `event.store` and records every purchase as `apple_revenuecat` (`database/billing.js` upsert, plan sync). A Play purchase would be mislabelled.
- Several Apple-only branches: membership price label, account deletion, admin business view, the Membership/Delete screens' "manage" link.
- **Fine already:** commercial status knows `google_revenuecat`; top-ups and accounting know `PLAY_STORE`; the sandbox guard fails closed (Play licence testers count as sandbox → no number).

## 2. Store listing and assets

| Item | Status → action |
|---|---|
| Play screenshots `marketing/play-store/final/01–08` (1080×1920, in the primary checkout, untracked) | 01 and 08 contain the banned "before they reach you"; 02, 04, 06 and 07 show the old navy UI and tab bar → **replace from vc 23 captures**. 03 and 05 layouts can be reused. No prices (good: Play bans them) |
| Feature graphic "Trusted contacts **always** ring through" | "Always" overclaims (holds, the breaker and the allowance reserve can refuse). Use "Trusted contacts ring straight through." |
| Old Play description (`docs/launch/STORE_LISTING_COPY.md`) | Price updated to £5.99 in source tonight, and the "see homecallguard.co.uk" steering line removed. Still to fix: "iPhone… coming soon" (stale once 1.0.2 ships) and "works quietly in the background" (overclaim) |
| New draft (`docs/releases/2026-10-04-GOOGLE-PLAY-ASSETS.md`) | Mostly accurate. Use the **no-price** variant until the live Stripe Price is £5.99. Drop the account-number What's New line unless 062 is live |
| Data safety form | Re-check: account number, server-side call history (caller numbers), transcription audio to a third party, and financial info (Stripe today; Play if C) |

## 3. Permissions and policy checklist

- [ ] **B-11 full-screen intent:** `USE_FULL_SCREEN_INTENT` is blocked (`app.config.js`), so on a locked phone the incoming-call banner collapses after about 5–6 s. **No acceptance is recorded.** Andrew must accept it for the cohort, or file the FSI declaration (HCG is arguably a calling app) and unblock it.
- [ ] Foreground service `microphone` (Twilio `VoiceService`): confirm the Play Console declaration was filed for vc19.
- [ ] Permission prompts (`RECORD_AUDIO`, `BLUETOOTH_CONNECT`, `POST_NOTIFICATIONS`) come from the Twilio SDK at first launch, with no explainer screen. Acceptable for the cohort; note it.
- [ ] targetSdk 36 / compileSdk 36 / minSdk 24 (RN 0.81 defaults). Verify on the built AAB.
- [ ] `expo-audio` stays excluded on Android (package.json `expo.autolinking.android.exclude`). Never import it at module level.

## 4. vc ≥ 23 production build checklist

1. Source = the approved SHA (includes `e63377f`); `tests/mobile-native-sdk-compat.test.mjs` green.
2. Profile **`production`** (AAB). The EAS **production** environment holds the production API and Supabase. After the build, grep the bundle: production ×1, ngrok/staging ×0.
3. versionCode from the remote counter. Record the assigned number (≥ 23; the staging profile shares the counter).
4. FCM: `GOOGLE_SERVICES_JSON` matches the backend's `TWILIO_VOICE_PUSH_CREDENTIAL_SID` (Android credential).
5. Signing: the upload key matches builds 8/9/10/19. **A Play-installed copy and an EAS APK have different signatures**, so installing one over the other means uninstalling first (wipes app data).
6. Submit: `eas.json` submit → track `internal`, `releaseStatus: completed`. Only on Andrew's explicit approval; **never Production**.
7. Before release: B-11 recorded, foreground-service and Data safety declarations current, release notes, testers list, a smoke test of the production AAB on a handset.

## 5. £5.99 on Android

The app has no price of its own: it shows the server's Stripe offer, which needs the new live Price to be **GBP, monthly, `tax_behavior=inclusive`**. The cutover is the same `STRIPE_PRICE_ID` switch as the website (`docs/launch/2026-10-05-PRICE-CUTOVER-CHECKLIST.md`). Builds older than Build 20 hard-code £4.99, so check what is on Play Production (B-13).

## 6. Decisions for Andrew (Android)

| # | Decision | Recommendation |
|---|---|---|
| A-1 (= L-1) | Android in the first cohort via Internal testing + Stripe (written risk acceptance), or not at all | See the launch runbook L-1 |
| A-2 | Start Play Billing (option C) now | Yes. It needs a Play Console subscription product (£5.99 base plan, no intro offer) and a RevenueCat Android app (only Andrew can create these) |
| A-3 (= B-13) | What is live on Play **Production** right now (versionCode; in-app Stripe?) | Andrew checks Play Console |
| A-4 (= B-11) | Accept the lock-screen banner collapse for the cohort, or file the FSI declaration | Accept for a ≤ 5-person cohort with it recorded; fix before Production |
| A-5 | Testers' Google-account emails | Needed for the Internal track |
