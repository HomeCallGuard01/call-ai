<!--
Provenance: produced 2026-10-04 by a read-only inventory pass over this
branch at the five-workstream merge commit 4a90763, compared with
origin/main eb43368 (what production deploys). The integration fixes made
after 4a90763 added NO commercial figure. The only related change is
routes/adminBusiness.js, which now reads the Twilio inbound rate from the
register instead of a literal; its £4.99 revenue fallback at line ~121 is
unchanged. No commercial decision is taken or implied by this document.
-->
# Commercial-figure inventory: integration/soft-launch-candidate-2026-10-04

- Worktree: `/Users/ad/call-ai-soft-launch-candidate` at HEAD `4a90763`. Compared against `origin/main` = `eb43368`, which is what production deploys.
- Method: `git grep -nE` over tracked files only. node_modules and package-lock are excluded. Every non-obvious hit was checked in context.
- Deployment state of `public/` is **unverified**. "On main?" means only that the same string exists at `origin/main`, the commit that production deploys.
- Migrations 064–071 (including 067 and 068) are **DRAFT and not applied**, according to the project memory. None of the files on this branch are deployed.

## 0. Where the actual charge comes from (no hard-coded price)

- **Stripe (web and Android):** the amount comes from the `STRIPE_PRICE_ID` env var. See `routes/billing.js:334,415`, `routes/mobileApi.js:301,364`, `services/checkoutSession.js`, `services/subscriptionPricing.js` and `services/serverConfig.js:28`. `.env.example:34` has `STRIPE_PRICE_ID=price_your-price-id` (PLACEHOLDER). The repo contains no £ amount for Stripe.
- **iOS:** RevenueCat entitlement `hcg_protected`, offering `default`, package `$rc_monthly`, App Store product `co.uk.homecallguard.app.monthly` (`mobile/lib/purchases.ts:22-30`). The price is read from StoreKit (`mobile/lib/subscriptionPrice.ts`). The branch has no hard-coded price.
  - On origin/main, the same comment (`mobile/lib/purchases.ts:26`) says "£4.99/month".
- **App UI on this branch:** no hard-coded £ figure. Subscribe shows the StoreKit or Stripe price, or falls back to `PRICE_PENDING_NOTE` (`mobile/lib/subscriptionPrice.ts:83`).
  - **origin/main hard-codes £4.99** at `mobile/app/(setup)/complete.tsx:89`, `mobile/app/(setup)/subscribe.tsx:277,323` and `mobile/app/(setup)/welcome.tsx:104`.
- **Store metadata:** `mobile/app.json` and `mobile/eas.json` contain no prices. `marketing/app-store/ios-102/generate_frames.py` contains no prices; line 16 records the copy rule "no price". The only 0.86 in it (line 166) is a layout coordinate, a false positive.
- **Emails:** no tracked email template contains a price. `docs/launch/SUPABASE_CONFIRMATION_EMAIL_TEMPLATE.md` has none.
- **Privacy page:** `public/privacy.html` has no price. Its only 0.86 is a CSS `font-size` value (line 298), a false positive.

## 1. Summary counts (hit lines) by figure and classification

| Figure | LIVE CUSTOMER-FACING | RUNTIME ENFORCEMENT | PLACEHOLDER | TEST | DOCUMENTATION | ECONOMIC SCENARIO |
|---|---|---|---|---|---|---|
| £4.99 | 33 (index 9, terms 4, guides 20) — all on main | 0 | 0 | ~59 | ~93 | 17 |
| £5.99 | 0 | 1 (comment in mig 067:99) | 0 | 11 | ~59 | 7 |
| £6.99+ (6.99/7.99/9.99/12.99/14.99) | 0 | 0 | 0 | 11 | ~49 | 4 |
| 100 monitored min | 0 | 1 (register:77 → plans.js `standard`) | 0 | ~9 | ~17 | 5 |
| 200 monitored min | 0 | 1 (register:77 → plans.js `plus`, not on sale) | 0 | 0 | 4 | 0 |
| £0.50 plan budget | 0 | 4 seed rows (mig 067:122-125) + 1 different-meaning default (067:76) | 0 | ~4 | ~23 | 3 |
| £0.86 envelope | 0 | 1 (comment in mig 067:103) | 0 | 2 | ~19 | 1 |
| £1.24 / £1.25 | 0 | 0 | 0 | 0 (the 3 test hits are unrelated) | ~18 | 1 |
| Top-up price | 0 | 0 (none configured; defaults are empty) | 1 (`productCatalog.js:12`, £2.99/30 min example) | ~6 files (£2.99/299p fixtures) | 2 (candidate £2.49/£2.99) | 1 (`productCatalog.js:29` £2.00 worked example) |

