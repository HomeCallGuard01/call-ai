Document: App Review Information Notes — Resubmission Draft (Guidelines 1.5, 2.1, 2.5.4, 3.1.2, 5.1.1(v))
Status: DRAFT — ready to paste into App Store Connect. Do not submit until Andrew has captured a fresh Build 10 physical-device screen recording (see the shot list below) and reviewed the wording.
Last Updated: 2026-09-09
Owner: Andrew Deane
Supersedes: docs/launch/APP_REVIEW_RESUBMISSION_2026-08-23.md (written for an earlier, since-superseded build — kept as historical record, not to be reused for this submission)

---

# Context

Apple rejected the 2026-09-07 submission (ca196b7b-859e-4df3-a1ca-de63f4b6805c, Version 1.0 (8)) across five areas: Support URL (1.5), demo account login (2.1), VoIP background mode (2.5.4), audio background mode (2.5.4), and Terms of Use/EULA link visibility (3.1.2). All five have since been addressed and verified:

- **Support URL** — `/support` now resolves live (PR #23, deployed).
- **Reviewer login** — password reset and verified via a real production sign-in (confirmed by the account's own `last_sign_in_at`, 2026-09-08).
- **VoIP background mode** — genuinely required and now physically proven working end-to-end on a real device: open/unlocked, locked, and a force-closed cold-launch resilience test (app fully closed, phone locked, ~1 minute wait, then a real incoming call) — all successful, no crash.
- **Audio background mode** — confirmed required alongside `voip` for this exact Twilio Voice SDK integration (matches Twilio's own official React Native reference app's declared background modes).
- **Terms/EULA** — Terms of Use and Privacy Policy now link directly from the subscription screen (PR #22, merged into `sandbox/mobile-app-v1`), not just from Account → Legal.

This is the target build for resubmission:

- **EAS build ID**: `ed2e8abb-6867-4e3f-8e96-74e7412bc59b`
- **Version / build number**: 1.0.0 (10)
- **Source commit**: `485e06eaef3a5af6a8e6effdcb4e9d7f4140af2b` (`sandbox/mobile-app-v1`)
- **TestFlight status**: uploaded, processed (`VALID`), available for internal testing, not yet submitted for App Review

---

# 1. Sign-in information (App Store Connect's dedicated fields)

**Sign-in required**: Yes

**Username**: `appreview@homecallguard.co.uk`
**Password**: already set in App Store Connect's own Password field (reset and verified working directly against production — not repeated here, consistent with this doc's own precedent of never letting a live credential sit in git history).

This account (`households.id = ccae29b4-bbf1-4469-837d-1b81236e9f01`) carries an active complimentary entitlement — the reviewer lands straight in the fully-entitled app state, no payment screen, no card required.

**Known, unavoidable gap**: this reviewer household has never completed real phone-forwarding activation (no UK phone line to forward from) — the setup screens (device/provider picker, activation code display) are fully navigable and safe to show in a recording, but the carrier-side "dial this code to forward your phone" step cannot be completed by Apple's reviewer. This is why the supplied screen recording (see below) demonstrates the live call-delivery flow on an already-fully-set-up device rather than relying on the reviewer account alone for that specific step.

---

# 2. App Review Notes field — exact text to paste

> Home Call Guard protects UK telephone users from potentially fraudulent and scam phone calls.
>
> Please sign in using the reviewer account credentials already provided in App Store Connect.
>
> How the service works: a customer subscribes, then sets up call forwarding from their own existing UK telephone number to Home Call Guard. Once forwarding is active, an incoming call from an unrecognised number is answered and screened by Home Call Guard first; an approved call is then delivered directly to the customer's own iPhone through this app, so their phone rings and they can answer and speak normally. The app uses the microphone and VoIP calling functionality to provide this two-way audio experience, the same as a standard phone call. Calls from the customer's own trusted contacts are never screened — they always ring straight through untouched.
>
> Because this service depends on forwarding a genuine UK telephone number, the complete live call-forwarding flow cannot necessarily be reproduced end-to-end using the reviewer account alone within Apple's review environment. The supplied physical-device screen recording demonstrates this full flow, including a real incoming call being delivered to and answered on the customer's iPhone.
>
> Where to find things in the app:
> - Manage Subscription / Restore Purchases: Account → Membership
> - Delete Account: Account → Delete Account
> - Support: Account → Support (also https://www.homecallguard.co.uk/support)
> - Privacy Policy and Terms of Use: linked directly on the subscription screen, and at Account → Legal
>
> Thank you for reviewing Home Call Guard.

Deliberately excludes: internal architecture, Twilio/push credentials, database implementation, fraud-detection internals, and development/incident history — none of that is reviewer-relevant.

---

# 3. Shot list for the Build 10 physical-device screen recording — NOT YET CAPTURED

The only recording referenced anywhere in this repo (2026-08-23) was for a much earlier, since-superseded build and should not be reused. One continuous take, real iPhone, no cuts:

1. **Sign in** — reviewer credentials, or a fully-set-up test account if that demonstrates the "protected" state more clearly.
2. **Home screen** — showing the genuine "You're protected" state (not "Almost there").
3. **Account → Legal** — Terms of Use and Privacy Policy links.
4. **Account → Support**.
5. **Account → Membership** — Restore Purchases and Manage Subscription entry points.
6. **Account → Delete Account** — show the screen and its confirmation step exists; no need to actually delete anything on camera.
7. **The proof point** — from the lock screen (not from inside the app), a real incoming call triggered on this device, the native CallKit incoming-call screen appearing with Home Call Guard's name/branding, answering it, a few seconds of visibly-live two-way audio.

Keep it under ~3 minutes.

---

# 4. Still needed before this can be submitted

1. Capture the Build 10 screen recording above (physical device).
2. Andrew's final read-through of the Notes text in section 2.
3. Paste sign-in fields + Notes into App Store Connect.
4. Submit for App Review.

None of the above has been done by this session — this document is preparation only.
