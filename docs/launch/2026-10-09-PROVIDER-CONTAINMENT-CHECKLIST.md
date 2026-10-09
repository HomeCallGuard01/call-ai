# Provider containment checklist: Twilio, OpenAI, Stripe (2026-10-09)

**Status:** document only. No console, API or account was opened, read or changed. Every step is for Andrew to do.
**Production:** `eb43368`. **Candidate (RC):** `ad545a1`.
**Builds on** `docs/integration/2026-10-04-PROVIDER_FINANCIAL_CONTAINMENT_FINAL.md` (FINAL) and `2026-10-04-TWILIO_CONTAINMENT_CHECKLIST.md`. Those documents cover detail and the Twilio questions Q1–Q12; this one does not repeat them.
**Evidence folder:** `docs/security/evidence/provider-config-2026-10-DD/`. Save dated screenshots or exports, and never save a secret.

**Definitions**
- **HARD LIMIT:** the provider itself refuses further billable activity.
- **ALERT:** only tells you; the spend continues.
- **PREVENTIVE CONFIG:** removes a path or a capability. It is not a £ limit.

## 1. Summary

| Provider | Control | Type | What it bounds | Where (console) | Evidence | When |
|---|---|---|---|---|---|---|
| OpenAI | Project spend limit with **Enforce a hard limit** on | **HARD LIMIT** (monthly; HTTP 429 `project_spend_limit_exceeded`; "can slightly exceed") | All spend on the key in production, including the forged `/media-stream` and `/process` paths | Project settings → Limits → Spend → Edit spend limit | Screenshot showing the amount and enforcement on | **Now** |
| OpenAI | Organization spend limit, enforced | **HARD LIMIT** (monthly; 429 `organization_spend_limit_exceeded`) | All projects and keys in the org | Organization → Limits → Spend → Edit spend limit | Screenshot | **Now** |
| OpenAI | Auto-reload off (or a monthly reload cap) | PREVENTIVE CONFIG (keeps the prepaid stop meaningful) | Card top-ups | Settings → Billing | Screenshot | **Now** |
| OpenAI | Spend alerts / notification threshold | ALERT | — | Limits → Spend alerts | Screenshot | Now |
| OpenAI | Production key is project-scoped with restricted permissions (Model capabilities only); no Admin key on Railway | PREVENTIVE CONFIG | A stolen key cannot raise limits or reach other endpoints | Project → API keys | Key list (names and last-4 only) | Now (verify); restrict at deploy |
| Twilio | Pay-as-you-go balance, **auto-recharge OFF**, balance kept at a small **B** | **HARD LIMIT, leaky** (suspension at about £0; in-progress calls continue; overrun **O** undocumented) | Total Twilio spend ≈ B + O + rental R | Billing → Auto-recharge; Billing → Add funds | Screenshot of balance and auto-recharge OFF | **Now** |
| Twilio | Messaging geo permissions: **UK only** | **HARD LIMIT** on destinations; **cannot be changed by API** | SMS to non-UK numbers (pumping, IRSF) | Messaging → Settings → Geo permissions | Screenshot | **Now** |
| Twilio | Voice geo permissions: **all countries off, GB included** | HARD LIMIT on outbound, but **API-reversible with the master token** | Outbound PSTN, premium and international numbers | Voice → Settings → Geo permissions | Screenshot plus Monitor → Events (90 days) | **Now** |
| Twilio | 24-Hour Maximum Call Duration **disabled** | HARD LIMIT (4 h per call) | Length of any one call | Voice → Settings → General | Screenshot | Now (verify) |
| Twilio | Voice fallback URL → TwiML Bin `<Response><Reject/></Response>` on every number and on the TwiML App | PREVENTIVE CONFIG (a rejected call is not billed); API-reversible | Calls during an HCG outage | TwiML Bins; Phone Numbers → each number → "Primary handler fails"; Voice → TwiML Apps | Screenshot of each number | **Now** (console only) |
| Twilio | Usage triggers: `totalprice` daily and monthly, `sms-outbound` daily, `calls-outbound` ≥ 1, `phonenumbers` | **ALERT** (checked "about once a minute"; fires at most once per period) | Detection only | Usage / Billing → Usage triggers | Trigger list export | Now with **email**; webhook at deploy |
| Twilio | Trigger webhook → `/webhooks/provider-usage-alert` → Fortress kill switch | Application stop. **Not** a provider limit | Stops HCG-initiated spend. Does not stop an attacker using the token | Trigger callback URL + `PROVIDER_USAGE_ALERT_TRIP_TRIGGER_SIDS` | Trigger SID in env; drill on staging | **At deploy** (the route does not exist on `eb43368`) |
| Twilio | Low-balance email | ALERT | — | Billing → Low balance | Screenshot | Now |
| Twilio | Subaccount + Restricted key; master token offline | PREVENTIVE CONFIG (credential scope) | Stolen backend credential | Account → Subaccounts / API keys | Key list | Before scaling past 5 |
| Stripe | Archive the live Price (stop sales until deploy) | PREVENTIVE CONFIG | New subscriptions → new numbers, Twilio and OpenAI cost | Product catalog → product → price ⋯ → Archive price | Screenshot | **Now** (decision P0-1) |
| Stripe | Checkout requires login (already true in prod); Stripe-hosted Checkout card-testing protection (rate limits, CAPTCHA) | PREVENTIVE CONFIG (built in) | Card testing → dispute fees, decline-rate damage | — (code) | n/a | Exists |
| Stripe | Radar: default rules on; custom velocity rules **only on Radar Plus/Pro** | PREVENTIVE CONFIG | Fraud and card testing | Radar → Rules | Screenshot of plan and rules | Before scaling |
| Stripe | Webhook endpoint: signing secret, only the needed events | PREVENTIVE CONFIG | Forged billing events (`constructEvent` already enforced) | Developers → Webhooks | Endpoint/events screenshot (no secret) | Verify now |
| Stripe | Restricted key (`rk_live_`) + access policy (ASN/country) instead of `sk_live_` | PREVENTIVE CONFIG | Stolen key → refunds, payouts, data | Developers → API keys; Access policies | Key list (no values) | At deploy / before scaling |
| Stripe | Disputes / failed-payment email notifications | ALERT | — | Settings → Communication preferences | Screenshot | Now |
| Stripe | Live/test separation: staging has only `sk_test_`/`rk_test_`; no live key outside Railway production | PREVENTIVE CONFIG | Test traffic charging real cards | Railway variables (names only) | Variable-name list | Verify now |