Excluded as false positives:

- `docs/security/evidence/2026-10-01-staging/staging-server-caps.log:10,14` and `staging-server-real-calls.log:3`: timestamps.
- `scripts/hcg-unit-economics.js:100`: matched "4.99" only inside "14.99".
- `public/index.html:271`: `699px` media query.
- `public/index.html:142`: `1.25rem`.
- `letterSpacing: 0.5` in two mobile files.
- `services/allowance/allowanceNotices.js:143`: warning level 100.
- `tests/live-monitoring-hangup-flush.test.mjs:125`: frame count.
- `tests/accounting-units.test.mjs:107`: −1.24 commission line item.
- `tests/financial-safety.test.mjs:323`: telephony cost sample 1.25.
- `services/liveMonitoring/scoring/scorer.js:75`, `migration 067:56` (`backstop_share` 0.5) and `services/finance/hcgUnitEconomics.js:161`: ratios.
- Register `streamRoundUpPerMonitoredCall` 0.5 and `stripeTaxPct`: not budgets.
- `services/finance/spendAnomaly.js:27` `estimateUndercountFloorGbp: 0.5`, and the matching "+ £0.50" in `tests/financial-safety.test.mjs:161` and `docs/finance/FINANCIAL_SAFETY_ARCHITECTURE.md:80`: an undercount tolerance, not the plan budget.
- `tests/financial-safety-migration.pglite.test.mjs:125`: £0.50/min test rate.
- Register line 95 `numberGbp: 0.5`: the Magrathea number-rental scenario, not the budget.

## 2a. LIVE CUSTOMER-FACING (in repo; deployment unverified)

Every row exists identically on origin/main.

| file:line | figure | context | on main? |
|---|---|---|---|
| public/index.html:41 | £4.99 | meta description "…£4.99/month including VAT…" | yes |
| public/index.html:47 | £4.99 | og:description "£4.99/month including VAT, no long-term contract" | yes |
| public/index.html:90 | 4.99 | JSON-LD Offer `"price": "4.99"` | yes |
| public/index.html:94 | 4.99 | JSON-LD price specification `"price": "4.99"` | yes |
| public/index.html:196 | £4.99 | HTML comment (design note, not rendered). Ambiguous: it sits in the page source but is not visible text | yes |
| public/index.html:365 | £4.99 | hero price `<span>£4.99</span>` | yes |
| public/index.html:521 | £4.99 | pricing card "£4.99 a month, including VAT" | yes |
| public/index.html:560 | £4.99 | FAQ "£4.99 a month, including VAT… no long-term contract" | yes |
| public/index.html:591 | £4.99 | footer CTA "£4.99 a month including VAT, no contract" | yes |
| public/terms.html:13 | £4.99 | meta description "the £4.99/month call-screening service" | yes |
| public/terms.html:341 | £4.99 | "paid subscription basis at **£4.99 per month**" | yes |
| public/terms.html:343 | £4.99 | "charge your payment method £4.99 automatically every month" | yes |
| public/terms.html:353 | £4.99 | "advertised price of £4.99 per month is inclusive of any VAT" | yes |
| public/guides/caller-id-number-spoofing-explained.html:89, 91 | £4.99 | body "£4.99/month including VAT, no long-term…"; CTA "Get protected on Android — £4.99/month incl. VAT" | yes |
| public/guides/can-you-block-a-specific-scam-number.html:91, 93 | £4.99 | body + CTA (same wording) | yes |
| public/guides/common-phone-scams-targeting-older-people-uk.html:87, 89 | £4.99 | body + CTA | yes |
| public/guides/do-call-blocking-apps-stop-scam-calls.html:92, 94 | £4.99 | body + CTA | yes |
| public/guides/how-to-identify-a-scam-phone-call.html:100, 102 | £4.99 | body + CTA | yes |
| public/guides/how-to-report-a-scam-phone-call-uk.html:100, 102 | £4.99 | body + CTA | yes |
| public/guides/protect-an-elderly-persons-landline.html:93 | £4.99 | body "£4.99/month including VAT" (Android only; landline "coming soon") | yes |
| public/guides/protect-elderly-parents-from-phone-scams.html:102, 104 | £4.99 | body "It costs £4.99/month including VAT" + CTA | yes |
| public/guides/stop-scam-calls-on-a-landline-uk.html:91 | £4.99 | body "available for Android phones, at £4.99/month including VAT" | yes |
| public/guides/stop-scam-calls-to-elderly-parents.html:89, 91 | £4.99 | body "£4.99/month including VAT, no long-term contract" + CTA | yes |
| public/guides/talking-to-elderly-parents-about-scam-calls.html:87, 89 | £4.99 | body + CTA | yes |
| public/guides/what-to-do-if-elderly-parent-keeps-getting-scam-calls.html:99, 101 | £4.99 | body + CTA | yes |

