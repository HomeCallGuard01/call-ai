# Android handset verification plan (launch blocker B2): 2026-10-09

**Status: PLAN ONLY.** Every 🔴 row needs Andrew's GO in the window. Nothing here changes production.

**Why:** **no 1.0.2 build has ever run on an Android handset.**
- On 5 Oct the Motorola was only the caller, and the vc 22 APK never installed.
- The last Android device evidence is 1.0.1 Build 19 (27–30 Sep), including an unexplained no-answer on 30 Sep.

The cohort is Android-only, so this plan is the launch gate for the app.

Builds on:
- `2026-10-05-STAGING-DEVICE-TEST-PLAN.md`: the START/END window procedure §2/§4, the abort rules and the caller scripts in Appendix A are reused unchanged;
- the Build 17 handover's stop rules.

## 0. Fixed facts

| Item | Value |
|---|---|
| Subscriber (runs HCG) | **Motorola**, its own SIM `…3030` |
| Caller and "support phone" | **iPhone `…2700`**. Sign out of HCG on the iPhone first, so only the Motorola is registered |
| Backend | Staging server at the pinned candidate SHA, with migrations ≤ 075 on staging (S0–S1 of the deploy procedure), behind the reserved ngrok domain |
| Staging number / household | `…1883` (inert outside the window) / `ffc4cfe1…` |
| Fortress limits | Unchanged staging caps: £0.30 per household, £0.50 per hour, £1 per day, 0 purchases, 600 s per call. Expected spend £0.20–£0.60 |
| Build | 🔴 **EAS build `staging-android` APK, versionCode ≥ 23**, from the pinned SHA. If Andrew approves the compliant Android payment route (Option C, `2026-10-09-ANDROID-COMPLIANT-PAYMENTS.md`), build **after** that change, so the cohort binary is the tested binary |
| Never | production changes, purchases, number purchase or release, real SMS (T15b), forwarding changes without the 🔴 in H8 |

## 1. Pre-window (Claude, no device)

| # | Check | Pass |
|---|---|---|
| A1 | APK SHA-256 recorded. Bundle grep: staging URL ×1, production URL ×0, ngrok domain present | As stated |
| A2 | `aapt dump badging`: versionCode ≥ 23, versionName 1.0.2. Permissions include `RECORD_AUDIO`, `POST_NOTIFICATIONS`, the `FOREGROUND_SERVICE*` set; `USE_FULL_SCREEN_INTENT` **absent** (blocked by design, B-11) | As stated |
| A3 | No `CallInvite` cold-start recovery (`getCalls()`) in `mobile/lib/voiceClient.ts`. This is a known risk, tested in H5 | Recorded |

## 2. Install and startup (Claude over adb; Andrew unlocks the phone)

| # | Step | Evidence | MUST |
|---|---|---|---|
| H0 | `adb devices -l` shows 1 authorised device. Record the Android version, model and the `dumpsys package co.uk.homecallguard.app` state. **If a Play-signed build is installed → STOP and ask** (signature clash) | adb output | ✔ |
| H1 | `adb install` → versionCode ≥ 23. Start `logcat` capture (ReactNativeJS, AndroidRuntime, Twilio*, FCM). Launch the app | No `FATAL EXCEPTION`; welcome screen (screencap) | ✔ |
| H2 | Andrew signs in with the temporary staging login. Allow the microphone and **notifications** (the Android 13+ runtime prompt) | Registration with the **Android** FCM credential; `voice_client_registered_at` set; `app_build_version` ≥ 23 | ✔ |
| H3 | Battery: `dumpsys deviceidle whitelist` and app standby bucket recorded. Note whether the app asks the user to exempt it from battery optimisation | Recorded (informs the customer guide) | — |

## 3. Call handling (iPhone `…2700` calls `…1883`; one action at a time)

