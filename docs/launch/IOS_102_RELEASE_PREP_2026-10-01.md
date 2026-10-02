# iOS 1.0.2: release preparation (overnight 30 Sep → 1 Oct 2026)

**Ownership:** Apple / iOS commercial release preparation.
- Pricing and financial containment: Claude A.
- Mobile technical reliability: Claude B.
- Supabase security: Claude C.

**Nothing was built, submitted, deployed, priced or bought.**
- No App Store Connect, Stripe or Google Play setting was touched.
- No production data was read or changed.
- `IOS_COMING_SOON` was not changed.

**The price is not final.** Claude A is modelling several price points against a ~40% contribution-margin requirement. Nothing in this document or the code assumes a figure; `[PRICE]` means "the price Andrew approves".

**Branch:** `feature/ios-102-dynamic-pricing`
- Worktree: `/Users/ad/call-ai-ios-dynamic-pricing`.
- Based on `readiness/android-call-delivery` `9535f5d`.
- Local only, not pushed.
- Commits:
  - `6d4b087` dynamic pricing (+ timeout fix, see git log)
  - `feeeb38` iPhone signup path in the iOS app
  - this document plus `TERMS_BILLING_DRAFT_2026-10-01.md`

**Corrections to my 30 Sep audit** (`docs/price-599-release-audit` `24cb3c3`):
1. £5.99 is **not** approved. The audit's "£5.99" figures are superseded by the price-agnostic procedure in §7.
2. The audit said iOS can't dial `**21*` codes. **That was wrong.** `docs/mobile-app/APP_DECISION_003_activation_strategy.md` records a real-iPhone test (23 Aug): the `tel:` link opens the Phone app with the code pre-filled, and one tap on Call activates forwarding. iOS uses the same one-tap activation as Android.

---

## 1. Exact iOS 1.0.2 scope

**Base: the modern app line, not Build 14.**
- Build 14 (`1f24483`, live 1.0.1) is 25+ mobile commits behind.
- It still contains the withdrawn 30-day money-back guarantee and hard-coded £4.99.

### In scope

| Area | What 1.0.2 gets | Source |
|---|---|---|
| Brand/UI | Black/green UI, splash, icon | on main (`ce0a940`) |
| Copy | 30-day guarantee **removed** everywhere; "Scam call protection"; landline "Coming soon" / "exploring" | on main (`730f7ea`, `871f6a4`, `526cc69`) |
| Onboarding | Carrier-compatibility gate before payment; recorded Terms acceptance; protection-status checklist; delivery-confirmed verify; optional test call | on main + `p0` |
| Call delivery | Evidence-based delivery health; invite child-SID fix; sign-out unregister; wrong-household guard; foreground re-registration; device readiness + telemetry | `p0/call-delivery-resilience`, `readiness/android-call-delivery` |
| Build 19 UX | Manual test-call UX removed from normal onboarding | `a1fcede` (**not yet on the readiness line**) |
| Carriers | giffgaff/Three forwarding number shown ("Enter this Home Call Guard number") | forwarding-number fix, **uncommitted** in `/Users/ad/call-ai-forwarding-number` |
| **Pricing** | **iOS shows StoreKit's own price; no amount hard-coded anywhere; Membership shows the customer's own price** | **this branch `6d4b087`** |
| **iPhone path** | **iPhone card is the normal signup path inside the iOS app** (no "Coming soon" dead end) | **this branch `feeeb38`** |
| Microphone | Ask for microphone permission during onboarding (today it is first requested mid-call) | **Claude B**, not started; needs a native dependency (`expo-audio` or equivalent) |
| Version | `mobile/app.config.js` `version` 1.0.1 → **1.0.2** (shared with Android `versionName`; EAS remote build number auto-increments to 15) | at build time |

### Excluded from 1.0.2

| Item | Why |
|---|---|
| `research/telephony-trusted-bypass`, busy-divert / conditional-forwarding experiments, landline POC | Android/experimental; not validated (E1/E2 not run) |
| Play Billing | Android-only |
| `USE_FULL_SCREEN_INTENT` / lock-screen notification work | Android-only (already on the line and harmless on iOS) |
| `feature/play-install-referrer-attribution` | Android attribution, not iOS; include only if Build 20 includes it (neutral for iOS) |
| Financial-safety client UI (allowance display, notifications) | **Waiting for Claude A.** Don't include placeholder values |
| Any allowance / limit copy | Waiting for Claude A |
| Voice provider portability, admin control centre | Not customer-facing / not ready |