Notes on the website and app strings:

- 11 guide files carry £4.99, giving 20 lines. Docs refer to "12 guides"; on this branch 11 contain the figure.
- No website, terms or app string states a minute allowance, a top-up, £5.99, or any higher plan.
- The following are LIVE CUSTOMER-FACING **on origin/main only**. The branch removed them.
  - `mobile/app/(setup)/complete.tsx:89`: "£4.99 per month including VAT, cancel anytime."
  - `mobile/app/(setup)/subscribe.tsx:277`: "£4.99/month, including VAT".
  - `mobile/app/(setup)/subscribe.tsx:323`: button "Subscribe & pay £4.99/month now".
  - `mobile/app/(setup)/welcome.tsx:104`: "£4.99/month including VAT".
- Per the docs, the live iOS 1.0.1 build and the live store screenshots also show £4.99. That is not verifiable from the repo.

## 2b. RUNTIME ENFORCEMENT

None of these files exist on origin/main.

| file:line | figure | context | class | on main? |
|---|---|---|---|---|
| services/finance/assumptions/hcg-unit-economics.v1.json:77 | 100 / 200 min | `planAllowanceMinutes: {standard: 100, plus: 200}`; `services/usage/plans.js:26-32` reads these as the plan allowance. They are used by monitoringGate, usageMeter, allowanceStatus and customerAllowance (metering, display and warnings). Monitoring stops at the allowance only if `MONITORING_ALLOWANCE_ENFORCED=true`; it is off by default. Env override is `PLAN_<CODE>_ALLOWANCE_MINUTES`. `plus` is not on sale. | RUNTIME ENFORCEMENT (metered; enforcement switchable) | no |
| supabase/migrations/067_financial_containment_authorization_ledger.sql:122-125 | £0.50 | `fc_budget_profiles` seeds for standard, plus, complimentary and internal_test: `0.50` period budget, `0.25` delivery reserve, `0.10` essential | RUNTIME ENFORCEMENT (DRAFT, not applied) | no |
| supabase/migrations/067…sql:76 | 0.50 | `global_worst_case_per_household_gbp default 0.50` is a global breaker scaling factor and **not** the plan budget | RUNTIME ENFORCEMENT (DRAFT; different meaning) | no |
| supabase/migrations/067…sql:99 | £5.99 | comment: seeds derived "at £5.99 inc. VAT" | RUNTIME ENFORCEMENT (comment explaining seeds) | no |
| supabase/migrations/067…sql:103 | £0.86 | comment: envelope "≈ £0.86" | RUNTIME ENFORCEMENT (comment) | no |
| services/finance/assumptions/hcg-unit-economics.v1.json:73 | 0.5 | `fortressSeedBudgetGbp {budget 0.5, deliveryReserve 0.25, essential 0.1}` mirrors migration 067 and is documentary. Ambiguous: it is in the register, but the enforced value is the migration seed. | ECONOMIC SCENARIO (listed here for traceability) | no |

