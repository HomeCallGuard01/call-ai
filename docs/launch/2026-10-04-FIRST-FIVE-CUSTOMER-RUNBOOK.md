# First five genuine customers: operations runbook (2026-10-04)

**Applies after** the five-customer gate (`2026-10-04-FIVE-CUSTOMER-SOFT-LAUNCH-GATE.md`) is GREEN. Nothing here is enabled yet.

Owner: Andrew (founder). Every genuine customer in the first five is followed end to end by a named human.

## 1. Notification configuration (prepared; production email NOT enabled)

The configuration needs migration 072 plus the event runner scheduled (decision D-OPS1). All values are environment variables; no address is in code.

```
OPS_NOTIFY_EMAIL_ENABLED=true                # only after the sender adapter + mailbox are approved
OPS_NOTIFY_ROLE_OPERATIONS_EMAIL=<operations@ mailbox>
OPS_NOTIFY_FOUNDER_EARLY_LAUNCH=true         # first five (and until Andrew turns it off)
OPS_NOTIFY_ROLE_FOUNDER_EMAIL=<Andrew's chosen address — set in Railway, never committed>
OPS_NOTIFY_PUSH_ENABLED=false                # future admin app
```

**Still to build before enabling:**
1. A sender adapter for the chosen provider (Resend is already used for critical alerts). It takes `{ to, subject, text, idempotencyKey }` and must honour the idempotency key.
2. A scheduled call of `runOpsEventScan` (every 15 min), then `deliverDueOpsEvents`.
3. An admin dashboard tile reading `GET /admin/api/ops-events` (unseen count + failed deliveries).

**Until all three exist:** Andrew checks `GET /admin/api/ops-events` (after 072) and the lifecycle exception queue `GET /admin/api/lifecycle/exceptions` **twice daily**.

## 2. Per-signup checklist (one row per customer, kept in the admin "first five" sheet)

| Step | Source of truth | Expected within | If not |
|---|---|---|---|
| 1. **Genuine payment confirmed** | Stripe Dashboard (live) payment of **£5.99** succeeded (launch price, decided 2026-10-04), and the HCG classifier = `genuine_paying` (admin label "Paying"). Store: RevenueCat shows **production** (not Sandbox). | at signup | not genuine: classify it; no further steps |
| 2. **Permanent HCG account number** | `households.account_number` (062), quoted in the `NEW_GENUINE_CUSTOMER` event | at signup | engineering (062 trigger) |
| 3. **Number provisioned** | event payload `numberState=active`; admin onboarding | 5 min | queue `NUMBER_PROVISIONING_FAILED` → admin retry (after checking provenance) |
| 4. **App registered** | `voice_client_registered_at` set; onboarding "App ready" | 1 h | contact the customer (approved wording) |
| 5. **Forwarding confirmed** | `activation_verified_at` for the **current** number | 24 h | `SETUP_STALLED` / `CUSTOMER_NEEDS_ATTENTION (not_protected_within_onboarding_window)` → support contact |
| 6. **First successful protected call** | `delivery_verified_at`; canonical `protected=true`; `CUSTOMER_PROTECTED` event | 72 h | ask the customer for a test call from a trusted contact |
| 7. **Allowance / cost exposure** | Fortress household status (`fc_household_status`): consumed vs budget; daily £ against the £5 auto-hold | daily | auto-hold → review; never release without a reason |
| 8. **Any failed delivery** | delivery health (`UNREACHABLE`/`SUSPECT`), `calls.dial_call_status` ≠ completed | each call | **same day**: the 6 Sep case lost 9 calls because the app wasn't registered and nobody noticed |
| 9. **Any support issue** | support inbox | 4 working hours | log in the sheet |

## 3. Daily routine (first five)

1. Ops events: acknowledge each one (`POST /admin/api/ops-events/:id/seen`).
2. Exception queue: anything `action` or `critical` gets an owner the same day.
3. Twilio usage (Console, read-only) against the HCG ledger: any mismatch above 20% → stop criteria.
4. Fortress overview: breaker state, holds, daily £.
5. Accounting exceptions (if capture is on).

## 4. Stop criteria (pause new sign-ups; kill switch if spend-related)

- An unexplained Twilio line item, or a breaker or kill-switch trip without cause.
- A household auto-held more than once.
- Any genuine customer unprotected for more than 72 h after signup with no contact made.
- Any notification delivery `failed`, or an event unacknowledged for more than 24 h.
- Any delivered-call failure without same-day follow-up.

## 5. Things never to do during the first five

- Release a number without the quarantine confirmation flow.
- Grant complimentary access to "fix" a payment problem without recording it.
- Change the price or allowance mid-cohort without the terms notice.
- Turn on the lifecycle sweep, top-ups or Xero posting.