Owner of every row: Andrew.

**Only these are true HARD LIMITS:**
1. OpenAI project spend limit (monthly, small overshoot).
2. OpenAI org spend limit (monthly, small overshoot).
3. Twilio prepaid balance with auto-recharge off (leaky).
4. Twilio messaging geo permissions (destination only).
5. Twilio voice geo permissions (outbound only, API-reversible).
6. Twilio 4 h per-call ceiling.

**Stripe has no spend limit**, because its exposure is fees, refunds and disputes. Every Stripe item above is preventive.

## 2. Do now on current production (before any deploy)

Do these in order. Each is a console action with no code change and no deploy.

1. **OpenAI project hard limit.**
   - Path: platform.openai.com → the project holding production `OPENAI_API_KEY` → Project settings → Limits → Spend → Edit spend limit.
   - Set a monthly £/$ amount **L**. Suggested: about 3× expected monthly transcription. Turn on **Enforce a hard limit**.
   - **Result:** the forged `/media-stream` (Whisper) and `/process` (gpt-4o-mini) paths are bounded at **L per calendar month, plus a "slight" undocumented overshoot**. Today the only bound is the 200-stream cap: up to about £1,365/day (200 × 1,440 min × £0.00474; inference).
   - **Cost:** an attacker can spend all of L in a day. Transcription then returns 429 for every customer until the month resets or the limit is raised. Calls still connect; monitoring goes blind.
2. **OpenAI org hard limit.** Organization → Limits → Spend. Set it ≥ L and enforce it.
3. **OpenAI auto-reload off.** Settings → Billing. Turn it off, or set a monthly reload limit.
4. **Twilio: read first.** Billing.
   - Confirm the account is **Pay-as-you-go**. If it is Invoiced, there is no balance stop; stop here and escalate.
   - Record the balance.
5. **Twilio auto-recharge OFF.** Billing → Auto-recharge.
   - If the Console refuses (support plan or short codes), record that. Twilio then has **no** hard stop.
6. **Twilio balance B.** Top up manually to no more than B. Suggested: 2–3 weeks of expected spend.
   - Current fixed cost: 10 numbers ≈ £8.69/month (inventory 2026-09-30, to re-check).
7. **Messaging geo: United Kingdom only.** Messaging → Settings → Geo permissions → Save.
   - This needs Owner/Admin and **cannot be changed via the API**.
8. **Voice geo: everything off, GB included.** Voice → Settings → Geo permissions.
   - Inbound calls and `<Dial><Client>` are unaffected.
   - Also check Monitor → Events for permission changes in the last 90 days.
9. **24-Hour Maximum Call Duration = disabled.** Voice → Settings → General.
10. **Fallback Reject Bin.**
    - Create a TwiML Bin `hcg-fallback-reject` containing `<Response><Reject/></Response>`.
    - Set it as "Primary handler fails" on every active number and on the TwiML App.
    - Do **not** change the primary URLs.