### Runtime-read but non-enforcing

These values are read by running backend code but never charge, limit or gate. They are classified ECONOMIC SCENARIO and listed here because they are easy to confuse with enforcement.

| file:line | figure | context | on main? |
|---|---|---|---|
| services/finance/assumptions/hcg-unit-economics.v1.json:19 | £5.99 | `priceIncVatGbp 5.99`, "Candidate price, NOT approved". It feeds `services/containment/economicPolicy.js:31` DEFAULT_ECONOMICS, then `commercialConfigValidation` (boot-time report at `server.js:1002` and the `routes/adminFortress.js` view). Env override is `HCG_ECONOMICS_PRICE_INC_VAT_GBP`. It does not set what customers are charged. | no |
| routes/adminBusiness.js:121 | 4.99 | admin revenue estimate: if the Stripe price lookup fails, `priceGbp` falls back to 4.99 (reporting only) | **yes** |
| services/finance/householdCosts.js:193; spendMonitor.js:94,106 | 4.99 | default `priceGbp = 4.99` for contribution and threshold alerts. Used by `scripts/spend-monitor.js`, not wired into the server. | no |

## 3. TEST / DOCUMENTATION / ECONOMIC SCENARIO / PLACEHOLDER (by file)

### PLACEHOLDER

| File | Lines | What |
|---|---|---|
| `.env.example` | 34 | `STRIPE_PRICE_ID=price_your-price-id` (no amount) |
| `services/allowance/productCatalog.js` | 12-14 | example `ALLOWANCE_TOPUP_PRODUCTS`: `topup_small`, 30 min, `priceGbpInclVat 2.99`, `hcg.topup.small` / `hcg_topup_small`. This is the only top-up price in code, and it sits in a comment. The defaults are empty. |

### ECONOMIC SCENARIO

| File | Lines | Figures |
|---|---|---|
| `services/finance/assumptions/hcg-unit-economics.v1.json` | 19, 23, 31, 73 | £5.99; 0.5 seed mirror. Lines 19 and 77 are also covered in §2. |
| `services/finance/commercialConfigValidation.js` | 134, 139 | £0.50/£0.25/£0.10 placeholders; "£5.99 (not yet approved)" |
| `scripts/hcg-unit-economics.js` | 7, 8, 100, 142-145 | £5.99, £6.99; TIERS 5.99/6.99/7.99/9.99/12.99/14.99; £0.86, £0.50, £2.07 for 100 min, "£1.25 candidate" |
| `scripts/pricing-scenarios.js` | 12, 31, 62, 112 | PRICES 4.99/5.99/6.99/7.99/9.99; 100-minute allowance |
| `scripts/unit-economics.js` | 12, 19 | default 4.99; "100 min/month" example |
| `scripts/exposure-report.js` | 15, 17 | £4.99 |
| `docs/finance/carrier-quotes.json` | 4 | scenario `priceGbp: 4.99` (script input) |
| `services/businessMetrics/config.js`, `vat.js`, `profitability.js` | 14; 2; 155 | £4.99 (comments) |
| `services/finance/spendAnomaly.js`, `spendGuard.js` | 18; 9, 21 | £4.99 (comments) |
| `services/finance/householdCosts.js`, `spendMonitor.js` | 12, 193; 94, 106 | 4.99 defaults (also in §2b) |
| `services/usage/safetyConfig.js` | 36, 43 | "£4.99–£6.99 after-fees revenue"; "≈ 6× a 100-min allowance" |
| `services/allowance/productCatalog.js` | 29 | £1 cost → "£2.00 incl VAT" top-up worked example |
| `routes/adminBusiness.js` | 121 | 4.99 fallback (§2b) |

