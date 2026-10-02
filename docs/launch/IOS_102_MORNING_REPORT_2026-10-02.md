# iOS 1.0.2: release-branch report (2 Oct 2026)

**Not done (by instruction):**
- no EAS build;
- no TestFlight upload or App Review submission;
- no App Store Connect, RevenueCat or subscription-price change;
- no production deployment or migration.

The live IAP stays at £4.99, and no price is hard-coded anywhere in the app.

## 1. Branch

| | |
|---|---|
| Branch | `release/ios-1.0.2` (pushed to `origin`) |
| Worktree | `/Users/ad/call-ai-ios-102-release` |
| Version | **1.0.2**. Build number assigned by EAS (remote auto-increment): **15** at the next production build |
| Based on | `readiness/ios-parity` `eab9caa` |

### Commits on the branch (oldest first)

| Commit | What |
|---|---|
| `91e1834` | Merge `feature/ios-102-dynamic-pricing` (StoreKit/Stripe-sourced price, iPhone signup path) into the iOS-parity line (mic permission, iOS-only device card, platform copy) |
| `2cf1003` | Version 1.0.1 → 1.0.2 |
| `9a054b3` | App Store listing pack + screenshot frame generator (frame 1 ready); approval marker on the iPhone-path decision |
| `a30f1b7` | Merge `a1fcede`: Build 19 removal of the manual onboarding test call |
| `829135c` | Merge `db998be`: giffgaff/Three forwarding-number fix (+ base `698bc58`, Android-only EAS Submit track pin) |
| `a3442d9` | iPhone-only Settings forwarding wording (App Review 2.3.10) |
| (this commit) | RevenueCat sandbox risk doc + this report |

## 2. ⚠ Decision awaiting Andrew's approval: iPhone availability / set-up path

Current implementation (`mobile/lib/iphoneAvailability.ts`, marked PROPOSED in the source):
- Inside the iOS app, choosing "iPhone" always continues to the carrier check and Apple purchase.
- The carrier is recorded as a UK mobile line (`deviceType "mobile"`), so the backend `IOS_COMING_SOON` flag (which gates Stripe iPhone signups) doesn't block it.
- Works on today's production backend.
- Trade-off: iPhone households show as `mobile` in admin.

The alternative (flag-gated, `deviceType "iphone"`) is on `readiness/ios-parity` `2f8d31f`. It needs a backend deploy + migration 061 + `IOS_COMING_SOON=false` before any new iPhone user, including an App Reviewer, gets past the picker.

**No further architectural change has been made**, by instruction.

## 3. Forwarding behaviour now implemented (per network)

Read from the merged code (`services/providerPolicy.js` policy `2026-09-19-v4` + the fix). Example HCG number 07700 900123.

| Network | Can pay? | Turn on | Number shown to customer | Turn off |
|---|---|---|---|---|
| **EE** | Yes (pay monthly and PAYG) | One tap opens the Phone app with `**21*07700900123#`; customer taps Call. On iOS, a keypad-fallback hint is shown under the button | "Your Home Call Guard number" box, from the API's `forwardingNumber` | No confirmed cancel code (`unknown`): "We don't have a confirmed call-forwarding removal code for your network yet. Check your phone's native call forwarding settings, or contact support" |
| **O2** | Yes (both tariffs) | `**21*07700900123#`, one tap | Same | `##002#` (medium confidence) |
| **Vodafone** | **Pay monthly only.** PAYG → "not currently supported" (no payment); tariff not given → asked first | `**21*07700900123#`, one tap | Same | `##002#` (high confidence, vodafone.co.uk) |
| **Three** | Yes (both tariffs) | **No dial code** (MMI unreliable on Three). Screen: "Your network needs call forwarding set up through your phone's own settings", then **"Enter this Home Call Guard number: 07700 900123"** + Copy number. **iPhone:** "Open Settings > Apps > Phone > Call Forwarding (on older iPhones: Settings > Phone > Call Forwarding). Turn Call Forwarding on, tap Forward To and enter your Home Call Guard number." Android: the server's Android steps | Yes, from the API field | Settings. iPhone: "…Settings > Apps > Phone > Call Forwarding … turn Call Forwarding off." |
| **giffgaff** | Yes (both tariffs) | Same as Three | Same | Same as Three |

Other changes the fix brings:
- Sky's `#61#` cancel code is withdrawn (61 = no-reply forwarding, not the unconditional 21 HCG sets); Sky cancels via Settings.
- A missing or malformed allocated number never produces a code or a number; the app shows a retryable error.

