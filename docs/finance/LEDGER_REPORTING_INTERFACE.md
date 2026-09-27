# Financial ledger: reporting interface for the admin dashboard

Owner: Finance/Pricing workstream. Consumers: the admin dashboard. The dashboard **reads** these interfaces; it doesn't compute money from supplier APIs or keep its own cost tables.

Migration: `051_financial_ledger_and_telephony_usage.sql` (renumbered from 048). **Applied to staging and validated on 2026-09-27; not applied to production.**

## 1. Rules every consumer must follow

1. **Money comes only from `financial_entries`, read through the views below.** Supplier APIs are for ingestion, not display.
2. **Never add amounts across currencies.** The views group by `native_currency`. A single "£" figure must convert explicitly, with the rate and date shown.
3. **UNKNOWN is not zero.** Rows with `amount_quality = 'UNKNOWN'` have no amount. Show the count ("N items not yet priced"), never £0.
4. **Show quality next to money.** ACTUAL, ALLOCATED, ESTIMATED and MANUAL must be distinguishable wherever a total is shown (colour, badge or split).
5. **Unallocated cost is real cost.** `is_unallocated = true` means a supplier charge with no evidence-based household. Show it in business totals and never spread it across customers silently.

## 2. Views (service role only; `security_invoker`)

### `finance_entries_reporting`: one row per ledger entry
All `financial_entries` columns, plus:

| Column | Meaning |
|---|---|
| `dashboard_bucket` | `revenue` · `tax` · `payment_fees` · `telephony` · `ai_transcription` · `infrastructure` · `advertising` · `other` |
| `amount_quality` | `ACTUAL` (the supplier priced it, including an explicit zero) · `ALLOCATED` (a share of a supplier aggregate) · `ESTIMATED` (HCG calculation) · `MANUAL` (entered by a person) · `UNKNOWN` (pending / not observed / unavailable; no amount) |
| `is_unallocated` | A cost or fee with no household |
| `signed_amount` | Revenue positive; refunds, tax, fees and costs negative (native currency) |
| `reporting_month` | Month of `occurred_at` (or `period_start`) |

### `finance_monthly_summary`
Per month × bucket × quality × currency: `entries`, `entries_without_amount`, `signed_total`, `unallocated_signed_total`.

### `finance_household_monthly`
Per household × month × bucket × quality × currency: `entries`, `signed_total`. Rows without a household are excluded; use the summary for them.

### `finance_monthly_contribution`
Per month × currency:

| Column | Contents |
|---|---|
| `revenue`, `tax`, `payment_fees` | As labelled |
| `direct_service_costs` | Telephony + AI |
| `contribution` | Revenue − tax − fees − direct costs |
| `infrastructure`, `advertising` | As labelled |
| `operating_result` | All buckets except `other` |
| `unallocated_costs` | Costs with no household |
| `estimated_or_allocated_part` | The portion not supplier-confirmed per item |
| `unknown_items` | Count of items with no amount |

## 3. Mapping to the dashboard pages

| Dashboard need | Read from |
|---|---|
| Overview P&L | `finance_monthly_contribution`, one row per currency |
| Customer economics | `finance_household_monthly`, plus usage from `telephony_call_legs` (billed minutes by `leg_type`; trusted vs monitored via the linked `calls.status`) |
| Provider economics | `finance_entries_reporting` grouped by `supplier`, `category`, `billing_model` |
| Unallocated cost | `finance_entries_reporting` where `is_unallocated`, grouped by `category` and `evidence->>'allocation_status'` |
| Number cost and anomalies | `services/ledger/numberCostReport.js` (`buildNumberCostReport`) or `scripts/number-cost-report.js --json=…`. This is read-only reconciliation; lifecycle state belongs to the number-lifecycle work. |
| Carrier comparison | `services/finance/carrierComparison.js` with `docs/finance/carrier-quotes.json` |

## 4. What populates the ledger today

| Source | Categories | Provenance |
|---|---|---|
| Twilio calls (per leg) | `inbound_voice`, `app_leg`, `outbound_voice` | ACTUAL, or UNKNOWN until priced |
| Twilio daily usage | `media_stream`, `tts`, `number_rental` | ALLOCATED to calls/numbers, or ACTUAL account-level UNALLOCATED |
| Twilio messages | `sms` | ACTUAL per message |
| OpenAI (no billing access) | `transcription` | ESTIMATED, USD, `unreconciled` |
| Manual schedules (dashboard branch `manual_cost_schedules`) | Overhead categories | MANUAL, `entry_key = schedule:<id>:<period>`. Compatible by design, but that migration must be renumbered above 051 because staging already applied a different 050. |
| Stripe / App Store / Google Play / ads | — | Not built yet (architecture §6) |

## 5. Reconciliation evidence (read-only dry run, 2026-09-27)

- **Ledger £37.93589 = Twilio £37.93589 across all seven categories** (July 22 to September 27), with a £0 discrepancy.
- **Unallocated £25.71:**
  - £13.91 rental of numbers since released (development/test, July–September);
  - £6.95 staging-number rental;
  - £2.61 quarantined test numbers;
  - £1.37 staging/old-architecture/test calls;
  - £0.87 orphan-number rental and £0.005 account-level fees (**unexplained**).
