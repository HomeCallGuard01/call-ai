# Android incoming-call chain audit (30 Sep 2026)

Branch `readiness/android-call-delivery`, based on `p0/call-delivery-resilience` (4f47df2). Not merged, deployed or applied anywhere.
This extends `CALL_DELIVERY_RESILIENCE.md` and doesn't repeat it.

## 1. The failing test (read-only evidence)

`scripts/triage-incoming-calls.js 9cb62adb --since 2026-09-27` (read-only, masked), run 30 Sep:

| When (UTC) | Parent | App leg | Note |
|---|---|---|---|
| 27 Sep 11:34 | completed | completed | delivered |
| 27 Sep 11:36 | completed | completed | delivered (last success) |
| 27 Sep 14:13 | — | — | **last app registration** (android 1.0.1 / Build 19) |
| **30 Sep 12:42** | completed | **no-answer** | reached HCG, household found, Dial issued, app never answered |

Household 9cb62adb: Android, carrier recorded as **Lebara**, delivery health still HEALTHY (one unconfirmed no-answer after a success).

**What the evidence can and cannot say.** The call reached Twilio and HCG and a `<Dial><Client>` was issued. Beyond that, production holds **no device-side evidence**:
- The app's invite reports were never matched: the child/parent SID bug, whose fix is on `p0/call-delivery-resilience` and undeployed.
- The push-failure poller is off.
- A further read-only pull of the call's Twilio events and alerts was declined by this session's permission policy and was not attempted another way.

So the stage where delivery stopped is **not determinable from production data today**. Which Android causes remain possible, given what Build 19 does:

| Candidate | Consistent with evidence? | How to tell |
|---|---|---|
| Push not delivered: app process force-stopped/killed, battery-restricted, or phone offline | Yes | no `app_invite_received`; no 52103 |
| Dead FCM token (rotated; SDK `onNewToken` only logs) | Yes | Twilio alert 52103 for the child SID |
| Invite delivered but not presentable: microphone/notification permission off → SDK 31401, no ring | Yes (less likely: earlier calls on the same install rang) | 31401 in logcat; `app_presentation_blocked` after this branch |
| Rang, not answered within ~20 s (Dial timeout includes push latency) | Yes | `app_invite_received` without `app_answered` |
| Build 19 has no foreground re-registration (fixed on the p0 branch, Build 20) | Contributes to token staleness | registration history |

**Physical re-test to settle it (10 minutes):** Motorola on USB, then `adb logcat -s VoiceFirebaseMessagingService VoiceService TwilioVoiceReactNative FirebaseMessaging` while a non-contact calls the ordinary number. Four outcomes:
- **no FCM log line at all** → push/background (or token) problem;
- **`onCallInvite` but "microphone permission not granted"** → readiness;
- **notification posted but unanswered** → timeout or UX;
- **nothing reached Twilio** → carrier.

## 2. Every failure mode in the chain

Legend:
- **Fixed-p0** = on `p0/call-delivery-resilience` (29 Sep).
- **Fixed-here** = this branch.
- **Open** = not fixed.

