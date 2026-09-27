<!--
STATUS (2026-09-27, branch feature/provider-neutral-billing-ledger — NOT merged, NOT deployed):
  Implemented on this branch:
    - migration 048 (financial_entries + telephony_call_legs), DRAFT, not applied anywhere
    - provider-neutral contract / allocation / reconciliation (services/ledger/)
    - Twilio billing adapter (services/telephony/twilio/billingRecords.js)
    - repository, writer, reconciliation worker (not scheduled, not wired into server.js)
    - read-only backfill plan + dry-run script (scripts/ledger-backfill.js)
  Design only (not built): revenue/store/ad/manual-cost integrations, manual_cost_schedules,
  marketing tables, customer_acquisition, acquisition_events extensions, fx_rates, forecasts, dashboards.
  Section 8.5 is superseded by section 9.
-->
# HCG financial data architecture: revenue, cost, acquisition and profitability

Specification, 27 Sep 2026. This extends and supersedes the telephony-ledger specification in `HCG_provider_billing_ledger_spec.md`; every change requested for that specification still applies.

No dashboard, pricing, allowance or production changes are part of this. No billing account was accessed.

## 1. Questions the system must answer

1. Is an individual customer profitable?
2. Is HCG as a whole profitable?
3. Which marketing campaigns acquire profitable customers?

## 2. Core design: one money ledger plus evidence tables

```
                 ┌──────────────────────── financial_entries (THE money ledger) ───────────────────────┐
 revenue, VAT,   │ one row per money movement or cost line, any supplier, native amount/currency,        │
 fees, refunds,  │ provenance + reconciliation status + cost class, linked to household/call/leg/        │
 direct cost,    │ subscription/campaign/manual schedule by reference                                    │
 overhead, ads   └──────────┬───────────────────────────┬──────────────────────────────┬────────────────┘
                            │                           │                              │
      evidence / usage ─────┼───────────────────────────┼──────────────────────────────┼─────────
   telephony_call_legs   (usage: billed    marketing_daily_metrics (non-money:     manual_cost_schedules
   duration, leg type,    duration, legs)  impressions, clicks, leads, installs)   (recurring/one-off
   billing model)                          customer_acquisition (household→        costs that generate
                                           campaign attribution)                   manual entries)
                            │
   reporting only ──────────┴── fx_rates (reporting currency conversion) · views/materialised views
   planning only  ───────────── forecast_scenarios / forecast_assumptions (never joined into actuals)
```

**Rules:**
- **Only `financial_entries` holds money.** Every dashboard figure is a query over it. No supplier is hard-coded into dashboard calculations; suppliers only appear as data (`supplier`, `source_system`).
- **Evidence tables hold quantities and relationships,** never money: telephony legs, ad clicks and impressions, attribution.
- **Supplier-native evidence is preserved.** Native signed amount, native currency, native quantity/unit and the original reference/transaction ID are never overwritten. Currency conversion happens only in reporting (`fx_rates`).
- **Forecasts live in separate tables** and are never mixed with actual accounting data.

## 3. `financial_entries`: the ledger (created now in migration 048)

