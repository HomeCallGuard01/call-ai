# Production customer and number reconciliation (2026-10-04)

**READ-ONLY.** Nothing was modified in production, Stripe, RevenueCat, Apple, Twilio or Supabase. No customer was contacted, and nothing was refunded, cancelled, released or purchased.

Masking: email shows its first 3 characters and domain; telephone numbers show their last 3 digits; household ids show 8 characters; payment and transaction ids are not shown.

## Evidence used, and what could not be used

| Source | Access | Used for |
|---|---|---|
| Production Supabase (`psbzynxplxfbyrbdidmn`) | existing service-role configuration in the primary checkout; **`select` and auth GET only** | households, auth timestamps, entitlements, subscriptions, **HCG-stored Stripe webhook payloads** (these include `livemode`, amount, cancellation details), calls, contacts, quarantine, classification, acquisition events |
| Twilio (production account) | existing account credentials; **list/fetch (HTTP GET) only** | number inventory and purchase dates, every call to and from the three numbers with Twilio's own prices, SMS |
| Economics register | `services/finance/assumptions/hcg-unit-economics.v1.json` | number rental **£0.86917 per number per month (KNOWN)**; the first month is charged at purchase (that *is* the purchase cost); inbound **£0.00756 per started minute (KNOWN)** |
| **Stripe (live)** | **not available.** The only key is test-mode. No other credential was sought. | — |
| **RevenueCat / App Store Connect** | **not available** | — |
| Email delivery logs (Supabase Auth, Resend), Railway logs | not available | — |

Without live Stripe access, **whether a charge settled, failed or was refunded cannot be established**. The HCG-stored payloads prove that a *live-mode subscription* existed and that its first invoice was created with `collection_method=charge_automatically`; they do not prove settlement.

---

## Account 1: `op2…@icloud.com` (household `0ffd9843`)

**A. Origin**
- Auth account created **2026-09-28 04:46:04 UTC**. Email/password; confirmed 34 s later; only sign-in 04:46:43.
- **iOS app.** The purchase is an Apple In-App Purchase through RevenueCat, which only the iOS app can make.
- No acquisition event; unclassified. **No HCG account number** (migration 062 is not in production).
- **TestFlight, sandbox or App Review is highly likely, not proven.** The entitlement runs 7 days (to 2026-10-05 04:49 UTC) on a monthly product documented as "no free trial". It was refreshed on day 6 at the purchase time-of-day, which matches daily renewals.

**B. Money**
- **No evidence of any payment.** There is no Stripe record at all.
- HCG holds an entitlement `paid_subscription / apple_revenuecat`, active 2026-09-28 04:48 → 2026-10-05 04:49. **That is an entitlement, not a payment.** Production does not store the store environment, amount or currency.
- Apple revenue, if any, would arrive about 30–45 days after month end, so its absence today proves nothing.
- **Andrew must check:** RevenueCat → Customers → app user `44601df1-…` (full id in Supabase `households.auth_user_id`). A "Sandbox" badge settles it. Alternatively, App Store Connect → Sales and Trends for 28 Sep (a production sale shows as 1 unit).

**C. Cost to HCG**
- Real Twilio number `…647` **purchased 2026-09-28 04:48 UTC**, 2 s after the grant. It is still active, not pending release, not quarantined.
- Rental billed so far: **1 month = £0.87.** The next charge is about 28 Oct.
- Calls, SMS, AI: **none** (Twilio: 0 calls to or from the number, 0 SMS).
- **Identifiable HCG cost ≈ £0.87.**

**D. Journey**
- App never registered for calls; no forwarding; never protected; 0 calls; 0 contacts.
- Emails: Supabase's signup confirmation (clicked). HCG sends no other customer email.
- No provisioning errors.
- Last activity: sign-in on 28 Sep. An Apple renewal-type event updated the entitlement on 4 Oct 04:53.