| # | Stage | Failure mode | Current behaviour | Status |
|---|---|---|---|---|
| 1 | Carrier | Divert off / PAYG credit / carrier drops divert | Nothing reaches HCG; invisible to HCG | Open: triage tool detects "no traffic"; needs customer check (`*#21#`) |
| 2 | Carrier | Unconditional divert loops if HCG ever dialled the mobile | No PSTN dial exists (by construction) | Safe |
| 3 | Twilio → backend | `/voice` down / 11200 | Caller hears the application error | Health checks; not app-attributable |
| 4 | Backend | Number not linked to a household | Fail-closed apology | Fixed-here: `household_not_found` event |
| 5 | Backend | "Ever registered" treated as reachable (binding ≈ 1 yr) | Dial always attempted; health downgrades on evidence | Fixed-p0 (health), Fixed-here (device readiness makes it UNREACHABLE without waiting for failures) |
| 6 | Backend | Never registered | `self-protecting-unreachable` apology + alert | Safe; now recorded as an event |
| 7 | Twilio → FCM | Dead token after reinstall/rotation (52103) | Silent no-answer | Fixed-p0 (poller, off by default; UNREACHABLE after 1). Needs `DELIVERY_PUSH_FAILURE_POLLING=on` |
| 8 | Token lifecycle | Access token 1 h; refresh timer doesn't run in background | Build 19 re-registers only when the in-memory flag is false | Fixed-p0 (foreground overdue re-register, Build 20) |
| 9 | Token lifecycle | OS rotates the FCM token in background; SDK `onNewToken` only logs | Dead binding until the app is next opened | Partly: Fixed-p0 on foreground. Background fix needs a native patch (not done, as recommended) |
| 10 | Reinstall | New token; old binding dead; must sign in again | Calls fail until the app is opened and signed in | Fixed-p0 detection (52103). Customer must open the app: needs a notification decision |
| 11 | Sign-out / account switch | Binding for the old household stays live | The old household's calls could ring on the new user's phone | Fixed-p0 (unregister + wrong-identity reject; Build 20) |
| 12 | FCM → device | App **force-stopped** (Settings › Force stop, some OEM "clean" tools) | FCM not delivered to stopped apps until next launch | Open: detectable only as "no invite" (now an explicit `device` stage); needs customer guidance |
| 13 | FCM → device | Battery restrictions (Restricted bucket, OEM killers) | High-priority data messages *usually* delivered; OEM variants (Xiaomi/Oppo/Huawei, some Samsung) may not | Open, **unverified per OEM**; test matrix item |
| 14 | FCM → device | Device offline / airplane mode | no-answer | Correct: soft failure |
| 15 | Device → UI | **Microphone permission off (Android 11+)** | SDK `VoiceService.incomingCall()` returns **before** posting a notification or ringtone, raises JS error **31401**, which the app only `console.error`s → silent no-answer, app still "registered" | **Fixed-here**: 31401 reported as `app_presentation_blocked`; readiness in registration → UNREACHABLE; Home banner with Open Settings |
| 16 | Device → UI | **Notifications off (Android 13+, POST_NOTIFICATIONS)** | SDK posts nothing ("Notification not posted, permission not granted"). The Answer button lives only in that notification | **Fixed-here** (same mechanism) |
| 17 | Permission prompts | SDK asks mic/BT/notifications on every Activity create; the app never explains or re-asks after denial | A one-time denial silently disables calls | Fixed-here (visibility + banner). A guided onboarding permission step is **open** (design needed; Apple 5.1.1(iv)-style wording rules apply on iOS) |
| 18 | Lock screen | `USE_FULL_SCREEN_INTENT` blocked (Play rejection of v10) | Heads-up banner collapses after ~5–6 s on a locked phone; Answer only in the notification shade | **Open, Play blocker**: Build 19 internal only; tradeoff never accepted. Options: FSI declaration appeal (calling is the core function) or `ConnectionService` |
| 19 | Notification channel | Channel demoted/muted by the OS or user (seen on the Motorola in Aug) | Ring may be silent or collapsed | Open: not detectable from JS without a native module; logcat/`dumpsys notification` check in the test plan |
| 20 | Do Not Disturb | App notifications suppressed under DND unless the app is an exception | HCG calls silent while cellular calls may still ring | Open, **unverified** |
| 21 | No Telecom `ConnectionService` | Calls aren't Telecom calls: no car-kit/Bluetooth ringing, and unclear behaviour during a cellular call | UX gaps | Open (architecture; post-launch) |
| 22 | Reboot | FCM restarts after boot; no JS runs until a push arrives | Should deliver (FCM service `stopWithTask=false`) | **Unverified on device**: test matrix |
| 23 | App killed (swiped) | FCM wakes `VoiceFirebaseMessagingService` → `VoiceService` → notification | Proven working earlier on the Motorola (Aug) | Re-verify on Build 20 |
| 24 | Ring timeout | `<Dial timeout=20>` includes push + cold-start latency | Effective ring time on the device may be well under 20 s | Open: measure (`push_requested` → `app_invite_received` delta is now recorded) before changing |
| 25 | Answer → media | Answered but no media (network, mic) | Dial `failed`/short | Fixed-here: `app_answered` without `app_media_connected` is diagnosed as the media stage |
| 26 | Fallback | Fail-closed: caller hears an apology (monitored) or silence (trusted) | Calls lost while the app is unreachable | Open: voicemail prototype is off in production; product decision |
| 27 | Customer notification | No SMS/email when UNREACHABLE | Customer unaware | Open: product decision (p0 doc §5) |
| 28 | Instrumentation | Stages spread over columns/logs; no single answer | "Why didn't it ring?" unanswerable | **Fixed-here**: `call_delivery_events` timeline + admin route (see `CALL_DELIVERY_TELEMETRY.md`) |