11. **Usage triggers with email notification** (the prod receiver route does not exist yet):
    - `totalprice` daily ≈ 5× a normal day;
    - `totalprice` monthly;
    - `sms-outbound` daily (low, e.g. 20);
    - `calls-outbound` ≥ 1 daily;
    - `phonenumbers` = expected count + 2.
    - Set a low-balance email at about one week of spend.
12. **Stop acquisition (P0-1).**
    - Stripe → Product catalog → archive the live Price. Existing subscriptions continue; payment links using it are deactivated.
    - Optionally remove the iOS IAP from sale in App Store Connect. A TestFlight/sandbox purchase buys a real number, because production has no RevenueCat sandbox guard.
    - Note that archiving makes production `/billing/create-checkout-session` fail for new buyers (`?checkout=error`). That is intended.
13. **Stripe read-only checks:**
    - Developers → Webhooks: one production endpoint, the needed events only.
    - API keys: list keys, and expire any unused ones.
    - Radar: note the plan and confirm default rules are on.
    - Turn on dispute email notifications.

**Bound after steps 1–13 (with the master token still in the backend):**

| Threat | Bound |
|---|---|
| OpenAI, from forged requests | ≤ L/month + slight overshoot (true hard limit) |
| Twilio SMS abuse via forged `/media-stream` | UK destinations only. ≤ B / £0.0423 per segment, e.g. B = £40 → ≈ 945 single-segment SMS, then suspension (+O) |
| Twilio inbound flood and number purchases | Within B (+O, +R accruing during suspension) |
| Twilio cost per day | Not separately bounded. **All of B can go in one day**; it is not refilled without a manual top-up |
| Anyone holding the master token | **Not bounded.** See §4 |

## 3. At deploy, and before scaling beyond 5

**At deploy** (RC `ad545a1`; production runbook window):
- [ ] Set `TWILIO_VOICE_FALLBACK_URL` to the Reject Bin URL, so new purchases get the fallback (`services/twilioProvisioning.js:67`; `launchConfig` check `twilio_voice_fallback_url`). Re-check each number bought afterwards.
- [ ] Point a designated `totalprice` daily trigger's callback at `https://<prod>/webhooks/provider-usage-alert`, and set `PROVIDER_USAGE_ALERT_TRIP_TRIGGER_SIDS` to its `UT…` SID (`launchConfig` `provider_usage_alert_trip`). Keep the email notification as well.
- [ ] Prove the kill switch off → on → off (B5), plus a signed test call.
- [ ] Unarchive the Price, or create the new tax-inclusive £5.99 Price (B7). Confirm `NEW_SUBSCRIPTIONS_ALLOWLIST` refuses uninvited checkout.
- [ ] OpenAI: restrict the production key to the endpoints in use. `/process` is off in RC, so Whisper (audio) only. Set an expiry.
- [ ] Stripe: if feasible, replace `STRIPE_SECRET_KEY=sk_live_…` with an `rk_live_` key limited to Checkout Sessions, Customers, Subscriptions (read/write), Billing Portal, Prices (read) and Webhook Endpoints (read). Verify the permission set on staging first; otherwise record this as deferred.
- [ ] Sign the written acceptance of the master-token residual (M7/B4).

