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

## Real-device finding: iOS Build 15 stays on the splash (2026-10-04)

**Status: Build 15 is NOT usable. Do not test with it.**

- **Evidence (iPhone log via `idevicesyslog`, 17:46:15):** `Unhandled JS Exception: [runtime not ready]: Error: Cannot find native module 'ExpoAsset'`. The JavaScript dies before the first screen, so the splash is never hidden. The backend being offline is unrelated.
- **Cause:** `expo-audio` (new in 1.0.2) declares the peer dependency `expo-asset: "*"`, so npm installed **expo-asset 57.0.18** (Expo SDK 57) at the top level. Its podspec requires iOS 16.4 while the app targets iOS 15.1, so its native module was left out. The Build 15 binary has every other Expo module but no `AssetModule`. SDK 54's JavaScript requires it, and crashes at launch.
- **Android vc 22:** the APK does contain `AssetModule`, so it is probably not affected. Untested (Android on hold).
- **Fix (`mobile/package.json` + lockfile):** `expo-asset ~12.0.13` is now a direct dependency, leaving one copy at 12.0.13 (the SDK 54 version, as in Build 14). iOS autolinking now resolves 23 modules, all with a minimum of iOS 15.1. Expo's optional `expo-asset` config plugin was deliberately not added.
- **Guard:** `tests/mobile-native-sdk-compat.test.mjs` fails the suite on any SDK-line drift or any iOS module that needs a newer iOS than the app target. Proven against the Build 15 lockfile (3 failures).
- **Startup safety net:** a root `ErrorBoundary` ("couldn't confirm your protection right now", Try again, support), a splash hide on root mount, and a 10 s stalled-start message. Tests: `tests/mobile-startup-safety-net.test.mjs`. This cannot catch a native module missing from the binary at import time. The guard above covers that.
- **Needs a new iOS staging build.** Proposed **1.0.2 (15.1)**, keeping Build 16 for the production candidate. Not built; needs Andrew's go-ahead.

## iOS 1.0.2 Build 16: corrected STAGING build (2026-10-04)

Andrew's decision: build numbers are disposable. Build 15 stays as the historical failed staging build; **Build 16 is its corrected successor**. The iOS production candidate will be **Build ≥ 17**. Same rules as Build 15: STAGING only, TestFlight internal only, never review, external testing or release.

| | |
|---|---|
| EAS build | `be1f645c-1082-43a0-8faf-bb9b82d4d449`, FINISHED, from `e63377f`, profile `staging-ios-testflight` |
| Binary | Info.plist 1.0.2 (16), MinimumOSVersion 15.1; `AssetModule` linked (absent in Build 15); lockfile single `expo-asset` 12.0.13 on `expo` 54.0.36 |
| Endpoints | JS bundle: staging API ×1, staging Supabase ×1, production backend/Supabase ×0 |
| TestFlight | EAS Submit `89a5d0ba-bd34-4eb6-972b-e94bc594790e` FINISHED 17:04 UTC, no error (upload only) |

### Real-device result: Build 16 startup PASS (2026-10-04, Andrew)

Installed from TestFlight on the test iPhone. The app gets past the native splash and opens, showing the "protection unconfirmed" state. That is expected while the staging backend is offline. **Startup: PASS.** The launch crash (missing `ExpoAsset`) is fixed on a real device.

Not yet tested: everything that needs the staging backend (sign-in, dashboard, call delivery). That is the controlled staging device test, next session. Android vc 22 remains untested and on hold (Motorola install failed).