| Column | Purpose |
|---|---|
| id | uuid |
| source_system | Where the record came from: `twilio`, `stripe`, `revenuecat`, `apple_asc`, `google_play`, `openai`, `meta_ads`, `manual`, `hcg`… (free slug) |
| supplier | The counterparty the money is with: `twilio`, `stripe`, `apple`, `google`, `railway`… (free slug) |
| entry_key | Deterministic idempotency key; unique with source_system |
| native_reference | Original transaction/reference ID (Stripe txn ID, Twilio CallSid, invoice number, report line ID) |
| entry_class | `revenue` · `refund` · `tax` · `fee` · `cost` |
| category | See the taxonomy below |
| cost_class | `variable_direct` · `semi_variable` · `fixed_overhead` · `customer_acquisition`. Required for `cost` and `fee`; null for revenue/refund/tax. |
| billing_model | `per_second` · `per_minute` · `per_started_minute` · `per_channel` · `per_number` · `fixed_period` · `per_transaction` · `percentage` · `other` |
| provenance | `provider_actual` · `provider_allocated` · `estimated` · `manual` |
| charge_observation | Only for `provider_actual`: `reported_amount` · `reported_zero` · `not_observed` · `unavailable` · `pending` |
| reconciliation_status | `pending` · `provisional` · `final` · `unreconciled` · `unavailable` · `mismatch` · `error` |
| native_amount / native_currency | Exactly as the supplier reported (signed; e.g. Twilio −0.03023 GBP) |
| native_quantity / native_unit | e.g. 4 `minute`, 1 `number-month`, 1,000 `impression` |
| amount | Sign-normalised magnitude in native_currency (no FX). Direction comes from entry_class. Null when unknown. |
| occurred_at | Economic date of the item |
| period_start / period_end | For period charges (rental, channel capacity, subscriptions, SaaS, ad spend days) |
| household_id / call_id / telephony_leg_id | Customer and usage links |
| subscription_ref | Stripe subscription ID / store original transaction ID |
| campaign_ref | Normalised campaign key (future: FK to marketing_campaigns) |
| allocation_basis | Required for allocated, estimated and manual rows: how the figure was derived |
| source_reference | Required for allocated rows: which supplier aggregate was apportioned |
| evidence | jsonb: verbatim non-personal supplier fields |
| notes, created_by | Manual context and who entered it |
| retrieved_at, finalised_at, created_at, updated_at | Lifecycle |

**Category taxonomy (extensible by migration):**
- **Revenue side:** `subscription`, `vat_output`, `store_commission`, `payment_processing_fee`, `refund`.
- **Direct service:** `number_rental`, `inbound_voice`, `app_leg`, `outbound_voice`, `media_stream`, `tts`, `channel_capacity`, `platform_fee`, `sms`, `transcription`, `ai_inference`, `email`.
- **Overhead:** `hosting`, `database`, `domain`, `developer_program`, `saas`, `insurance`, `accountancy`, `other_overhead`.
- **Acquisition:** `advertising`, `acquisition_other`.
- `other`.

**Enforced invariants:**
- Absence of a charge is never a zero.
- `provider_actual` ⇔ an observation is present.
- Derived rows must explain themselves (`allocation_basis`).
- Allocated rows cite their provider aggregate.
- Costs and fees carry a cost class.
- Final rows have a finalised timestamp.

**Provenance renamed:** the telephony specification's `hcg_estimate` becomes `estimated`, as your latest list asks.

**Trusted vs monitored traffic** isn't a money attribute. It comes from the linked call (`calls.status` Known/Unknown) and leg type, so the same inbound-voice entry answers both "trusted minutes" and "monitored minutes" questions.

## 4. Future tables (designed now, not built)

| Table | Purpose |
|---|---|
| `manual_cost_schedules` | supplier, category, cost_class, native amount/currency, cadence (`one_off` · `monthly` · `annual`), start/end, allocation rule (none / per active customer / per minute), notes. A job (or admin action) posts one `manual` entry per period, keyed `schedule:<id>:<period>`, so re-running never duplicates. Edits apply to future periods; posted entries stay as history. |
| `marketing_campaigns` | platform, account ID, campaign/ad-set/ad IDs and names, normalised `campaign_ref` matching the UTM convention |
| `marketing_daily_metrics` | platform, date, campaign/ad-set/ad ref, impressions, clicks, leads, installs, platform-reported conversions. Spend itself is a `financial_entries` row (`advertising`, `customer_acquisition`) so money stays in one place. |
| `customer_acquisition` | household → first-touch/last-touch campaign_ref, channel, attribution method (`utm_checkout`, `store_referrer`, `self_reported`, `unknown`), confidence |
| `fx_rates` | date, from/to currency, rate, source (reporting only) |
| `forecast_scenarios`, `forecast_assumptions` | Price, mix, usage, churn, CAC assumptions per scenario. Never joined into actuals. |
| `revenue_subscriptions` view | Built from Stripe/RevenueCat/Play entries for MRR, churn and retention |

## 5. How the dashboards query it (later)