## 3. Changes on this branch

- **Device call-readiness** (`mobile/lib/callReadinessModel.ts`, `callReadiness.ts`, `components/CallReadinessBanner.tsx`, `lib/voiceClient.ts`):
  - microphone and notification permission state is sent with every registration and on foreground when it changes;
  - SDK error 31401 is reported as a presentation block;
  - Home shows "Protected calls can't ring on this phone…" with an **Open Settings** button, and re-checks on foreground.
  - Uses React Native's own `PermissionsAndroid` only. No new native dependency.
- **Backend:**
  - `POST /api/v1/voice/device-readiness` (authenticated, enum-only);
  - optional `readiness` on `/voice/registered`;
  - `presented` on invite reports;
  - a `connected` outcome (timeline only; `client_outcome` unchanged);
  - `computeDeliveryHealth` treats a current denial or 31401 as UNREACHABLE. A later delivered call, or an all-granted report, clears it.
- **Telemetry:** see `CALL_DELIVERY_TELEMETRY.md`.
- **Routing, TwiML, the monitoring gate and `dialHouseholdOrFailClosed` are byte-for-byte unchanged.** `server.js` changes are purely additive, and the existing structural guard tests pass unmodified.

Tests:
- `tests/call-delivery-events.test.mjs` (privacy, recorder, timeline, 30 Sep scenario, wiring, migration);
- `tests/device-call-readiness.test.mjs` (parser, health, mobile model, wiring);
- full `npm test` green (4,127 checks);
- `tsc --noEmit` clean.
- One pre-existing literal check in `tests/mobile-app.test.mjs` was updated because the invite report now carries readiness. Its intent (fire-and-forget, no token threaded) is still asserted.

## 4. Physical verification still required (Build 20)

| # | Test | Pass |
|---|---|---|
| P1 | App foreground, unknown caller | Rings; `app_invite_received`, `app_ringing`, `app_answered`, `app_media_connected`, `delivered` in the timeline |
| P2 | App swiped away | Rings (cold start). Record the push → invite delay |
| P3 | Phone locked, screen off | Rings, Answer reachable (records the FSI-blocked behaviour) |
| P4 | After reboot, app never opened | Rings |
| P5 | Settings › Force stop | Expected: does **not** ring; timeline diagnosis "device"; after opening the app, rings |
| P6 | Revoke microphone, then call | No ring; `app_presentation_blocked`; health UNREACHABLE; Home banner shows |
| P7 | Android 13+ phone, revoke notifications | Same as P6 with the notifications message |
| P8 | Reinstall without opening | Fails; 52103 (poller on, staging); open the app and sign in → rings |
| P9 | Sign out, sign in as another household | The old household's call does not ring |
| P10 | DND on | Record the behaviour |
| P11 | Battery saver / Restricted | Record the behaviour per OEM (Motorola, Samsung) |
