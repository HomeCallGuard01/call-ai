<!--
STATUS (2026-09-28, v3): branch feature/admin-control-centre-v2 (pushed, no PR, not deployed).
v3 = the five-tab consolidation + payment history. Strictly observational (GET only), no migration.
See also: RECONCILIATION_CONSOLIDATION_PLAN.md, ACQUISITION_READINESS_REVIEW.md,
STAGING_NUMBERS_ON_PRODUCTION_TWILIO.md.
-->

## v3 (2026-09-28): five tabs

The nine tabs (Overview, Business, Customers, Subscriptions, Reconciliation, Finance, Marketing, Operations, System Health) are now five. No endpoint changed; the former tabs are sections.

| Tab | Sections | Question it answers |
|---|---|---|
| **Overview** | Needs your attention · checks (Customers & revenue → Protection → Numbers & cost) · definitions | What needs me today? |
| **Customers** | health table (Genuine / Unclassified / Test badge and filter on every row) · Memberships & payment history | Who are my customers, which are real, are they protected? |
| **Numbers** | lifecycle reconciliation · Twilio number inventory | Does every number match its subscription, and what am I paying for? |
| **Money** | Finance · Marketing · website funnel | Is HCG profitable, and what brings customers? |
| **Operations** | call activity & failures · System Health · admin tools · activity · launch readiness | Are calls working, is the system healthy, what can I do? |

**Removed** (duplicates or misleading figures):
- The Business tab's revenue, cost and two profitability blocks. Finance supersedes them, with provenance on every line.
- Both entitlement × list-price MRR figures. MRR now comes only from Stripe, for genuine customers.
- The raw "All accounts" block, whose "Active paid customers" contradicted Overview.
- "Protection rate".
- The Ops subscription/number status breakdowns.
- The stale "known gaps" list.
- The acquisition "Top sources" table. It duplicated Marketing and rendered `utm_source` unescaped.

### Reconciling "0 genuine paying customers" with the Stripe evidence

"Genuine paying customers" = classified `genuine_customer` **and** a *current* paid entitlement. A real payer could vanish from every figure in two ways:

1. **They paid and then cancelled.** Recorded evidence (27 Sep): production household `87fdd35a` paid by Stripe on 6 Sep and cancelled on 9 Sep. "0 paying now" is then correct, but nothing said "1 former paying customer".
2. **They were never classified.**
   - An unclassified account counts as neither genuine nor test, and was only visible while it still had access.
   - In live mode, the Stripe module moved its payments into a bucket (`otherNonGenuine`) that no screen showed.

v3 closes both gaps:
- **Payment history** is shown: paying now vs former paying vs ever paid.
- A new Overview check, **"Paid at some point, not classified"** (amber), lists every account with a recorded paid membership that has no classification.
- The MRR card reports **UNATTRIBUTED** live Stripe subscriptions and payments: customers who are unclassified or belong to no household.

Caveat: a paid entitlement can come from a Stripe **test** or Apple **sandbox** purchase. Payment history therefore means "a paid membership was recorded", not "money was received". Only the live-mode Stripe figures prove money.

**Not verified this session:** whether `87fdd35a` is classified, and the live Stripe totals. The production read was declined by the session's permission policy, and this environment's Stripe key is test-mode. Opening the deployed Overview answers both.

> **CORRECTION (2026-09-27, later):** the "Stripe £39.92 gross (ACTUAL)" figure in §6 below came from the local environment's Stripe **test-mode** key, not production revenue. v2 detects Stripe's mode and never shows test-mode figures as revenue (MRR/revenue go grey: "Stripe TEST mode").

## v2 structure (summary)

- **Overview (default tab):** twelve loose-end cards (genuine paying customers · complimentary/internal/test/reviewer access · genuine MRR from Stripe · Protected · entitled but not protected · households with a number · active Twilio numbers · numbers not mapped to an expected household · cancelled/expired households still holding a number · entitled households missing a number · pending release/quarantine · failed releases/unresolved anomalies).
  - Colour comes from the stated rule on each card: red = loose end, amber = check, green = checked and zero, grey = cannot check, info = a count.
  - The definitions glossary sits below the cards.
- **Subscriptions:** paid / complimentary / trial / internal-reviewer / unclassified / cancelled / expired / protected / entitled but not protected, all from `definitions.js`.
- **Reconciliation:**
  - a per-household lifecycle timeline (active path and cancellation path, first broken step highlighted);
  - the **Twilio number inventory**: owner, why HCG holds it, environment evidence, rental, state, anomaly and next step.
