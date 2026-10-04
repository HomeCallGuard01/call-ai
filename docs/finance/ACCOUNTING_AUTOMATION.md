# Accounting automation: payments, reconciliation and Xero

Branch `feature/accounting-automation` (from `integration/launch-fortress-2026-10-03` @ `2011ab6`), 2026-10-04.

**Status: built and tested locally only.**
- Nothing is deployed and migration 071 has not been applied anywhere.
- No provider setting has been changed: Stripe, RevenueCat, Apple, Xero and Supabase are untouched.
- Capture is OFF (`ACCOUNTING_CAPTURE_ENABLED` is unset).
- Xero is not connected: there are no credentials, and posting is OFF.
- Every tax and revenue-recognition choice is an open **accountant decision** (§10). Until each is confirmed, the code blocks posting rather than guessing.

---

## 1. Purpose

HCG should not need Andrew to reconcile subscriptions by hand each month. The aim is that every payment, refund, chargeback, fee and payout:

- is recorded once;
- is linked to the customer's permanent **HCG account number**;
- is reconciled against the provider and against entitlement;
- is posted to Xero exactly once.

Anything that can't be done automatically goes to an **exception queue** that explains why.

## 2. What existed before this branch (audit)

| Area | Finding | Where |
|---|---|---|
| Stripe webhook | Only one route. Handles `customer.subscription.created/updated/deleted` plus the top-up `checkout.session.*` and `charge.refunded` events. Every other type is acknowledged with 200 and **discarded**: `invoice.paid`, `invoice.payment_failed`, `charge.dispute.*`, and subscription refunds. | `routes/billing.js` (`POST /billing/webhook`) |
| Stripe dedupe | `stripe_webhook_events` + `claim_stripe_webhook_event` covers subscription events only. Top-ups dedupe on `allowance_credits (source, provider_transaction_id, kind)`. | migrations 011/014/063 |
| Stripe sandbox | The subscription webhook path ignores `livemode`. The top-up path respects it. | `services/allowance/topUpCredit.js` |
| Stripe VAT | Prices are VAT-inclusive. Stripe Tax is on (`automatic_tax`) since **2026-09-20**. Before that date Stripe charged the gross with **no VAT calculated**. The code says AFMD Ltd is VAT-registered (GB379120684). | `routes/billing.js`, `services/checkoutSession.js` |
| Stripe fees | Never stored. They are only read live for the dashboard (`balance_transaction.fee`). | `services/businessControl/stripeRevenue.js`, `services/businessMetrics/revenue.js` |
| Billing Portal | `billingPortal.sessions.create` (web + mobile). No portal configuration id is set. | `routes/billing.js`, `routes/mobileApi.js` |
| RevenueCat | Authenticated by a shared secret. There is **no event-id dedupe**; idempotency comes from entitlement state. It never reads `price`, `tax_percentage`, `commission_percentage` or `cancel_reason`. Refunds are not handled. | `routes/mobileApi.js`, `services/revenuecatWebhook.js` |
| Apple | iOS goes through RevenueCat (`co.uk.homecallguard.app.monthly`). There are no direct App Store Server Notifications and no App Store Connect API key in use. | `mobile/lib/purchases.ts` |
| Google Play | **No Play Billing.** Android pays through in-app Stripe, which is a known Play policy risk. | `docs/architecture/FINANCIAL_DATA_ARCHITECTURE.md` |
| Entitlement | `entitlements` (`stripe` / `apple_revenuecat` / `admin_manual`). There is one canonical decision (070, DRAFT): paid supersedes complimentary, and no channel revokes another channel's paid access. | migrations 011/053/070 |
| Complimentary / test | `entitlement_type` complimentary/partner/staff…; `account_classifications` (internal_test/admin/reviewer/qa_automation). | 011, 031, 069 |
| Financial ledger | 051 `financial_entries` supports revenue/refund/tax/fee rows, but **only costs are ever written**. Revenue is computed live and never stored. | 051, `services/ledger/*` |
| HCG account number | `households.account_number`, format `HCG-` + serial + Luhn (062, DRAFT, backfill not run). | 062, `services/customerIdentity/accountNumber.js` |
| Xero | Not implemented. There is one design note in the allowance handover §13. | `docs/handovers/2026-10-03-customer-allowance-billing-handover.md` |

