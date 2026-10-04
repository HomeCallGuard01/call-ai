# iOS 1.0.2 release preparation (2026-10-05)

**Status: prepared, NOT built or submitted.** Build 16 (staging) passed startup on a real iPhone; its end-to-end staging device test has **not** run. The production candidate is **Build ≥ 17** (EAS `production` profile). Nothing here touches App Store Connect.

## 1. App Store copy: corrected, price-free (paste-ready after Andrew approves)

**Rules:** no price in any field (Apple shows it, and the live IAP is still £4.99); nothing beyond verified product behaviour (`MARKETING_FACTS.md`).

| Field | Text |
|---|---|
| Subtitle (≤30) | `Scam call protection` |
| Promotional text | `Home Call Guard checks calls from unknown numbers while you talk, and your trusted contacts ring straight through.` |
| Keywords | `scam,calls,nuisance,elderly,parents,family,protection,screening,fraud,caller` (drops "spoofed"; see §2 row 4) |

**Description:**

> Home Call Guard adds a layer of protection to calls from numbers you don't know. Scammers can change their numbers, so a list of blocked numbers can't catch every threat. Home Call Guard adds a check to the call itself.
>
> HOW IT WORKS
> • People you trust ring straight through. Their calls connect as normal and are never monitored.
> • Calls from numbers you don't know hear a short message that the number is protected, then connect, and Home Call Guard listens for the signs of a scam while you talk.
> • If there are clear signs of fraud, Home Call Guard can end the call.
> • The app tells you plainly whether your phone is protected, confirmed by real calls, and walks you through setup step by step.
>
> SET UP
> Turn on call forwarding with the step-by-step guide in the app, add your trusted contacts, and keep the app installed and signed in so protected calls can reach you.
>
> MEMBERSHIP
> Home Call Guard is a monthly auto-renewing subscription protecting one UK mobile number. [ALLOWANCE SENTENCE — decision I-3.] Manage or cancel any time in Settings → your name → Subscriptions.
>
> PRIVACY
> Home Call Guard doesn't store call audio or a transcript of what's said. [Legal to confirm.]
>
> No service can identify every scam call. Home Call Guard is an extra layer of protection, not a guarantee.

**What's New:** `A clearer home screen that shows whether your phone is protected, step-by-step setup, a new Membership tab, and easier help.` (The account-number line is only added if migration 062 is live in production when 1.0.2 releases; decision I-6.)

**Review notes additions:**
- The reviewer account will show **FINISH SETTING UP PROTECTION**, because call forwarding can't be completed in Apple's environment.
- "Please use the provided account; do not purchase." Keep the sandbox sentence only once migration 053 (the RevenueCat environment guard) is in production.

## 2. Claims removed or corrected (from the audit)

| # | Was | Now / action |
|---|---|---|
| 1 | Old listing: "stops scams before they reach you", "landline or mobile", "never delayed" (`docs/launch/STORE_LISTING_COPY.md`; may still be live in ASC) | Replaced by §1. **Andrew: check what ASC holds now** |
| 2 | £5.99 in the promo text and description (4 Oct pack) | Removed. Price-free everywhere |
| 3 | "the call is ended" | "can end the call" (only on a red line, while monitoring runs) |
| 4 | "make a call look like it's from someone you trust", keyword "spoofed", frame 02 card "“Your bank” — Number made to look familiar" | A spoof of a **trusted** number rings through unmonitored, so this implied protection HCG doesn't give. Copy fixed. **Frame 02 card: decision I-4** (proposed: `07700 900233 — Another new number`) |
| 5 | Checking is unconditional | There is a monthly allowance. Disclosure wording is decision I-3, and the terms need it too |
| 6 | Frame 04 "No checks, no delays" ("no delays" is banned) | **Fixed in the generator:** "Their calls connect as normal and are never monitored." |
| 7 | "Turn on call forwarding with one tap" | "with the step-by-step guide" (iPhone `**21*` auto-dial is unverified) |
| 8 | What's New account-number line | Only if 062 is live (I-6) |
| 9 | App Home: "Blocked a suspected scam call" (`mobile/app/(tabs)/index.tsx:79`) | Proposed "Screened — high risk, call ended" (matches Activity). **Feature freeze: decision I-10.** Not changed |

## 3. Screenshots: approved 8-frame set (direction kept; only real captures needed)

Generator: `marketing/app-store/ios-102-v2/build_preview.py`.
- Preview: `python3 …/build_preview.py`.
- **Final:** `python3 …/build_preview.py --final` → `final/6.9/` (1320×2868) + `final/6.5/` (1284×2778), RGB, no alpha.
- A missing capture → that frame is written `DRAFT-*` and the run exits 2, so a mock can never be uploaded.
- `captures/` and `final/` are gitignored, because captures may contain real data.

| Frame | Content | Needs a real capture? |
|---|---|---|
| 01 Beyond blocking numbers | artwork | no |
| 02 Scammers change numbers | artwork | no (decision I-4 on one card) |
| 03 Protection as the call develops | Activity screen | **yes**: `captures/03-activity.png` |
| 04 Trusted people ring straight through | artwork (caption fixed) | no |
| 05 Know when you're protected | Home, protected | **yes**: `captures/05-home-protected.png` |
| 06 Simple, step-by-step setup | Home, setup checklist | **yes**: `captures/06-home-setup.png` |
| 07 Choose who you trust | Contacts | **yes**: `captures/07-contacts.png` |
| 08 Brand close | artwork | no |

