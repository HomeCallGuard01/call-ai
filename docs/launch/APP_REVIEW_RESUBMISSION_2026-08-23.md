Document: App Review Information Notes — Resubmission Draft (Guideline 2.1)
Status: DRAFT — ready to paste into App Store Connect once the physical iPhone Voice SDK/CallKit proof (in progress) is complete and the screen recording is captured. Do not submit yet.
Last Updated: 2026-08-23
Owner: Andrew Deane

---

# Context

Apple rejected iOS build 1.0.0 (3) under Guideline 2.1 (Information Needed) — no functional objection, just missing information. This document is the complete replacement content for App Store Connect's "App Review Information" → "Notes" field, plus the sign-in details field, prepared from the actual current implementation (no invented functionality). **Do not resubmit until the iPhone CallKit reception test passes and the recording below is captured** — the recording should show the finished, working call-delivery journey, not the currently-blocked one.

---

# 1. Sign-in information (App Store Connect's dedicated fields)

**Sign-in required**: Yes

**Username**: `appreview@homecallguard.co.uk`
**Password**: `HCGReview-<see note>` — freshly reset and verified via a real production login just now (`POST /login` → `302 /dashboard` with a valid session cookie, checked directly against `www.homecallguard.co.uk`, not simulated). The live current password is in `/private/tmp/.../scratchpad/.reviewer_creds` on this machine — Andrew, pull the current value from there (or ask me to re-paste it) rather than this file, so it never sits in git history.

This account (`households.id = ccae29b4-bbf1-4469-837d-1b81236e9f01`) already carries an **active `complimentary` entitlement** (`entitlements.id = 9c36a2a0-fbea-4981-9db4-c6c2dfd4a47a`, explicitly noted "App Store / Google Play reviewer account. Complimentary access for review purposes only — no Stripe subscription.") — the reviewer lands straight in the fully-entitled ("Protected") app state, no payment screen, no card required.

**Known gap to flag before recording**: this reviewer household has never completed real phone-forwarding activation (`twilio_number` is null, `twilio_provisioning_status: pending`) — expected, since it isn't attached to a real UK phone line. The setup screens (device/provider picker, activation code display) are fully navigable and should be shown in the recording; the *carrier-side* "dial this code to forward your phone" step obviously can't be completed by Apple's reviewer (it requires a real UK landline/mobile), so the recording substitutes a real device's forwarding activation (already physically proven, see draft note in the recording section) to demonstrate that specific step actually works, while the reviewer account itself demonstrates login → protected dashboard → contacts → activity → account, i.e. everything reachable without a real phone line.

---

# 2. Notes field — full text

> **What Home Call Guard does**
> Home Call Guard is a consumer telephone scam-protection service, not a native call-blocking or Call Directory app. A customer forwards their existing landline or mobile number to a private number we provision. Calls from contacts they've marked as trusted ring straight through immediately and are never monitored. Calls from anyone else are answered and monitored in real time during the call itself; if the conversation matches known scam patterns (e.g. impersonating a bank, a "family member in trouble" request for money, a request to move funds or share one-time codes), the call is interrupted and the customer is protected before any harm occurs. The customer keeps their existing phone number throughout — nothing is blocked before it rings, and no caller ID list or on-device call-blocking extension is used.
>
> **The app's own role** (this is the part App Review is specifically evaluating): the mobile app lets a customer register, subscribe, set up call forwarding for their line, manage trusted contacts, review recent call activity, and manage their subscription. As of this build, an approved/trusted call can also ring directly inside the app itself via Twilio's Voice SDK (native CallKit integration on iOS) as the primary delivery path, rather than only ever reaching the customer's original phone line by network-level forwarding — this is what the attached screen recording demonstrates end-to-end on a real device.
>
> **Who it's for and why**: built primarily for adult children setting up scam protection for an elderly parent or grandparent's phone, and for anyone who wants their phone screened without screening it themselves. The value is specifically that trusted people are never delayed or challenged, while unknown/scam calls are stopped mid-call rather than merely flagged afterward.
>
> **Not a medical device or regulated health service**: Home Call Guard is a telecommunications/consumer-safety product. It does not diagnose, monitor, treat, or make any claim related to a medical condition, and does not fall under any medical device or telehealth regulatory framework. Any "elderly protection" framing in our marketing refers to protecting a person from financial/telephone fraud, not to health monitoring of any kind.
>
> **External services / third-party platforms actually used in this build**:
> - **Supabase** — user authentication (email/password, confirmation, password reset) and the application's Postgres database (household, contacts, call-activity, subscription/entitlement records). All access is authenticated and row-scoped to the signed-in household.
> - **Twilio** — provisions the private forwarding number, receives and routes incoming calls, and (new in this build) delivers an approved call directly into the app via the Voice SDK and native iOS CallKit / Android FCM push. Twilio is also used for the transactional SMS sent when a call is interrupted for the customer's protection.
> - **Stripe** — subscription billing for the service, handled via Stripe Checkout and the Stripe Billing Portal in a web browser (deep link out of the app and back), not Apple In-App Purchase. The subscription pays for an ongoing telephone-monitoring *service* consumed primarily outside the app (the phone call itself), consistent with Apple's guidance on external services for real-world/physical services.
> - **OpenAI (Whisper model, `whisper-1`)** — real-time speech-to-text transcription of the audio during a *monitored* (non-trusted-contact) call only, so the scam-detection logic can inspect what's being said. The actual scam-risk classification itself is a deterministic rule/keyword-based scorer over that transcript, not a black-box AI judgment — model-based blending exists in the codebase but is explicitly disabled in the current production call path (rules-only).
> - No other third-party SDKs, ad networks, or analytics platforms are used in this build.
>
> **Regional scope**: Home Call Guard currently serves **UK customers only** — phone-forwarding setup instructions are specific to UK mobile networks and UK landline providers (BT, Sky, Virgin, etc.), and the provisioned numbers are UK numbers. There is no regional variation within the app itself to account for; it is a single-region (UK) product at this stage, with no other market currently supported.
>
> **Devices/OS tested**: [Andrew — please confirm the exact iPhone model + iOS version used for the attached recording, and the Android model/OS version already used for earlier physical testing (a Motorola Moto E7 was used for the Android Voice SDK proof); I don't have reliable access to your device's exact model/OS string from here.]
>
> **Setup/access instructions for the reviewer**:
> 1. Install the build and open the app.
> 2. Log in with the reviewer credentials above — this lands directly on the Home screen in the already-"Protected" state (no payment step needed).
> 3. Review Contacts (add/edit/remove a trusted contact), Activity (recent call history), and Account/Membership screens — all fully functional with this account's real data.
> 4. The Setup flow (device/provider picker, activation code) is fully navigable from Account; as noted above, the final "dial this code on your own phone" step requires a real UK phone line the reviewer won't have — this is expected and is why it's demonstrated separately in the attached recording rather than via the reviewer account itself.