- **Finance:**
  - Revenue ex VAT (genuine only) · Payment fees · Telephony · AI · Railway · Supabase · Resend · Other → total operating cost, gross contribution and operating contribution; marketing is shown separately.
  - Partial totals are labelled "known part only"; unknown ones are "Not connected".
  - Finance ledger views (051) are used only when `BUSINESS_FINANCE_LEDGER_VIEWS=enabled`.
- **Marketing:** a channel comparison (Instagram / TikTok / Facebook / LinkedIn / Direct / Other), the campaign table and the link builder. Self-report is kept separate.

# Business control dashboard

The admin dashboard (`/admin/business`) should answer three questions without logging into Twilio, Stripe, Railway or the database:

1. Are my customers and subscriptions healthy?
2. Does every HCG number match its subscription and lifecycle?
3. Is HCG profitable, and which marketing pays for itself?

This version adds four tabs next to the existing ones: **Subscriptions, Reconciliation, Finance, Marketing**. Business, Customers, Operations and System Health are unchanged. Each new tab loads only when opened.

**Strictly observational.** The four API routes are GET-only. Opening a tab performs:
- database reads;
- read-only Stripe balance-transaction and Twilio usage-record reads (the same calls the Business tab already makes);
- a read-only Twilio number list.

Nothing purchases, releases, quarantines, schedules or modifies a number, subscription, entitlement or any database row.

It builds on existing work and duplicates none of it:

| Existing work | How this uses it |
|---|---|
| `docs/architecture/FINANCIAL_DATA_ARCHITECTURE.md`, migration 048 `financial_entries` (branch `feature/provider-neutral-billing-ledger`) | Finance reads the ledger contract. No second money table. |
| Number lifecycle (016/017/037 on `main`; 047 guard on `fix/number-lifecycle-entitlement-guard`) | Reconciliation reports lifecycle state. It never schedules, quarantines or releases anything. |
| `acquisition_events` (032), `/go`, ADR-0017 attribution design | Marketing reports existing events and the planned chain. No new tracking. |
| `services/businessMetrics/*` (Stripe, Twilio, OpenAI, fixed-cost settings) | These are the live Finance sources until the ledger exists. |
| `account_classifications` (031) | "Genuine" means classified `genuine_customer`, as the Business tab already defines it. |

## 1. Subscriptions

| Figure | Definition | Source |
|---|---|---|
| Genuine paying customers | `genuine_customer` with an active `paid_subscription` entitlement | entitlements + classifications |
| Active paid subscriptions | All active paid entitlements, total and genuine, split by source (stripe / apple_revenuecat) | entitlements |
| Cancelling / payment issue / cancelled | Latest Stripe subscription row per household: `cancel_at_period_end`, `past_due` or `unpaid`, `canceled` | subscriptions (webhook-maintained) |
| Complimentary, trial | Active non-paid entitlements, by type | entitlements |
| Reviewer / test / internal | Classified `reviewer`, `internal_test`, `admin`, `qa_automation`. Always visible, never genuine | classifications |
| New genuine paying | First paid entitlement in the last 7 / 30 days | entitlements |
| Churn (30 days) | Genuine customers paying 30 days ago who no longer have paid access, ÷ genuine customers paying 30 days ago. **Hidden when the base is 0.** | entitlements |
| Needs classification | Unclassified accounts with active access. Never counted as genuine | classifications |

Deleted (anonymised) accounts are counted separately.

## 2. Reconciliation (read-only)

Each household's chain: subscription → entitlement → HCG number → app registered → delivery confirmed → protected → release scheduled → quarantine → provider number released.

| Anomaly | Severity | Rule |
|---|---|---|
| Paying customer without an HCG number | Action | Active paid entitlement, no number, more than 1h after start or provisioning failed |
| Entitled household without an HCG number | Action | Same rule for non-paid access |
| Number provisioning in progress | Watch | Less than 1h after the entitlement started |
| Entitled household whose number is scheduled for release | Action | Active entitlement **and** `twilio_number_pending_release_at` set (the case 047 guards against) |
| No entitlement, number retained, no release scheduled | Action | Number held, no entitlement, no release date |
| Number still held after its scheduled release | Action | More than 48h past `pending_release_at` (the release job runs every 24h) |
| Quarantined number awaiting deactivation confirmation | Action | `twilio_number_quarantine`, unconfirmed |
| Confirmed quarantine not released | Action | Confirmed more than 48h ago, not released. **Inferred:** release failures are only logged today |
| Number on the provider account not held by HCG | Action | On Twilio but in no household and no open quarantine. May be staging/test; verify first |
| Household number not found at the provider | Action | Household holds a number Twilio doesn't list |
| App (Voice SDK) never registered | Watch | Entitled, number assigned, no registration |
| Call delivery never confirmed | Watch | Entitled, number assigned, no delivered call |

