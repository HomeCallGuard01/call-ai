# Controlled commercial launch (target Thu/Fri this week): master go/no-go runbook

Prepared 2026-10-05. **A deliberately tiny first cohort (≤ 5 genuine customers, invite-only), then the weekend watched closely, expanding only on good evidence.**

**Non-negotiable:**
- financial containment;
- customer protection (never "protected" when not);
- production safety.

**No hard limit is weakened to pass a gate.**

Companion documents:
- `2026-10-05-PRODUCTION-DEPLOYMENT-RUNBOOK.md` (migrations + backend)
- `2026-10-05-PRICE-CUTOVER-CHECKLIST.md`
- `2026-10-05-STAGING-DEVICE-TEST-PLAN.md`
- `2026-10-04-FIRST-FIVE-CUSTOMER-RUNBOOK.md` (per-customer checklist)
- `2026-10-05-ACCOUNTING-OPS-LAUNCH-MINIMUM.md`
- `docs/releases/2026-10-05-{IOS-102,ANDROID}-RELEASE-PREP.md`

---

## L-1. Cohort channel decision (Andrew; it decides most of the remaining work)

| Option | What customers do | Ready Thu/Fri? | Risk |
|---|---|---|---|
| **A. Android via Play *Internal testing* + Stripe in-app** | Invited by Google-account email; pay £5.99 by Stripe in the app | Only if Android vc ≥ 23 (production profile) passes a handset test | **Play Payments policy risk not proven exempt on testing tracks.** Needs a written risk acceptance |
| **B. iOS 1.0.2 via the App Store** | Apple IAP | Only if Build ≥ 17 passes review in time | Live IAP is £4.99 until the ASC price change, which should wait for 1.0.2 adoption |
| C. Both | — | — | Both risks |
| D. Slip by a few days | — | — | Time |

**Recommendation:**
- **A**, with a written risk acceptance and **only** if tomorrow's device testing passes on the Motorola too.
- Otherwise **D**: slip until either channel is clean.
- iOS (B) only once Build ≥ 17 is approved. Its £4.99 interim price would need L-2.

---

## 1. MUST be GREEN before the first genuine customer

| # | Item | Evidence / how | Status now |
|---|---|---|---|
| M1 | **Staging device test passed** on the cohort's platform (iPhone T-series; Motorola M-series if L-1 = A) | `2026-10-05-STAGING-DEVICE-TEST-PLAN.md` §5 table | RED (tomorrow) |
| M2 | **073 applied to staging**, staging smoke test green | schema verifier + device test | RED |
| M3 | **Production backup + restore point**, rehearsal on a restored copy | runbook §2 | RED |
| M4 | **Production migrations 047 → 073** applied, verified (invariants, grants, account numbers) | runbook §3–4 | RED |
| M5 | **Production backend deployed**, `check-launch-config` START, first **signed production call** trusted + unknown on Andrew's `…6063` | runbook §5 | RED |
| M6 | **Fortress production budget profiles set from the £5.99 economics** (C12); global caps set; kill switch tested off/on/off in production with no live calls | `fc_global_status`, audited `fc_set_*` | RED |
| M7 | **Provider exposure bounded or accepted (C7/C8):** `<Reject/>` fallback URL on every production number; one Twilio usage trigger; OpenAI project spend limit set and evidenced; **written acceptance of the master-token residual** | console exports + Andrew's signed note | RED |
| M8 | **£5.99 live and consistent:** new tax-inclusive live Stripe Price, `STRIPE_PRICE_ID` switched, Stripe Tax live (first charge VAT £1.00), receipts on, Portal at period end; terms/website published with the deploy | price-cutover checklist B1–B4, B9 | RED |
| M9 | **Invite-only cohort enforced:** `NEW_SUBSCRIPTIONS_ALLOWLIST` = the invited emails (web/Android checkout). If iOS is offered, Apple can't be gated: accept it, or keep the iOS app's sign-up closed | env + a refused uninvited test checkout | RED (control built 2026-10-05) |
| M10 | **Stop-acquisition switch tested:** `NEW_SUBSCRIPTIONS_PAUSED=true` refuses a checkout with "no payment was taken" | one test with the switch on, then off | RED (control built) |
| M11 | **Andrew is told about every genuine customer:** 072 applied, `OPS_EVENTS_SCHEDULE_ENABLED=true`, founder role on. Email only if operations@ exists; else the twice-daily dashboard check | `GET /admin/api/ops-events` shows the event | RED |
| M12 | **Support ready:** inbox owner, twice-daily check, cohort refund rule (L-5) written | Andrew | RED |
| M13 | **Store build for the chosen channel:** Android vc ≥ 23 on Internal (A) / iOS ≥ 17 approved (B), production profile, binary endpoint check passed | release-prep docs | RED |
| M14 | **Admin login verified on production** (MI-3): every Control Centre tab loads | Andrew, 2 minutes | RED |

## 2. Acceptable temporary limitations for this cohort only (written down, revisited weekly)

