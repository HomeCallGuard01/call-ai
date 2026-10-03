# iOS 1.0.2: App Store listing pack (draft, 1 Oct 2026)

**Status:** draft for Andrew's approval. Nothing here has been entered in App Store Connect.

**Source of wording:** the approved homepage (`website/launch-ready-homepage` `44e2d55`, approved 29 Sep). Every customer-facing line below is taken from it or shortened from it.

**Rules for every field:**
- no price;
- no allowance or minute figure;
- no "30-day" guarantee;
- no "before they reach you";
- no invented statistics;
- no Android mention;
- no landline claim.

The price lives only in the IAP and on the paywall, where StoreKit supplies it. That way the listing stays correct through any price change (see §7 of `IOS_102_RELEASE_PREP_2026-10-01.md`).

## 1. Live listing today (public lookup, 1 Oct 2026)

| Field | Live value |
|---|---|
| Version | 1.0.1, released 28 Sep 2026 |
| Seller | AFMD limited |
| Category / age | Utilities, 4+ |
| Minimum iOS | 15.1 |
| Release note | "Minor update to support App Store subscription availability." |
| Description | Acceptable. No price. Has the EULA link. "Intelligent monitoring of unknown callers" is vaguer than the approved positioning |
| Screenshots | 5 × 1242×2688 raw TestFlight captures (`HCG_AppStore_1–5`). They show £4.99, the withdrawn 30-day guarantee, a sandbox dialog, a TestFlight status bar, and "Stop scam callers before they reach you". **Replace all 5** |
| Subtitle / keywords | Not exposed by the public API. Check them in ASC |

## 2. Proposed fields

| Field | Limit | Proposed | Length |
|---|---|---|---|
| Subtitle | 30 | **Scam call protection** (alternative: "Protection from scam calls") | 20 (26) |
| Keywords | 100 | `scam,scam calls,phone scam,fraud,call protection,trusted contacts,elderly,parents,family,nuisance` | 97 |
| Promotional text (editable without review) | 170 | Call-blocking apps check the number — scammers can fake that. Home Call Guard also checks the conversation while you talk, and can end the call if the risk is serious. | 167 |
| What's New (1.0.2) | 4000 | A refreshed look, simpler set-up on iPhone, clearer protection status and more reliable call delivery. The subscription price is now shown directly from the App Store. | 167 |

**Keywords:**
- "call blocker", "spam" and "caller ID" are left out on purpose. The positioning is "more than blocking", and a blocker-seeking user may expect number blocking.
- Apple already indexes the app name and subtitle, so "home", "guard" and "protection" don't need repeating; "call protection" is kept for phrase matching.
- No competitor names (Guideline 2.3.7).

### Description (replace the live one)

> Scam call protection for your mobile phone.
>
> Call-blocking and caller-ID apps check the number that's calling — and scammers can fake that. Home Call Guard also checks the conversation for signs of a scam while you talk, and can end the call if the risk is serious.
>
> How it works
> • Trusted contacts ring straight through. Calls from people on your trusted list aren't monitored.
> • Calls from people you don't know are checked while you talk — for example, a caller asking you to move money, read out a security code or install software on your phone.
> • If the conversation shows serious signs of a scam, the call can be ended to help protect you.
> • See how every call was handled in your call activity.
>
> Simple to set up
> • Add the people you trust from your contacts.
> • Turn on call forwarding with one tap in the app. We check that your mobile network is supported before you subscribe.
> • Keep your number. No contract — cancel any time.
>
> Made with older adults and their families in mind, Home Call Guard is designed to be calm, simple and reassuring to use.
>
> Your privacy
> Home Call Guard doesn't record your calls. When someone who isn't on your trusted list calls, the conversation is transcribed automatically while it happens, using a third-party service, so it can be checked for signs of a scam. We don't keep that transcript with your account.
>
> Subscription
> Home Call Guard is a monthly auto-renewing subscription that protects one UK mobile number. Payment is charged to your Apple Account at confirmation of purchase. The subscription renews automatically unless cancelled at least 24 hours before the end of the current period. Manage or cancel any time in your Apple Account settings.
>
> Home Call Guard is an assistance and risk-reduction service. It cannot identify or prevent every scam, and you should continue to take care when sharing personal or financial information.
>
> Privacy Policy: https://homecallguard.co.uk/privacy
> Terms of Use (EULA): https://www.apple.com/legal/internet-services/itunes/dev/stdeula/

