# Investigation: unrecognised "Paying" account (28 Sep 2026)

2026-10-04 · **READ-ONLY.** Nothing about this customer or any other was changed, emailed, refunded, deleted, allocated or released.

## Access used and its limits

- **Production Supabase:** the service-role configuration already present in the primary checkout's `.env`, project `psbzynxplxfbyrbdidmn`. This is the same access the 27–28 Sep read-only audits used. Only `select` queries and an `auth.admin.getUserById` GET were issued, from scratch scripts that contain no write calls.
- **One table refused access:** `terms_acceptances` returned `permission denied`. No workaround was attempted.
- **Stripe:** the only key available is **test-mode**, so live Stripe data **could not be read**. Live-mode facts below come from the Stripe event payloads that HCG itself stores.
- **RevenueCat / App Store Connect / Apple payouts:** **no access.** Production (`main` @ `eb43368`) does not store RevenueCat events or their `environment`.
- **Railway logs, Resend logs, Supabase email logs:** no access.

Masking: the email shows its first characters only, the telephone number shows its last 3 digits only, and payment and transaction ids are truncated.

## Findings, answering the 18 questions

| # | Question | Finding | Basis |
|---|---|---|---|
| 1 | Genuine or test? | **Not established with certainty. All evidence points to a non-production Apple purchase (sandbox, TestFlight or App Review), not a genuine paying customer.** See "Why sandbox/TestFlight is the most likely explanation" below. | inference from DB facts + code |
| 2 | Signup | Auth user created **2026-09-28 04:46:04 UTC** (05:46 BST), email/password provider. Email confirmed 04:46:38 (34 s later). First sign-in 04:46:43. Household row created 04:46:40. No acquisition (UTM/referrer) record. | `auth.users`, `households`, `acquisition_events` |
| 3 | HCG account number | **None.** Migration 062 is not applied in production, so no account numbers exist there. | schema |
| 4 | Payment channel | **Apple In-App Purchase via RevenueCat** (`source=apple_revenuecat`, notes "Granted via RevenueCat (Apple In-App Purchase, StoreKit)"). **No Stripe customer, subscription or Stripe event.** | `entitlements`, `households`, `subscriptions`, `stripe_webhook_events` |
| 5 | Payment detail | Entitlement `paid_subscription`, status active. It started **2026-09-28 04:48:29 UTC** and currently ends **2026-10-05 04:49:49 UTC**. The original transaction id is `20000012…1886` (truncated). **Amount, currency, trial or paid status, and environment are NOT recorded by HCG** and cannot be read without RevenueCat or App Store Connect access. | `entitlements` |
| 6 | Did HCG receive money? | **No money is evidenced.** Stripe is not involved. Apple pays developers roughly 30–45 days after the end of the fiscal month, so the absence of Apple money on 4 Oct proves nothing either way. **The "Paying" label is a classification of entitlement *type*, not of money received** (`adminCustomerHealth.describeAccount`: `paid_subscription` ⇒ "Paying"). | code (main) |
| 7 | Routing number allocated? | **Yes.** A real Twilio number `+44 1… …647` became active at **04:48:31 UTC, 2 s after the Apple grant**, through the RevenueCat webhook → `updateTwilioNumberForEntitlementChange`. Attempts 0, no error. | `households` |
| 8 | Number lifecycle now | `twilio_provisioning_status=active`, not pending release, not quarantined. It is billed at about £0.87/month. When the entitlement expires, the production webhook should mark it for release after a 30-day grace period. Not verified, not touched. | `households`, `twilio_number_quarantine` |
| 9 | Forwarding | **Never verified** (`activation_verified_at` null). No carrier or device captured. | `households` |
| 10 | App registered/used | The iOS app was used to sign up and to make the StoreKit purchase. RevenueCat purchases are in-app only. The app **never registered for calls**: `voice_client_registered_at`, `app_platform` and `app_version` are all null. | `households` |
| 11 | Calls reached HCG? | **None** (0 rows in `calls`). Contacts: 0. | `calls`, `contacts` |
| 12 | Emails/messages sent | Supabase's signup confirmation email was sent and clicked within 34 s. **HCG itself has no customer email path** that would have fired (lifecycle comms do not exist; allowance notices are off). No SMS: there were no calls. Supabase/Resend delivery logs: no access. | code + `auth.users` |
| 13 | Errors | None recorded (`twilio_provisioning_last_error` null). Server logs not accessible. | `households` |
| 14 | Why not surfaced before | (a) The 27 Sep admin/usage audit ("0 genuine paying customers") **predates** this signup by about a day. (b) The 4 Oct launch-readiness and integration work was git/doc-only, with no production reads. (c) Production has **no alert** for a new paid signup or for a paid customer stalled in setup: the onboarding monitor is dashboard-only. (d) Production records no store environment, so a sandbox purchase looks identical to a real one. (e) The account is unclassified. | |
| 15 | Other accounts since 1 Sep Andrew may not know | See the table below. **The notable one: `sim…@icloud.com` (87fdd35a)**, a **live-mode £4.99 GBP Stripe subscription** created 6 Sep and deleted 9 Sep. Its number is **still active**, it has 9 calls, and forwarding was verified. Also **`sni…@icloud.com` (ca47d38d)**: four Apple/RevenueCat "paid" periods of 1–6 days (7–19 Sep, all expired). Its number is **still active and billed**. | |
| 16 | Reconcile "8 customers / 1 paying / 7 complimentary / 4 test/reviewer" | **Reconciles exactly** with production rows. The 8 households with a current entitlement are: 1 `paid_subscription` (this account, Apple) + 7 `complimentary/admin_manual`. Of those, 4 are classified test/reviewer: 2 `reviewer` (`app…@`, `rev…@homecallguard.co.uk`) and 2 `internal_test` (`p_d…@sky.com`, `t-w…@sky.com`). The other 3 complimentary accounts are unclassified (`and…@gmail.com`, `gar…@gmail.com`, `ad_…@yahoo.co.uk`). **Cannot cross-check against live Stripe, RevenueCat or Apple** (no access). | |
| 17 | Missing alert? | **Yes, launch-critical.** Production would have needed an alert that a genuine paying customer has been unprotected for more than 24 h. Production would *also* have raised that alert wrongly for this account, because it cannot tell sandbox from production. | |
| 18 | Does the integrated queue catch it? | **Yes, and now correctly.** The candidate queue detects the stalled setup. After today's fix it reports this account as **`PAYMENT_ENVIRONMENT_UNVERIFIED`** ("verify in RevenueCat; not counted as paying"), not as a stalled *paid* customer. A real production-environment purchase in the same state raises `SETUP_STALLED`, plus the new `CUSTOMER_NEEDS_ATTENTION` operational event. Proven in `tests/ops-events-commercial-classification.test.mjs` §7. | test |

