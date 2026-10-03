# Release blockers: Android + iPhone (30 Sep 2026)

Evidence: `ANDROID_CALL_CHAIN_AUDIT_2026-09-30.md`, `IOS_PARITY_AUDIT_2026-09-30.md`, `CALL_DELIVERY_TELEMETRY.md`, `CALL_DELIVERY_RESILIENCE.md`, and the recorded workstream notes.
"Fixed tonight" means code on `readiness/android-call-delivery` (pushed, not merged, not deployed).

Severity scale:
- **S1** = unsafe to launch, or could lose customers' calls or money.
- **S2** = must fix before broad launch.
- **S3** = can follow.

## Telecom / carrier / economic

| Blocker | Android | iPhone | Sev | Fixed tonight? | Test required | Release blocking? |
|---|---|---|---|---|---|---|
| Trusted calls billed for the whole conversation under `**21*` (no provider can remove it) | ✓ | ✓ | S2 | No (research: busy-divert E1 ready, not run) | E1 physical test | Economic decision, not technical |
| No enforced spend limits (only 30-min per-call cap); `<Dial>` has no timeLimit | ✓ | ✓ | **S1** (your launch blocker) | No (financial-safety branch `feature/financial-safety-hard-limits`, peer session) | Allowance/admission tests + staging | **Yes** |
| Landline delivery has no loop-safe path | n/a | n/a | S1 for landline | No | Test 3 package prepared | Yes for landline only; keep it hidden |
| Carrier compatibility (Three/giffgaff forwarding-number fix uncommitted; EE/giffgaff deactivation codes unverified) | ✓ | ✓ | S2 | No (`/Users/ad/call-ai-forwarding-number`) | Build 20 onboarding on giffgaff/Three | Yes for those carriers |
| Number rental price unverified ($3.50 list vs £0.869 on the account) | ✓ | ✓ | S3 | No | Price at next purchase | No |

## Call reliability

| Blocker | Android | iPhone | Sev | Fixed tonight? | Test required | Release blocking? |
|---|---|---|---|---|---|---|
| 30 Sep no-answer (9cb62adb): the stage where it stopped can't be determined from production data | ✓ | — | **S1** | Diagnosed as far as evidence allows; telemetry now pinpoints it next time | logcat re-test (audit §1) | **Yes, until reproduced/explained** |
| Registered but can't ring: mic/notification permission off → SDK 31401 silent drop | ✓ | (mic: see iOS) | **S1** | **Yes**: readiness reporting, UNREACHABLE health, Home banner | P6/P7 on device | Yes (needs Build 20) |
| Dead FCM token (52103) invisible; SDK `onNewToken` only logs | ✓ | — | S1 | Fixed on p0 branch (poller off by default) | P8 | Yes: deploy + enable poller |
| Build 19 has no foreground re-registration | ✓ | ✓ | S2 | Fixed on p0 branch | P1–P2 | Yes (Build 20) |
| Sign-out leaves the old household's binding (calls ring on the wrong phone) | ✓ | ✓ | **S1** (privacy) | Fixed on p0 branch | P9 | Yes (Build 20) |
| Invite reports never matched (child/parent SID) | ✓ | ✓ | S2 | Fixed on p0 branch (server-side, works for Build 19 once deployed) | Any call | Yes: deploy |
| Locked-screen incoming UI collapses after ~5 s (USE_FULL_SCREEN_INTENT blocked) | ✓ | — | **S1** | No | P3 | **Yes**: accept the tradeoff, file the FSI declaration, or build `ConnectionService` |
| Force-stop / OEM battery killers stop delivery | ✓ | — | S2 | Detected (`device` stage) | P5, P11 | Guidance copy needed |
| Fail-closed with no voicemail or customer notification when unreachable | ✓ | ✓ | S2 | No (prototype off) | — | Your product decision |
| Ring timeout 20 s includes push latency | ✓ | ✓ | S3 | Measured by new telemetry | P2 | No |
| DND / notification channel muted | ✓ | — | S3 | No | P10 | No |
| Screened-call audio quality gap vs trusted | ✓ | ✓ | S2 | No | Quality comparison | Blocks broad advertising |

## Apple / App Store

| Blocker | Android | iPhone | Sev | Fixed tonight? | Test required | Release blocking? |
|---|---|---|---|---|---|---|
| IAP subscription attachment to 1.0.1 | — | ✓ | S1 | No (your action in ASC) | — | Yes |
| Current mobile code is Android-first ("iPhone — Coming soon"; `IOS_COMING_SOON=true`) | — | ✓ | S1 | No | iOS onboarding on device | Yes, for any new iOS build |
| iOS never requests microphone permission | — | ✓ | S1 | No (needs `expo-audio` + build) | First-call test | Yes |
| Build 12 lacks 23 mobile commits (delivery fixes, carrier gate, terms record) | — | ✓ | S2 | No | — | Recommend a new build instead of Build 12 |

