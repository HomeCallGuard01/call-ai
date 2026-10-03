# Mobile release blockers: morning report (1 Oct 2026)

Supersedes the mobile rows of `RELEASE_BLOCKERS_2026-09-30.md`.

Branches (pushed, **not merged, not deployed, no builds made**):
- `readiness/android-call-delivery` (Android + shared delivery work)
- `readiness/ios-parity`, built on the Android branch
- `preserve/forwarding-number-api-wip-2026-09-30` (a verbatim snapshot of uncommitted work, not reviewed)

**"Fixed?" means code-complete with automated tests. Not one of these is device-verified.** Every "Device test required? Yes" row stays unproven until you run it on a handset (plan below).

## Android + shared call delivery

| Blocker | Android | iPhone | Severity | Fixed? | Tested? | Device test required? | Production change required? | Release blocking? |
|---|---|---|---|---|---|---|---|---|
| Registered but can't ring: mic (11+) / notifications (13+) off → SDK drops the call, error 31401 ignored | ✓ | mic (see iOS) | S1 | Yes (readiness report, UNREACHABLE health, Home banner) | Unit/wiring | Yes: P6, P7 | Backend deploy + Build 20 | Yes |
| "Registered once" treated as reachable | ✓ | ✓ | S1 | Yes: explicit reachability (unreachable/degraded/presumed/confirmed) in health, dashboard and trace. Routing unchanged by design | Unit | Yes: P1, P5 | Backend deploy | Yes |
| FCM token rotation leaves a dead binding (SDK `onNewToken` only logs) | ✓ | (PushKit, same code) | S1 | Yes, on foreground (token compare → re-register). Background rotation without a foreground is still open (native patch) | Unit | Yes: P8 | Build 20 | Yes |
| Dead-token push failures (52103) invisible | ✓ | — | S1 | Yes (p0 poller) | Unit | Yes: P8 | Deploy + `DELIVERY_PUSH_FAILURE_POLLING=on` | Yes |
| Sign-out / account switch leaves the old household ringing | ✓ | ✓ | S1 | Yes (p0) | Unit | Yes: P9 | Build 20 | Yes |
| Invite reports never matched (child/parent SID) | ✓ | ✓ | S2 | Yes (p0, server-side) | Unit | Any call | Deploy | Yes |
| 30 Sep no-answer (9cb62adb) root cause | ✓ | — | S1 | Undetermined from production data; the trace now pinpoints the stage | — | **Yes: P0 logcat re-test** | — | Yes, until explained |
| Locked screen: incoming UI collapses after ~5 s (USE_FULL_SCREEN_INTENT blocked) | ✓ | — | S1 | **No** (your decision: accept, file the FSI declaration, or `ConnectionService`) | — | Yes: P3 | Build | **Yes** |
| Force-stop / OEM battery killers | ✓ | — | S2 | Detected (trace "device" stage); no in-app guidance | — | Yes: P5, P11 | — | Guidance copy |
| Notification channel muted / DND | ✓ | — | S3 | No (needs a native module to detect) | — | Yes: P10 | — | No |
| Ring timeout 20 s includes push latency | ✓ | ✓ | S3 | Measurable now (push_requested → app_invite_received); Dial is owned by the financial-safety branch | — | Yes: P2 | — | No |
| No voicemail or customer alert when unreachable | ✓ | ✓ | S2 | No (product decision) | — | — | — | Your call |
| Call-delivery trace (inbound → household → classified → route → endpoint health → push → device received → ringing → answered → media → completed/failed + reason) | ✓ | ✓ | S1 (diagnosability) | Yes (migration 060 DRAFT, admin JSON route, diagnosis) | Unit | Yes: P1 (full trace visible) | Apply 060 staging→prod, `CALL_DELIVERY_EVENTS_DB=on` | Yes (to never guess again) |

## Security / denial-of-wallet (mobile scope)

| Blocker | Android | iPhone | Severity | Fixed? | Tested? | Device test required? | Production change required? | Release blocking? |
|---|---|---|---|---|---|---|---|---|
| S1: Voice token can place outgoing calls; TwiML App URL unknown; fallback route missing | ✓ | ✓ | High | Mitigated (`/voice` rejects `client:` origin; fallback route restored) | Unit | No | Deploy + **you: read-only check of the TwiML App Voice URL** | Yes |
| S2: Leaked token → a binding for ~1 year → call interception | ✓ | ✓ | High | **No** (identity-epoch design) | — | Yes, after implementation | Migration + backend + app | Recommend before broad launch |
| S3: Unsigned `/voice` and `/call-delivery-failed` | ✓ | ✓ | Medium | Telemetry doesn't amplify it; enforcement is Claude A's | Unit | — | Signature enforcement | Claude A |
| S4/S5: REST amplification and unbounded app routes | ✓ | ✓ | Medium | Yes (rate limits + negative cache) | Unit | No | Deploy | Yes |
| S6: Unauthenticated debug beacon | ✓ | ✓ | Low | No | — | — | Global rate limiter | No |

## iPhone

