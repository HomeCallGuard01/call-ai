# Apple App Store — assets and listing for iOS 1.0.2 (2026-10-04)

> **STATUS: APPLE STORE IMAGE PREVIEW READY FOR REVIEW. Asset finalisation is STOPPED until Andrew approves the visual direction.**
> Nothing is uploaded to App Store Connect. All UI data in the frames is fake.

## 1. Current Apple requirements (checked 2026-10-04, official sources)

| Requirement | Value | Source |
|---|---|---|
| Required iPhone size | **6.9"** (or 6.5"). 6.9" alone is enough; smaller sizes scale down from it | developer.apple.com/help/app-store-connect/reference/screenshot-specifications |
| 6.9" portrait pixels | 1260×2736, 1290×2796, **1320×2868** | same |
| 6.5" portrait pixels | 1284×2778, 1242×2688 | same |
| iPad | not required (`supportsTablet: false`) | same |
| Count | 1–10 per size | same |
| Format | PNG / JPEG, **no alpha / transparency** | same |
| Colour space | not specified by Apple; we export sRGB | — |
| 2.3.3 | Screenshots must show the app in use; text overlays allowed | developer.apple.com/app-store/review/guidelines/ |
| **2.3.7** | **No prices in name, subtitle, screenshots or previews** | same |
| 2.3.10 | No other platforms' names or imagery ("Android") | same |
| 2.3.9 | Fictional account data only | same |
| 2.3.2 | Make clear what requires purchase (description) | same |
| Text limits | Name 30 · Subtitle 30 · Promotional text 170 · Description 4000 · Keywords **100 bytes** (£ = 2 bytes) · What's New 4000 | developer.apple.com/help/app-store-connect/reference/app-information/… |

**Consequence for the brief.** The proposed Image 8 says "£5.99/month". **Apple 2.3.7 and Google Play's screenshot policy both prohibit price in screenshots.** The preview's final frame therefore carries the brand, "Scam call protection" and "one simple monthly membership — cancel any time", with **no price**. The price belongs in the description and promotional text (§5), and it appears automatically on Apple's own purchase sheet.

Repository requirements are stale. Docs from 1 Oct proposed 6.9" + 6.5". Current rules make 6.9" sufficient, though a 6.5" set may still be supplied.

## 2. Audit of current Apple assets

| Asset | Where | Finding | Action |
|---|---|---|---|
| Live 1.0.1 screenshots (5) | `~/Downloads/HCG_AppStore_1–5_1242x2688.png` (outside repo) | Show **£4.99**; show the pre-1.0.2 UI; 1.0.1-era copy | **Retire** with 1.0.2 |
| 1 Oct Frame 01 (6.9" + 6.5") | `marketing/app-store/ios-102/out/` | Good copy direction; shield bottom point clipped flat by `generate_frames.py` | **Retire.** Superseded by the preview's Frame 01 (full-point master). |
| 1 Oct frames 02–06 | never generated (captures missing) | — | superseded |
| Old Play captures | `docs/launch/google-play-screenshots/` (390×844) | old navy UI, too small | not for Apple |
| App icon | `mobile/assets/icon.png` 1024 | approved shield | keep |

## 3. The preview

**Contact sheet:** `marketing/app-store/ios-102-v2/preview/PREVIEW-contact-sheet.png`
**Frames:** `marketing/app-store/ios-102-v2/preview/PREVIEW-HCG-iOS102-0{1..8}-1320x2868.png` (6.9", RGB, no alpha)
**Generator:** `marketing/app-store/ios-102-v2/build_preview.py`. It builds HTML from the app's `theme.ts` palette and the real shield master, then renders with headless Chrome. Re-run it after any copy change.

The style is the established campaign look, unchanged: near-black, glowing green shield, bold SF headline with a green accent phrase, phone mock-ups of the real screens, and outcome cards (as in the approved Play set). No new identity.

| # | Headline | Supporting line | Visual |
|---|---|---|---|
| 01 | Scam call protection that goes **beyond blocking numbers** | Home Call Guard checks unknown calls while you talk — not just the number they come from. | Large glowing shield; three plain benefits |
| 02 | Scammers **change their numbers** | A block list only stops numbers already known. Scammers switch to new ones — or make a call look like it's from someone you trust. | Number cards: blocked → new number → disguised "Your bank" → "Home Call Guard checks the call itself" |
| 03 | Protection **during the call** | Unknown callers are checked while you talk. If there are clear signs of a scam, Home Call Guard ends the call. | Activity screen + "High risk — call stopped" / "All clear" cards |
| 04 | Trusted people **ring straight through** | Calls from your trusted contacts connect straight away and are never monitored. | Trusted contacts screen + "Mum — rang straight through · not monitored" |
| 05 | Know when **you're protected** | One clear answer on your home screen — confirmed by real calls, not guesswork. | New Home: **YOUR PHONE IS PROTECTED** |
| 06 | Simple, **step-by-step** setup | See exactly what's done and what's next. Each step is ticked only when it's confirmed. | New Home setup state + checklist |
| 07 | Choose who **you trust** | Add family, friends and your GP from your contacts in a few taps. Change them any time. | Trusted contacts list |
| 08 | Home Call **Guard** | Scam call protection · Keep your own number. One simple monthly membership — cancel any time. | Brand close (no price, see §1) |

**Claims check.** Every claim maps to shipped behaviour (support FAQ, `mobile/app/(tabs)/account/support.tsx`).

Avoided:
- "stops every scam", "guaranteed", "before they reach you"
- any competitor name or claim
- any price
- "Android"
- landline
- statistics

Frame 02 states a general fact about number blocking and spoofing, not a claim about any product.

**2.3.3 note.** Six of eight frames show the app in use. Frames 02 and 08 are concept/brand frames. Apple allows overlays, and the majority-in-use mix is common. If Apple objects, Frame 02 can gain a phone mock-up.

**Mock-up honesty.** Frames 03–07 are faithful mock-ups of the 1.0.2 screens on this branch, not device captures. **Before final upload, replace each mock-up with a real capture from the 1.0.2 TestFlight build** (fake test household; status bar 9:41). This is Apple-safe and guarantees the screenshots match the binary.

## 4. Awaiting Andrew

1. **Approve or redirect the visual direction and the 8-frame story.**
2. Confirm dropping the price from Frame 08 (store policy).
3. Choose finals: 6.9" only (sufficient), or also 6.5" (1284×2778).
4. Approve the copy below.

After approval: real TestFlight captures, then 6.9" finals (+6.5" if wanted), then a QA checklist. **No upload by me.**