- **Overview:** Gross revenue (`subscription`) → VAT (`tax`) → store/payment fees (`fee`) → net revenue → direct service costs (`variable_direct` + `semi_variable`) → contribution → overhead (`fixed_overhead`) → advertising (`customer_acquisition`) → operating profit/loss. Every line shows its provenance mix.
- **Customer economics:** per household and billing period: net revenue, trusted and monitored minutes (legs joined to calls), telephony / AI / other direct cost, contribution and margin. Shared costs such as channel capacity appear only as clearly labelled allocations.
- **Marketing:** spend by campaign → clicks and leads (metrics) → paying customers (attribution) → CAC → attributed customers' contribution → payback period → retention and churn. LTV is shown only once cohorts have enough months.
- **Provider economics:** cost by supplier, number, call, trusted/monitored traffic and billing model, with legs as the usage evidence.
- **Forecasting:** break-even customer count and scenarios, from forecast tables, visually separated from actuals.

## 6. Integration feasibility (verified vs unknown)

"Verified" means seen in HCG code or observed on HCG's accounts. Everything else is marked.

| Source | Data | Class | Evidence |
|---|---|---|---|
| **Twilio calls** | Per-call billed duration, price, currency, child legs | **A** | Verified: read-only API calls on 26–27 Sep |
| **Twilio usage records** | Daily totals by category (inbound, media streams, Polly, numbers) | **A** | Verified (used by `twilioCosts.js`) |
| Twilio SMS | Per-message price | **A (candidate)** | Message resource has a price field per Twilio's API docs; not yet read by HCG code, and not verified on this account |
| **Stripe** | Charges, fees, refunds (balance transactions); subscription lifecycle webhooks | **A** | Verified in code (`revenue.js`, `routes/billing.js`) |
| Stripe Billing / Tax fees | Invoiced separately | **B** (monthly import or manual) | Whether they appear as balance transactions is **UNKNOWN** |
| **RevenueCat (Apple)** | Subscription lifecycle events | **A** for lifecycle | Verified: webhook handler exists |
| RevenueCat price/commission/tax fields | Per-transaction amounts | **D** | HCG reads only IDs and type today. Whether stored payloads include price/commission is **UNKNOWN**; check a real payload. |
| **Apple App Store Connect** | Sales and finance reports (proceeds, commission) | **B** | No ASC API access configured for HCG (memory: key found but deliberately unused). Manual CSV until you approve a key. |
| Apple commission tier (Small Business Program) | 15% vs 30% | **C / D** | Enrolment **UNKNOWN** |
| **Google Play** | Earnings/financial reports | **B (future)** | No Play Billing exists; Android pays through Stripe today |
| **OpenAI** | Actual costs | **B** once an Admin key exists; **estimated** until then | Verified: the project key gets 403 on the organisation costs endpoint (`openaiCosts.js`). Estimates can come from HCG-recorded audio seconds. |
| **Telnyx** | Per-call cost / CDRs | **D** | Not an HCG account; unverified |
| **Meta, Google Ads, TikTok** | Spend, clicks, impressions, ad IDs | **B** now (CSV export) → **D** for API automation | No credentials or integration in HCG. Their public APIs require approvals and tokens, **not verified for HCG**. |
| HCG acquisition events | Visits, registrations, checkout, paid conversions with utm_source/medium/campaign | **A** (internal) | Verified (migration 032). **No utm_content/utm_term or click IDs; cookie-free visits aren't linked to households.** Ad-set/ad-level attribution needs new UTM conventions. |
| App-install attribution | Play install referrer, Apple attribution | **D** | Not implemented |
| Railway | Monthly bill | **C** | Billing API **UNKNOWN**; no Railway access from this environment |
| Supabase | Monthly bill (production + staging) | **C** | Billing API **UNKNOWN** |
| Resend | Email plan | **C** | Free tier per the launch audit |
| Domains, Apple Developer (annual), Google Play developer (one-off), insurance, accountancy, ICO fee, other SaaS | | **C** | Recurring/one-off manual schedules |
| VAT | Output VAT on Stripe sales | Derived (**A** from Stripe gross) | For App Store / Play sales the store is typically the deemed supplier handling VAT; **confirm with your accountant** |