**E. Recommendation:** **INVESTIGATE FURTHER** (RevenueCat environment).
- **If sandbox, TestFlight or App Review:** classify it as test, then **RELEASE NUMBER** after the entitlement lapses on 5 Oct. Production will mark it pending release for 30 days, then quarantine it; release needs a human confirmation.
- No customer contact and no refund action: Apple handles store refunds.

---

## Account 2: `sni…@icloud.com` (household `ca47d38d`)

**A. Origin**
- Auth account created **2026-08-27 21:36:56 UTC**; confirmed 32 s later; last sign-in **2026-09-07 12:45**.
- **iOS app** (Apple/RevenueCat).
- A Stripe *customer* exists but there is **no Stripe subscription and no Stripe event**, consistent with a checkout that was started but never completed.
- Unclassified; no account number.
- **TestFlight or sandbox pattern, strongly indicated:** four separate Apple grants, 7 Sep → 11 Sep (4 days), 11 → 17 Sep (6 days), 17 → 18 Sep (1 day), 18 → 19 Sep (1 day). Each is a new purchase, and all fall around 12:46–13:17 UTC. Production monthly subscriptions cannot produce 1-day and 4-day periods.

**B. Money**
- **No evidence of any payment.** Entitlements only, all expired (the last ended 2026-09-19 13:13).
- **Andrew must check:** RevenueCat for this customer's app user (full id in Supabase), and Stripe live for the dormant customer: confirm no charge.

**C. Cost to HCG**
- Real number `…513` **purchased 2026-09-07 12:46 UTC** with the first grant. Still active.
- Pending release **2026-10-19**, after which production *quarantines* it; it stays billed until a human confirms.
- Rental billed so far: **1 month = £0.87**; the 2nd month is due about 7 Oct (another £0.87).
- Calls and SMS: **none**.
- **Identifiable cost ≈ £0.87 now, £1.74 after 7 Oct.**

**D. Journey**
- Never registered the app for calls; no forwarding; never protected; 0 calls; 0 contacts.
- Signup confirmation email only. No errors recorded.
- Last activity: 2026-09-07 sign-in (the grants on 11, 17 and 18 Sep arrived by webhook).

**E. Recommendation:** **INVESTIGATE FURTHER** (RevenueCat), then **RELEASE NUMBER**. It is already scheduled to reach quarantine on 19 Oct, and it has no calls ever, so releasing is safe. Classify as test if confirmed. No contact, no refund.

---

## Account 3: `sim…@icloud.com` (household `87fdd35a`): **probably a genuine paying customer**

> **Correction (Andrew, 2026-10-04):** this is probably the customer Andrew already knew about and remembers **refunding**. Do not treat them as newly discovered unless Stripe later proves otherwise. Nothing is to be refunded, contacted or changed. The remaining action is to *confirm* the refund in Stripe (live) and classify the account. The analysis below stands as evidence.

**A. Origin**
- Auth account created **2026-09-06 19:26:27 UTC**; confirmed 39 s later; last sign-in **2026-09-09 11:41**.
- **Web.** HCG recorded `checkout_started` on the web route `/billing/create-checkout-session` at 19:27:52 and `paid_conversion` from the Stripe webhook at 19:29:17. No UTM or referrer.
- **Stripe.** Unclassified; no account number. Their own phone number is on file; 10 trusted contacts uploaded.
- **No evidence of test use:**
  - live mode;
  - an ordinary checkout;
  - real inbound calls from the public network;
  - the customer, not an admin, cancelled with a feedback reason (see B).

  This is the only one of HCG's six live-mode Stripe subscriptions with customer-entered cancellation feedback.