### Production households since 1 Sep 2026 (masked)

| Created (UTC) | id | Email (masked) | Class | Current entitlement | Stripe | Number | Calls |
|---|---|---|---|---|---|---|---|
| 09-04 08:19 | bada5c94 | adm…@homecallguard.co.uk | admin | none | cust | none | 0 |
| 09-04 08:49 | 466123fa | (deleted) | internal_test | none (live £4.99 sub 4 Sep, deleted same day) | — | none | 0 |
| 09-05 14:46 | f06bc964 | p_d…@sky.com | internal_test | complimentary → 2027-09-06 | — | active | 21 |
| **09-06 19:27** | **87fdd35a** | **sim…@icloud.com** | **UNCLASSIFIED** | **none: live £4.99 Stripe sub 6–9 Sep** | **yes** | **active (still held)** | **9** |
| 09-07 13:39 | ca819dbe | t-w…@sky.com | internal_test | complimentary → 2027-09-07 | — | active | 0 |
| 09-20 (×6) | … | (deleted ×5), hcg…@mailinator.com ×2, and…@protonmail.com | UNCLASSIFIED | none | 1 cust | none | 0 |
| 09-20 14:45 | 3d0db4cc | adh…@gmail.com | UNCLASSIFIED | none | cust, no events | none | 0 |
| 09-21 17:16 | 9cb62adb | ad_…@yahoo.co.uk | UNCLASSIFIED | complimentary → 2026-10-07 | — | active | 17 |
| 09-26 10:35 | 76c8f319 | and…@yahoo.co.uk | UNCLASSIFIED | none | cust, no events | none | 0 |
| **09-28 04:46** | **0ffd9843** | **op2…@icloud.com** | **UNCLASSIFIED** | **paid_subscription / Apple → 10-05** | — | **active** | **0** |