### Android non-regression

Both of my commits keep Android behaviour identical except for where the price text comes from:
- Android's iPhone card still says "iPhone — Coming soon".
- Android pricing still charges through Stripe, and still shows the amount when the server can read the Stripe Price.

Proven by:
- `npm test`: 4,199 pass, 0 fail;
- `tsc`: clean;
- `expo export`: iOS and Android both OK.

## 2. Required code / commit integration

Integration belongs to **Claude B's** release line. I haven't modified B's branches.

Trial merges in a throwaway worktree (since removed) show my two commits merge cleanly with:
- `release/android-consolidated`
- `fix/revenuecat-sandbox-environment-guard`
- `fix/process-endpoint-webhook-auth`
- `feature/financial-safety-hard-limits`
- `website/launch-ready-homepage`
- `feature/play-install-referrer-attribution`

The only overlap is the shared `package.json` `test` line (append both).

**Conflicts that already exist, unrelated to my commits, for Claude B:**
- `readiness/android-call-delivery` + `release/android-consolidated` (`a1fcede`) conflict in `mobile/app/(tabs)/index.tsx`: the Home readiness banner vs the removed test-call UX.
- `readiness` + `feature/financial-safety-hard-limits` conflict in `server.js` (delivery telemetry vs call admission in `/voice`).

**Recommended merge order** (each step: `npm test` + `tsc` + `expo export` both platforms):
1. `readiness/android-call-delivery` (base; contains main, `p0`, the lock-screen fix)
2. `release/android-consolidated` (`a1fcede`, `698bc58`): resolve `index.tsx`
3. The forwarding-number fix, committed first by its owner
4. `fix/revenuecat-sandbox-environment-guard` `f5a920e` (migration **053**; check numbering with Claude C)
5. `fix/process-endpoint-webhook-auth` `e2895f1`
6. **`feature/ios-102-dynamic-pricing` `6d4b087` + `feeeb38`** (this branch)
7. Microphone-permission work (Claude B)
8. Financial-safety work, only when Claude A says so (resolve `server.js`)
9. Version bump to 1.0.2

**Backend and app are independent of each other:**
- **New app on old backend:** the Android app calls `GET /api/v1/billing/offer` → 404 → shows no amount ("You'll see the monthly price, including VAT, before you pay") and still checks out through Stripe, which shows the real amount. iOS doesn't call it.
- **Old apps (Build 14 / 19) on the new backend:** everything works. Their Membership card shows the new per-customer label: the customer's own Stripe price; "Billed monthly by Apple…" for Apple subscribers; "No charge…" for complimentary accounts (today it wrongly shows "£4.99" to complimentary accounts, including the App Review account).

## 3. App Store Connect / IAP checklist (for Andrew to verify)

