<!--
STATUS (2026-09-27): audit of the EXISTING admin dashboard (Business and
Operations tabs, routes/adminBusiness.js, database/adminMetrics.js) on
origin/main eb43368. Evidence gathered read-only from code and production
data. Fixes: A1 is in PR #48; the rest are proposed (see "Proposed fixes").
-->
# Admin dashboard: stale or incorrect financial statements

Each finding lists what the dashboard says, what is true, the evidence, and severity. "Production" figures come from running the dashboard's own functions read-only against production data on 27 Sep 2026.

| # | Where | Statement | What's actually true | Severity |
|---|---|---|---|---|
| A1 | Business → Costs, "Twilio spend MTD (confirmed)", plus every profit figure using it | About £0.70 | Twilio's own total is **£16.50**. Rental is billed as `phonenumbers-local`, which the allow-list missed; Media Streams and TTS were missed too | **High. Fixed in PR #48** |
| A2 | Operations → "Active paid customers" (also feeds Business estimated profitability) | **7** | **0** paying. The count is *every* active entitlement; all 7 are `complimentary/admin_manual` | **High** |
| A3 | Operations → "Monthly recurring revenue (all accounts)"; Business → "MRR (all sources/accounts)" | **£34.93** | **£0** recurring revenue. It's active entitlements × list price, so complimentary accounts are counted as revenue. The caption mentions test/reviewer accounts but not complimentary ones | **High** |
| A4 | Operations → "Active protected households"; Business → "Active protected (real)" | Operations **9** | These count households with an active Twilio number. The customer-facing Protected definition (`computeProtectionStatus`: delivery verified + app registered) gives **3** | Medium |
| A5 | Business → Known gaps, items 1 and 7 | "`calls.duration_seconds` does not exist in production" | It exists and is populated: 55 of 101 calls have it, since 2026-09-07. The new Finance tab uses it for monitored minutes | Medium |
| A6 | Business → "Real MRR (confirmed)" | Labelled *confirmed* | Derived: genuine Stripe-paying count × list price, not invoiced amounts. Falls back to a hard-coded £4.99 if the Stripe price can't be read | Medium |
| A7 | Business → estimated profitability: avg revenue / cost / contribution per customer, break-even minutes | Per-customer figures | Denominator is A2's count (7 complimentary accounts), so "per customer" means per complimentary account | Medium |
| A8 | Business → Production release card | Android versionCode **4**, iOS build **8**, "confirmed 2026-09-03" | These are **hard-coded defaults** used whenever the `BUSINESS_ANDROID_*` / `BUSINESS_IOS_*` settings are unset. Android v10 has since been built. Railway's settings can't be checked from here; if they're unset, the card is stale | Medium (conditional) |
| A9 | Business → "Collected this month (confirmed)" | Next to "Real customers" headline figures | All Stripe charges, including any internal or test live-mode purchases, and VAT-inclusive. Correct as cash collected; not "real customer" revenue | Low |
| A10 | Business → break-even monitored minutes | Uses a Twilio inbound rate of £0.007558/min "confirmed 2026-09" | Hard-coded; not re-checked | Low |
| A11 | Business → OpenAI cost (estimated) | Monitored-call **count** × assumed minutes | Real `duration_seconds` now exists for delivered calls and could replace the assumption (partially: blocked calls have none) | Low |
| A12 | Operations → "Protection rate" | Blocked ÷ processed calls | Reads like a quality score; it's the share of calls classed as scam | Low |

## Proposed fixes (not deployed; branch `fix/admin-business-tab-statements`, no PR)

| # | Fix |
|---|---|
| A2 | `getBusinessOverview`: count only active `paid_subscription` entitlements as "Active paid customers" |
| A3 | MRR (all accounts) = active **paid** entitlements × price. Caption: "list price × paid entitlements, incl. Apple and test/reviewer paid accounts" |
| A4 | Rename to "Households with an active HCG number". Keep the figure; don't call it Protected |
| A5 | Correct known-gaps items 1 and 7 |
| A6 | Label "Real MRR" as *derived* (list price × genuine Stripe-paying customers) |
| A7 | Follows from A2: per-customer figures then use paying customers (0 → "no paying customers") |

A8 is a **settings** issue: set `BUSINESS_ANDROID_VERSION_CODE` etc. in Railway, or remove the hard-coded defaults so the card says "not configured". A9–A12 are labelling notes; the new Finance tab already presents these honestly.

## DECISION REQUIRED

Ship the proposed fixes as a follow-up PR after #48, or fold them into #48? I recommend a **separate PR after #48**. They change existing Business and Operations figures, which deserves its own review.