**Backend dependency:** `forwardingNumber` comes from the backend half of this fix, which is **not deployed**. Against today's production backend:
- EE/O2/Vodafone: the app falls back to reading the number from the dial code (works).
- **giffgaff/Three: the app gets no number, so the customer sees "We couldn't load your Home Call Guard number" (retryable). Safe, but set-up can't finish until the backend fix is deployed.**

## 4. Build 19 onboarding behaviour now incorporated

- Setup-complete screen: no "Test my protection now (optional)" link. Shows the price-free renewal line and "Go to my dashboard".
- Home, `awaiting_confirmation`: "**Protection set up** — We'll confirm automatically when your next call comes through." No test button.
- The 24-hour "Let's check your protection / Check now" reminder card and its timer are removed. Silence is never treated as a fault.
- Home, `delivery_problem`: "**Checking your protection** — A recent call to your protected number didn't come through as expected. Your protection has worked before — this may be a one-off, and we'll keep monitoring automatically." No test-call action.
- Home, `protected`: the "Test my protection" link next to "Last confirmed …" is removed. The iOS line's "Protection status" link (→ protection-status screen) is kept.
- `verify.tsx` is preserved but unlinked from the normal journey. Verification is passive: the first genuine forwarded call stamps activation/delivery server-side.

## 5. RevenueCat sandbox → production risk

Full write-up: `docs/launch/IOS_102_REVENUECAT_SANDBOX_RISK_2026-10-02.md`.

**Risk:**
- Production (`origin/main` `eb43368`) ignores RevenueCat's `environment`.
- Every TestFlight or App Review **sandbox** purchase grants a `paid_subscription` and **buys a real UK Twilio number** on the production account.
- When the sandbox subscription lapses, that number is quarantined and never auto-released.

**Fix (`f5a920e` + migration 053, not deployed):**
- Additive `entitlements.revenuecat_environment` column.
- Fail-closed `resolveEventIsSandbox`: only `PRODUCTION` provisions. Sandbox still grants the entitlement but skips Twilio; revoke is unchanged.
- **Apply 053 before the code**, or every Apple grant fails.
- Smallest safe deploy: `f5a920e` on top of production's `eb43368`, independent of this release line.

Side-effect: sandbox buyers get no number, so review notes should keep reviewers on the provided account for set-up screens.

## 6. What still prevents Build 15

1. **Your approvals:**
   - the iPhone-path decision (§2);
   - the EAS build itself.
2. **Before any TestFlight purchase:** deploy the RevenueCat sandbox guard (053 → `f5a920e`). It's not strictly a build blocker, but required before the TestFlight purchase tests that build would be for.
3. **giffgaff/Three set-up needs the backend half of the forwarding fix in production.** The binary is ready for it; the backend is not deployed.
4. **Migration-number collisions** block any backend deploy from this line: 060/061 (this line vs Claude C's, already applied on staging) and 055 (two branches). They don't affect the iOS binary.
5. **Still unverified on a physical iPhone** (TestFlight matrix, prep doc §11):
   - whether iOS dials the `**21*` tel: link (`APP_DECISION_003` says yes, the 30 Sep parity note says no);
   - incoming calls in all app states;
   - the mic prompt during onboarding;
   - the Settings path wording on iOS 18/26.
6. App Store Connect state unknown to me (no access): the IAP checklist in the prep doc §3, and the "held" submission/IAP state you mentioned.

Not blocking: screenshots 2–6 need real captures from the TestFlight build. Frame 1 is ready at both sizes.

## 7. Tests and checks (final state of the branch)

| Check | Result |
|---|---|
| `npm test`: full root chain, 120 test files incl. pglite migrations, iOS parity, price display, iPhone signup path, forwarding-number API, Settings-copy, Build 19 checks | **4,433 pass, 0 fail** |
| `mobile` `tsc --noEmit` | clean |
| `expo export --platform ios` | OK |
| `expo export --platform android` | OK |
| `expo config` | version 1.0.2, `co.uk.homecallguard.app`, `aps-environment: production`, audio+voip modes, mic purpose string |
| Hard-coded prices in app source (`mobile/app`, `components`, `lib`) | none (not even in comments); `5.99` appears nowhere outside docs/research |

Test environment: dummy, unroutable values only (`SUPABASE_URL=http://127.0.0.1:9`, fake keys). No real service was contacted. Nothing is device-verified.