## 5. Listing copy (draft, not submitted)

Rules carried over from the 1 Oct draft: no allowance figures, no "30-day", no "before they reach you", no Android, no landline. Price appears only in the description and promotional text, and **only once the store price is £5.99** (see the price note at the end of this section).

| Field | Limit | Draft | Length |
|---|---|---|---|
| Name | 30 | Home Call Guard | 15 |
| Subtitle | 30 | **Scam Call Protection** | 20 |
| Promotional text | 170 | Scammers can change or disguise their numbers, so blocking alone isn't enough. Home Call Guard checks unknown calls while you talk. £5.99 a month. | 146 |
| Keywords | 100 bytes | `scam,scam calls,phone scam,fraud,spoofed,call protection,trusted contacts,elderly,parents,family` | 96 bytes |

**What's New in 1.0.2**
> A clearer home screen that tells you exactly whether your phone is protected — and, if it isn't, the one thing to do next.
> • See your setup progress, step by step
> • New Membership tab, with your Home Call Guard account number for support
> • Reconnect this phone in one tap if it isn't receiving protected calls
> • Simpler set-up on iPhone, with the price shown directly from the App Store
> • Reliability and accessibility improvements

**Description**
> Scam call protection that goes beyond blocking known numbers.
>
> Scammers can change their numbers, or make a call look like it's from someone you trust — so a list of blocked numbers can't catch every threat. Home Call Guard adds protection to the call itself: calls from people you don't know are checked while you talk, and if there are clear signs of a scam, the call is ended.
>
> HOW IT WORKS
> • Your trusted contacts ring straight through, and their calls are never monitored.
> • Calls from unknown numbers are put through to you and checked while you talk — for example, a caller asking you to move money, read out a security code or install software.
> • If the conversation shows clear signs of a scam, Home Call Guard ends the call.
> • See how every call was handled in your activity.
>
> KNOW WHEN YOU'RE PROTECTED
> Your home screen tells you plainly whether your phone is protected. If something needs attention — for example, call forwarding needs turning on — it shows you the one thing to do next.
>
> SIMPLE TO SET UP
> • Choose the people you trust from your contacts.
> • Turn on call forwarding with the step-by-step guide. We check your mobile network is supported before you subscribe.
> • Keep your own number. No contract.
>
> Designed with older adults and their families in mind: calm, simple and reassuring.
>
> YOUR PRIVACY
> Home Call Guard doesn't record your calls. When someone who isn't on your trusted list calls, the conversation is transcribed automatically while it happens, using a third-party service, so it can be checked for signs of a scam. We don't keep that transcript with your account.
>
> MEMBERSHIP
> Home Call Guard is £5.99 a month, including VAT — a monthly auto-renewing subscription protecting one UK mobile number. Payment is charged to your Apple Account at confirmation of purchase. The subscription renews automatically unless cancelled at least 24 hours before the end of the current period. Manage or cancel any time in your Apple Account settings.
>
> Home Call Guard is an assistance and risk-reduction service. It can't identify or prevent every scam, so please continue to take care when sharing personal or financial information.
>
> Privacy Policy: https://homecallguard.co.uk/privacy
> Terms of Use (EULA): https://www.apple.com/legal/internet-services/itunes/dev/stdeula/

**Price coordination.** The promotional text and the Membership paragraph name **£5.99**. Paste them **only on the day the App Store subscription price is £5.99**. Until then, use the same text without the amount: promotional text ending "…checks unknown calls while you talk." and "Home Call Guard is a monthly auto-renewing subscription…". The privacy statement and the URL checks from the 1 Oct draft (`docs/launch/IOS_102_STORE_LISTING_2026-10-01.md`) still apply, including the open item on historical pre-fix logs.