### TEST

£4.99 / 499p:

| File | Lines |
|---|---|
| account-classification | 146, 170, 184, 186 |
| accounting-ledger-projection.pglite | 49 |
| accounting-units | 73-75, 86 |
| business-control-centre | 83, 84, 88, 97, 98, 103, 198, 205, 323, 326 |
| business-control | 171 |
| business-metrics | 72, 73, 117, 119, 123 |
| carrier-comparison | 25, 26 |
| checkout-existing-subscription | 176 |
| economics-register | 105 |
| failure-scenarios | 36 |
| financial-containment-service | 73 |
| financial-ledger | 82 |
| financial-safety | 67, 96, 112, 216 |
| helpers/accountingFixtures | 64 |
| helpers/accountingScenarios | 47, 52, 156, 158, 460 |
| launch-fortress-admin-commercial | 35 |
| launch-gate/registry | 118 |
| migrations.pglite | 1556, 1576, 1591 |
| pricing-scenarios | 17-19, 37-39 |
| release-copy-corrections | 3 |
| unit-economics | 20-22, 31, 32, 35, 38, 40 |
| website-landline-coming-soon | 132 |

£5.99:

| File | Lines |
|---|---|
| business-control-centre | 88, 103 |
| economics-register | 52, 93, 95 |
| financial-containment-ledger.pglite | 41 |
| financial-containment-service | 74 |
| launch-fortress-admin-commercial | 24 |
| launch-gate/registry | 117, 118 |
| unit-economics | 34 |

£6.99 and above:

| File | Lines | Note |
|---|---|---|
| admin-metrics | 60 | £9.99 MRR fixture |
| economics-register | 95 | |
| financial-containment-service | 84 | 9.99 |
| pricing-scenarios | 33-36, 42-44, 48 | |

100 / 200 minutes:

| File | Lines | Note |
|---|---|---|
| financial-safety-callpath | 36, 182, 183 | "default plan: 100 min placeholder, NOT enforced" |
| customer-allowance | 91, 106 | |
| economics-register | 116 | |
| launch-fortress-admin-commercial | 26 | |
| pricing-scenarios | 24 | |
| spend-guard | 50 | "200-minute call", an anomaly, not an allowance |

£0.50 / £0.86:

| File | Lines |
|---|---|
| economics-register | 109, 111, 116 |
| customer-allowance | 375 |
| financial-containment-harness | 58 |
| financial-containment-ledger.pglite | 41 |

Top-up prices (£2.99, 299 pence fixtures):

| File | Lines | Note |
|---|---|---|
| customer-allowance | 199-206 | £2.00 / £2.60 |
| customer-allowance | 212, 213, 241, 258, 259 | |
| customer-allowance-ui | 53, 58 | |
| customer-allowance-webhooks | 20, 83, 112 | |
| launch-fortress-realpg | 81, 93 | 299p |
| allowance-economic-bridge.pglite | 36, 48, 55, 63 | |
| customer-allowance-migration.pglite | 61 | |
| fortress-kill-switches.pglite | 89 | |
| accounting-units | 71 | |

### DOCUMENTATION