## 7. Compatibility decision for the telephony ledger being built now

The previously specified `telephony_charges` table would have been a **second money table**, incompatible with section 2. Migration 048 therefore:

- **Keeps `telephony_call_legs`** as specified: the usage and evidence table.
- **Creates `financial_entries`** as the generic money ledger instead of `telephony_charges`. The Twilio adapter writes telephony costs into it (`source_system = 'twilio'`, telephony categories, `cost_class = 'variable_direct'`, or `semi_variable` for number rental / channel capacity).
- **Keeps every telephony requirement,** enforced by constraints: the 4-way charge observation, provenance separating actual/allocated/estimated, the 7 billing models, and native evidence.

Revenue, ads, manual costs and forecasts need **only new tables and new source_system values later**, with no redesign of 048.

## 8. Customer acquisition attribution (provider-neutral)

### 8.1 What HCG captures today (verified in code, `origin/main`)

| Stage | Captured | Linked to household? |
|---|---|---|
| Landing visit (`/`, `/go`) | utm_source/medium/campaign, referrer **host** only | No (cookie-free by design, migration 032) |
| Web registration submitted/completed | utm_source/medium/campaign from hidden form fields | **No:** `household_id` is null |
| Checkout started / paid conversion | household_id | **Yes, but no UTM or referrer is stored** |
| `/go` → Google Play → app | UTMs forwarded only onto `/go`'s "Learn more" web link | **Lost at the Play Store; no install referrer read by the app** |
| utm_content / utm_term / click IDs / landing path / self-report | Not captured | — |

**Result: no household's acquisition source is currently recoverable.** Existing households must be recorded as `unknown`. Matching old registration events to households by timestamp would be fabrication.

### 8.2 Model

**`attribution_touches`** (append-only; one row per attributable arrival):
- `touch_token` (random, server-issued, carried in URLs, **not stored on the device**) and `occurred_at`.
- `utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term`.
- `click_ids` jsonb (gclid / fbclid / ttclid / msclkid, **only if present in the URL**).
- `landing_path` (path only, no query string beyond UTMs), `referrer_host`.
- `entry_surface` (`web`, `go_page`, `android_install_referrer`, `ios`, `other`).
- `household_id` (set when the token reaches signup).

**`customer_acquisition`** (one row per household; first touch is **write-once**):
- **First touch:** source, medium, campaign, content (ad ID), term, landing_path, referrer_host, click_ids, `first_touch_at`, `first_touch_token`. These are **never overwritten** (enforced by a DB trigger or an update-where-null rule).
- **Latest attributable touch:** the same fields as last_*, plus `last_touch_at`. Updated when a newer touch carries attribution; direct/no-UTM visits never overwrite it.
- **Signup source:** `web`, `android_app`, `ios_app`, `complimentary_invite`, `admin_created`, `unknown`.
- **Self-reported:** optional "How did you hear about Home Call Guard?": a fixed list (Search engine, Facebook/Instagram ad, Facebook group/community, Friend or family, News/PR, Charity/organisation, Other) plus optional free text.
- **Derived fields:**
  - `channel`: `paid_social`, `paid_search`, `paid_other`, `organic_search`, `organic_social`, `community`, `referral`, `pr`, `email`, `direct`, `unknown`.
  - `attribution_method`: `utm_url`, `play_install_referrer`, `referrer_only`, `self_reported`, `none`.
  - `confidence`: `high` = UTM or install referrer; `medium` = referrer host; `low` = self-report only; `none`.
- **Unknown stays `unknown`.** A visit with no UTM and no referrer is `direct_or_unknown`, never assigned to a campaign.

**Channel rules:**
- utm_medium in (cpc, paid, paid_social, display) → paid_*.
- Referrer host is a search engine and there are no UTMs → organic_search.
- Social host and no UTMs → organic_social. It can't be told apart from community posts unless those posts use `utm_medium=community`, which the naming convention requires.
- Otherwise a referrer host → referral.
- Nothing → direct_or_unknown.
- Channel is derived and can be recalculated, but the raw fields are never altered.

### 8.3 Handoff chain