| Limitation | Why acceptable for ≤ 5 | Revisit by |
|---|---|---|
| Twilio has no hard spend cap; the master token is in the backend | Fortress per-household and global caps + kill switch + usage trigger + daily manual review; written acceptance (M7) | before 25 customers |
| Accounting capture off; Stripe + ASC are the records | volume is tiny; accountant brief sent | 2 weeks |
| No operations@ mailbox; notifications on the dashboard (or the founder email) | twice-daily check | before 10 |
| Android lock-screen banner collapses after ~5 s (FSI blocked, B-11) | customers told to answer from the notification; recorded acceptance | before Play Production |
| Stripe in-app on Android Internal track (if L-1 = A) | written risk acceptance; Play Billing started now | before any Closed/Production promotion |
| Apple refund recorded and alerted, not auto-revoked (D-A1) | support acts on each | 2 weeks |
| Allowance disclosure only in-app (meter), not yet in terms/listing | small, known cohort told personally | before public listing copy |
| Admin revenue figures are estimates | not used as records | — |

## 3. MUST be GREEN before scaling beyond the initial cohort

- Provider containment GREEN: Twilio subaccount, master token offline, a restricted runtime key, automated suspension (P1).
- Play Billing for any Play promotion beyond Internal (P2).
- iOS 1.0.2 live + App Store screenshots and metadata current (P3); ASC price £5.99.
- Accounting capture in shadow mode (G20); AD-1…AD-4 answered.
- operations@ + notification email on.
- Allowance and price-change wording in the terms (notice period D-P2/D-P3).
- Staging gate G-items GREEN with evidence; `run.mjs --enforce` reviewed.
- A week of cohort evidence: delivery success, spend per household vs the Fortress model, no unexplained provider line items.

---

## 4. STOP-ACQUISITION / incident procedure (anyone with Railway + admin access)

| Trigger | Immediate action (minutes) | Customer protection implication |
|---|---|---|
| Any spend anomaly: unexplained Twilio/OpenAI line item, breaker trip without cause, a household auto-held twice | **1.** Railway env `NEW_SUBSCRIPTIONS_PAUSED=true` (new sign-ups stop; existing customers unaffected). **2.** Admin → Fortress → **kill switch ON** (audited, typed confirmation): refuses new HCG-funded calls; live calls end at lease renewal. **3.** Twilio console: check usage; reset the master token if compromised | **Kill switch = forwarded calls are refused** (callers hear busy) for **every** customer, trusted included, while it's on. Use it for real spend danger only, and tell affected customers the same day. Prefer the per-household hold (affects one household) when the anomaly is one household |
| One household abusive or anomalous | Admin → household → **hold** (audited) | That household's forwarded calls are refused (busy). The app shows the approved D-C5 paused wording, so they know to turn off forwarding |
| Calls not being delivered (app unregistered, push failing) | Check delivery health / ops events. Contact the customer the same day (approved wording) | The customer misses calls: highest priority. Finding-1 means no paid apology is played; the call is rejected unbilled |
| A bad deploy | Redeploy `eb43368` (schema-compatible) | brief |
| A data or security incident | `HCG_INCIDENT_MODE=contain` (no purchases/SMS) or `suspend_paid` (no new monitoring; calls still delivered). `full_stop` refuses all calls: last resort | `full_stop` breaks delivery for everyone. Manual only |

**After any stop:** a written note (what, when, who, spend so far) before anything is turned back on.
- Resume order: kill switch off → `fc_reset_breaker` (audited) → watch 30 min → then `NEW_SUBSCRIPTIONS_PAUSED=false`.

## 5. Provider-spend monitoring (daily, first two weeks)

1. **Fortress overview** (admin): global £ today/hour versus caps, breaker state, holds, per-household consumed versus budget.
2. **Twilio console usage** (read-only): calls, minutes, SMS, numbers. Compare with the Fortress ledger; a gap above 20% → stop criteria.
3. **OpenAI usage** page against the project spend limit.
4. **Stripe:** charges, refunds, disputes; VAT present on each charge.
5. Record in the "first five" sheet: date, £ by provider, notes.

## 6. First-customer monitoring (each genuine customer; see the first-five runbook §2)

Each item, with how long it should take:
- payment confirmed (Stripe live, VAT £1.00): at signup;
- account number (062);
- number provisioned: 5 min;
- app registered: 1 h;
- forwarding confirmed: 24 h;
- first protected call: 72 h;
- daily cost against budget;
- any failed delivery: same day;
- support response: 4 working hours.

The `NEW_GENUINE_CUSTOMER` event (numbered; milestone #1–5) is the trigger to start the row.

## 7. Weekend monitoring (Fri evening → Mon morning)

- **Twice daily (09:00, 18:00):** ops events + lifecycle exception queue; Fortress overview; Twilio usage; support inbox.
- **Phone alerts:** critical alerts via Resend (breaker, kill switch, provider alert) must reach a phone that is watched.
- **Pre-agreed:** who can flip `NEW_SUBSCRIPTIONS_PAUSED` and the kill switch if Andrew is unreachable (name them). Without a named person, **acquisition stays paused** over the weekend after the first cohort signs up.
- No deploys over the weekend except a rollback.

## 8. GO / NO-GO

- **GO** only when every M1–M14 is GREEN with evidence (date, operator, SHA, artefact), and §2's limitations are signed off in writing.
- **NO-GO:** any M-item RED, or any open stop criterion.