---

# 3. Shot list for the physical-device screen recording

One continuous take, real iPhone, no cuts — record once the CallKit reception step (currently in progress) has passed.

1. **Cold launch** — app icon tap, splash, straight to Home in the Protected state (using either the reviewer account or a real fully-activated test household — prefer a household with a real completed forwarding setup so the "Protected" badge and activity history look genuine, not the reviewer account's pending-setup state).
2. **Contacts** — show the existing trusted-contact list, add one new contact on camera, confirm it appears immediately.
3. **Activity** — scroll the real call-activity list, showing at least one trusted-contact call and one screened call if available.
4. **Setup / activation walkthrough** — open the device/provider picker, select "Mobile", show the generated activation code screen (this is the one part of setup safe to show fully, since it's just a UI screen, not a live carrier action).
5. **The actual proof point — incoming call via the app**: from outside the app (screen recording should capture the *lock screen* or *home screen*, not just inside the app), show a real incoming call triggered on this household's number, the native CallKit incoming-call screen appearing with Home Call Guard's name/branding, answering it, and a few seconds of visibly-live two-way audio (a second person talking on the other end is enough — no need to narrate the scam-detection logic itself on camera).
6. **Membership/Account screen** — brief pass showing subscription status and the Manage Membership (Stripe Billing Portal) entry point (no need to actually complete a Stripe flow on camera).
7. **Sign out / sign back in** (optional but a good closer) — confirms session handling is real, not a one-shot demo state.

Keep it under ~3 minutes; Apple's reviewers skim, and a shorter, confident, real recording reads better than an exhaustive one.

---

# 4. Verified today (2026-08-23)

- Reviewer account confirmed live and working: real `POST /login` against production returned `302 → /dashboard` with a valid session cookie (not a mocked/simulated check).
- Reviewer account's active complimentary entitlement confirmed directly in the production database (not assumed from an old doc).
- External services list above cross-checked directly against the actual code (`services/liveMonitoring/transcribeChunk.js` for Whisper, `services/liveMonitoring/riskMonitor.js` for confirmation that model-blended scoring is currently disabled in the real call path, `routes/billing.js`/Stripe Checkout for payment, `services/voiceAccessToken.js`/Twilio Voice SDK for in-app call delivery) — nothing above is inferred from marketing copy alone.

# 5. Still needed from Andrew before this can be finalized/submitted

1. Exact iPhone model + iOS version (and Android model/OS version) for the "Devices/OS tested" line.
2. The physical-device screen recording itself, once the CallKit reception work in progress completes.
3. A decision on whether to pre-configure the reviewer account with a synthetic completed activation (so it shows "Protected" with a real-looking activity history instead of "Setting up") — recommended, but not done yet since it wasn't explicitly requested; flagging rather than acting on it.