```
advert / link (UTM convention: utm_campaign = campaign id, utm_content = ad id, utm_term = ad set)
  → website visit: server issues touch_token, appends it to internal links (URL only, no cookie)
  → signup (web form carries token + UTMs; app carries Play install-referrer UTMs or self-report)
  → household created → customer_acquisition row written (first touch fixed)
  → subscription / entitlement (Stripe / RevenueCat / Play) → revenue entries (financial_entries.household_id)
  → service cost entries (telephony, AI, SMS) → customer contribution
  → campaign spend (financial_entries advertising, campaign_ref) + marketing_daily_metrics (clicks)
```

**Reporting per campaign/source:**
- Spend and visitors (touches).
- Signup and paying conversion.
- CAC = spend ÷ new paying customers.
- Churn (entitlement ends).
- Revenue and contribution after direct service costs (financial_entries by household).
- CAC payback = CAC ÷ average monthly contribution.
- Contribution-based LTV and LTV:CAC: only for cohorts with at least 6 months of history, labelled as insufficient evidence until then.
- **Non-paid sources are reported alongside paid ones,** with spend = 0 or manual PR cost.

### 8.4 Privacy, cookie and consent position

- First-party and server-side only. **No advertising pixels, SDKs or third-party trackers** (none are added without your explicit approval).
- **No device storage for attribution before consent.** The touch token lives only in the URL, so PECR's storage/access rule isn't triggered. The trade-off is accepted: a visitor who leaves and returns later without the link isn't linked. The Data (Use and Access) Act 2025 may relax consent for some first-party analytics storage; **whether and when that applies to HCG needs legal confirmation** before any cookie or localStorage approach.
- **Click IDs are pseudonymous identifiers.** Store them only if present, keep them 90 days, and never upload them to ad platforms (offline conversions) without approval and a privacy-policy update.
- No IP address, no full referrer URL, no user-agent (matching migration 032).
- The self-report question is optional.
- **The Privacy Policy needs a short addition** ("we record how you found us, e.g. the link or campaign you arrived from, to understand which of our marketing works") before launch.
- Lawful basis: legitimate interests (to confirm).

### 8.5 Minimum pre-launch attribution (separate from the ledger work)

The goal is that customers acquired from now on don't permanently lose their source.

| # | Change | Surface | Needs app build? |
|---|---|---|---|
| 1 | `customer_acquisition` table with write-once first touch; mark every existing household `unknown` | DB + backend | No |
| 2 | At web registration, write the UTMs the form **already** captures into `customer_acquisition` against the new household. This alone fixes the biggest current loss. | Backend | No |
| 3 | Extend capture to utm_content, utm_term, landing path and click IDs (present-only); carry them through `/go` → `/register.html` like the existing three | Website + backend | No |
| 4 | Optional "How did you hear about Home Call Guard?" on web registration | Website + backend | No |
| 5 | Same question in app onboarding; `signup_source = android_app/ios_app` | App | **Yes (next build)** |
| 6 | `/go` Google Play links carry `&referrer=utm_source%3D…` so the next app build can read Google's **Play Install Referrer** (a Play Store service, not an ad tracker) | Website now; app reading it later | **Yes, for reading** |
| 7 | UTM naming convention for every paid ad, community post, PR link and QR code | Documentation | No |
| 8 | Privacy Policy sentence | Website | No |

Items 1–4, 7 and 8 are backend/website only and can ship before the next Android candidate. Items 5–6 go into the next shared mobile release. None of this is being built in the current ledger branch.

## 9. One download page (`/go`) and the app-store boundary (supersedes §8.5)

### 9.1 What `/go` records today (verified in code)
- A `landing_visit` row in `acquisition_events`: path `/go`, utm_source/medium/campaign, referrer **host**. No household, no visitor ID (cookie-free).
- UTMs are forwarded only onto the "Learn more" link (`/`).
- **The Google Play button is a plain link:** clicks aren't recorded, and nothing is passed to Play, so attribution ends at the store.
- The iPhone card is a "Coming soon" waiting-list form. Its App Store link is swapped in only when `IOS_COMING_SOON=false` and `APP_STORE_URL` is valid.
- Not captured: utm_content, utm_term, click IDs, store clicks, a touch identifier.