`docs/finance/*.md` are generated or analysis documents. They are classified DOCUMENTATION because they are docs/*.md, although much of the content is economic scenario.

| File | £4.99 | £5.99 | £6.99+ | 100/200 min | £0.50 | £0.86 | £1.24/1.25 |
|---|---|---|---|---|---|---|---|
| finance/PRICING_AND_ALLOWANCE_EVIDENCE.md (superseded header) | 20 lines (5, 27…280) | 18 | 24 | 46, 80, 82, 91, 93, 102, 104, 113, 115, 226 | 3 | 3 | 3, 31, 54 |
| finance/HCG_UNIT_ECONOMICS_V1.md | 4, 52, 242, 256 | 4, 24, 33, 36, 78, 85, 153, 192, 202, 283 | 36, 242, 252-256, 262-264 | 34, 55, 244 | 21, 46, 53, 58, 253, 295 | 21, 23, 46, 52, 53, 183, 186, 244 | 23, 46, 54, 182 |
| finance/HCG_UNIT_ECONOMICS_V1_TABLES.md | 7-10 (net ex-VAT of £5.99, not a price), 87, 105 | 1, 7-10, 93, 100, 107 | 87, 88, 93, 94, 101-105 | 92, 138 | 102, 137 | 34, 36, 92, 136 | 33, 34, 36, 139-142 |
| finance/UNIT_ECONOMICS_AND_PROVIDER_REQUIREMENTS.md | 40, 60, 69, 70 | 61 | 62, 63, 71, 72 | — | 3 | 3 | 3 |
| finance/FINANCIAL_SAFETY_ARCHITECTURE.md | 7, 93, 129, 130 | — | 93, 129 | 95 | — | — | — |
| finance/FINANCIAL_SAFETY_CONTROLS.md | 5, 13, 51 | — | — | — | — | — | — |
| finance/FINANCIAL_CONTAINMENT_P0.md | 175 | 173 | — | — | 233, 374, 398 | 179, 374 | — |
| finance/COST_CONTROL_AUDIT_2026-09-27.md | 15 | — | — | — | — | — | — |
| finance/BUILD20_MONITORING_ALLOWANCE_API.md | — | — | — | 75 ("42 of 100 minutes", example only) | — | — | — |
| handovers/2026-10-04-unit-economics-handover.md | — | 11, 43, 51, 63 | — | 11, 41 | 11, 40, 64 | 11, 39 | 11, 42 |
| handovers/2026-10-03-customer-allowance-billing-handover.md | 333 | 333 | — | 333 | — | — | — |
| handovers/2026-10-03-financial-fortress-p0-handover.md | — | — | — | — | 298 | 298 | — |
| handovers/2026-10-03-launch-gate-adversarial-handover.md | 170 | 170 | — | — | — | — | — |
| handovers/2026-10-03-launch-fortress-integration-handover.md | — | 131 | — | — | — | — | — |
| handovers/2026-10-04-launch-readiness-handover.md | 49 | 49 | — | — | — | — | — |
| integration/2026-10-03-LAUNCH_GATE_RESULT.md | — | 163, 193 | — | 163 | 163, 185 | — | 186 |
| integration/2026-10-03-INTEGRATION_GRAPH.md | — | 72 | — | — | — | — | — |
| integration/2026-10-03-COST_SURFACE_INVENTORY.md | — | — | — | — | 15 | — | — |
| launch-gate/LAUNCH_GATE_MATRIX.md | 104 | 104 | — | — | — | — | — |
| release/2026-10-04-SOFT_LAUNCH_READINESS.md | 143, 147, 149, 205 | 143, 145, 205 | — | — | 204 | — | — |
| launch/IOS_102_RELEASE_PREP_2026-10-01.md | 34, 105, 109, 128, 191, 206, 238, 341, 342 | 25 | — | — | — | — | — |
| launch/IOS_102_STORE_LISTING_2026-10-01.md (draft store copy; no price in the listing itself) | 28, 82, 87, 93 | 80, 82, 86, 90 | — | — | — | — | — |
| launch/IOS_102_MORNING_REPORT_2026-10-02.md | 9 | 117 | — | — | — | — | — |
| launch/STORE_LISTING_COPY.md (draft Play copy: "£4.99 a month including VAT"; ambiguous, as it may have been pasted into a live listing) | 113 | — | — | — | — | — | — |
| launch/TERMS_BILLING_DRAFT_2026-10-01.md | 106, 107 | — | — | — | — | — | — |
| launch/LAUNCH_DAY.md | 50, 113 | — | — | — | — | — | — |
| launch/FINAL_ACCEPTANCE_REPORT.md | 41, 138 | — | — | — | — | — | — |
| mobile-app/APP_VISUAL_SPECIFICATION.md | 110 | — | — | — | — | — | — |
| ARCHITECTURE.md | 138 | — | — | — | — | — | — |
| PROJECT_OVERVIEW.md | 42 | — | — | — | — | — | — |
| PROJECT_STATUS.md | 196, 226, 294 | — | — | — | — | — | — |
| admin/ACQUISITION_READINESS_REVIEW.md | 28 | — | — | — | — | — | — |
| CURRENT_STATE.md (root) | 215, 227, 370, 408, 477, 485 | — | — | — | — | — | — |
| MARKETING_FACTS.md (root; marketing source of truth) | 10, 27, 37, 71, 89 | — | — | — | — | — | — |
| PROJECT.md (root) | 36, 90, 142 | — | — | — | — | — | — |

Top-up prices in DOCUMENTATION: `HCG_UNIT_ECONOMICS_V1.md:244` and `HCG_UNIT_ECONOMICS_V1_TABLES.md:92` give candidate prices of £2.49 / £2.49 / £2.99 by channel for 100 minutes of delivery capacity.

## 4. Inconsistencies (factual)

1. **Price: £4.99 vs £5.99.**
   - Every customer-facing surface in the repo says £4.99: the website, the terms (s.4, which hard-code £4.99 and a monthly charge of £4.99), 11 guides, and on origin/main the app.
   - The economics register and economicPolicy default to £5.99 (`priceIncVatGbp`, "NOT approved"). Migration 067's budget seeds are derived "at £5.99".
   - So the seeded containment budgets assume revenue that no live surface advertises.
   - The real charge is neither of these numbers: it is whatever Price `STRIPE_PRICE_ID` points to (unverified) and whatever the App Store Connect price is (docs say £4.99).
2. **Non-enforcing code defaults are split between £4.99 and £5.99.**
   - £4.99: `householdCosts.js`, `spendMonitor.js`, `adminBusiness.js` fallback, `carrier-quotes.json`, `exposure-report.js`, `unit-economics.js`.
   - £5.99: the register and `commercialConfigValidation`.
3. **App price source.**
   - The branch shows the StoreKit or Stripe price dynamically.
   - origin/main (the live code) hard-codes £4.99 in 3 setup screens and 4 strings.
   - A price change would therefore be shown correctly only once this branch's app build ships.
4. **Allowance vs budget.**
   - `plans.js` (via the register) sets Standard at 100 monitored minutes. It is not enforced by default and is not stated on any customer surface.
   - Migration 067 seeds a £0.50 budget. The docs compute that this funds about 22 monitored minutes at Fortress rates; 100 minutes costs about £2.07 on the Fortress basis, or £1.72 at billed cost.
   - The code flags this at boot as `plan_minutes_unfundable` / `minutes_promise_exceeds_budget`.
5. **The `plus` plan** has 200 minutes in the register but the same £0.50 seed as `standard`. No price or product exists for it.
6. **No customer surface mentions a minute allowance.** The website and terms describe an unlimited-style £4.99 monthly service, while the branch meters monitored minutes against a 100-minute placeholder.
7. **Budget figures conflict across docs.**
   - The docs cite £0.50, £0.86 and £1.25 budgets.
   - £0.86 is the economicPolicy envelope (comment in migration 067:103).
   - £0.50 is its 58% slice, and is the value seeded in 067.
   - £1.25 has no source in code; per `HCG_UNIT_ECONOMICS_V1.md:23` it can only be reconstructed (≈ £1.239).
8. **Top-up prices.**
   - None is configured at runtime.
   - The code comment uses £2.99 for 30 minutes. The tests use £2.99 for 30 minutes (299p).
   - The economics doc gives candidates of £2.49 / £2.49 / £2.99 for 100 minutes.
   - No customer surface mentions top-ups. Two reserve ratios differ: 15% for the plan and 10% for top-ups.
9. **Higher prices** (£6.99, £7.99, £9.99, £12.99, £14.99) appear only in scenario scripts, docs and tests. They appear in no runtime config and on no customer surface.
10. **The guide count** is given as "12" in `TERMS_BILLING_DRAFT_2026-10-01.md:107` and `SOFT_LAUNCH_READINESS.md:143`. On this branch, 11 guide files contain £4.99.