**Consequence today:** HCG has no stored record of the revenue it has earned, no refund or chargeback accounting, and no fee record. Monthly reconciliation would be entirely manual.

## 3. Authoritative sources

| Question | Authority | Notes |
|---|---|---|
| **1. Entitlement** (may this household use HCG?) | `entitlements` via the existing canonical decision path (Stripe webhook RPC 070; RevenueCat handler) | Accounting **never** grants or revokes access. It only reports disagreements (§8.3). |
| **2. Customer payment** (did money move?) | **Stripe** for web/Android (HCG is merchant of record). **Apple** (and later Google) for in-app purchases, which HCG learns about **through RevenueCat**. | RevenueCat is a *feed*, not a payment channel. |
| **3. Accounting revenue** | The accounting sub-ledger (`accounting_transactions`, 071), built only from the payment authorities above and confirmed by settlements. **Xero** is the book of record once posted. | Store revenue is posted from reconciled **settlement summaries**, never per event. |
| **4. Refunds** | Stripe `charge.refunded` (one record per refund object). Apple/Google refunds come via RevenueCat `CANCELLATION` + `cancel_reason=CUSTOMER_SUPPORT`, and are confirmed by the store report. | A refund always links to its original sale (§5.3). |
| **5. Fees** | Stripe balance transactions, learnt from the **payout** (settlement). Store commission comes from the store's financial report; the RevenueCat `commission_percentage` is only an estimate. | Fees post once per payout or report. |
| **6. Reconciliation** | HCG reconciliation engine (§8). The Xero **bank feed** matches payouts and store remittances to the bank. | The exception queue is the single to-do list. |

## 4. No double counting: the rules

1. **One event type per piece of Stripe money.**
   - Subscription money comes from `invoice.paid`.
   - Top-ups come from the paid `checkout.session.completed` / `async_payment_succeeded` (keyed by PaymentIntent).
   - `charge.succeeded`, `payment_intent.succeeded` and `invoice.payment_succeeded` are recorded as *non-economic*.
   - A subscription-mode Checkout Session is non-economic too: its money arrives as `invoice.paid`.
2. **RevenueCat never duplicates Stripe.** A RevenueCat event with `store=STRIPE` is recorded as `superseded_by_primary` and creates no transaction.
3. **RevenueCat and a future direct Apple feed share one key.** Store money is keyed by the **store transaction id** (`app_store:sale:<transaction_id>`), never by RevenueCat's event id. A RevenueCat redelivery, a replay with a new event id, or a future App Store Server Notification all land on the same row.
4. **Store transactions are a sub-ledger.** Apple and Google pay HCG monthly in arrears, net of commission, and act as the VAT supplier (AD-3). Individual store transactions are therefore never posted to Xero. Only the reconciled **settlement** is posted, as one document per store per period.
5. **Entitlement events are never revenue.** INITIAL_PURCHASE/RENEWAL change access through the entitlement path. Only the money fact goes to accounting.
6. **Complimentary, sandbox and test never become revenue.**
   - `store=PROMOTIONAL`, £0 invoices and free trials are non-economic.
   - Only `livemode:true` (Stripe) and `environment=PRODUCTION` (RevenueCat) are production.
   - A sandbox transaction can never be ready or posted (DB check constraint).

## 5. Transaction model

### 5.1 Tables (migration `071_accounting_transactions.sql`, DRAFT)

| Table | One row per | Uniqueness |
|---|---|---|
| `accounting_source_events` | webhook or report delivery (payload **not** stored, only a SHA-256 digest) | `(source, source_event_id)` |
| `accounting_transactions` | piece of money: sale, refund, chargeback, chargeback reversal | `economic_key` |
| `accounting_exceptions` | open or closed reconciliation condition | `exception_key` (deterministic) |
| `accounting_postings` | Xero posting (outbox) | `posting_key` |
| `accounting_settlements` | Stripe payout / store financial report | `(channel, settlement_ref)` |

### 5.2 `accounting_transactions` fields