**Before scaling beyond 5:**
- [ ] Production Twilio **subaccount**. Move the numbers in.
- [ ] Master token and Main keys **offline**. Rotate the master token (secondary token, then promote).
- [ ] Backend on a **Restricted key** (no `calls/create`, no `active-numbers/create`). The Standard key is kept only for Voice SDK tokens (FINAL §5).
- [ ] Independent breaker service that can suspend the subaccount.
- [ ] Send Q1–Q4 to Twilio and get written answers. They decide O and whether auto-recharge can be changed via the API.
- [ ] Stripe: Radar Plus custom velocity rules, if card testing appears. Access policy on the live key (Railway ASN/country, or static egress IPs: **unverified for HCG's Railway plan**).
- [ ] Review OpenAI L and Twilio B against real usage weekly.

## 4. Residual exposure after every step above (honest statement)

1. **Twilio has no spend cap.** Twilio states there is no maximum spend limit setting (FINAL §2, read 2026-10-04). Usage triggers only notify (re-confirmed today).
2. **The balance can go negative.**
   - What the 2026-10-04 research found: in-progress calls continue after the balance hits zero, charges can post late, and Twilio "does not often suspend right at zero balance". Overrun **O is undocumented**.
   - Re-confirmation today failed: help.twilio.com returned 403 / empty pages. Treat this as **unconfirmed but assumed true**.
   - Worst illustrative case: a holder of the master token re-enables voice geo and places 4-hour premium calls at 1 CPS. Those calls run past suspension. Scale: about $151k committed in 10 minutes (FINAL §4, inference).
3. **The master token undoes most Twilio controls through the API:**
   - voice geo permissions;
   - fallback URLs;
   - the TwiML App URL;
   - deleting triggers;
   - buying numbers;
   - minting keys;
   - silently rotating the token.

   It **cannot** change messaging geo permissions. Whether it can turn on auto-recharge is **UNKNOWN** (Q4). Until the subaccount and offline-token work is done, a backend compromise is **unbounded on Twilio**.
4. **OpenAI:**
   - The limit is monthly only, with an undocumented "slight" overshoot.
   - A stolen **Admin** key could remove the limit. Keep none on the server.
   - Hitting the limit blinds monitoring for every customer.
5. **Stripe:**
   - Refunds, dispute fees and lost-dispute amounts are not capped by any setting.
   - `sk_live_` (if that is what production uses) allows refunds and data access by whoever holds it.
   - Stripe Tax misconfiguration leaves HCG liable for under-collected VAT (pre-2026-09-20 charges had none).
6. **Outside scope:** Railway, Resend and Supabase have their own usage billing, not audited here. RevenueCat/Apple sandbox purchases buy real numbers until the RC is deployed; the balance B bounds them.

## 5. Verification (read-only; save each item as evidence)

| # | Proves | How (no changes) |
|---|---|---|
| V1 | OpenAI project hard limit | Project → Limits → Spend shows the amount and **Enforce a hard limit** on. If the Admin API is available offline: `spend_limit` `enforcement.status = enforcing` |
| V2 | OpenAI org hard limit | Organization → Limits → Spend, as V1 |
| V3 | OpenAI auto-reload | Billing page shows auto-reload off, or the reload cap |
| V4 | OpenAI key scope | Project → API keys: production key is project-scoped and restricted; no Admin key in Railway variable names |
| V5 | Twilio payment type, balance, auto-recharge | Billing pages: Pay-as-you-go, balance ≤ B, auto-recharge OFF |
| V6 | Messaging geo | Geo permissions page: only United Kingdom ticked |
| V7 | Voice geo | Geo permissions: 0 enabled countries; Monitor → Events shows no later change |
| V8 | 4 h cap | Voice → Settings → General: 24-hour duration disabled |
| V9 | Fallback | Each active number (count matches inventory) and the TwiML App show the Reject Bin as fallback |
| V10 | Triggers | Trigger list: categories, values, recurrence, notification target. After deploy, the trip SID is in env. A staging drill latches the kill switch |
| V11 | Stripe sales stopped (now) | Product catalog: price **Archived**. An uninvited test signup reaches `checkout=error`, with no live charge |
| V12 | Stripe keys, webhooks, Radar | API keys list (types and last-used only); Webhooks endpoint and events; Radar plan and rules page |
| V13 | Re-check | Repeat V5–V9 weekly and after any number purchase. Any drift means suspected credential misuse: escalate |

## Sources (official, read 2026-10-09 unless noted)

**OpenAI**
- developers.openai.com/api/docs/guides/spend-limits. Hard limits: 429 codes; "Enforcement is not instantaneous… can slightly exceed"; monthly; alerts "do not enforce a cap". The page carries no date.
- …/guides/rbac (project roles; Model capabilities permission). It gives no console path for key-level restrictions, so key restriction is per FINAL §3 (help.openai.com 8867743, read 2026-10-04).

**Twilio**
- twilio.com/docs/usage/api/usage-trigger: notification only; "about once a minute".
- twilio.com/docs/messaging/guides/sms-geo-permissions: "can not be changed programmatically via the API"; Owner/Admin only.
- twilio.com/docs/usage/fraud-response-guide.
- "No maximum spend limit", negative balance and in-progress calls: help.twilio.com 49507358452635, 223135487, 223183248. These were read 2026-10-04 (FINAL §9). **The re-fetch on 2026-10-09 failed (403/empty)**, so they are not re-confirmed.
- **Unconfirmed:** whether usage triggers created in the Console offer email notification, and the exact current Console menu labels. Use Console search if a path differs.

**Stripe**
- docs.stripe.com/keys: RAK, access policies, rotation with a 7-day grace period.
- docs.stripe.com/disputes/prevention/card-testing: Checkout's built-in rate limiters and CAPTCHA; "requiring login".
- docs.stripe.com/radar/how-radar-works: custom rules on Plus/Pro only.
- docs.stripe.com/products-prices/manage-prices: archiving a price keeps existing subscriptions; payment links are deactivated.
- **Not verified:** Stripe UK dispute fee amount; whether processing fees are returned on refunds.

**Repo**
- `services/twilioClient.js:8-10`: master token.
- `services/containment/providerUsageAlert.js` and `server.js:1465` (RC only; absent at `eb43368`).
- `services/twilioProvisioning.js:61-73`.
- `services/config/launchConfig.js:114-122`.
- `eb43368:routes/billing.js:399,562`: Checkout requires an authenticated household; `constructEvent` with `STRIPE_WEBHOOK_SECRET`.