## Android / Play

| Blocker | Android | iPhone | Sev | Fixed tonight? | Test required | Release blocking? |
|---|---|---|---|---|---|---|
| In-app Stripe very likely breaks Play Payments policy | ✓ | — | **S1** | No (needs your decision: Play Billing via RevenueCat) | Purchase test | **Yes, for Production** |
| FSI permission policy (see reliability) | ✓ | — | S1 | No | — | Yes |
| Build 19 is Internal Testing only; Build 20 not built | ✓ | — | S1 | Code ready on branches | Full P1–P11 | Yes |

## Subscription / payment

| Blocker | Android | iPhone | Sev | Fixed tonight? | Test required | Release blocking? |
|---|---|---|---|---|---|---|
| Play Billing (above) | ✓ | — | S1 | No | — | Yes |
| RevenueCat sandbox purchases provision real numbers (fix unmerged) | — | ✓ | S2 | No (fix on `fix/revenuecat-sandbox-environment-guard`) | Sandbox purchase | Yes, before iOS review |
| Terms: price-change clause, no allowance wording, no store billing/cancellation wording | ✓ | ✓ | S2 | No | Legal review | Yes (your call) |
| Stripe Checkout text lacks VAT | ✓ | — | S3 | No | — | No |

## Onboarding

| Blocker | Android | iPhone | Sev | Fixed tonight? | Test required | Release blocking? |
|---|---|---|---|---|---|---|
| No guided permission step; one denial silently disables calls | ✓ | ✓ | S2 | Partly (banner + detection) | P6/P7 | No, with the banner |
| giffgaff/Three show no forwarding number (uncommitted fix, Build 20) | ✓ | ✓ | S2 | No | Onboarding on those carriers | Yes for those carriers |

## Monitoring / scam detection

| Blocker | Android | iPhone | Sev | Fixed tonight? | Test required | Release blocking? |
|---|---|---|---|---|---|---|
| `/media-stream` unauthenticated (signature shadow-only; crash fixed) | ✓ | ✓ | S2 | No | — | Recommend enforcing before launch |
| OpenAI failure silently stops monitoring (no alert) | ✓ | ✓ | S2 | No | — | Recommend |
| Historical Railway logs may hold transcript text (pre-fix) | ✓ | ✓ | S2 | No | — | Retention decision |

## Dashboard / admin (not priorities tonight)

| Blocker | Android | iPhone | Sev | Fixed tonight? | Test required | Release blocking? |
|---|---|---|---|---|---|---|
| Migration numbering drift (two 055s; 046 unrecorded in prod) | ✓ | ✓ | S2 | No (058 chosen to avoid clashes) | Integration | Yes, at integration |
| Admin delivery panel UI | ✓ | ✓ | S3 | JSON route + spec only | — | No |
| Entitled household without a number (30f01a7a); quarantine never auto-releases | ✓ | ✓ | S2 | No | — | Operational |

## Website / marketing (not priorities tonight)

| Blocker | Android | iPhone | Sev | Fixed tonight? | Test required | Release blocking? |
|---|---|---|---|---|---|---|
| Launch-ready website not deployed; landline must stay "In development" | ✓ | ✓ | S3 | No | — | No |

## What remains between the repository and a technically release-ready Android + iPhone product

1. **Integrate and deploy the backend** (each step needs your approval):
   - `p0/call-delivery-resilience` + `readiness/android-call-delivery` + `fix/process-endpoint-webhook-auth` + `fix/revenuecat-sandbox-environment-guard` + the financial-safety limits;
   - resolve migration numbering; apply 055 and 058 (staging, then production); enable `DELIVERY_PUSH_FAILURE_POLLING` and `CALL_DELIVERY_EVENTS_DB`.
2. **Decide on the locked screen:** accept the FSI tradeoff, file the declaration, or build `ConnectionService`. **Decide Play Billing.**
3. **Build 20 (Android)** from the integrated line (includes the forwarding-number fix). Run P1–P11 on the Motorola plus one Samsung, and reproduce the 30 Sep failure with logcat.
4. **iOS build from the current line:**
   - platform-aware device picker; microphone permission (`expo-audio`);
   - IAP attached in ASC; `IOS_COMING_SOON=false` at launch;
   - physical iPhone test; then submit.
5. **Product decisions:** customer notification or voicemail when unreachable; Terms (price clause, allowance, store billing); transcript-log retention; telemetry retention.
6. **The carrier/economic decision** (trusted-call cost, pricing) is separate and doesn't block technical readiness, except for the spend-limit S1.