**Identity and linkage**
- HCG account / customer: `household_id`, `account_number` (the permanent HCG number; it is the Xero contact and reference).
- Channel and kind: `channel` (stripe / app_store / play_store), `kind`, `environment`, `source`.
- Provider identity: `provider_transaction_id`, `provider_refs` (invoice, charge, payment_intent, subscription, customer, refund, dispute, store transaction ids), `economic_key`.
- Links: `original_transaction_id` (refund/chargeback → sale; reversal → chargeback), `settlement_id`.

**Money**
- `currency` (GBP only accepted today), `gross_minor`, `tax_minor` (VAT), `net_minor` (= gross − VAT, enforced), `fee_minor`, `proceeds_minor` (store).
- `amount_quality`: `provider_actual` (Stripe), `estimated` (RevenueCat) or `settled`.
- `tax_source`: `provider`, `provider_estimate`, `pro_rata_from_original` or `missing`. Missing is never zero.

**Accounting status and Xero**
- `status`: `excluded_sandbox`, `subledger_only`, `blocked`, `ready`, `posting`, `posted` or `failed`.
- `blocked_reasons`: every reason, machine-readable.
- `xero_status`, `xero_reference`, `xero_document_ids`.

Amounts are integers in minor units (pence), never floats.

**Database guards:**
- The money identity (key, channel, kind, gross, currency, provider id, environment) is immutable.
- Once posted, VAT, net, household and account are frozen. Corrections are new transactions.
- A postable row must carry an HCG account number.
- A postable refund must reference its original.
- Fees stay updatable after posting, because Stripe fees are learnt from the payout.

### 5.3 Idempotency and replay safety (three layers)

1. **Source event:** a redelivery of the same event is `duplicate_event` and does nothing. An event whose processing crashed before completion is processed again, which is safe because of layer 2.
2. **Economic key:** a *different* event for the *same money* is `duplicate_economic`. If it describes the money **differently** (e.g. a different amount), a `duplicate` exception is raised. The first record is kept and posting is **held** until a person reviews it.
3. **Posting (§7.4):** one posting per economic key. Each Xero call has a deterministic Idempotency-Key and Reference. Whenever the previous outcome is uncertain, the posting finds the document by Reference first and adopts it.

**Out-of-order delivery.** A refund or dispute that arrives before its sale is stored `blocked` with `refund_mismatch: original_not_found`. When the sale arrives it is re-linked automatically and the exception auto-resolves. A full event log replayed in reverse order, then replayed again, produces the identical ledger (tested).

**Refund VAT.** Stripe does not split VAT on refunds. Refund and chargeback VAT is pro rata from the original's Stripe-reported VAT (`83 × refund/499`). It is never invented when the original has none.

**Over-refund.** If refunds plus chargebacks minus reinstatements exceed the original, the transaction is blocked with `refund_mismatch`.

## 6. Event mapping

### 6.1 Stripe (`services/accounting/normalizeStripe.js`)

| Event | Accounting effect | Economic key |
|---|---|---|
| `invoice.paid` (amount_paid > 0) | sale | `stripe:sale:invoice:<in_…>` |
| `invoice.paid` (amount 0) | non-economic (trial / 100% coupon) | — |
| `checkout.session.completed` / `async_payment_succeeded` (mode=payment, paid) | sale (top-up) | `stripe:sale:pi:<pi_…>` |
| `checkout.session.*` (mode=subscription, or unpaid) | non-economic | — |
| `charge.refunded` / `refund.*` (succeeded refunds only) | refund, one per refund object | `stripe:refund:<re_…>` |
| `charge.dispute.funds_withdrawn` | chargeback (+ dispute fee) | `stripe:chargeback:<dp_…>` |
| `charge.dispute.funds_reinstated` | chargeback reversal | `stripe:chargeback_reversal:<dp_…>` |
| `charge.dispute.created/updated/closed` | non-economic (the funds events carry the money) | — |
| `invoice.payment_failed`, `charge.failed`, `customer.subscription.*` (incl. cancellation) | non-economic, recorded for audit | — |
| anything else | `unhandled_event_type` (recorded, never guessed) | — |

### 6.2 RevenueCat (`services/accounting/normalizeRevenueCat.js`)

