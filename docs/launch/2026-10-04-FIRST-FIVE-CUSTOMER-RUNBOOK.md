# First five genuine customers: operations runbook (2026-10-04)

**Applies after** the five-customer gate (`2026-10-04-FIVE-CUSTOMER-SOFT-LAUNCH-GATE.md`) is GREEN. Nothing here is enabled yet.

Owner: Andrew (founder). Every genuine customer in the first five is followed end to end by a named human.

## 1. Notification configuration (prepared; production email NOT enabled)

Built 2026-10-05 (launch sprint): Resend sender with idempotency (`services/opsEvents/emailSender.js`), milestone numbering (each genuine customer is numbered; **#1–5, 10, 25, 50, 100 are flagged "MILESTONE"**), and a 15-minute schedule (`services/opsEvents/scheduler.js`). All of it is OFF until configured. Tests: `tests/ops-notifications-launch.test.mjs`. The schedule needs **migration 072** in production. All values are environment variables; no address is in code.

```
OPS_EVENTS_SCHEDULE_ENABLED=true             # scan + deliver every 15 min (dashboard alert even with email off)
OPS_NOTIFY_EMAIL_ENABLED=true                # only after the operations@ mailbox exists (startup refuses it without Resend + recipient)
OPS_NOTIFY_ROLE_OPERATIONS_EMAIL=<operations@ mailbox>
OPS_NOTIFY_FOUNDER_EARLY_LAUNCH=true         # first cohort: Andrew gets every event too
OPS_NOTIFY_ROLE_FOUNDER_EMAIL=<Andrew's chosen address — set in Railway, never committed>
OPS_NOTIFY_FROM_EMAIL=<optional; default alerts@mail.homecallguard.co.uk sender>
OPS_NOTIFY_PUSH_ENABLED=false                # future admin app
```

**Guarantees (tested):**
- Only canonical genuine paying customers produce `NEW_GENUINE_CUSTOMER`. Reviewer, internal/test, Apple sandbox/TestFlight, unverified store, Stripe test and complimentary accounts never do.
- Each event is recorded exactly once, and never renumbered on a re-scan.
- A retry reuses the same `Idempotency-Key`, so a lost response cannot send a second email.
- After 5 attempts a delivery is marked `failed` (visible in admin).
- Nothing here is imported by any billing, entitlement, webhook or provisioning path.

**Before enabling email:** create the operations@ mailbox, then send **one test** through the staging window (the staging start script currently refuses `OPS_NOTIFY_EMAIL_ENABLED=true`; relax it only for that attended test).

**Until email is on:** Andrew checks `GET /admin/api/ops-events` (after 072) and the lifecycle exception queue `GET /admin/api/lifecycle/exceptions` **twice daily**.

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

---

# Additions for the controlled cohort (WS4, 2026-10-10)

**Additive only; §1–§5 above are unchanged.** Branch `launch/ws4-payments-ops`, not merged or deployed. Where this section and §2 differ, this section reflects the 2026-10-09/10 decisions: cohort ≤5, **Android only** (Play Internal track), invite-only (`NEW_SUBSCRIPTIONS_ALLOWLIST`), iOS off sale, **£5.99** for new members, **Option C** (the Android app takes no payment: customers pay on the website, then sign in).

## 6. How a cohort customer joins (Option C)

1. Andrew adds the customer's email to `NEW_SUBSCRIPTIONS_ALLOWLIST` (Railway) **and** to the Play Internal testers list.
2. **By email (outside the app):** send the website sign-up link. The app must never contain a link, button, QR code or price for web checkout (Google Play Payments policy; `tests/android-option-c-consumption-only.test.mjs` enforces it). Emails are not restricted.
3. The customer subscribes on the website (Stripe, £5.99 incl. VAT), then installs the Play Internal build and **signs in with the same email**.
4. An Android account without a membership sees only: "This account doesn't have an active membership yet. Membership is set up on our website, homecallguard.co.uk." Support must not tell customers they can pay in the app.

## 7. Support-verified "Protected" (replaces §2 step 5’s `activation_verified_at`)

Since LF-2 (074) only `forwarding_proven_at` makes a customer Protected, and for the cohort only support writes it (migration 075, `2026-10-09-SUPPORT-VERIFIED-PROTECTION.md`). Prerequisites: 075 applied; `HCG_SUPPORT_VERIFICATION_CALLERS=<support phone, E.164>` set (otherwise the action returns 503).

Per customer, **attended** (phone or video, customer present):
1. The customer turns on forwarding using the app's instructions (§9.1) and says it is on.
2. From the **designated support phone**, dial the **customer's own mobile number** (never the HCG number).
3. The call must ring **in the HCG app**; the customer answers **in the app**, then hangs up.
4. Open `/admin/forwarding-proof?household=<household id>` within 60 minutes. Pick the call marked **eligible**, enter the **last 4 digits you dialled**, write who was present and what was seen (≥ 10 characters), type `RECORD FORWARDING PROOF`, select Record.
5. Ask the customer to refresh the app: it now shows Protected. Tick §2 steps 5 and 6.
6. **Clear the proof** (`CLEAR FORWARDING PROOF`) whenever the customer turns forwarding off, cancels, changes SIM or carrier, or says calls stopped arriving in the app.
7. Weekly: for each Protected customer, check that at least one call reached HCG in the last 7 days; if none, contact them (forwarding may have been turned off).

If step 3 fails (the call rings the phone normally, or nothing arrives in the app): do not record anything; work through §9.1 for their carrier, then retry.

## 8. Money: price, grandfathering, refunds, top-ups

**Price.** New members pay **£5.99/month including VAT** (the Stripe Price `STRIPE_PRICE_ID` points at). The Membership screen shows each household its own price on iOS and on the website; the Android app shows "Billed through our website" and no amount.

**Grandfathering (existing £4.99 subscribers).** They stay on their £4.99 Price for as long as their subscription continues. Proven in code (`tests/grandfathering-old-price.test.mjs`): renewals on the old (even archived) Price keep the same entitlement, number and plan; nothing in HCG compares a subscription's Price with `STRIPE_PRICE_ID`; no code changes a subscription's Price. Rules for support:
- **Never** move a £4.99 subscriber to £5.99 (no "update subscription" in the Stripe Dashboard). Moving anyone needs ≥ 30 days' notice under terms §3 and Andrew's decision (D-P2).
- **Archive, don't delete**, the old Price at cutover. Archiving stops new checkouts using it; existing subscriptions keep renewing on it (Stripe behaviour; not re-verified live by WS4).
- Stripe Billing Portal: **"switch plan" must be OFF** (cancel at period end only), so the portal can't offer a £4.99 subscriber a plan change. Console check for Andrew; HCG code never opens a plan-switch flow.
- A grandfathered customer who cancels and later re-joins pays the current price.

**Refund rule for the cohort (Andrew, 2026-10-10): a full refund on request within 14 days of the first payment, no questions asked. Refund and cancel happen together, never one without the other.** Order matters, because cancelling while forwarding is still on can leave calls going to a number that is about to be withdrawn:
1. Ask the customer to **turn off call forwarding first** (§9.3), then confirm with a test call from the support phone that it rings their phone directly (and does not appear in the app).
2. `/admin/forwarding-proof`: **Clear** the proof (reason: "refund + cancel on request").
3. Stripe Dashboard (live) → the customer's subscription → **Cancel immediately** (not at period end).
4. Stripe Dashboard → the payment → **Refund the full amount**. (Stripe's cancel dialog may also offer to refund the last payment; either way, check the payment shows "Refunded".)
5. Check the webhook landed: the household's entitlement is no longer active, and an alert email "Stripe refund recorded" arrived at support@ (from 2026-10-10 code). The number moves to the grace period and then quarantine; it is never auto-released.
6. Send the refund macro (§10.5). Record it in the first-five sheet.
Outside 14 days: terms §5/§10 apply (no partial-month refunds except legal rights or billing errors); escalate to Andrew. **Disputes (chargebacks):** an alert "Stripe DISPUTE opened" arrives; Andrew responds in the Stripe Dashboard before the deadline. Do not refund a disputed payment separately (that can double-refund).

**Top-ups.** None are sold to the cohort (`ALLOWANCE_TOPUPS_ENABLED` off; no products configured; the Android app could not sell them anyway). If a customer's allowance runs out: tell them the date it resets (shown in the app), that calls from unknown numbers aren't checked until then, and that they can turn off forwarding meanwhile so calls ring the phone directly. Any extra allowance is **Andrew's decision**, applied by engineering as an audited Fortress adjustment; never by granting complimentary access, and never by raising the global budget.

## 9. Notifications the cohort relies on (verified 2026-10-10)

| Situation | How support hears about it | Tested in |
|---|---|---|
| New genuine customer | ops event `NEW_GENUINE_CUSTOMER` (numbered; #1–5 flagged MILESTONE) | `ops-notifications-launch` |
| App unreachable after it worked | ops event `CUSTOMER_NEEDS_ATTENTION` reason `protection_lost_app_unreachable` (immediate) | `ops-notifications-customer-ops` |
| App never registered ("failed registration") | `CUSTOMER_NEEDS_ATTENTION` reason `not_protected_within_onboarding_window`, blocker `appReachable` (after 24 h; there is no earlier signal) | `ops-notifications-customer-ops` |
| Number provisioning failed | `CUSTOMER_NEEDS_ATTENTION` reason `number_provisioning_failed` + exception queue | `ops-notifications-customer-ops` |
| Forwarding not proven | `CUSTOMER_NEEDS_ATTENTION` reason `forwarding_not_proven` → §7 | `lf2-forwarding-proof` |
| Payment failed | **new:** real-time alert email "Stripe membership payment FAILED" (`invoice.payment_failed`) + ops event reason `payment_failed` (once per failed period) | `ops-notifications-customer-ops` |
| Refund recorded / dispute opened or closed | **new:** real-time alert emails from the verified Stripe webhook | `ops-notifications-customer-ops` |

Prerequisites: ops events need migration 072 and `OPS_EVENTS_SCHEDULE_ENABLED=true` (§1); alert emails need `Resend_API_Key` and go to support@. **Andrew (console):** the live Stripe webhook endpoint must be subscribed to `invoice.payment_failed`, `charge.refunded`, `charge.dispute.created` and `charge.dispute.closed` (in addition to the `customer.subscription.*` events), or those alerts never fire. Not verified by WS4 (no console access).

Known gaps: a sign-up that fails before a household exists produces nothing (watch the support inbox); refunds/disputes are alert emails, not dashboard ops events (they would need a migration to 072's event types); store (Apple/Google) payment failures aren't covered here (no store sales in the cohort).

## 10. Support macros (plain text; send from support@, quote the HCG account number, never ask for card details)

Placeholders: `<name>`, `<HCG account>`, `<date>`.

### 10.1 Setting up call forwarding (by carrier)

The app always generates the exact steps for the customer's carrier (during setup, and afterwards from **Account → Help & support → set up call forwarding**, or the Home screen's "set up forwarding" action). Only cohort-eligible carriers can pay (the website checks the network first: **Tesco Mobile and 1pMobile are not supported; Lyca, VOXI, Asda and "other" are unconfirmed and blocked until confirmed**).

> Hi `<name>`, here's how to send your calls through Home Call Guard. Open the Home Call Guard app and go to **Account → Help & support**, then **Set up call forwarding**. It shows the exact steps for your network:
> - **O2, Vodafone, Lebara, EE, SMARTY, iD Mobile, Talkmobile, Sky Mobile:** tap the button to dial the forwarding code the app shows (it starts `**21*` and includes your Home Call Guard number), then press call. You'll see a message that forwarding is on.
> - **Three and giffgaff:** these networks don't accept the code. Open your phone's **Phone app → Settings → Calls/Supplementary services → Call forwarding → Always forward**, and enter the Home Call Guard number shown in the app.
> Once it's on, reply to this email and we'll arrange a quick test call with you to confirm everything works. Your account: `<HCG account>`.

### 10.2 Screening paused (allowance used up)

> Hi `<name>`, this month's protection allowance on your account has been used up, so calls from unknown numbers aren't being checked for scams until it resets on `<date>` (the app shows this too). Calls from your trusted contacts are not affected by screening. If you'd rather calls rang your phone directly until then, you can turn off call forwarding (Account → "Need to turn protection off?") and turn it back on after `<date>`. If you have any questions, just reply. Account: `<HCG account>`.

*(Check the app's actual state first: if the household is in the "calls may not get through" mode, say so plainly instead: "calls forwarded to Home Call Guard may not get through until `<date>`, so we recommend turning forwarding off until then.")*

### 10.3 Turning off call forwarding

> Hi `<name>`, to stop your calls going through Home Call Guard, open the app and go to **Account → "Need to turn protection off?"**. It shows the exact code or phone setting for your network. On most networks you dial the code shown and press call; on Three and giffgaff you switch off **Always forward** in your phone's call settings. Afterwards, ask someone to ring you: the call should ring your phone normally and not appear in the Home Call Guard app. Account: `<HCG account>`.

### 10.4 Cancelling

> Hi `<name>`, you can cancel any time with no fee. Sign in to your account on our website and choose **Manage Membership**, or simply reply to this email and we'll cancel it for you. Your protection continues until the end of the month you've paid for. **Important:** cancelling doesn't switch off call forwarding on your phone, so please turn it off before your protection ends (Account → "Need to turn protection off?" in the app), otherwise calls may not reach you. Account: `<HCG account>`.

*(The Android app has no Manage Membership button by design (Play policy); the website does. If support cancels, use Stripe "cancel at period end" unless a refund is being given (§8).)*

### 10.5 Refund (within 14 days, cohort rule)

> Hi `<name>`, we've cancelled your membership and refunded your payment of `<amount>` in full. Refunds usually reach your card within 5–10 working days, depending on your bank. Before we did this you turned off call forwarding, so your calls now ring your phone directly as before. Thank you for trying Home Call Guard; if you have a moment, we'd really value a line on what didn't work for you. Account: `<HCG account>`.

*(Send only after §8 steps 1–5 are done. `<amount>` = the amount actually refunded in Stripe.)*
