# Google Play — assets and listing for Android 1.0.2 (2026-10-04)

> **STATUS: plan + copy only.** No Play images are produced yet. They follow the Apple direction once Andrew approves it (`2026-10-04-APPLE-STORE-ASSETS.md`), so the two stores share one campaign. Nothing is uploaded. **Play Production is blocked by Play Billing** (see `2026-10-04-MOBILE-1.0.2-PREPARATION.md` §4).

## 1. Current Google Play requirements (checked 2026-10-04, official sources)

| Requirement | Value | Source |
|---|---|---|
| Phone screenshots | 2–8 per device type; JPEG or 24-bit PNG, **no alpha**; each side 320–3840 px; long side ≤ 2× short side | support.google.com/googleplay/android-developer/answer/9866151 |
| For promotion eligibility | ≥ 4 screenshots, ≥ 1080 px, 9:16 portrait (**1080×1920** min) | same |
| Feature graphic | **1024×500**, JPEG / 24-bit PNG, no alpha | same |
| App icon | 512×512, 32-bit PNG, ≤ 1 MB | same |
| **Content** | **No price or promotional information** in screenshots, feature graphic or icon; no ranking/awards/testimonials; no call-to-action ("Download now"); taglines ≤ 20% of the image; show the actual in-app experience | answer/9866151, answer/13393723 |
| Title / short / full | 30 / 80 / 4000 characters; no emoji, no ALL CAPS unless brand, no "Free"/"#1" | answer/9898842, answer/13393723 |
| File-size limit for phone screenshots | **not stated** on the official page (commonly quoted 8 MB is documented only for XR) | — |

## 2. Audit of current Play assets

| Asset | Where | Finding | Action |
|---|---|---|---|
| "Final" Play set 01–08 (1080×1920) | `/Users/ad/call-ai/marketing/play-store/final/` (**untracked**, main checkout; not modified) | 01 says "Stop scam callers **before they reach you**", which is now **banned wording**. 02/04/06/07 use the old tab bar (Activity/Account). 08 shows the `**21*` code. 02 says "You're protected", which is the old hero. | **Retire 01, 02.** Replace all with the new campaign after approval. 03/05 layouts are the model the Apple preview follows. |
| Old captures | `docs/launch/google-play-screenshots/01–05` (390×844, navy UI) | too small, old UI | retire |
| Feature graphic | `docs/launch/play-store-feature-graphic.png` (1024×500) | shield + name + short description; check it carries no "before they reach you" | review after approval |
| Icon | `docs/launch/google-play-app-icon-512*.png` | approved shield | keep |

## 3. Proposed coordinated Play set (after Apple approval)

The same 8 stories as Apple, re-flowed to **1080×1920** (9:16). The Play set is shorter than Apple's 19.5:9, so each phone mock-up sits slightly lower and smaller.

- **Android tab bar and status bar in the mock-ups.**
- Frame 06 may show the network-specific forwarding step.
- No price on any frame (policy).
- No "iPhone" emphasis.

Re-use `marketing/app-store/ios-102-v2/build_preview.py` with a 360×640 CSS canvas ×3.

Feature graphic: shield + "Home Call Guard · Scam call protection" on the campaign background. No price, no CTA.

## 4. Listing copy (draft, not submitted)

**App name (30):** Home Call Guard

**Short description (80):**
> Scam call protection that goes beyond blocking known numbers. (61)

**Full description:**
```
Scam call protection that goes beyond blocking known numbers.

Scammers can change their numbers, or make a call look like it's from someone you trust — so a list of blocked numbers can't catch every threat. Home Call Guard adds protection to the call itself: calls from people you don't know are checked while you talk, and if there are clear signs of a scam, the call is ended.

HOW IT WORKS
• Your trusted contacts ring straight through, and their calls are never monitored.
• Calls from unknown numbers are put through to you and checked while you talk — for example, a caller asking you to move money, read out a security code or install software.
• If the conversation shows clear signs of a scam, Home Call Guard ends the call.
• See how every call was handled in your activity.

KNOW WHEN YOU'RE PROTECTED
Your home screen tells you plainly whether your phone is protected. If something needs attention — for example, call forwarding needs turning on — it shows you the one thing to do next.

SIMPLE TO SET UP
• Choose the people you trust from your contacts.
• Turn on call forwarding with the step-by-step guide for your network. We check your mobile network is supported before you subscribe.
• Keep your own number. No contract.

Designed with older adults and their families in mind: calm, simple and reassuring.

YOUR PRIVACY
Home Call Guard doesn't record your calls. When someone who isn't on your trusted list calls, the conversation is transcribed automatically while it happens, using a third-party service, so it can be checked for signs of a scam. We don't keep that transcript with your account.

MEMBERSHIP
£5.99 a month, including VAT, for one UK mobile number. Cancel any time.

Home Call Guard is an assistance and risk-reduction service. It can't identify or prevent every scam, so please continue to take care when sharing personal or financial information.
```

**Price coordination.** Use the MEMBERSHIP paragraph **only** once the live Stripe Price is £5.99, or the Play Billing product once it exists. Until then, use "A monthly membership for one UK mobile number. Cancel any time." This replaces `docs/launch/STORE_LISTING_COPY.md`'s Play description, which says £4.99 and "Android — available now · iPhone — coming soon".

**What's new (1.0.2):**
> A clearer home screen that tells you exactly whether your phone is protected — and the one thing to do next if it isn't. Step-by-step setup progress, a new Membership tab with your account number for support, one-tap reconnect if this phone isn't receiving protected calls, and reliability and accessibility improvements.

## 5. Awaiting

- Andrew's approval of the Apple direction (which drives this set).
- The Play Billing decision before any Production listing change.
- Andrew's decision on the lock-screen tradeoff or a Play full-screen-intent declaration.