| # | Scenario | Andrew reports | Server / adb evidence | MUST |
|---|---|---|---|---|
| H4a | Trusted, **foreground** → answer in the app → in-app call screen: Mute (caller hears nothing) → unmute → Speaker on → off → **End on the Motorola** | Rang? Screen shown? Controls worked? | `<Dial timeLimit>`; one reservation committed and released; both legs completed | ✔ |
| H4b | Trusted, **background** (home screen) → answer from the notification | Rang? HCG call screen after answering? | As H4a | ✔ |
| H5 | Trusted, **app killed** (swipe away; then `adb shell am force-stop` as a separate variant) → answer from the notification | Did it ring? Does the HCG screen appear? Can you hang up? | FCM delivery in logcat; `client_invite_received_at`. **If the call connects but no HCG screen and no way to end it, record it as a blocker (fix: cold-start `getCalls()` recovery)** | ✔ |
| H6 | Trusted, **phone locked** (screen off for at least 30 s) | Heads-up or notification? How long visible (expect about 5–6 s collapse, B-11)? Answered? | logcat notification channel and importance | ✔ (behaviour recorded for B-11) |
| H7a | Remove `…2700` from trusted contacts. **Unknown caller, monitored**: announcement → answer → 30 s chat | Announcement heard? Audio OK both ways? | Stream token issued from signed `/voice`; transcription; reservation released | ✔ |
| H7b | Warning script (Appendix A). **SMS not sent** (staging SMS guard) | Anything shown? | Warning threshold reached; recorded outcome | ✔ |
| H7c | Red-line script → the call ends by itself → the call screen dismisses by itself | Ended? Screen gone? | `terminated_by_system` | ✔ |
| H7d | The caller hangs up while the Motorola is muted and on speaker → the screen dismisses. The next call starts unmuted with speaker off | — | — | ✔ |

## 4. Real forwarding and support-verified proof (🔴 separate GO: changes the Motorola's carrier forwarding)

| # | Step | Evidence | MUST |
|---|---|---|---|
| H8a | Home shows **not Protected** with truthful wording (`forwarding_unconfirmed`) | API `activationStage`; screencap | ✔ |
| H8b | 🔴 Andrew follows the app's own forwarding instructions for the Motorola's carrier (code or Settings path shown in the app; record which carrier) | Carrier confirmation tone or message | ✔ |
| H9 | **Support-verified proof end to end:** with `HCG_SUPPORT_VERIFICATION_CALLERS=<…2700>` on staging, the iPhone dials **the Motorola's own number `…3030`**. The carrier diverts it to `…1883`, the app rings, and Andrew answers in the app, then ends the call. Claude opens `/admin/forwarding-proof?household=ffc4cfe1…` (staging admin login), checks the call is "eligible", enters `3030`, writes the reason and the phrase, then Records | Call row: `dial_call_status=completed`, From = `…2700`, created after the assignment. One `forwarding_proof_audit` row. The app turns **Protected** after refresh | ✔ |
| H10 | Negative controls in the same session: (a) iPhone dials `…1883` directly → the call works, but the admin page cannot be used to prove with digits other than `3030`, and a non-support caller is not eligible; (b) re-using the H9 call SID → refused | 409 messages | ✔ |
| H11 | 🔴 Andrew turns forwarding **off** with the code or path the app shows. A call to `…3030` now rings the Motorola natively | Native ring | ✔ |
| H12 | Admin → **Clear proof** (audited) → Home back to not Protected | Audit row `cleared` | ✔ |

## 5. Safety controls on device

| # | Step | Evidence | MUST |
|---|---|---|---|
| H13 | Household **hold** → refresh → the paused-account wording (D-C5) → a call → the caller hears busy | Audited hold; no spend | ✔ |
| H14 | **Kill switch** on → a call is refused busy → off + `fc_reset_breaker` | `fc_global_status` | ✔ |
| H15 | **Sign out** → a call → unbilled `<Reject/>`. **Sign in** → a call rings again | Unregister reached the server | ✔ |
| H16 | Backend down (stop the tunnel) → refresh → "couldn't confirm your protection", never Protected → restart the tunnel | Screencap | ✔ |
| H17 | Budget cap (last; only if budget remains): repeated unknown calls until the Fortress refuses | Refusal at the household cap; global caps unaffected | — |