| Blocker | Android | iPhone | Severity | Fixed? | Tested? | Device test required? | Production change required? | Release blocking? |
|---|---|---|---|---|---|---|---|---|
| **With `IOS_COMING_SOON=false` no iPhone customer could ever pay** (carrier always NULL for iphone, both route and SQL) | — | ✓ | S1 | Yes (route + migration 061 DRAFT) | Unit + pglite | Yes: I4 | Apply 061; deploy | Yes |
| Current app code Android-first (iPhone dead end; Android card shown on iOS → 2.3.10) | — | ✓ | S1 | Yes (flag-driven iPhone path, iOS shows iPhone only, copy de-Androided) | Unit | Yes: I1–I3 | `IOS_COMING_SOON=false` at launch (Apple Claude's planning) | Yes |
| iOS never requests microphone → silent first call | — | ✓ | S1 | Yes (expo-audio, iOS-only link, neutral Continue → prompt, Settings if denied) | Unit + autolinking check | Yes: I5, I6 | New iOS build | Yes |
| tel: links with `*`/`#` not dialled by iOS | — | ✓ | S2 | Partly: keypad fallback hint shown on iOS (behaviour unverified) | Unit | Yes: I3 | — | Verify |
| iOS 1.0.1 = Build 12 (old line, 23+ commits behind) | — | ✓ | S1 | New build from `readiness/ios-parity` needed | — | Yes (all I-tests) | New build | Yes |
| RevenueCat sandbox purchases provision real numbers | — | ✓ | S2 | Fixed on `fix/revenuecat-sandbox-environment-guard` (unmerged, not mine) | Its tests | Sandbox purchase | Deploy | Yes, before review |
| IAP attachment in App Store Connect | — | ✓ | S1 | Apple Claude / you | — | — | ASC | Yes |
| Forwarding-number fix (giffgaff/Three) | ✓ | ✓ | S2 | Uncommitted in its worktree; **snapshot preserved** | Its own tests (90/90 reported) | Yes | Deploy with Build 20 | Yes for those carriers |

## Not in my scope, but blocking (for completeness)
- Spend limits and Dial `timeLimit`: the financial-safety branch.
- Play Billing.
- Terms wording.
- Supabase grants: Claude C (058/059 already on staging).

## Physical tests Andrew needs to perform

Android: Build 20 from the integrated line, on the Motorola and one Samsung. Staging backend with 055 + 060 applied and `CALL_DELIVERY_EVENTS_DB=on`. After each call, open `GET /admin/api/households/<id>/call-delivery-timeline` and record the diagnosis.

| # | Test | Pass condition |
|---|---|---|
| P0 | Current Build 19 on the Motorola, USB, `adb logcat -s VoiceFirebaseMessagingService VoiceService TwilioVoiceReactNative FirebaseMessaging`; a non-contact calls your number | Explains 30 Sep: no FCM line = push/background; "microphone permission not granted" = readiness; notification posted but unanswered = timeout/UX |
| P1 | App in foreground, unknown caller, answer | Rings; the timeline shows every stage through `app_media_connected` and `delivered` |
| P2 | App swiped away | Rings; record the push → invite delay |
| P3 | Locked, screen off | Rings; can you answer? (FSI behaviour) |
| P4 | Reboot, don't open the app | Rings |
| P5 | Settings › Force stop | Does not ring; diagnosis "device"; open the app → rings |
| P6 | Revoke microphone, call | No ring; Home banner; health UNREACHABLE |
| P7 | Android 13+: revoke notifications | Same as P6 with the notifications message |
| P8 | Uninstall and reinstall, don't open; call; then open and sign in; call | First fails (52103 in the trace with the poller on); second rings |
| P9 | Sign out; sign in as a different household; call the first household | The phone does not ring for the first household |
| P10 | DND on | Record |
| P11 | Battery saver / Restricted | Record per OEM |

iPhone: new build from `readiness/ios-parity` (TestFlight only), with the staging flag `IOS_COMING_SOON=false` on staging only.

| # | Test | Pass condition |
|---|---|---|
| I1 | Onboarding | Only an "iPhone" card; no Android text anywhere |
| I2 | Carrier step | Carrier/tariff asked; reaches Subscribe |
| I3 | Activate | Does "Activate protection" open the Phone app with the code? Record exactly; the keypad fallback works |
| I4 | Sandbox purchase (RevenueCat sandbox guard merged first) | Entitlement granted; no real number provisioned in sandbox |
| I5 | Home microphone banner → Continue | System prompt appears; banner clears when granted |
| I6 | Deny the microphone, call | The call rings (CallKit); banner "callers won't be able to hear you"; Open Settings works |
| I7 | Locked / terminated app, call | CallKit rings; answer; two-way audio |
| I8 | Sign out / switch household | No ring for the old household |
| I9 | Unknown caller with scam phrases | SMS warning / termination as on Android |

## Exact steps to a technically release-ready mobile build
1. Review and merge (your approval) `p0/call-delivery-resilience` → `readiness/android-call-delivery` → `readiness/ios-parity`, plus the forwarding-number fix (from its worktree or the preserve snapshot), the RevenueCat sandbox guard, and Claude A's financial-safety and webhook-auth work. Renumber migrations at integration.
2. Staging: apply 055, 060, 061 (with Claude C's 058/059), deploy, enable the poller and telemetry writes. **You: check the TwiML App Voice URL (read-only).**
3. Decide on the locked-screen/FSI approach, and on voicemail or customer alerts when unreachable.
4. Build 20 (Android) and an iOS TestFlight build from the integrated line; run P0–P11 and I1–I9.
5. Fix what the device tests find. Only then run the production migrations and deploy (your approval), set `IOS_COMING_SOON=false` at iOS launch, and submit.
6. Before broad launch: implement the identity epoch (S2) and enforce webhook signatures (S3, Claude A).