| Event | Accounting effect |
|---|---|
| INITIAL_PURCHASE / RENEWAL / NON_RENEWING_PURCHASE (APP_STORE, PLAY_STORE; production; price > 0; not TRIAL) | store sale, **estimated**, `subledger_only` |
| CANCELLATION with `cancel_reason=CUSTOMER_SUPPORT` | store refund, linked to the sale with the same store transaction id |
| CANCELLATION (other reasons), UNCANCELLATION, EXPIRATION, BILLING_ISSUE, PRODUCT_CHANGE, TRANSFER, SUBSCRIPTION_PAUSED… | non-economic |
| `store=STRIPE` | superseded by the Stripe webhook |
| `store=PROMOTIONAL` | complimentary |
| environment ≠ PRODUCTION (incl. missing) | sandbox |
| TEST | ignored |

Store estimates are:
- VAT = price × `tax_percentage`
- commission = price × `commission_percentage`
- proceeds = price − VAT − commission

These are labelled estimates. The store report decides the real figures.

## 7. Xero integration (intended model)

### 7.1 Connection
- **Connection type:** a Xero **custom connection**. This is machine-to-machine OAuth 2.0 client-credentials for one organisation, and is a paid Xero add-on. No user consent screen or refresh-token rotation is needed. Configured via `XERO_CLIENT_ID`, `XERO_CLIENT_SECRET`, `XERO_SCOPES` and optional `XERO_TENANT_ID`.
- **Scopes:** set by configuration. Xero is moving to granular scopes, so confirm the exact names when the connection is created.
- **Posting switch:** posting also needs `ACCOUNTING_XERO_POSTING_ENABLED=true`. **None of this is configured.**
- **API behaviour assumed:** `PUT` creates only. The `Idempotency-Key` header (≤128 chars, roughly 24 h lifetime) is supported on PUT/POST/PATCH. Rate limits are about 60 calls/min and 5,000/day per organisation. Re-verify these against Xero's current documentation when connecting.
- **Adapter:** `services/accounting/xero/xeroClient.js`. It is tested with a fake `fetch` and makes no network calls.
- **Mock Xero:** `services/accounting/xero/mockXero.js`, used by every posting test.

