# 1.0.2 STAGING test builds: iOS Build 15, Android vc 22 (2026-10-04)

> **STAGING-ONLY BINARIES. Never submit iOS Build 15 for App Store review, never add it to external TestFlight testing, and never upload or promote Android vc 22 on Google Play.** They talk to the staging backend. The store candidates take the next numbers (iOS 1.0.2 Build ≥ 16, Android vc ≥ 23) after the attended staging handset test passes. (Andrew, 2026-10-04.)

## Source

- Commit `779ab00` = release candidate `c3b9374` + `cc3498c` (approved D-C5 paused-account wording) + `779ab00` (staging EAS profiles only).
- Tests at `cc3498c`: 202/202 files, 8,927 checks; mobile `tsc` 0 errors.

## Build profiles (`mobile/eas.json`)

| Profile | Platform | Distribution | Backend |
|---|---|---|---|
| `staging-android` | Android APK | EAS internal (install link) | `https://ferret-augmented-distrust.ngrok-free.dev` + staging Supabase `tigwgmayeuisrxjjykqd` (EAS env `preview`) |
| `staging-ios-testflight` | iOS | store-signed → TestFlight **internal** testers only | same |

The `production` profile is unchanged. It points at the production backend and production Supabase, and must be used for store candidates.

## Builds

| | iOS | Android |
|---|---|---|
| Version / build | 1.0.2 (15) | 1.0.2 (vc 22) |
| EAS build | `21a5ede7-1be4-44b4-ad7a-7b8a3584d2b9` | `d2c03b4b-0b03-4333-8718-59d41f4d54cc` |
| Artifact expiry | 2026-11-03 | 2026-10-18 |

The status, TestFlight state and install route are recorded in §Result below.

## Safety notes

- **The app only reaches the backend while the staging server and the ngrok tunnel are running.** Outside a window, it shows "couldn't confirm your protection". That is expected.
- **No purchase test.** The server-side sandbox guard (fails closed on any non-`PRODUCTION` RevenueCat event; provenance purchase guard) and the Stripe test-mode rule are unchanged. Staging Fortress limits are unchanged: £0.30 per household, £0.50/h, £1/day, 0 purchases/day, 600 s.
- …1883 is untouched; the Twilio/OpenAI window has not started.

## Result (2026-10-04)

| | iOS 1.0.2 (15) | Android 1.0.2 (vc 22) |
|---|---|---|
| EAS build | `21a5ede7-1be4-44b4-ad7a-7b8a3584d2b9`, FINISHED 15:32 UTC, no errors | `d2c03b4b-0b03-4333-8718-59d41f4d54cc`, FINISHED 15:35 UTC, no errors |
| Commit | `779ab00` | `779ab00` |
| Binary check | `main.jsbundle`: staging API ×1, staging Supabase ×1, production backend/Supabase ×0; D-C5 wording and "See setup steps" present; Info.plist 1.0.2 (15), non-exempt encryption = false | `index.android.bundle`: same result |
| Distribution | EAS Submit `55163763-2da9-4069-9dbc-e06f3ec50f81` → App Store Connect, FINISHED 15:42 UTC, no error. **Upload only; not submitted for review; no external testing.** | EAS internal install link (APK). Not uploaded to Google Play. |
| Install | TestFlight app, internal tester (after Apple processing) | https://expo.dev/accounts/homecallguard/projects/home-call-guard/builds/d2c03b4b-0b03-4333-8718-59d41f4d54cc |