### 9.2 One page, many tracked links
Every channel links to the **same** `/go` page, distinguished only by query parameters, following a published naming convention:

| Channel | Link |
|---|---|
| TikTok organic | `/go?utm_source=tiktok&utm_medium=organic_social` |
| Instagram organic | `/go?utm_source=instagram&utm_medium=organic_social` |
| Facebook community post | `/go?utm_source=facebook&utm_medium=community&utm_campaign=<group-slug>` |
| Paid Meta/TikTok | `/go?utm_source=meta&utm_medium=paid_social&utm_campaign=<campaign-id>&utm_content=<ad-id>&utm_term=<adset-id>` (platform click ID appended automatically if present) |
| PR / referral / QR | `/go?utm_source=<outlet or partner>&utm_medium=pr` (or `referral` / `qr`) |
| Organic Google / direct | No parameters: classified from the referrer host, otherwise `direct_or_unknown` |

No page copies are created. Optional later: short vanity redirects (`/t/tiktok` → the same `/go?…`) for bios.

### 9.3 First-party capture flow (no cookies, no pixels, no third-party SDK)
1. **`GET /go?...`** The server issues a random **touch token** and records `landing_visit`: token, all five UTMs, click IDs (only if present), landing path, referrer host, timestamp. The token is embedded **only in links on the rendered page**; nothing is stored on the device.
2. **Store buttons go through a first-party redirect:** `/go/store/android?t=<token>` (and later `/go/store/ios`). The server records `store_click` (platform, token, timestamp), then 302-redirects to the store.
   - **Android:** the Play URL gets `&referrer=` URL-encoded `utm_source=…&utm_medium=…&utm_campaign=…&utm_content=…&hcg_t=<token>`. Google Play hands this string to the installed app through the **Play Install Referrer API**, a Google Play service rather than an ad tracker. According to Google's documentation it stays readable for a period after install (**exact retention to verify**).
   - **iOS:** the App Store passes **nothing** to the app per user. The redirect adds Apple's App Store campaign parameters (`ct=<source-campaign>`, `pt=<provider token>`), which give **aggregate** campaign reporting in App Store Connect (**to verify once the iOS listing is live and ASC access is approved**). There's no per-user linkage without a third-party SDK or fingerprinting, both of which are rejected.
3. **The app on first launch** (next build): Android reads the install referrer once and sends the raw string with the signup request. iOS sends nothing automatically.
4. **Signup:** the backend parses the referrer, finds the touch token, and links `landing_visit` + `store_click` → household in `customer_acquisition`, with method `play_install_referrer` and high confidence.
   - Web signups link through the UTMs and token carried in the form (method `utm_url`).
   - No link means **unknown**, never guessed.
5. **Self-reported "How did you hear about Home Call Guard?"** is stored in its own fields (`self_reported_source`, `self_reported_detail`) and **never overwrites or fills in** automatic attribution. Reports show both side by side.

**First/last touch:**
- `customer_acquisition.first_*` is written once, from the earliest touch linked at signup, and never overwritten.
- `last_*` is updated only by a later linked touch that carries attribution.
- Unlinked earlier visits by the same person can't be joined without cookies. That limitation is accepted and documented, not worked around.

### 9.4 Chain for future reporting
source/campaign → `landing_visit` (token) → `store_click` (token) → signup (token via referrer/URL) → household (`customer_acquisition`) → subscription and revenue (`financial_entries`, household_id) → service cost (`financial_entries` + `telephony_call_legs`) → contribution.

Advertising spend is `financial_entries` (category `advertising`, cost_class `customer_acquisition`, `campaign_ref`). `campaign_ref` = lower-case `<source>/<medium>/<campaign>`, the same normalisation applied to `customer_acquisition`, so spend and customers join on one key.

That supports customers, paying customers, spend, CAC, retention/churn, revenue, contribution and profit **by source**, CAC payback, and contribution-based LTV once cohorts are old enough. Free channels have spend = 0, or manual cost where relevant (PR).

