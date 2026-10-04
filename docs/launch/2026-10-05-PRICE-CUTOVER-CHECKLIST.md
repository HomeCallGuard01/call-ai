# £5.99 launch-price cutover checklist (prepared 2026-10-05)

**Approved price: £5.99/month including VAT** (Andrew, 2026-10-04). **Nothing live has been changed.** This is the exact order for the live cutover, so no customer ever sees £4.99 beside a £5.99 charge, or the reverse.

## A. Already done in source (branch `integration/soft-launch-candidate-2026-10-04`, NOT deployed)

| Area | Change | Guard |
|---|---|---|
| Homepage `public/index.html` | Every £4.99 → £5.99: meta, OG, JSON-LD `Offer.price` ×2, hero, pricing card, FAQ, footer. A CSS comment was made price-neutral. | `tests/website-landline-coming-soon.test.mjs`: £5.99 pricing card + JSON-LD; **no 4.99 on homepage/terms/any guide** |
| 12 guides `public/guides/*.html` | CTA buttons drop the amount ("Get protected on Android"); body lines say £5.99/month including VAT | same test |
| Terms `public/terms.html` | §3 "current standard price for new subscribers £5.99 incl. VAT; the price that applies is shown before you subscribe", plus Stripe vs **Apple** payment wording. §4 Apple confirmation. §5 Apple cancellation + "cancelling does not switch off call forwarding". §10 Apple refunds. Last updated 5 Oct 2026. The price-change clause is **unchanged** (notice period / grandfathering are Andrew's decisions, below) | `TERMS_VERSION = "2026-10-05"` (`services/legalVersions.js`); acceptances record the version |
| Apps | No amount in the 1.0.2 source. iOS uses StoreKit `priceString`; Android uses the server's Stripe offer | `tests/subscription-price-display.test.mjs`, `tests/release-copy-corrections.test.mjs` |
| Server | Checkout text and membership label are dynamic. Remembered £4.99 fallbacks were replaced by the economics register (5.99): `routes/adminBusiness.js`, `services/finance/householdCosts.js`, `spendMonitor.js` | full suite |
| Docs | `MARKETING_FACTS.md`, `docs/launch/LAUNCH_DAY.md`, `docs/launch/STORE_LISTING_COPY.md` (Play), economics register note, launch-gate D1 evidence | `release-copy-corrections` |

**Do not blind-replace "£4.99" elsewhere:** in the finance docs and tests, £4.99 is often the **ex-VAT net of £5.99** (5.99 / 1.2 = 4.99).

## B. Live cutover: exact order (each step needs Andrew)

**Rule: the backend that reads prices dynamically must be live before any live price changes.** The current production backend `eb43368` hard-codes "£4.99" in the checkout text and the mobile membership label.

| # | Step | Who / where | Verify |
|---|---|---|---|
| 1 | Production backend deployed from the candidate (`2026-10-05-PRODUCTION-DEPLOYMENT-RUNBOOK.md`). Website and terms deploy **with it**, because `server.js` serves `public/`. **Do steps 2–4 in the same window, before announcing.** | Andrew GO, Railway | `/health`; signed call |
| 2 | **Stripe (live):** create a new Price on the existing product: **£5.99, GBP, recurring monthly (interval_count 1), `tax_behavior = inclusive`**. Do NOT edit or archive the £4.99 Price (existing subscribers stay on it). | Andrew, Stripe Dashboard | Price shows "£5.99 inc. tax" |
| 3 | Railway env: `STRIPE_PRICE_ID` = the new Price id; `HCG_ECONOMICS_PRICE_INC_VAT_GBP=5.99`. Restart (the price cache is per Price id, so it takes effect at once). | Andrew GO; Claude can do it via Railway if authorised | `GET /billing/offer` → `available:true`, `£5.99`, VAT-inclusive. **If `available:false`, the Price isn't tax-inclusive or isn't monthly GBP: fix the Price, never the code.** |
| 4 | **Stripe Tax** live registration active (UK); **customer emails** on (successful payments + refunds; business name, address and VAT number on receipts); Billing Portal = cancel at period end, no proration | Andrew, Stripe Dashboard | A test against the live Checkout page shows £5.99 and VAT of £1.00 (1/6). **The first real charge must show VAT £1.00, not £0.** |
| 5 | **App Store (only when iOS 1.0.2 is live and adopted):** ASC → In-App Purchases → `co.uk.homecallguard.app.monthly` → price → UK £5.99. Choose "existing subscribers keep current price" (recommended) or a price increase with Apple's consent flow. **Do not do this while 1.0.1 is the live version:** 1.0.1 hard-codes "£4.99" on its subscribe button. | Andrew, ASC | StoreKit shows £5.99 in 1.0.2's subscribe screen (TestFlight sandbox, no purchase) |
| 6 | **RevenueCat:** nothing to change (same product id, offering `default`, package `$rc_monthly`, entitlement `hcg_protected`). Check the price displayed in RevenueCat after ASC propagates. | Andrew | — |
| 7 | **Google Play:** no Play product exists (Android pays via Stripe, so step 3 covers it). If Play Billing is built later, create the base plan at £5.99, **with no intro offer** (an intro offer hides the price in-app). | — | — |
| 8 | Store listings: App Store and Play descriptions **without price** (recommended); retire the 1.0.1 App Store screenshots that show £4.99 | Andrew, ASC / Play Console | — |
| 9 | Final sweep: `grep -rn "4\.99" public/` returns nothing (the test enforces it); a live check of homepage, terms, `/billing/offer`, the app subscribe screen (Android) and Stripe Checkout all show £5.99 | Claude | Evidence into the soft-launch gate C11 |

## C. What does NOT change at cutover

- **Existing £4.99 Stripe subscribers stay on £4.99**, since Stripe subscriptions keep their Price. Moving them needs notice under terms §3 (decision D-P2).
- The membership card shows each household its **own** price (from its subscription's Price), so existing subscribers keep seeing £4.99.

## D. Decisions for Andrew (price-related)

- **D-P1:** iOS in the first cohort? If yes **before** the ASC price changes, iOS customers pay £4.99 (and live 1.0.1 still shows the withdrawn 30-day guarantee). **Recommendation: Stripe-only cohort first.**
- **D-P2:** existing £4.99 subscribers: grandfather (recommended; one sentence in terms §3) or migrate with **≥ 30 days' notice**.
- **D-P3:** sign off the terms changes (A) before they deploy, and set the notice period wording if migrating.