**B. Money**
- **A live-mode £4.99 GBP monthly Stripe subscription**, created 2026-09-06 19:29:10. Status active; `charge_automatically`; a first invoice exists; no trial.
- **Cancelled by the customer** on 2026-09-09 11:35:51 (`cancellation_requested`, feedback **"switched_service"**, which is Stripe's customer-portal cancellation flow). It ended immediately at 12:19:16; the entitlement expired at the same moment.
- **Whether £4.99 was actually collected, and whether it was refunded (and by whom), CANNOT be established** without live Stripe.
- If it was collected and not refunded: gross £4.99, less Stripe fees, and before the VAT question (charges before 20 Sep were made without VAT; accountant decision AD-2).
- **Andrew must check:** Stripe Dashboard (live) → Customers → this customer (search the email shown in the HCG admin) → Payments for 6 Sep: succeeded or failed, refunded or not, and any dispute.

**C. Cost to HCG**
- Real number `…151` **purchased 2026-09-06 19:29 UTC**. Still active.
- Pending release **2026-10-09**, after which production quarantines it; it stays billed until confirmed.
- Rental billed so far: **1 month = £0.87**; the 2nd month is due about **6 Oct** (another £0.87).
- Calls: **9 inbound calls** reached HCG on 7–9 Sep, each 3–10 s and **£0.00756** (Twilio-billed), **£0.068** in total. No SMS, no AI classification, no monitoring.
- **Identifiable cost ≈ £0.94 now, about £1.81 after 6 Oct.**

**D. Journey (the important part)**
1. Paid 19:29 and the number was assigned 19:29 on 6 Sep. Contacts were uploaded and their own phone number saved.
2. **Forwarding worked:** calls forwarded from their phone reached HCG from 7 Sep 08:09 onwards (9 calls up to 9 Sep 11:33). `activation_verified_at` was stamped at 9 Sep 11:39.
3. **The app never registered to receive calls** (`voice_client_registered_at` null). **All 9 calls** were dialled to the app and ended **no-answer**. **These were not test calls to HCG. They were real calls from the customer's own callers, and none of them reached the customer.**
4. Cancelled through the Stripe portal at 11:35 on 9 Sep with the reason "switched service". The last sign-in was 11:41.
5. **No calls since 9 Sep** (Twilio): the customer most probably removed the forwarding.

There are no onboarding emails from HCG beyond Supabase's confirmation. Stripe receipts or emails depend on Stripe Dashboard settings (unknown). No provisioning errors.

**E. Recommendation:**
1. **REFUND CONFIRMATION** (per the correction above): confirm in Stripe live that the £4.99 was refunded. No new customer contact.
2. ~~Customer contact~~: not required. Andrew already handled this customer.
3. **Classify** the account (`genuine_customer` if Andrew does not recognise them).
4. **RELEASE NUMBER** after 9 Oct (via quarantine and confirmation). Twilio shows no calls since 9 Sep, so their phone is no longer forwarding to it.
5. Record this as **the first evidence of the setup-failure mode** (paid, forwarding OK, app never ready, calls lost). It is exactly what the candidate's `SETUP_STALLED` and `CUSTOMER_NEEDS_ATTENTION` events would now surface within 24 h.

---

## Answers to the six questions

**1. How many genuine production paying customers has HCG ever had?**
- **At most one: `sim…` (6–9 Sep), already known to Andrew and, he recalls, refunded.** It is "probable", not "proven": it is unclassified, and money settlement is unverified.
- HCG has recorded **6 live-mode £4.99 Stripe subscriptions** in total:

| Created | Household | Evidence |
|---|---|---|
| 15 Aug | `f8719395` (account since deleted) | ended 22 Aug 16:55, 14 min before Andrew's `and…@gmail.com` signed up |
| 22 Aug | `30f01a7a` `and…@gmail.com` | Andrew's own account (now complimentary) |
| 22 Aug | `f01cfbfc` (deleted) | |
| 23 Aug | `c4609f47` (deleted) | |
| 4 Sep | `466123fa` (deleted) | classified `internal_test` |
| 6 Sep | `87fdd35a` `sim…` | customer-portal cancellation with feedback |

- `30f01a7a`, `f01cfbfc` and `c4609f47` were **all cancelled in the same minute** (23 Aug 18:52, an admin clean-up). None of the first five has customer cancellation feedback.
- Those five are therefore **very probably internal tests**. Three were anonymised, so they cannot be attributed definitively.
- **Apple:** 9 grants ever (`gar…`, `sni…`, `op2…`), all with test-like 1–7-day periods. There is **no evidence of any production Apple sale.**

**2. Genuine customer revenue to date**
- **£0 proven.**
- Very probably **£0 net**, because sim…'s £4.99 was, per Andrew, refunded. Confirm in Stripe.
- If every live-mode first invoice settled unrefunded, the **upper bound is £29.94 gross**, of which **£24.95 is very probably Andrew's own test payments**.
- Settlement and refunds need a live Stripe check. Apple: nothing evidenced.

**3. Real Twilio numbers currently paid for:** **10** (Twilio inventory; every one matched to the DB).

**4. Breakdown**

| Category | Numbers |
|---|---|
| **Genuine, currently paying** | **0** |
| Genuine ex-customer (ended) | 1: `…151` (sim…), pending release 9 Oct |
| Store test / environment unverified | 2: `…647` (op2…), `…513` (sni…, pending release 19 Oct) |
| Reviewer (complimentary) | 1: `…288` (`rev…@homecallguard.co.uk`) |
| Internal test (complimentary) | 2: `…653` (`t-w…@sky.com`), `…533` (`p_d…@sky.com`) |
| Complimentary, unclassified (Andrew's / known tester) | 2: `…063` (`ad_…@yahoo.co.uk`), `…494` (`gar…@gmail.com`) |
| Orphaned, no household | 2: `…510` (quarantined since 23 Sep; very probably Andrew's original number; last call 13 Sep) and `…883` (staging handset test number; **in use**, last call 1 Oct; no voice URL) |

**5. Monthly number rental exposure:** 10 × £0.86917 ≈ **£8.69/month**.
- Releasing the three accounts' numbers plus `…510` would save about **£3.48/month**: £0.87 per number per month, with the next monthly charges about 6 Oct (sim…), 7 Oct (sni…), 28 Oct (op2…).
- Every month any of them stays in quarantine costs another £0.87 each.

**6. Any other genuine or potentially genuine customers not yet discussed?**
- **No further genuine payers were found.**
- **`f8719395`:** a live £4.99 subscription 15–22 Aug, account since deleted. It is very probably Andrew's test, given the timing next to his own re-signup, but it **cannot be attributed with certainty** because the account was anonymised. Worth one look in Stripe live.
- **`gar…@gmail.com` (`3192e94f`):** four Apple test-pattern grants (30 Aug – 11 Sep), now complimentary until 7 Oct, 27 calls, fully protected. It's a known tester or friend, but **unclassified**.
- Sign-ups with **no payment** (no revenue): `hcg…@mailinator.com` ×2, `and…@protonmail.com`, `adh…@gmail.com` (Stripe customer, no subscription), `and…@yahoo.co.uk` (Stripe customer, no subscription). These are probably Andrew's tests.
- **Housekeeping:** 22 households are unclassified. Classifying them in `account_classifications` would make the dashboard exact.

---

## Checks only Andrew can do (exact)

1. **Stripe Dashboard (live) → Payments:**
   - the sim… payment of 6 Sep (succeeded? refunded? disputed?);
   - the 15 Aug payment (`f8719395`);
   - confirm the 22/23 Aug and 4 Sep payments were your own (and refunded, if so).
2. **RevenueCat → Customers:** the app users of op2… and sni… (full ids in Supabase `households.auth_user_id`). Look for the "Sandbox" badge.
3. **App Store Connect → Sales and Trends:** any unit sold 7–28 Sep.
4. Decide on the actions above: refund or contact for sim…; number releases (all through the existing manual quarantine confirmation); account classification.