**Upcoming entitlements** (status `scheduled`, or `active` with a future start) follow migration 047's definition and PR #47's rule. Keeping a number for one is expected; a scheduled release while one exists is flagged.

Overall status is **ACTION REQUIRED** if any action item exists, **WATCH** if only watch items exist, otherwise **OK**. The provider list is a read-only `incomingPhoneNumbers.list`. Once the provider-neutral numbers seam (`architecture/voice-provider-portability`) merges, it should read through that seam instead.

## 3. Finance

Every line carries a provenance label:
- **ACTUAL:** the supplier's own reported figure.
- **ALLOCATED:** a supplier total apportioned by HCG.
- **ESTIMATED:** calculated from assumptions.
- **MANUAL:** entered by an admin.
- **NOT CONNECTED:** no source exists. **Never shown as £0.**

Any total that includes a not-connected line is marked *incomplete*.

### Line sources

| Line | Today (live, before the ledger) | Once the ledger has rows |
|---|---|---|
| Subscriptions: Stripe | ACTUAL: Stripe balance transactions (charges) | `revenue/subscription` from stripe |
| Subscriptions: App Store / Play | ESTIMATED (Apple entitlements × list price), or £0 when there are none | `revenue/subscription` from apple, google |
| Refunds | ACTUAL: Stripe refunds | `refund/refund` |
| VAT | ESTIMATED: configured rate inside VAT-inclusive Stripe receipts. **Confirm with your accountant** | `tax/vat_output` |
| Payment fees | ACTUAL: Stripe fees | `fee/payment_processing_fee` |
| App store commission | NOT CONNECTED (ASC reports), or £0 with no app-store sales | `fee/store_commission` |
| Telephony usage | ACTUAL: Twilio usage total minus rental | inbound_voice, app_leg, outbound_voice, media_stream, tts, sms, platform_fee |
| Number rental | ACTUAL: Twilio `phonenumbers*` usage | number_rental, channel_capacity |
| AI / transcription | ESTIMATED: monitored calls × assumed minutes × rate | transcription, ai_inference |
| Railway / Supabase / Resend | MANUAL if `BUSINESS_FIXED_COST_*_GBP` is set, otherwise NOT CONNECTED | hosting, database, email |
| Other overheads | NOT CONNECTED until manual costs exist | developer_program, domain, saas, insurance, accountancy, other_overhead, other |
| Advertising | NOT CONNECTED until manual costs or an ad import exist | advertising, acquisition_other |

**This version runs in live-source fallback mode only:** it never queries `financial_entries`. The read model already supports ledger mode, line by line, as a tested pure function: GBP only, and unobserved charges are never zero. Turning ledger mode on is a small, separately reviewed change once 048 is applied.

### Totals and unit economics

- **Totals:** gross revenue → revenue ex-VAT → variable cost → gross contribution → fixed infrastructure → marketing → operating profit.
- **Per active customer** (paid + complimentary + trial): cost, and telephony cost.
- **Per genuine paying customer:** net revenue.
- **Monitored minutes:** `calls.duration_seconds` of delivered unknown-caller calls.
- **CAC:** NOT CONNECTED.

### Manual costs (not in this version)

The Finance tab says "Not available yet". The design below lives on `feature/admin-business-control`:
- **Form:** Finance → Manual costs. Fields: supplier, description, category, amount, currency, one-off / monthly / annual, dates, and a campaign for ads.
- **Posting:** "Post due entries" writes one ledger row per due period (`source_system='manual'`, `provenance='manual'`, `entry_key='schedule:<id>:<period>'`). Posting again never duplicates.
- **Ending:** a schedule is ended by setting an end date. Posted entries stay as history.
- **Availability:** disabled with an explanation until migrations 048 and 050 are applied.

### Which costs can be automated

See the architecture doc, section 6. In summary:
- **Automatic today:** Stripe, Twilio.
- **Possible with approvals or keys:** OpenAI (Admin key), App Store Connect (API key), Meta/TikTok/Google Ads (API approval; CSV first).
- **Manual:** Railway, Supabase, Resend, Apple Developer Program, Google Play registration, domains, insurance, accountancy, ICO fee, other SaaS.

## 4. Marketing

- Visits and registrations by `source/medium/campaign`, which is the same normalisation `financial_entries.campaign_ref` and `customer_acquisition` use.
- Untagged visits are classified from the referrer host (organic search, organic social, referral), otherwise **direct / unknown**.
- The attribution chain status is shown as-is: checkouts and paid conversions carry no campaign today, so **paying customers, revenue and CAC per campaign are NOT CONNECTED**.
- Spend per campaign appears once advertising entries exist. CAC appears only when spend **and** attributed paying customers both exist. A click never counts as a purchase.
- **Tracked link builder:** one `/go` page, many tagged links. Nothing is stored.

