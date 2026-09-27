<!--
STATUS (2026-09-27): review of the admin dashboard as due-diligence evidence,
based on feature/admin-control-centre-v2 (not deployed).
-->
# Admin dashboard: acquisition / due-diligence readiness

A buyer will ask HCG to **evidence** its numbers, not assert them. This review asks, for each area: what can the dashboard evidence today, how trustworthy is it, and what would mislead.

## Evidence map

| DD question | Where | Evidence quality today | Gap |
|---|---|---|---|
| Genuine customer count | Overview → Genuine paying customers; Subscriptions | **Strong:** explicit classification, never inferred; unclassified accounts shown separately | Classification is manual (`account_classifications`); keep an audit trail of who classified what and when |
| Genuine revenue / MRR | Overview → MRR; Finance → Revenue ex VAT | **Strong when Stripe is live:** Stripe subscriptions and charges mapped to genuine customers; test mode is refused | App Store revenue is not connected (RevenueCat prices not stored). VAT split is calculated; confirm with an accountant |
| Unit economics | Finance → Unit economics; Finance's `unitEconomics.js` model | **Partial:** telephony is actual; AI is estimated; infrastructure is manual | Needs the ledger (051) for per-customer actuals; OpenAI Admin key for actual AI cost |
| Provider costs | Finance → lines; Overview → Twilio numbers | **Twilio actual**, after the cost fix (the old dashboard understated it about 20×) | Railway, Supabase and Resend are monthly settings (dated). The ledger will make them entries |
| Number inventory | Reconciliation → Twilio number inventory | **Strong:** the provider's own list, each number explained or flagged | Staging numbers live on the production account (7 today). A clean separation (sub-account) is a buyer red flag to fix first |
| Subscription / entitlement reconciliation | Reconciliation → lifecycle timeline | **Strong** and read-only, with the first broken step shown | One shared definition with P0 (consolidation plan) so the API, sweep and dashboard agree |
| Lifecycle anomalies | Overview cards 9–12 | **Strong:** factual rules shown on each card | Release failures are inferred until P0's release-attempt columns are applied |
| Acquisition source | Marketing → By channel / campaign | **Weak (honestly labelled):** visits and web signups only; no link to paying customers | Migration 049 (attribution) plus UTM discipline; self-report question |
| Operational health | Customers (health), System Health | Customers: evidence-based. System Health: configured ≠ confirmed, and says so | Uptime / incident history isn't recorded anywhere |

## Metrics that would mislead a buyer (and their status)

| Metric | Problem | Status |
|---|---|---|
| "Active paid customers" = all active entitlements | Showed 7; real paying 0 | Fixed on `fix/admin-business-tab-statements` and in v2 definitions |
| "MRR" = entitlements × £4.99 | Showed £34.93 from complimentary accounts | Replaced by Stripe-based genuine MRR (v2) |
| "Active protected households" = has a number | Showed 9; Protected is 3 | Renamed (audit fix); v2 uses the customer-facing definition |
| Twilio spend | £0.70 shown vs £16.50 actual | Fixed in PR #48 |
| "Customers" on the Customers tab (included reviewers) | Mixed customer and test accounts | Renamed "Accounts with access" (v2) |
| Stripe figures from a **test** key | A test-mode account can look like revenue | v2 detects the mode and refuses to show test figures as revenue |
| "Protection rate" (blocked ÷ processed) | Reads as a quality score | Still on the Operations tab: recommend removal or relabelling |
| Raw landing visits | Page requests, not people; bots not filtered | Labelled; never presented as reach |
| Estimated profitability block (Business tab) | Mixes estimates across all accounts | Superseded by Finance (v2). Recommend retiring the old block once v2 ships |

## Recommendations before any DD process

1. **Separate staging from production at Twilio** (sub-account), and release staging numbers through the lifecycle (Finance audit item 1). Today 7 of 19 billed numbers are staging.
2. **Apply the ledger (051) and the release-attempt recording (P0 050)**, so costs and release failures are *recorded*, not inferred.
3. **Attribution (049)** before paid marketing, so CAC by channel can be evidenced; until then, say "not measured".
4. **Monthly evidence snapshot** (design): a read-only admin export of the Overview cards, number inventory, Finance lines (with provenance) and definitions, archived monthly. It gives a buyer a time series instead of a live screen. Not built; a small follow-up.
5. **Classification audit trail:** record who classified each account and when. A buyer will ask why an account is "genuine".
6. **Retire superseded vanity blocks** on the old Business/Operations tabs once v2 is live: estimated profitability, protection rate, raw MRR.
7. **VAT treatment and App Store proceeds** confirmed by an accountant, and App Store Connect reports connected once iOS sells.