**To verify before pasting:**
- [ ] The Privacy Policy URL path matches the one set in ASC → App Privacy.
- [ ] If the custom Terms (not Apple's standard EULA) should govern the subscription, link `https://homecallguard.co.uk/terms.html` as well (note `/terms` without `.html` returns 404). Today's listing uses Apple's standard EULA, which is acceptable for 3.1.2.
- [ ] "doesn't record your calls" / "don't keep that transcript": this is the website's 27 Sep evidence-based copy. **Historical pre-fix Railway logs are still OPEN** (privacy finding, fix `bff819e`). The statement is about the present service, the same as on the website.

## 3. The £5.99 question (needs your decision)

The brief asked for "£5.99 membership presentation where applicable". The latest record in the repository says the price is **still undecided**: research commit `89d213c` (1 Oct, 08:35) says "price unchanged and undecided", and the live Apple IAP is £4.99.

So 1.0.2 is prepared **price-agnostic**:
- The iOS paywall shows StoreKit's own `priceString`; the Membership card shows the customer's own price.
- If you approve £5.99 and schedule it in ASC (§7 Phase 2 of the prep doc), 1.0.2 shows £5.99 **with no new build**.
- If the IAP stays at £4.99, 1.0.2 shows £4.99.
- No store field above contains a price, so nothing in the listing needs changing either way.

**Only if you approve £5.99**, the places that carry a literal figure are:
- the website homepage, meta tags and JSON-LD, and the Terms;
- the subscription's App Store **localisation description** (recommended: keep it price-free, "Scam call protection for one mobile number, billed monthly.");
- the ASC price schedule itself. It is irreversible once effective for an increase, and should be scheduled only after 1.0.2 is live, because live 1.0.1 hard-codes £4.99.

## 4. App Privacy ("nutrition label"): points to re-check in ASC

1.0.2 adds **no new data types**:
- the microphone permission is used only for the live call audio, like any phone call, and is not collected;
- call-delivery telemetry is content-free device-readiness state.

Re-confirm the existing answers still cover these:

| Data | Linked to user | Purpose | Note |
|---|---|---|---|
| Email address | Yes | App functionality, account | Sign-up |
| Phone number | Yes | App functionality | Protected number + numbers on the call activity |
| Contacts (names + numbers of chosen trusted contacts only) | Yes | App functionality | Only the contacts the user chooses |
| Purchase history | Yes | App functionality | Subscription state via RevenueCat |
| Other user content: call outcome records (time, number, how handled) | Yes | App functionality | No transcript stored with the account |
| Diagnostics (device call-readiness: permission state, OS version, app version) | Yes | App functionality | **New since 1.0.1 (delivery telemetry).** If "Diagnostics" isn't declared today, add it |
| Audio data | — | — | **Decision for Andrew/legal:** call audio is transcribed in real time by a third party and not retained with the account. Apple's definition excludes data processed only in real time and not retained, **but** the provider's own retention terms apply. Declare it if in doubt |

Tracking: none (no ATT prompt; the IDFA is not used).

## 5. Screenshots

The generator is `marketing/app-store/ios-102/generate_frames.py`. It renders the 6-frame set at **6.9" 1320×2868** and **6.5" 1284×2778**, RGB with no alpha, in the app's own black/green identity (`mobile/lib/theme.ts`, `assets/shield-mark.png`).

| # | Headline | Sub-line | Capture needed (`captures/…`) | State |
|---|---|---|---|---|
| 1 | Scam call protection for your mobile phone | Call-blocking apps check the number — and scammers can fake that. Home Call Guard also checks the conversation. | none | **READY** |
| 2 | Trusted contacts ring straight through | Calls from people on your trusted list aren't monitored. | `02-contacts.png`: Contacts list | placeholder |
| 3 | Anyone else is checked while you talk | If the conversation shows serious signs of a scam, the call can be ended. | `03-call.png`: Activity row(s) showing screened / stopped outcomes, or the Home "how it works" card | placeholder |
| 4 | See how every call was handled | Your recent calls, and what happened to each one. | `04-activity.png`: Activity | placeholder |
| 5 | Set up once, in the app | Add the people you trust, then turn on call forwarding. | `05-forwarding.png`: Set up call forwarding | placeholder |
| 6 | Keep your number | No contract. Cancel any time. | `06-home.png`: Home, "Protected" | placeholder |

**Rules for the captures:**
- Take them from the **1.0.2 TestFlight build on a physical iPhone**, with a real signed-up and activated account. No mocked APIs, no auth bypass.
- Dismiss any sandbox/TestFlight dialogs, and avoid a TestFlight status-bar banner.
- Use example-style names ("Mum", "Dr Patel") and only numbers that are safe to publish.
- Any 19.5:9 iPhone capture works; the generator scales it to fit.
- Frames without a capture are written as `DRAFT-…png`, so a placeholder can't be uploaded by mistake.

Re-run with `python3 marketing/app-store/ios-102/generate_frames.py`.

## 6. App Review notes for 1.0.2 (append to the 9 Sep text)

> **What's new for review in 1.0.2:** an iPhone user can now sign up from scratch in the app: Create account → confirm email → choose "iPhone" → choose their UK mobile network (we check it's supported before payment) → subscribe with In-App Purchase. The price on the Subscribe screen is read from the App Store.
>
> **In-app purchases during review use Apple's sandbox.** They unlock the app, but a real UK forwarding number is only assigned to live purchases, so please use the provided account to see the fully set-up state (trusted contacts, call activity, protection status).
>
> **Microphone:** Home Call Guard connects approved calls with two-way audio through CallKit, so it asks for microphone access during set-up, after a short explanation, rather than in the middle of the first call.
>
> **Call forwarding** is a standard UK network feature. The app opens the Phone app with the network's call-forwarding code filled in; the user taps Call to turn it on, and is given the code to turn it off again.

**Before using the sandbox sentence:** it is only true once `fix/revenuecat-sandbox-environment-guard` (backend + migration 053) is deployed. Without that, a reviewer's sandbox purchase provisions a **real** Twilio number in production. Either deploy the guard first, or delete that sentence and ask reviewers to use only the provided account.
