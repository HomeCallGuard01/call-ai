# iOS parity and release readiness (30 Sep 2026)

This is a repository and configuration audit only. **Nothing was submitted to Apple, and no App Store Connect access was used.** iOS 1.0.1 remains held at Ready for Review, and this audit does not change that.

## What iOS 1.0.1 is

The held iOS build is **Build 12** = commit `11d3b6a` (`sandbox/mobile-app-v1` line, built 18 Sep; EAS `10ad1c4b`). The mobile code on `main` and on the Android release line has moved on: **23 mobile commits** since, including every call-delivery and onboarding fix below.

## What iOS has (Build 12, and still on main)

| Area | State |
|---|---|
| Voice SDK / VoIP push | PushKit registry initialised at module import (Build 9 SIGABRT fix); `aps-environment: production`; production APNs VoIP push credential; `UIBackgroundModes: audio, voip` |
| Incoming call UI | CallKit, via the Twilio iOS SDK (`reportNewIncomingCall`). Works when locked or terminated by design (PushKit → CallKit) |
| Registration | Same JS as Android: register on sign-in; 1 h token with a refresh timer |
| Purchase | RevenueCat/StoreKit (`lib/purchases.ts`), product `co.uk.homecallguard.app.monthly`, entitlement `hcg_protected`; backend RevenueCat webhook grants entitlement |
| Onboarding | Contacts (Apple picker + bulk), Apple-compliant purpose string and pre-permission flow (Build 10 rejection fixed), device picker with Android references removed (Build 12 fix) |
| Trusted contacts | Same backend and screens as Android |
| Account deletion | In-app route (backend live since 8 Sep) |

## What iOS lacks compared with the current Android line

| Gap | Impact | Fix |
|---|---|---|
| **The current mobile code is Android-first.** Device picker shows "iPhone — Coming soon" as a dead end; backend `IOS_COMING_SOON` (default **true**) blocks `device_type = iphone` at checkout | **An iOS build cut from main today would not let an iPhone user sign up.** Apple would reject it (2.1 completeness) | Platform-aware device picker (on iOS the iPhone card is the path); set `IOS_COMING_SOON=false` at the iOS launch; verify the iOS IAP path isn't blocked by the Stripe-oriented eligibility check the subscribe screen calls first |
| **Microphone permission is never requested on iOS.** The Twilio iOS SDK doesn't request it, and the app has no audio-permission module | The first answered call triggers the system prompt mid-call (possibly from the lock screen). Until granted, the caller hears silence from the customer | Add `expo-audio` (or equivalent) and ask during onboarding with a neutral explainer (5.1.1(iv): no "Allow" pre-button). **Needs a native dependency and a new build, so not done tonight** |
| Invite/outcome reporting (045), child-SID fix, sign-out unregister, wrong-household guard, foreground re-registration (p0 branch), device readiness + telemetry (this branch) | Build 12 is blind: no device evidence, and an account switch can leave the old household ringing | In the next iOS build from the current line |
| Carrier-compatibility gate and terms-acceptance record (Build 12 never calls them) | iPhone customers bypass the carrier gate and no terms-acceptance row is written | Current line calls both |
| Protection-status checklist, delivery-confirmed verify, onboarding redesign | UX parity | Current line |
| Readiness on iOS | Reports `notifications: not_required` (CallKit needs none) and `microphone: unknown`; never treated as blocked | Becomes real once a mic-permission module exists |

## Subscription / IAP (repository view)

- Product, entitlement and offering IDs are hard-coded in `lib/purchases.ts`. The key comes from `EXPO_PUBLIC_REVENUECAT_API_KEY_IOS` (EAS env).
- The RevenueCat webhook is live on the backend, and a sandbox-purchase guard exists (`fix/revenuecat-sandbox-environment-guard`, unmerged). It stops sandbox purchases from provisioning real Twilio numbers.
- **Not verifiable from here:** whether the subscription is attached to the 1.0.1 version in App Store Connect, its review status, and the price point. You said this is the reason 1.0.1 is held.
- An ASC API key file exists in `~/Downloads`. It was **not used**; using it needs your explicit authorisation.

## App Store submission blockers

1. The IAP subscription must be attached to the version for its first review (your action in ASC).
2. Decide which binary to submit:
   - **Build 12:** old line. Missing delivery fixes; bypasses the carrier gate and the terms record.
   - **A new iOS build from the current line:** needs the Android-first gating reversed on iOS, plus mic permission.

   **Recommendation: a new build.** Submitting Build 12 would ship a client that current backend fixes can't observe or repair.
3. Reviewer account: its password must still work (2.1 history).
4. A physical iPhone test of the current line: locked, terminated, CallKit answer, audio both ways, mic first-run.
5. `IOS_COMING_SOON=false` deployed at the moment the iOS app goes live (and the website label changed).
6. Terms: Apple billing and cancellation wording is missing (terms audit 2026-09).