| Channel | Link |
|---|---|
| Instagram (organic) | `/go?utm_source=instagram&utm_medium=organic_social&utm_campaign=<name>` |
| TikTok (organic) | `/go?utm_source=tiktok&utm_medium=organic_social&utm_campaign=<name>` |
| Facebook group post | `/go?utm_source=facebook&utm_medium=community&utm_campaign=<group>` |
| Paid Meta / TikTok ad | `/go?utm_source=meta&utm_medium=paid_social&utm_campaign=<campaign-id>&utm_content=<ad-id>&utm_term=<adset-id>` |
| Google Ads | `/go?utm_source=google&utm_medium=paid_search&utm_campaign=<campaign>` |
| PR / QR | `/go?utm_source=<outlet>&utm_medium=pr` (or `qr`) |

**Note:** `acquisition_events` stores only source, medium and campaign today. `utm_content` / `utm_term` are dropped until the 049 attribution work extends capture.

## 5. Migrations and dependencies

| Item | Status | Needed for |
|---|---|---|
| 047 number-release entitlement guard | Branch, draft | Prevents what "entitled household pending release" reports. Reconciliation works without it |
| 048 `financial_entries` + `telephony_call_legs` | Branch, draft | Ledger mode in Finance, manual costs, spend per campaign |
| 049 `customer_acquisition` + `acquisition_events` extensions | Designed (architecture doc §9.5), **not written** | Paying customers / revenue / CAC by campaign |
| 050 `manual_cost_schedules` | Draft on `feature/admin-business-control`, **not included here**, not applied | Manual costs. Needs 048 applied to post entries |
| Twilio-costs fix (this version) | Code, no migration | Correct Twilio totals on both Business and Finance |
| PR #47 `feature/admin-lifecycle-reconciliation` | Open, not merged | A separate read-only reconciliation API (no UI) that overlaps the Reconciliation tab. **DECISION REQUIRED:** consolidate into one rule set after #47 merges |

**Migration numbering conflict (pre-existing, not from this branch):** `wip/monitoring-allowance-financial-safety-2026-09-26` has a `046_…` that collides with `main`'s `046_voice_client_registration_history.sql`.

## 6. Findings from the read-only production preview (27 Sep 2026)

1. **Twilio spend was understated.** The Business tab showed about £0.70 month-to-date against Twilio's own **£16.50**. The number-rental category was missing. Fixed on this branch.
2. **8 of 19 Twilio numbers** aren't held by any production household or open quarantine, costing about £7/month in rental. They may be staging/test numbers. **Verify before releasing anything.**
3. **2 quarantined numbers are awaiting deactivation confirmation.** Use the existing confirm action (Operations).
4. **2 households hold a number with no entitlement and no release scheduled.**
5. **2 entitled households have no HCG number.**
6. **No genuine paying customers yet.** All 7 active accounts are complimentary (4 reviewer/test/admin), and 3 active accounts are unclassified.
7. **Finance, month to date:** Stripe £39.92 gross (ACTUAL), Twilio £16.50 after the fix (ACTUAL), OpenAI £0.46 (ESTIMATED). Railway, Supabase, Resend and advertising are NOT CONNECTED (no monthly figures set). Operating profit is therefore shown as incomplete.
8. **Stale note in the existing Business tab:** its "known gaps" text says `calls.duration_seconds` doesn't exist. It does, and Finance uses it.

## 7. Recommended next steps

1. Review and merge this observational PR; deploy when you're ready. No migration is needed.
2. Set `BUSINESS_FIXED_COST_RAILWAY_GBP`, `…_SUPABASE_GBP` and `…_RESEND_GBP` in Railway so fixed costs show as MANUAL rather than NOT CONNECTED.
3. Verify the 8 unaccounted Twilio numbers (staging, or leaked?). Release only through the existing lifecycle.
4. Land 048 (ledger) → apply 050 → enter manual costs (Apple Developer, domains, insurance, ad invoices).
5. Write 049 (`customer_acquisition` plus `/go/store` click and UTM content/term capture), then wire it into `getCampaignPerformance` (a single marked placeholder).
6. Consider persisting provider release failures (e.g. a `release_error` column on `twilio_number_quarantine`), so failures stop being inferred.
7. Later: OpenAI Admin key (actual AI cost), App Store Connect reports, ad-platform CSV import, FX rates.