**Capture checklist (during or after the device test; portrait screenshots straight from the iPhone):**
- [ ] **06-home-setup**: Home showing FINISH SETTING UP PROTECTION, scrolled so the checklist shows (✓ Membership, ✓ number, ○ forwarding…). **Take it before forwarding is verified.**
- [ ] **07-contacts**: Contacts with 4–5 example names on **Ofcom drama numbers only** (07700 900xxx / 01632 960xxx). Remove or rename the real test contact (…2700) first.
- [ ] **03-activity**: Activity after the test calls, including at least one "High risk — call stopped" (T14), "Screened, no concerns" (T11/T13) and "Rang straight through" (T6–T8). The Activity screen shows no numbers.
- [ ] **05-home-protected**: Home showing YOUR PHONE IS PROTECTED, the same day as T14. **Needs a genuinely protected state** (decision I-2: optional T12 forwarding in the staging window, or capture later on Build 17 with a production complimentary account). It will also show the allowance meter (decision I-3). **Never staged or faked.**
- For every capture:
  - no "Test purchase" text;
  - no price;
  - no TestFlight or sandbox dialog;
  - no offline or staging banner;
  - no real customer numbers.

**Then run:** `--final` → upload `final/6.9/*` (and optionally `final/6.5/*`) → delete the 5 live 1242×2688 screenshots, which show £4.99 and the withdrawn 30-day guarantee.

## 4. Build ≥ 17 production-candidate checklist

**Before building**
- [ ] Source = the approved candidate SHA, including `e63377f` (expo-asset pin) and the post-device-test fixes. `tests/mobile-native-sdk-compat.test.mjs` and `tests/mobile-startup-safety-net.test.mjs` are green.
- [ ] Profile **`production`** (never `staging-ios-testflight`). The EAS **production** environment holds:
  - `EXPO_PUBLIC_API_BASE_URL` = the production backend;
  - `EXPO_PUBLIC_SUPABASE_URL`/`ANON_KEY` = production `psbz…`;
  - `EXPO_PUBLIC_REVENUECAT_API_KEY_IOS` = the production public key (if it's missing, purchases are silently disabled).
- [ ] The production backend is **deployed first**. The 1.0.2 app expects the candidate backend: canonical protection fields, account number (062), `/api/v1/billing/offer`.

**After building (before any upload)**
- [ ] Binary check (as for Build 16):
  - Info.plist 1.0.2 (17+);
  - **production** API ×1 and production Supabase ×1, ngrok/staging ×0;
  - `AssetModule` linked;
  - D-C5 wording and "See setup steps" present.
- [ ] `aps-environment` production. The production backend has `TWILIO_VOICE_PUSH_CREDENTIAL_SID_IOS` (production VoIP credential).
- [ ] Production smoke test on TestFlight internal: sign in to a production complimentary account → Home → a trusted call rings (CallKit) → Membership tab.

**App Store Connect (Andrew)**
- [ ] Version 1.0.2; attach the build; **Manual release**.
- [ ] IAP `co.uk.homecallguard.app.monthly` unchanged (price changes only per the price-cutover checklist).
- [ ] Copy from §1; URLs: privacy `/privacy`, support `/support`, terms `/terms.html` (`/terms` 404s).
- [ ] App Privacy label: add Diagnostics if not declared; decision I-8 on Audio data.
- [ ] Reviewer `appreview@homecallguard.co.uk`: re-verify the password and the complimentary entitlement in production.
- [ ] Screenshots from §3.
- [ ] Submit only on Andrew's explicit instruction.

## 5. Decisions for Andrew (iOS)

| # | Decision | Recommendation |
|---|---|---|
| I-1 | Price in metadata | Never (price-free listing survives price changes) |
| I-2 | Frame 05 protected capture | Capture on Build 17 with a production complimentary account after deploy (avoids routing your real calls through staging) |
| I-3 | Allowance disclosure (listing + terms) and the meter in frame 05 | Disclose it plainly; allow the meter in frame 05 |
| I-4 | Frame 02 "“Your bank” — made to look familiar" card | Replace with "07700 900233 — Another new number" |
| I-6 | Is 062 live when 1.0.2 releases? | Yes (it's in the production runbook) → keep the account-number line |
| I-8 | App Privacy "Audio data" | Legal call; lean towards declaring it (third-party real-time transcription, not retained) |
| I-10 | "Blocked a suspected scam call" on Home | Fix in 1.0.2 (one string, matches Activity) |
| I-11 | Live ASC subtitle/keywords | Andrew checks; replace with §1 |
| I-12 | iOS in the first cohort at all | Part of the cohort-channel decision **L-1** in `docs/launch/2026-10-05-CONTROLLED-LAUNCH-RUNBOOK.md`. iOS is the policy-clean in-app channel but depends on Build ≥ 17 clearing review in time; the live IAP is still £4.99 |