What I know: the live App Store page shows the in-app purchase "Home Call Guard £4.99", so the subscription is **approved and on sale**. Everything else needs your eyes in ASC (I have no ASC access and didn't use the API key in Downloads).

### A. Agreements, tax, banking (Business → Agreements)
- [ ] **Paid Apps Agreement: Active** (required for IAP; it must already be, since the IAP is on sale).
- [ ] Tax forms complete (UK); banking account verified.
- [ ] If Small Business Program enrolment is intended: enrolled (15% vs 30% commission; affects Claude A's margins).

### B. Subscription group (App → Monetization → Subscriptions)
- [ ] Group exists and holds exactly one subscription.
- [ ] Group reference name recorded here: `__________`.
- [ ] Group localisation (en-GB): display name, e.g. "Home Call Guard".
- [ ] App name display: "Use App Name" or custom.

### C. Subscription product
- [ ] Product ID = **`co.uk.homecallguard.app.monthly`**. It must match `mobile/lib/purchases.ts` `EXPECTED_APPLE_PRODUCT_ID`; RevenueCat package `$rc_monthly` in the **default/current offering**; entitlement **`hcg_protected`**.
- [ ] Duration: **1 month**. The app now refuses to show "/month" for any other duration.
- [ ] **Introductory offers / free trials: NONE.** 1.0.2 deliberately shows no amount if an intro offer exists (it can't describe one yet), and an iOS purchase can't start until a price is shown.
- [ ] Status: **Approved / Ready for Sale**.
- [ ] Availability: United Kingdom only (or as intended).
- [ ] Price: current UK price (expected £4.99). **Do not change tonight.** See §7 for the procedure.
- [ ] Family Sharing: record on/off. Off is recommended: one subscription protects one phone number.
- [ ] Localisation (en-GB):
  - display name;
  - description.
  - The description must contain **no price and no allowance figure** until Claude A decides. Suggested: "Scam call protection for one mobile number, billed monthly."
- [ ] Review information: screenshot of the paywall (the 1.0.2 Subscribe screen, taken from a TestFlight build) and review notes. Only needed if Apple asks, or the metadata changes; changing metadata sends the IAP back for review.

### D. App-level requirements for a subscription app
- [ ] The description (or EULA field) links Terms of Use. The live description already includes Apple's standard EULA link.
- [ ] Privacy Policy URL set.
- [ ] App Privacy answers still accurate (1.0.2 adds no new data types; delivery telemetry is content-free).
- [ ] In the app (already implemented):
  - title "Home Call Guard Standard";
  - length "/month";
  - price from StoreKit;
  - Terms and Privacy links on the Subscribe screen;
  - "Restore purchases" (Account → Membership);
  - "Manage subscription" → Apple subscriptions;
  - in-app account deletion.

### E. RevenueCat (dashboard)
- [ ] App Store app configured with the **In-App Purchase Key (StoreKit 2)** or the App-Specific Shared Secret.
- [ ] App Store Server Notifications URL → RevenueCat.
- [ ] The webhook to our backend (`POST /api/v1/billing/apple/revenuecat-webhook`) is enabled, with its authorisation header set.
- [ ] Default offering → `$rc_monthly` → `co.uk.homecallguard.app.monthly`.
- [ ] The EAS production env holds `EXPO_PUBLIC_REVENUECAT_API_KEY_IOS` (public key).

### F. Sandbox testing
- [ ] ASC → Users and Access → Sandbox → a sandbox tester exists (a UK storefront email not used for a real Apple ID).
- [ ] **Before any TestFlight purchase test: deploy `fix/revenuecat-sandbox-environment-guard` (backend + migration 053).** Until then, every sandbox/TestFlight purchase provisions a **real** Twilio number in production. This is a cost leak.
- [ ] With the guard deployed, a sandbox purchase unlocks the app but gets **no real number**, so activation can't complete for that household. Expected; test activation with a real (non-sandbox) account.

### G. Review submission sequence
1. Integration build passes the tests; Andrew approves the EAS iOS build.
2. `eas build --platform ios --profile production` produces build 15 (1.0.2).
3. `eas submit --platform ios --id <build>` uploads it to TestFlight. Needs Andrew's approval; it's an upload, not a review submission.
4. TestFlight internal testing, §11 matrix.
5. ASC: create version **1.0.2**; attach build 15. Fill in:
   - What's New (§6);
   - screenshots (§6);
   - description / promotional text (§6);
   - review notes (below);
   - sign-in details: reviewer account `ccae29b4…`, complimentary; confirm the password still works (the 2.1 history).
6. The subscription is already approved, so it **does not** need to be added to this submission. Only new or changed IAPs go with a version.
7. Version release: **"Manually release this version"**, so the release can be coordinated with the backend, website and price (§7).
8. Submit for review.

**Review-notes addition for 1.0.2** (append to the 9 Sep text):
> In-app subscription purchases made during review use Apple's sandbox. They unlock the app, but a real UK forwarding number is only assigned to live purchases, so please use the provided account to see the fully set-up state. The subscription price shown in the app is read from the App Store.

## 4. Dynamic pricing: implementation status

**Done, on this branch (`6d4b087`):**

| Channel | Source of truth | Where it is shown | If unavailable |
|---|---|---|---|
| **Apple (iOS)** | StoreKit product (`pkg.product.priceString`, currency, `P1M` period) for the exact package the app then buys | Subscribe price line + button | No amount; the button is disabled with "We couldn't load the subscription price… Try again" (a purchase is impossible without the product anyway) |
| **Stripe (Android)** | Server: the Stripe Price `STRIPE_PRICE_ID` points at → `GET /api/v1/billing/offer` | Subscribe price line + button | "You'll see the monthly price, including VAT, before you pay"; the button says "Subscribe & pay now" (still states the obligation to pay, CCR 2013 reg. 14(3)); Stripe Checkout shows the real amount |
| **Stripe (web)** | The same, via `GET /billing/offer` (session auth) | `upload.html` price note + button | Same as Android |
| **Stripe Checkout page** | Stripe itself | Stripe's own amount | `custom_text` is now price-agnostic ("the amount shown on this page… the same amount every month") |
| **Membership card (app + web)** | **The customer's own** `subscriptions.stripe_price_id` → Stripe Price | `membership.priceLabel` | "Billed monthly. Your price is shown under Manage membership." |
| Apple subscriber's card | No per-customer Apple price is stored | — | "Billed monthly by Apple. Your price is shown in your Apple subscription settings." |
| Complimentary / trial / staff | — | — | "No charge…" (today it wrongly says £4.99) |

Safety rules in `services/subscriptionPricing.js`:
- It describes only a Price that is `gbp`, `month`, `interval_count 1` and **`tax_behavior: "inclusive"`**; anything else shows no amount.
- Reads are cached per Price ID (Prices are immutable); failures are never cached; there is no fallback figure.

`mobile/lib/subscriptionPrice.ts`:
- It validates the server string format.
- It makes no VAT claim for a non-GBP storefront.
- If an intro offer exists, it shows no amount.

Tests: `tests/subscription-price-display.test.mjs` (mutation-checked: 7 regressions each caught). Four existing copy tests now assert the legal properties (VAT wording, recurring wording, pay-obligation button) without a pinned amount.

**Not done (listed, not changed):**
- **Website marketing pages** are static HTML with literal prices: homepage (launch-ready branch), 12 guides, `terms.html`, meta/OG/JSON-LD. They change with the price decision (§7, step W). Recommendation: remove the amount from the 12 guide CTAs, so only the homepage and Terms carry the figure.
- **Admin:** `routes/adminBusiness.js:121` falls back to `4.99` and estimates Apple revenue at the *Stripe* price. It is internal-only, but becomes wrong once Apple and Stripe prices differ or a customer is grandfathered. It's also on the financial-safety branch, so it's left for Claude A / the admin owner (see §7, step A).
- **Apple per-customer price:** needs either a column fed from the RevenueCat webhook (`price_in_purchased_currency`, `currency`), which is a migration for Claude C, or a RevenueCat REST lookup. The label above is honest without it.
- **Before relying on this in production:** confirm the production Stripe Price's `tax_behavior` is `inclusive`. The 20 Sep code comment says it was made VAT-inclusive, but I couldn't read production Stripe (blocked as a production read). If it isn't, the app and web show **no amount** (safe, but visible).

## 5. iPhone onboarding: journey audit and blockers

| Stage | Current line (with this branch) | Status | Owner |
|---|---|---|---|
| Account creation | Register → confirm email → `confirmed.html` → `/confirm-session` handoff. Platform-agnostic | Ready. One unexplained real-world failure on record, not reproduced | — |
| Setup welcome | 3 steps, no amount | Ready | — |
| Device picker | **Was a blocker** ("iPhone — Coming soon" dead end). **Fixed on this branch:** the iOS app treats the iPhone card as the path → carrier check (recorded as a mobile line) | Fixed, needs a device test | me (done) |
| Carrier check | Same as Android; giffgaff/Three are `native_settings` (Settings → Phone → Call Forwarding) | Ready except giffgaff/Three number display | forwarding-fix owner |
| Subscription | Terms + immediate-start consent → Terms record → carrier re-check → StoreKit sheet (price from StoreKit) → RevenueCat webhook → entitlement → number provisioned (production purchases only, once the guard is deployed) | Ready in code; needs a sandbox + real purchase test | me (pricing) / Andrew (ASC) |
| Permissions: contacts | iOS picker incl. Limited Access, purpose string compliant (Build 10 fix) | Ready | — |
| **Permissions: microphone** | **Never requested before the first call.** The first answered call raises the iOS prompt mid-call (possibly from the lock screen); until granted, the caller hears silence | **BLOCKER** | **Claude B** (`expo-audio` + onboarding explainer, no "Allow" pre-button per 5.1.1(iv)) |
| Permissions: notifications | Not needed (PushKit → CallKit) | OK | — |
| Trusted contacts | Sync / choose / add manually | Ready | — |
| Forwarding setup | One-tap `tel:` with the code pre-filled + Call (confirmed on a real iPhone 23 Aug); copy-code fallback; undo code shown | Ready; giffgaff/Three need the forwarding-number fix | forwarding-fix owner |
| Activation verification | Automatic on the first forwarded call; optional test call | Ready | — |
| Home screen | 5-step protection checklist; iOS readiness reports `microphone: unknown`, so no false "can't ring" banner | Ready. The mic state becomes real with Claude B's work | Claude B |
| Incoming calls | PushKit + CallKit (Build 9 SIGABRT fix, `aps-environment: production`, VoIP push credential); registration on sign-in + foreground; unregister on sign-out | Ready in code; needs the physical matrix (§11) | Claude B |
| Membership | Own-price label; Manage → Apple subscriptions; Restore purchases | Ready | me (done) |
| Landline | "Exploring for the future" | OK | — |

Not a blocker, but note:
- `mobile/lib/landlineAvailability.ts` says "Home Call Guard is available now for Android phones". An iPhone user can only see it by reaching the landline step, which the picker no longer offers.
- Change it to "mobile phones" when the landline copy is next touched.

## 6. Screenshot and listing plan

### Findings (recap)
- **Live Apple screenshots** (`~/Downloads/HCG_AppStore_1–5_1242x2688.png`) are raw TestFlight captures. They show:
  - "£4.99";
  - the withdrawn 30-day guarantee;
  - a "Beta testers are not charged" sandbox dialog;
  - a "TestFlight" status bar;
  - the old "Stop scam callers before they reach you" headline.
- **Replace all five.**
- **Live Google Play set:** `/Users/ad/call-ai/marketing/play-store/final/01–08` (1080×1920).
  - 01/03/05 are brand marketing frames. 03 and 05 contain an iPhone-style device frame.
  - 02/04/06/07/08 are Android captures of the old navy UI; 08 shows the `**21*` code.
- **No layered source files exist.**

### Rules for every frame
- No price, no allowance, no "30-day", no "before they reach you".
- No invented statistics ("2 scam calls stopped").
- No Android UI in an Apple frame.
- Wording taken from the approved website (`website/launch-ready-homepage`).

### Apple set: 6 frames
- Deliver at **1320×2868** (6.9") **and 1284×2778** (6.5"). PNG, no alpha.
- App captures sit *inside* a device frame, so the capturing iPhone's own resolution doesn't matter.

| # | Headline (approved website wording) | Sub-line | Visual | Source |
|---|---|---|---|---|
| 1 | **Scam call protection for your mobile phone** | Call-blocking apps check the number — scammers can fake that. Home Call Guard also checks the conversation. | Logo + shield + wave background | **Reuse** Play 01 artwork (new text) |
| 2 | **Trusted contacts ring straight through** | Calls from people on your list aren't monitored. | Fresh iPhone capture: Contacts list | Frame layout from Play 03/05; **new capture** |
| 3 | **Anyone else is checked while you talk** | If the conversation shows serious signs of a scam, the call can be ended. | Three callout cards: "Rang straight through / Screened, no concerns / High risk — call stopped" + device | **Reuse** Play 03 layout; **new capture** inside |
| 4 | **See how every call was handled** | Your recent calls, and what happened to each one. | Fresh capture: Activity (real calls from a real test household) | **Reuse** Play 05 layout; **new capture** |
| 5 | **Set up once, in the app** | Add the people you trust, then turn on call forwarding with one tap. | Fresh capture: Set up call forwarding (iPhone) | Frame; **new capture** |
| 6 | **Keep your number** | No contract. Cancel any time. | Fresh capture: Home "Protected" (real state) | Frame; **new capture** |

**Captures required**, from the 1.0.2 **TestFlight** build on a real iPhone, using a real signed-up and activated account (no mocked APIs, no auth bypass):
- Contacts
- Activity
- Set up call forwarding
- Home (protected)

EAS has a `screenshots` build profile (internal, production env) if a non-TestFlight capture build is preferred.

Before capture:
- dismiss any sandbox/TestFlight dialogs;
- use example-looking names (e.g. "Mum", "Dr Patel");
- use only numbers that are safe to publish.

**Reusable assets:**
- Play 01/03/05 backgrounds, wave, logo lockup and device frame (cropped from the flattened PNGs);
- `mobile/assets/shield-mark*.png`, `splash-shield.png`, `icon.png`;
- `public/logo.png`, `public/hcg-shield.png`.

**Must replace:**
- all 5 live Apple screenshots;
- Play 02/04/06/07/08 (old UI / Android dial code);
- Play 01's headline.

**Play refresh:** after the Apple set is approved, re-cut the Play set at 1080×1920 from the same layouts with Android captures, so both stores tell one story.

### Listing copy (drafts; no price, no allowance)
- **Subtitle (≤30):** "Scam call protection" (20)
- **Promotional text (≤170, editable any time):** "Call-blocking apps check the number — scammers can fake that. Home Call Guard also checks the conversation while you talk, and can end the call if the risk is serious."
- **What's New (1.0.2):** "A refreshed look, simpler set-up, clearer protection status, and more reliable call delivery. Subscription prices are now shown directly from the App Store."
- **Description:**
  - The live one is acceptable.
  - Replace "Intelligent monitoring of unknown callers" with "Calls from people you don't know are checked while you talk".
  - Keep the existing limitation and EULA paragraphs.
  - Add no price and no allowance.
- **Repo draft `docs/launch/STORE_LISTING_COPY.md` §App Store Connect is outdated** (landline, "before they reach you"). Don't paste it.

## 7. Price-change release procedure (price-agnostic, not executed)

**Principle:**
- After this branch, every *app and checkout* surface shows the price of the system that charges.
- A price change is therefore a **billing-system change plus static website/Terms copy**, not an app change.
- The remaining risks are clients that still hard-code an amount: **iOS 1.0.1 (Build 14), and every Android build before Build 20**.

### Phase 0 — prerequisites (before any price change)

| Step | Action | Approval |
|---|---|---|
| P1 | Deploy the backend with dynamic pricing **at the current price**. Verify in production that `GET /billing/offer` (logged in) returns the current price (this proves `tax_behavior` inclusive) and that Membership labels are correct | Andrew (deploy) |
| P2 | Ship **iOS 1.0.2** and **Android Build 20** (both dynamic) at the current price | Andrew (builds/submission) |
| P3 | Measure the old-client tail: iOS 1.0.1 installs (ASC → App Analytics by version) and pre-Build-20 Android installs (Play Console) | Andrew |
| P4 | Terms: publish the price-agnostic §3/§5/§10 (draft in `TERMS_BILLING_DRAFT_2026-10-01.md`) after legal review. The allowance clause waits for Claude A | Andrew + legal |

### Phase 1 — preparation (harmless; affects no customer)

| Step | Action |
|---|---|
| S1 | **Stripe:** create a **new** Price on the existing product: GBP, monthly, `tax_behavior: inclusive`, amount [PRICE]. Don't archive the old Price (existing subscribers stay on it). Record its ID |
| W1 | Website: prepare, on a branch, the homepage/meta/JSON-LD/Terms figures at [PRICE] (guides: remove the amount) |
| A1 | Admin: confirm the admin revenue view uses per-subscription prices, or accept the documented estimate |

### Phase 2 — the change (one window, in this order)

| Step | Action | Why this order |
|---|---|---|
| 1 | **Apple:** ASC → subscription → Plan Subscription Price Change: UK, [PRICE], start date = D, **"keep current price for existing subscribers"** (unless Andrew decides otherwise, §8). Only one change can be scheduled per region; an increase can't be reversed once effective | Apple's switch time is date-based, not minute-precise, so schedule it first and confirm |
| 2 | On D, check the new price is live on Apple (App Store product page "In-App Purchases", and the 1.0.2 Subscribe screen on a test device) | iOS 1.0.2 then shows [PRICE] automatically (StoreKit/RevenueCat can cache offerings for minutes) |
| 3 | **Stripe + website + Terms in one deploy:** set `STRIPE_PRICE_ID` = the new Price; deploy the website/Terms copy; Terms "Last updated" = D | App/web/Checkout pick it up on restart; the static pages change in the same deploy |
| 4 | Verify: `GET /billing/offer` = [PRICE]; a Stripe test-mode checkout → new Price; the Android Subscribe screen shows [PRICE]; an existing subscriber's Membership still shows **their** price | — |
| 5 | Google Play (only if Play Billing exists by then): change the base plan price; existing subscribers go into a **legacy price cohort** automatically (not moved) | — |

**Residual mismatch windows:**
- **Between steps 1–2 and 3** (hours at most): Apple charges [PRICE] while the website still shows the old figure. No in-app or checkout surface is wrong. Keep this short, or make the homepage figure price-agnostic for the day.
- **Old clients:**
  - iOS 1.0.1 shows hard-coded "£4.99" while StoreKit's sheet shows [PRICE].
  - Pre-Build-20 Android shows "£4.99" while Stripe Checkout shows [PRICE].
  - Both only affect *new purchases on old app versions*. Mitigation: do Phase 2 only once P3 shows the tail is negligible.
  - Or (decision): serve old Android builds nothing new (Andrew previously rejected app-version logic).

**Never do:**
- change `STRIPE_PRICE_ID` before the app and web show dynamic prices;
- edit the existing Stripe Price (it's immutable; create a new one);
- schedule the Apple change before 1.0.2 is live;
- move existing subscribers without the notice in Terms §3.4.

## 8. Existing-customer / grandfathering options

**Facts:**
- The admin audit on 27 Sep found **0 genuine paying customers**.
- Apple subscribers since 1.0.1 went live on 28 Sep are **unknown**: check ASC Sales / RevenueCat.
- Any Stripe or Apple subscriber today pays the current price.

| Option | Stripe | Apple | Customer notice | Recommendation |
|---|---|---|---|---|
| **A. Grandfather indefinitely** | Do nothing: subscriptions stay on the old Price object; new customers get the new Price | "Keep current price for existing subscribers" (they can also resubscribe at that price within 60 days of lapsing) | None needed | **Recommended** for early customers: simplest, no consent risk, and the numbers are tiny |
| B. Grandfather for a fixed period (e.g. 6–12 months), then move | Later: update each subscription item to the new Price (proration off) after Terms-compliant notice | Later: schedule an increase for existing subscribers; Apple notifies (27 days, monthly) and requires **consent** where the rules demand it. Non-consenters lapse. Irreversible | Email + in-app notice ≥ Terms notice period | Only if the margin requires it (Claude A) |
| C. Move everyone at the change | As B, immediately | As B, immediately | As B | Not recommended: consent churn on Apple, and a goodwill cost for very few customers |

**UI/server support:**
- **Stripe:** done on this branch. The label is each subscription's own Price.
- **Apple:** the label deliberately shows no amount. To show an Apple subscriber's own price, either:
  - capture `price_in_purchased_currency` / `currency` from the RevenueCat webhook into a new column (a migration for Claude C); or
  - read RevenueCat's subscriber API server-side.
- **Admin:** revenue must use per-subscription prices once more than one Price exists (`routes/adminBusiness.js`, Claude A / admin owner).

## 9. Terms changes required

The full draft clause text is in **`docs/launch/TERMS_BILLING_DRAFT_2026-10-01.md`**:
- §3.1 price (price-agnostic, one dated current price);
- §3.2 how you pay: Stripe / Apple / Google;
- §3.3 failed payments;
- §3.4 price changes (notice period `[NOTICE PERIOD]` ≥ 30 days; grandfathering option);
- §4 Apple start;
- §5 cancellation per channel, and "cancelling doesn't turn off forwarding";
- §8 app delivery;
- §10 store refunds;
- §13 material changes.

**PENDING — FINANCIAL-SAFETY DECISION:**
- §3.5 allowance;
- what happens when the allowance is reached;
- §9 fair-use alignment.

**Legal review needed:**
- the notice period;
- the immediate-start consent wording;
- store refunds vs the proportionate deduction;
- §13 "continued use".

## 10. Actions requiring Andrew's approval

1. Review and merge direction: approve `feature/ios-102-dynamic-pricing` (`6d4b087`, `feeeb38`) for Claude B's integration line. Push it (it's local only).
2. Commit the forwarding-number fix (its owner) and resolve the `index.tsx` conflict (Claude B).
3. **Deploy the backend** with the sandbox guard (migration 053, numbering checked with Claude C) + dynamic pricing + webhook auth. Required **before** any TestFlight purchase test.
4. Confirm in the Stripe Dashboard that the production Price has `tax_behavior = inclusive`, and which account and Price production uses.
5. The ASC checklist (§3): verify, and answer Family Sharing, Small Business Program and billing grace period.
6. **EAS iOS build** 1.0.2 (build 15), then **upload to TestFlight** (`eas submit`).
7. The microphone-permission work in 1.0.2 (Claude B).
8. Screenshot headlines (§6) and the capture session with a real account; listing copy.
9. The price (Claude A → Andrew), then the §7 procedure, step by step.
10. Grandfathering option (§8), and whether to publish before or after the old-client tail shrinks.
11. Terms draft → legal review → publish (allowance clause after Claude A).
12. App Review submission with **manual release**; the release date coordinated with §7 Phase 0.
13. Website: the iPhone label ("Coming soon" → available) when 1.0.2 is released. `IOS_COMING_SOON=false` only if web/Android iPhone signups via Stripe should also open. It is **not** needed for the iOS app path (see `feeeb38`).

## 11. Path: current state → TestFlight → App Review

1. **Now:** code ready on `feature/ios-102-dynamic-pricing` (tests green). Plan and Terms draft ready.
2. **Integration (Claude B):** merge in the §2 order; add the microphone permission; bump to 1.0.2; `npm test`, `tsc`, `expo export` for iOS and Android.
3. **Backend deploy (approval):** sandbox guard + migration 053, dynamic pricing, webhook auth, plus whatever Claude A/C require. Verify `/billing/offer` and Membership labels in production at the current price.
4. **EAS iOS build (approval)**, then **TestFlight upload (approval)**.
5. **TestFlight matrix on a physical iPhone** (numbered PASS/FAIL list):
   1. New account: register → confirm email → back in the app.
   2. Device picker shows "iPhone" (not "Coming soon") → carrier check → Subscribe.
   3. The Subscribe screen shows **StoreKit's price** (matches ASC); airplane mode → "couldn't load price", button disabled; "Try again" recovers.
   4. Sandbox purchase → confirmation → entitled (no real number: expected with the guard).
   5. Real account (production household, complimentary or live): contacts permission (Full and Limited) → sync.
   6. Forwarding: one tap opens the Phone app with the code → Call → carrier confirmation. Undo code visible.
   7. **Microphone prompt appears during onboarding, not mid-call.**
   8. Incoming unknown call: app in foreground, background, locked, and terminated → CallKit rings → answer → two-way audio → shown in Activity.
   9. Trusted-contact call rings straight through.
   10. Membership: correct label; "Manage subscription" opens Apple subscriptions; Restore purchases.
   11. Sign out → sign in as a different household → the old household no longer rings this phone.
   12. Account deletion flow.
   13. Android regression: Build 20 candidate shows "iPhone — Coming soon" on Android; Subscribe shows the Stripe price.
6. **ASC:** version 1.0.2, build attached, What's New, 6 screenshots (6.9" + 6.5"), description/promo, review notes (+ the sandbox note), reviewer credentials checked. **Manual release.**
7. **Submit for review (approval).**
8. **After approval:** release on the coordinated date (with website label changes). Price changes follow §7 later, independently.