Before 1 Sep (for completeness): **`sni…@icloud.com` (ca47d38d, 27 Aug)** holds only expired Apple grants (7–19 Sep, periods of 4, 6, 1 and 1 days), yet its **number is still active**.

Live-mode Stripe subscriptions since 1 Sep (from HCG-stored payloads, all `livemode=true`, £4.99 GBP): `466123fa` (internal_test, 4 Sep, deleted the same day) and `87fdd35a` (6–9 Sep). Whether those charges settled or were refunded **cannot be read** with the test-mode key.

## Why sandbox/TestFlight is the most likely explanation (inference, not proof)

1. **Production code has no environment guard.** On `main` @ `eb43368`, `routes/mobileApi.js` treats every RevenueCat grant event the same way: it creates `paid_subscription` and calls Twilio provisioning. The sandbox guard (`f5a920e`, migration 053) exists only on unmerged branches, including this candidate. So a sandbox, TestFlight or App Review purchase **would** produce exactly this record. *(Confirmed.)*
2. **The product is monthly, and the documented launch model is "paid from day one, no free trial"** (`mobile/app/(setup)/subscribe.tsx`). A production monthly purchase on 28 Sep would expire about 28 Oct. This entitlement expires **5 Oct**, exactly 7 days after purchase. *(Confirmed facts; App Store Connect's actual offer configuration is not visible.)*
3. **The 4 Oct 04:53 update** came about 4 minutes after the 04:49 purchase anchor, on day 6. That is what a daily renewal looks like: TestFlight renews monthly subscriptions on an accelerated schedule. A caveat: the production upsert rewrites `ends_at` on every grant event (it compares timestamps as strings, `+00:00` vs `.000Z`), so the update proves *an event arrived*, not that the expiry changed.
4. **A sibling account (`sni…@icloud.com`) shows the same non-production pattern:** irregular 1–6-day Apple periods.
5. Other consistent but weaker signals: an iCloud Hide-My-Email-style address; signup in US working hours; purchase completed but the app never set up for calls, no forwarding, no calls; and Andrew sees no corresponding payment.

**Falsifiable checks:**
- If this was TestFlight or sandbox, the entitlement should **not renew past 2026-10-05 04:49 UTC**.
- **Definitive:** RevenueCat dashboard → Customers → app user `44601df1-…` shows a "Sandbox" badge on the transactions. App Store Connect Sales and Trends shows no unit on 28 Sep.

## Conclusions

1. **HCG classified a store entitlement as "Paying" without knowing whether it was production money.** This is confirmed as a production defect: the label is entitlement-type based and the environment isn't recorded.
2. **A non-production Apple transaction can, and very probably did, cause a real Twilio number to be purchased in production.** The mechanism is confirmed in production code; that this specific transaction was sandbox is highly likely but unproven. The same applies to `sni…@icloud.com`. Each of those numbers is billed at about £0.87/month.
3. **Fixed in the candidate (not deployed):**
   - one commercial classifier (`services/commercial/commercialStatus.js`);
   - the number-purchase provenance guard on every path;
   - honest admin labels and counts;
   - environment-aware exception queue items;
   - the operational event framework that would have notified about this signup *correctly*.
4. **Launch blocker:** until the candidate (with 053) is deployed, production keeps buying real numbers for sandbox, TestFlight and App Review purchases, and keeps labelling them "Paying".

## Decisions for Andrew (nothing done)

- Check RevenueCat or App Store Connect for app user `44601df1-…` (and for ca47d38d's app user) to settle production vs sandbox.
- Decide whether to keep or release the numbers held by `op2…`, `sni…` and `sim…`. That is a manual confirmation through the quarantine flow; **not done**.
- Classify the unclassified accounts in `account_classifications`; **not done**.
- Check in the Stripe Dashboard (live) whether `sim…@icloud.com`'s £4.99 charge on 6 Sep settled or was refunded.