### 7.2 Posting model (subject to AD-6/AD-7)
| Money | Xero documents | Contact | Reference |
|---|---|---|---|
| Stripe sale | ACCREC **Invoice** (VAT-inclusive line, Stripe's VAT amount) + **Payment** into a *Stripe clearing* bank account | HCG account number (no name or email) | `HCG-00010017 stripe:sale:invoice:in_…` |
| Stripe refund | ACCRECCREDIT **CreditNote** + refund **Payment** out of Stripe clearing | HCG account number | `… stripe:refund:re_…` |
| Stripe chargeback / reversal | CreditNote / Invoice on the chargeback account + Payment | HCG account number | `… stripe:chargeback:dp_…` |
| Stripe payout | **SPEND BankTransaction** (fees) in Stripe clearing. The payout itself is matched by the bank feed as a transfer from clearing to the bank. | Stripe | `HCG settlement stripe:po_…` |
| App Store / Play month | One ACCREC **Invoice** to the store contact at net proceeds, *or* gross with a negative commission line (AD-4). Paid by the bank feed. | Apple / Google | `HCG settlement app_store:<period>` |

There are **no default account codes or tax types**. All come from `ACCOUNTING_XERO_ACCOUNT_CODES` (JSON). The keys are:
- `subscription_revenue`, `topup_revenue`
- `stripe_clearing`, `vat_output_tax_type`
- `chargebacks`, `chargeback_tax_type`
- `stripe_fees`, `stripe_fee_tax_type`, `stripe_contact_name`
- `store_revenue`, `store_commission`, `store_tax_type`
- `apple_contact_name`, `google_contact_name`

A missing code blocks the transaction with a `tax_treatment_unconfirmed:account_codes` exception. The store revenue basis comes from `ACCOUNTING_STORE_REVENUE_BASIS` (`net_proceeds` or `gross_with_commission`); until it is set, settlement postings are **held**.

Xero normally creates a contact automatically when an invoice names one that doesn't exist. Confirm this on the target organisation. Pre-creating contacts may be preferred (AD-10).

### 7.3 Account number as the business reference
The HCG account number is:
- the Xero contact name and AccountNumber;
- the first token of every Xero Reference;
- on every exception.

Together these let support and the accountant search Xero by account number and trace any Xero document back to `accounting_transactions` through the economic key in the same Reference. A Stripe transaction for a household without an account number (062 not applied, or backfill not run) is **blocked** with `missing_account`. It posts automatically once the number exists.

### 7.4 Posting queue (`services/accounting/postingQueue.js`)
- **Leased claims:** `FOR UPDATE SKIP LOCKED` in SQL plus a lease, so two workers never post the same row.
- **Plan rebuilt at post time:** the document plan is rebuilt from the *current* transaction and policy. A transaction that is no longer `ready` (e.g. a duplicate was raised) is **held**.
- **Progress persisted per step:** after a crash, the posting resumes at the missing step (e.g. creates only the Payment).
- **Uncertain outcomes:** after a timeout, 5xx, or an expired lease from a worker that died mid-call, every step is looked up by Reference first. If Xero already has the document, it is adopted. A test proves this prevents a duplicate even when the Idempotency-Key is ignored.
- **Error handling:**
  - Xero **unavailable** or not configured: the posting stays queued and consumes no attempt.
  - 429 or network error: exponential backoff capped at 6 h, honouring Retry-After.
  - 400 rejection, or 8 attempts used up: the posting fails and a `failed_xero_posting` exception is raised.
- **Manual retry:** `retryFailed(postingKey, { actor })` re-queues a failed posting. Its completed steps are kept and the lookup-first path runs.

## 8. Reconciliation

### 8.1 Stripe payouts (`services/accounting/settlement.js`)
A payout's balance-transaction lines are matched one by one:
- charge → sale (by charge, payment_intent or invoice);
- refund → refund;
- dispute → chargeback.

On a match, the Stripe **fee** is written onto each transaction. These outcomes raise exceptions:
- unknown line → `unmatched_payment`;
- line amount ≠ transaction amount → `amount_discrepancy`;
- payout total ≠ Σ lines − fees → `amount_discrepancy`.

A clean payout becomes `reconciled` and queues one fee posting.

### 8.2 Apple / Google reports
These reports are aggregated per product, country and **fiscal month**, not per transaction. Reconciliation compares the report's net units and proceeds with the RevenueCat sub-ledger for the same period:
- tolerance is 2% of proceeds (configurable);
- units must match exactly.

Within tolerance the report is `reconciled` and posted as one summary. Otherwise an `amount_discrepancy` is raised. A person can accept it (resolve), and posting then continues.

**Real-file parsers are not written.** The normalised input shape is documented in `settlement.js`. Parsers for the Stripe payout reconciliation report and the Apple/Google financial reports must be written and validated against real files (§13).

### 8.3 Money ↔ entitlement (`services/accounting/reconciliation.js`, report-only)
| Rule | Meaning |
|---|---|
| `paid_without_entitlement` | Production sale with no paid entitlement from that channel covering it |
| `entitled_without_payment` | Active paid production entitlement with no payment on its channel in 35 days (3-day grace) |
| `parallel_paid_channels` | Same household paid on two channels for overlapping periods (customer double-billed) |
| `internal_account_payment` | internal_test / admin / reviewer / qa account paid real money |
| `complimentary_with_payment` | Complimentary-type entitlement still active while the household pays |

Sandbox RevenueCat entitlements are ignored. Re-running never duplicates exceptions, and cleared conditions auto-resolve.

## 9. Exception queue

| Type | Raised when | Who acts | Clears |
|---|---|---|---|
| `unmatched_payment` | money with no recognisable household, or a payout line with no transaction | support / finance | automatically when the customer is linked |
| `duplicate` | same economic key reported with different content | finance (review, then resolve) | by a person; posting then continues |
| `missing_account` | household has no HCG account number | engineering (062 backfill) | automatically |
| `conflicting_entitlement` | §8.3 rules | support | automatically when the condition clears |
| `refund_mismatch` | refund with no original, or over-refund | finance | automatically when the original arrives |
| `failed_xero_posting` | Xero rejected the document, or retries ran out | finance / engineering | automatically when a retry posts |
| `amount_discrepancy` | VAT check failed, payout total mismatch, or store report ≠ sub-ledger | finance / accountant | by a person (accept) or automatically |
| `tax_treatment_unconfirmed` | an accountant decision or account code is missing (**one per decision**, not per transaction) | accountant → operator config | automatically when confirmed |
| `unsupported_currency` | non-GBP money | finance | — |

**Exception lifecycle:**
- A *dismissed* exception stays dismissed if the condition recurs; occurrences are still counted.
- An *auto-resolved* or *resolved* exception reopens if the condition recurs.

## 10. Accountant decisions

Nothing below has been decided. Each item blocks the related posting until it is listed in `ACCOUNTING_CONFIRMED_DECISIONS`, which an operator sets only after sign-off.

| ID | Decision needed |
|---|---|
| AD-1 | AFMD Ltd VAT registration: effective date, scheme (standard / flat-rate / cash) and return periods. |
| AD-2 | Stripe VAT. Is VAT due on charges **before 2026-09-20**, which were collected with no VAT calculated, and how are they corrected? Currently each such charge is flagged `vat_not_calculated` and blocked. |
| AD-3 | Apple and Google as deemed supplier / commissionaire for UK VAT, so HCG has no output VAT on store sales and its supply is to Apple Distribution International. |
| AD-4 | Store revenue basis: net proceeds, or gross with commission as an expense. |
| AD-5 | Recognition timing: at payment, or deferred over the service period (needed if annual plans appear). |
| AD-6 | Xero granularity: per-transaction Stripe invoices (proposed) vs daily/payout summaries; monthly store summaries. |
| AD-7 | Chart of accounts and tax rate codes (`ACCOUNTING_XERO_ACCOUNT_CODES`). |
| AD-8 | Chargebacks: reverse revenue or bad-debt expense; dispute fees. |
| AD-9 | Credit-note VAT for partial refunds and refunds across VAT periods. |
| AD-10 | Is the HCG account number (no name or email) an acceptable Xero contact under the UK simplified-invoice rules and GDPR minimisation? |
| AD-11 | FX for any non-GBP store proceeds. |

The admin status lists all eleven with their confirmed flag.

## 11. Management ledger (051) projection

`services/accounting/financialEntriesProjection.js` maps each transaction to 051 `financial_entries` rows (`source_system='hcg_accounting'`):

| Row | Contents |
|---|---|
| Revenue | gross |
| VAT | Stripe sales only |
| Fee | always emitted; *pending* when unknown, never £0 |

- Store rows are `estimated` and exclude the store's VAT.
- 051 signs every tax row negative, so it cannot hold a VAT reversal. Stripe refunds and chargebacks are therefore projected **ex VAT**, which keeps `contribution` correct. Xero, not 051, is the VAT record.
- The PGlite test proves 051 accepts every row, that the projection is idempotent, and that contribution equals the hand-computed truth.
- **No writer is wired yet.**

## 12. Configuration (all unset today)

| Variable | Effect |
|---|---|
| `ACCOUNTING_CAPTURE_ENABLED=true` | Webhook routes record events into the sub-ledger. Requires 071. |
| `ACCOUNTING_CONFIRMED_DECISIONS=AD-1,…` | Accountant decisions confirmed (operator sets after sign-off) |
| `ACCOUNTING_XERO_ACCOUNT_CODES={…}` | Account codes and tax types; no defaults |
| `ACCOUNTING_STORE_REVENUE_BASIS` | `net_proceeds` or `gross_with_commission` (AD-4) |
| `ACCOUNTING_XERO_POSTING_ENABLED=true` | Allows Xero posting |
| `XERO_CLIENT_ID`, `XERO_CLIENT_SECRET`, `XERO_SCOPES`, `XERO_TENANT_ID` | Xero custom connection |

**Admin status (read-only):**
- `GET /admin/api/accounting/status`
- `GET /admin/api/accounting/exceptions?status=open`

Both are behind `requireAuth` + `requireAdmin`. They return 503 with a reason until 071 is applied.

**Manual worker (not scheduled):** `node scripts/accounting-run.js [--reevaluate] [--entitlements] [--post]`. With no flags it is read-only. `--post` refuses unless Xero is enabled and configured.

## 13. Gaps and risks (honest list)

**Not built or not wired**
1. **Stripe webhook subscriptions.** The Stripe Dashboard endpoint must also send `invoice.paid`, `charge.refunded`, `charge.dispute.funds_withdrawn` and `charge.dispute.funds_reinstated`. Changing this is a provider setting and has **not** been done. Until it is, only the event types already subscribed reach the capture hook.
2. **Stripe API version.** Newer API versions (2025 "basil" onwards) moved `invoice.charge` / `invoice.payment_intent` and `charge.invoice` into invoice payments. Refund→sale matching then relies on the payment_intent or charge. If neither is present, refunds raise `refund_mismatch` until matched via the payout. Check the webhook endpoint's API version before enabling capture; an `invoice_payments` lookup may be needed.
3. **Capture failure is not retried by the provider.** The route still returns its normal status. Missed events show up as `unmatched_payment` at payout reconciliation and can be re-fed from the Stripe Events API (30 days). A backfill script is not written.
4. **No settlement parsers** for real Stripe payout reports or Apple/Google financial reports. There is no App Store Connect API key in use, and Play Billing does not exist.
5. **Not wired:** the 051 writer, the scheduled worker, and admin actions (resolve / dismiss / retry from the UI). Those functions exist in the services but have no routes, because they write.

**Unverified**
6. RevenueCat `commission_percentage` / `tax_percentage` presence and meaning per store should be verified on a real production event.
7. Real multi-connection concurrency (`SKIP LOCKED`) is proven only on single-connection PGlite. Repeat it on real PostgreSQL / staging.

**Known limitations**
8. Only GBP is accepted. Other currencies raise `unsupported_currency`.
9. Android in-app Stripe remains a Play policy risk. If Play Billing is adopted, the `play_store` channel is ready in the model; it arrives through RevenueCat.

## 14. Activation runbook (none of this has been executed)

1. Accountant reviews §10 and confirms or amends AD-1…AD-11, and supplies codes (AD-7).
2. Andrew decides Xero granularity (AD-6) and buys a Xero custom connection (or chooses a demo organisation first).
3. Apply 062 (account numbers) and 071 on **staging**. Run the 062 backfill.
4. Set `ACCOUNTING_CAPTURE_ENABLED=true` on staging. Subscribe the staging Stripe webhook to the §13.1 events. Replay sandbox events and confirm they record as `sandbox`.
5. Run the `scripts/accounting-run.js` report and review the exceptions.
6. Connect a Xero **demo company**. Post the staging data with test codes, and verify the documents and idempotency (retry, timeout, find-by-reference).
7. Production: apply 071, enable capture (no posting), and let the sub-ledger fill for a full month. Reconcile one Stripe payout and one Apple month by hand against the system.
8. Only then set `ACCOUNTING_CONFIRMED_DECISIONS`, the account codes and `ACCOUNTING_XERO_POSTING_ENABLED` for production, and schedule the worker.

## 15. Tests

| File | What it proves |
|---|---|
| `tests/accounting-engine.test.mjs` | 29 scenarios against the in-memory reference store: duplicate Stripe/RevenueCat events, Apple+Stripe no double count, refunds (full/partial/over/out-of-order/Apple), chargebacks, cancellation, payment failure, multiple channels, complimentary, sandbox/test, VAT, accountant gates, missing account, entitlement conflicts, Xero unavailable, retry after failure (with and without Idempotency-Key support), rejected → manual retry, exhausted retries, crash mid-plan, concurrent workers, full reverse-order replay, Stripe payout, App Store settlement, frozen posted money, top-ups |
| `tests/accounting-store-parity.pglite.test.mjs` | The **same 29 scenarios** through the 071 SQL functions on PGlite, plus direct SQL guards: immutability, frozen posted VAT, sandbox never postable, account required, refund requires original, service-role-only access, rollback refuses while anything is posted |
| `tests/accounting-units.test.mjs` | Normalisers, policy, VAT check, Xero mapping, the Xero HTTP adapter (fake fetch: token, PUT, Idempotency-Key, error classes, find-by-reference), capture hook (off by default, never throws), hook placement in the routes, admin route auth/503, and SQL vocabulary = JS constants |
| `tests/accounting-ledger-projection.pglite.test.mjs` | 051 accepts every projected row; projection is idempotent; contribution equals the economic truth |
| `tests/migration-allocation.test.mjs` | 071 allocated with a rollback |