## 6. Mandatory reset (even after an abort)

In this order:
1. `…1883` voice URL emptied first, and read back.
2. Forwarding confirmed **off** on the Motorola.
3. Proof cleared.
4. Fixtures restored.
5. Temporary login and secrets deleted.
6. Fortress: 0 active reservations.
7. Processes stopped (PIDs verified before killing).
8. Production fingerprint compared.
9. Twilio reconciled against the Fortress ledger.
10. Evidence committed: `docs/launch/2026-10-XX-ANDROID-DEVICE-EVIDENCE.md`, with private logs outside the repo.

## 7. Production-build check (after the production deploy; 🔴)

| # | Step | MUST |
|---|---|---|
| P1 | EAS `production` AAB (vc = staging vc + 1) from the same SHA. Bundle grep: production URL ×1, staging ×0, ngrok ×0 | ✔ |
| P2 | Submit to the Play **Internal** track only. Install on the Motorola from Play. Sign in to Andrew's own production household. One trusted call and one unknown call to `…6063` (deploy procedure D9) | ✔ |

## 8. Pass rule

- **GO for the Android cohort:** every MUST row is PASS.
- **H5 or H6 result:** if the killed-app answer cannot show or end the call, it is a **code fix before launch**. If only the locked-screen banner collapses (expected), that is B-11, recorded for Andrew's acceptance with customer guidance ("answer from the notification").
- **Any failed delivery** (a ring never arrives) on a warm app → **NO-GO** until explained.

## 9. Added 2026-10-10 (WS3): rows for the new app behaviours

**Status: PLAN ONLY.** These rows cover WS3's code on `launch/ws3-mobile-routing`. They apply only if the build under test contains it. Run them in the same window, using the same rules as above. A3 above is superseded: the build now contains `getCalls()` recovery, but it is **not device-proven**. H5 is still the acceptance test.

| # | Scenario | Andrew reports | Evidence | MUST |
|---|---|---|---|---|
| W1 | **Cold-start recovery (H5 with the fix):** app swiped away, then answer the trusted call from the notification. Then open HCG from the launcher or recents if it doesn't come up by itself. Variant: `am force-stop` | Does the HCG call screen appear (within ~10 s of opening the app)? Do Mute, Speaker and End work? Does End hang up both sides? | logcat `call-recovered` beacon (`start:connected`); one `accepted` and one `connected` invite outcome for the client call SID; the call is not moved to the loudspeaker on its own | ✔ |
| W2 | **Background recovery:** answer from the notification with the app backgrounded, then bring HCG to the front | Call screen shown; controls work | beacon `foreground:connected`, or the live `Accepted` path | ✔ |
| W3 | **No phantom screen:** open the app with no call in progress, and again just after a call ended | No call screen | — | ✔ |
| W4 | **Allowance banners.** Staging only: set the household's allowance state through WS2's staging mechanism (no code change on the device) to `screening_paused`, then `continuity_low`, then `hard_ceiling`, then back to `normal`, refreshing Home each time | Truthful wording ("Screening paused — calls are still reaching you, but unknown callers are not being checked"); Home **never** says "Protected" in the three paused states; no price, buy button, link or QR anywhere; only the plain support-email note | Screencap per state; API `allowanceState` as returned | ✔ |
| W5 | **Turn off call forwarding (action only, no dialling):** tap the banner action → the guided screen → **Open Phone app** | The dialer opens with the carrier's cancel code pre-filled (or `##21#` with the "not confirmed" caveat for Lebara/EE). **Andrew does NOT press Call** in this row | Screencap of the dialer | ✔ |
| W6 | 🔴 (Optional; combine with H11) press Call on the code from W5 instead of typing the H11 code by hand | Carrier message confirms forwarding off; a call to `…3030` rings natively | As H11 | — |

Pass rule addition: if W1 fails (no screen, or controls don't work), that is the H5 code-fix outcome from §8. Record the logcat lines around `call-recovered` and `VOICE DEBUG: active call recovery failed`.