### 9.5 Answers

1. **What `/go` records now:** a landing visit with 3 UTMs and the referrer host. It doesn't record store clicks, content/term, click IDs, a token, or anything linkable to an account.
2. **Minimum before wider marketing (website + backend only):**
   - (a) Store buttons through `/go/store/<platform>`, recording `store_click` and adding the Play `referrer` with UTMs + token.
   - (b) Capture utm_content/utm_term/click IDs (present-only, 90-day retention for click IDs) and the touch token on `landing_visit`.
   - (c) `customer_acquisition` table, with web registration writing first touch from the form's existing UTMs and token.
   - (d) A backend-only self-report fallback: an optional one-click "How did you hear about us?" link in the post-signup email, answered on a web page. No app change needed.
   - (e) The UTM naming convention.
   - (f) One Privacy Policy sentence.
   - Database: additive columns and event types on `acquisition_events` (reused as the touch log; no second event table) plus the new `customer_acquisition` table, in a future migration numbered at the time (probably 049).
3. **Can safely wait until after launch:**
   - The app reading the Play Install Referrer and sending it at signup.
   - The in-app self-report question.
   - iOS App Store campaign parameters and aggregate ASC import (iOS isn't live yet).
   - Ad-platform spend import (CSV, then API).
   - `marketing_daily_metrics`; vanity short links; marketing dashboard; LTV.
   - Any click-ID offline-conversion upload, which needs separate approval.
4. **Linking website attribution to an account across the store boundary:**
   - A first-party touch token travels in URLs.
   - On Android it crosses the store inside Google's install referrer and is read by HCG's own app at signup.
   - On the web it travels in the registration form.
   - On iOS no per-user link is possible without tracking tools, so iOS relies on aggregate ASC campaign data plus self-report.
   - In every case, if no link exists the source stays `unknown`.
   - Items (a) and (b) above make the next Android build able to attribute installs retroactively for as long as Google keeps the referrer available.
5. **Mobile build needed?** The initial implementation (items 2a–2f) is **website/backend only** and doesn't touch or delay the Apple/Google release. Only reading the install referrer and the in-app self-report question need a future app build, and they can join the next normal release.

### 9.6 Effect on the database design
- Migration 048 (`financial_entries`, `telephony_call_legs`) needs **no change**: `household_id` and `campaign_ref` are the join points.
- Attribution uses **`acquisition_events` extended** (token, utm_content, utm_term, click_ids, landing_path, event types `store_click` / `install_referrer_received`) plus **`customer_acquisition`**, in a later migration. Both are additive.

## 10. Verified backfill dry run (2026-09-27, read-only, production data)

`node --env-file=<prod .env> scripts/ledger-backfill.js` (dry run; nothing written):

| Measure | Result |
|---|---|
| HCG calls found | 101 (all with CallSid; 0 without a Twilio record) |
| Twilio legs found | 336: 207 parents, 129 children (178 inbound, 100 app/client, 58 outbound) |
| Exact CallSid matches | 101 of 101 HCG calls |
| Household matches | via_call 101 · via_parent 81 · via_number 2 · ambiguous 0 · unmatched 152 (Twilio calls with no HCG row, on numbers not currently assigned to any household; not guessed) |
| Charge observations | inbound: 141 priced, 6 explicit zero, 30 not observed, 1 pending · outbound: 39 priced, 1 explicit zero, 18 not observed · **app legs: 96 not observed, 4 pending, 0 priced** |
| Media Streams | 39 calls allocated from Twilio daily totals, 0 estimated |
| Twilio total (inbound + outbound + app + Media Streams) | £2.27558 |
| Reconstructed ledger total | £2.27558 |
| Discrepancy | **£0.00000** (per category: inbound 0, outbound 0, app 0, Media Streams 0) |
| Not reconstructed per call (shown as supplier totals) | Polly £0.02282, SMS fee £0.00152, number rental £35.63597 |

The first run found a real defect: an explicit £0 Media Streams day (2026-09-07) was replaced by an HCG estimate (+£0.01665). This was fixed in 5340328, so the supplier's own figure now always wins over an estimate.
