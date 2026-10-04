# Accounting and operations: launch minimum for the first five customers (2026-10-05)

Review of the accounting automation (`docs/finance/ACCOUNTING_AUTOMATION.md`), support, refunds and escalation. **No Xero connection, no posting, no capture switched on.**

## Verdict

The accounting automation does **not** need to be on for the first five. Records for the cohort:
- **Stripe** for its own invoices, charges and refunds (plus Stripe Tax reports for VAT);
- **App Store Connect** financial reports, if iOS is offered.

Accounting capture stays **OFF in production** until staging gate G20 passes.

## MUST be true before the first genuine customer

1. **Live £5.99 Stripe Price, `tax_behavior=inclusive`**, and `STRIPE_PRICE_ID` pointing at it (otherwise no price is shown at all: `services/subscriptionPricing.js` fails closed). See the price-cutover checklist.
2. **Stripe Tax live:** UK registration active. **Evidence:** the first live charge shows **VAT £1.00 on £5.99**. A £0 VAT result repeats the pre-2026-09-20 bug.
3. **Stripe customer emails on:** successful payment and refund receipts, with business name, address and VAT number. The Stripe receipt is the customer's only billing document.
4. **Terms match the price** (done in source tonight; publish with the deploy after sign-off D-P3).
5. **Billing Portal** cancels at the period end with no proration refunds (matches terms §5).
6. **Written cohort refund rule** (decision L-5 below).
7. **Support inbox owner and a twice-daily check.** Critical alerts also land in `support@` until operations@ exists.
8. **Accounting capture OFF.** Turning it on before G20 puts a 2-second-bounded dependency in front of webhook entitlement handling.

## CAN follow within two weeks

- G20 on staging → capture ON in production in shadow mode (no posting).
- Subscribe the Stripe webhook to `invoice.paid`, `charge.refunded`, `charge.dispute.funds_withdrawn`/`funds_reinstated`.
- **Accountant brief (send now; no answers needed before launch):**
  - AD-1: VAT registration date, scheme and periods;
  - AD-2: the pre-2026-09-20 no-VAT charges, including the £4.99 charge on 6 Sep;
  - AD-3/AD-4: Apple as the supplier, net vs gross;
  - confirm "Stripe + Stripe Tax + ASC reports, no Xero posting" is acceptable for the first quarter.
- Set up the operations@ mailbox and turn on the notification email (`docs/launch/2026-10-04-FIRST-FIVE-CUSTOMER-RUNBOOK.md` §1).
- Written refund and dispute policy (D-B2).

## LATER (public launch)

- Xero connection and a demo-company dry run.
- AD-5…AD-11.
- Payout and store report parsers.
- Scheduled worker.
- Play Billing.
- An admin deletion route for emailed requests.

## Separation of records (prevents duplicate invoices or revenue)

| Channel | Source of truth | Never |
|---|---|---|
| Stripe (web/Android) | Stripe invoices, charges and refunds; Stripe Tax for VAT; balance transactions for fees. Only `invoice.paid` counts as subscription revenue | A second customer invoice from HCG or Xero. Running the HCG poster **and** a Stripe→Xero app |
| Apple (iOS) | ASC proceeds (net of commission and VAT), monthly, one entry per store per month | Booking RevenueCat "revenue", or both gross and net |
| RevenueCat | Entitlement and event feed only | Money |
| Entitlement | `entitlements` via the canonical paths (070 + the RevenueCat handler) | Accounting granting or revoking access |
| Admin "Business Control" figures | Live estimates | Treated as a record |

**Isolation proven:** `tests/accounting-integration-safety.test.mjs`. Accounting is off by default and bounded; it never writes entitlements, households, subscriptions or Fortress tables, and production refuses posting without confirmed decisions.

## Support, refunds, escalation for the first five

**Exists:**
- `support@homecallguard.co.uk` (site, app, terms). Public promise: reply within 1 business day; internal target: 4 working hours.
- Stripe self-serve cancellation (period end).
- Apple cancellation in iOS Settings (now in the terms, in source).
- 14-day statutory right (terms §10).
- In-app deletion cancels Stripe immediately.

**Gaps for the cohort:**
1. A written refund rule (L-5).
2. Support inbox owner and a daily check.
3. If iOS is offered: the live 1.0.1 build and its screenshots still show the withdrawn 30-day guarantee.

**Fine for five:**
- Manual email deletions.
- A named human as escalation (complaints procedure later).
- Stripe Dashboard refunds.
- No operations@ yet (provided support@ is checked twice daily).
- A Stripe refund does **not** end access by itself: refund **and** cancel the subscription in the same action.
- An Apple refund is recorded and alerted (migration 073), and access is not cut automatically (decision D-A1).

## Decisions (batched)

| # | Decision | Recommendation |
|---|---|---|
| L-5 | Cohort refund rule | Full refund on request within 14 days, with no deduction for the first five. Otherwise terms §5. Refunds are done in the Stripe Dashboard together with an immediate subscription cancel. If someone pays on both channels, refund and cancel Stripe and tell them to cancel Apple |
| L-6 | Send the accountant brief (AD-1…4) now | Yes |
| L-7 | Approve the Stripe Dashboard items (Price, Tax, emails, Portal) as one batch at cutover | Yes |
