# Customer Lifecycle & Operations Automation

**Branch:** `feature/customer-lifecycle-automation` (from `integration/launch-fortress-2026-10-03` @ `2011ab6`)
**Date:** 2026-10-04 · **Status:** audit + built code, **nothing deployed, merged, applied, or changed at any provider.**

This document treats Home Call Guard as an operating telephone-protection business. It covers four things:

- every lifecycle step from visitor to data deletion;
- where a human (Andrew or support) must currently intervene;
- what was automated on this branch, and what deliberately was not;
- the policy decisions that remain open.

Every factual claim cites `file:line` on this branch. Claims marked **(verified)** were re-checked by hand during this session. The rest come from a structured read-only audit of the code.

---

## 1. Summary

| | |
|---|---|
| **Biggest operational risk** | Abandoned numbers are **never released without a human**. Quarantine is indefinite by design, the confirm step has **no admin UI button** (verified: `admin-business.html` never calls `confirm-deactivation`), and the sweep that schedules releases for lapsed complimentary/Apple memberships is **off by default** (verified: `server.js:3211`). |
| **Biggest customer-truth risk** | "Protected" ignores the Fortress financial hold, number quarantine, entitlement, and whether the evidence belongs to the *current* number (verified: `services/callRouting.js:163-171`). A held household (whose trusted callers are refused too) still sees "You're protected". |
| **Biggest silent gap** | No lifecycle message is sent by HCG except allowance warnings, which are off by default. That covers welcome, payment failed, cancellation, service ending and security events. Stripe `invoice.payment_failed`, disputes, and subscription refunds are acknowledged and ignored (verified: `routes/billing.js:626-630`). |
| **New defect found** | **F-03.** After in-app account deletion, Stripe's `customer.subscription.deleted` fails on every retry. Cause: the household was anonymised (`stripe_customer_id` set to null by migration 029:122), and the RPC raises on the mismatch (070:50-54, returns `failed`, 157). Result: a 500, Stripe retries, and critical alerts (verified). |
| **Built** | (1) An activation state machine, the one definition of *protected*. All 9 gates are required, and the test covers 8,192 adversarial combinations. (2) A derived operational exception queue. (3) A lifecycle communications planner (plans only, sends nothing). (4) An abandoned-number retirement planner with cost exposure. (5) Support search fixes: phone formats, former routing numbers, and filter-injection hardening. (6) Read-only admin endpoints. |
| **Tests** | `npm test`: **182 files, 182 passed, 7,853 checks, 0 failed.** That includes 4 new files (184 checks) and the existing account-number search test, which is unchanged. |

---

## 2. Lifecycle map

Key: ✅ automated · ⚠️ automated with a gap · 🧑 manual · ❌ absent.

| # | Step | Trigger / system of record | State | Human intervention today | Customer told? |
|---|---|---|---|---|---|
| 1 | Visitor → signup | `POST /register` / `/api/v1/register` → Supabase `signUp` (`server.js:2339-2490`, `routes/mobileApi.js:478`). No household yet. | ✅ | — | Supabase confirm email |
| 2 | First session | `ensureHouseholdAndRole` creates `households` (`status='active'`, provisioning `pending`) (`services/householdBootstrap.js`) | ✅ | — | — |
| 3 | Carrier/device capture | `routes/billing.js:219-278`; gates checkout (`:343-346`) | ✅ | — | in-app |
| 4 | Payment | Stripe Checkout (`routes/billing.js:322-433`) or Apple via RevenueCat | ✅ | — | Stripe/Apple receipts only |
| 5 | Entitlement | Stripe: only `customer.subscription.created/updated/deleted` (`billing.js:626-630`) → `process_stripe_webhook_event` (070, **DRAFT**; prod runs 027). RevenueCat grant/expire (`mobileApi.js:1410-1590`). Web has a reconcile poll (`billing.js:477-556`); **mobile Stripe checkout has none** | ⚠️ | Parallel Apple + Stripe payment: "support must refund one" (`mobileApi.js:1527-1531`); ambiguous `TRANSFER` (`revenuecatWebhook.js:216`) | — |
| 6 | Permanent HCG account number | 062 trigger, `HCG-`+serial+Luhn (`services/customerIdentity/accountNumber.js`) | ⚠️ 062 **DRAFT, not applied, no backfill run** | Choose serial start (062:69-71) | Dashboard shows it |
| 7 | HCG routing number | Bought at entitlement time (`twilioProvisioning.js:597-612`), behind the abuse guard, environment guard and Fortress authorisation; adopt-before-buy (`:217-241`) | ✅ | Retry on failure (`routes/admin.js:136`); orphan-risk alerts (`:298`) | in-app |
| 8 | Forwarding setup | Customer dials the carrier code; any signed `/voice` for the number stamps `activation_verified_at` (`server.js:1097-1107`) | ⚠️ never re-verified, never invalidated | — | in-app only |
| 9 | Contacts | Manual + device sync (`mobileApi.js:1262-1368`) | ✅ | — | — (not required for protection) |
| 10 | Protection active | `computeProtectionStatus` (`callRouting.js:163`) | ⚠️ see §4 | — | in-app only |
| 11 | Normal usage | `/voice` pipeline + Fortress reservation | ✅ | Hold release, breaker reset (admin only) | — |
| 12 | Allowance warnings | 75/90/100% outbox (063, `allowanceNotices.js`) | ⚠️ **email off** unless `ALLOWANCE_NOTICE_CHANNELS`; copy DRAFT; push has no pipeline | — | in-app; email when enabled |
| 13 | Top-up / higher plan | Top-ups behind `ALLOWANCE_TOPUPS_ENABLED`; `planSync` is a no-op until `PLAN_PRODUCT_MAP` | ⚠️ off | Partial top-up refunds; "top-up paid with no entitlement" (`topUpCredit.js:162`) | — |
| 14 | Payment failure | Stripe `past_due` arrives only via `subscription.updated`; access **continues**. `invoice.payment_failed` ignored. RevenueCat `BILLING_ISSUE` ignored (verified `mobileApi.js:1581`) | ❌ | Nobody is told | "Payment issue" label only |
| 15 | Renewal | Stripe: no-op (entitlement `ends_at` NULL). Apple: `RENEWAL` extends `ends_at` | ✅ | — | store receipts |
| 16 | Cancellation | Stripe Billing Portal only (`billing.js:443-466`); `cancel_at_period_end` keeps access. Apple `CANCELLATION` acknowledged, access runs to `ends_at` | ✅ | — | label only |
| 17 | End of paid period | Stripe `deleted` or a non-qualifying status → entitlement expired (070:137-141) → `pending_release_at = now + 30d` (`database/households.js:222`). **Apple/complimentary expiry by date alone schedules nothing** unless the sweep runs | ⚠️ | Turn the sweep on | ❌ nothing (forwarding still reaches HCG for 30 days) |
| 18 | Number recovery/release | Daily runner moves the number into quarantine at grace end; **release needs a human confirm** (`routes/admin.js:380-418`, API only) → daily runner removes it at Twilio (`twilioProvisioning.js:511-587`) | 🧑 | **Every abandoned number** | ❌ |
| 19 | Refund | Subscriptions: **no code**; refunds/disputes do not touch entitlement or number. Top-ups: full refunds only (`topUpCredit.js:47-56`) | ❌ | Every refund/dispute decision | — |
| 20 | Support | `GET /admin/api/search` (see §9); onboarding monitor; health views | ⚠️ | Everything outbound (no "contact customer" tool) | — |
| 21 | Data deletion | In-app `DELETE /api/v1/me/account` → cancel Stripe, quarantine the number, anonymise (029), delete the auth user (`services/accountDeletion.js:79-175`). No web/admin route | ⚠️ | Apple subscription must be cancelled by the customer; email deletion requests are handled by hand | in-app confirmation |
| 22 | Retention | Only `telephony_call_attempts` (2 days, 056:464) and `fc_spend_minutes` (3 days, 067:896) are purged | ❌ | Policy needed (§11) | — |

---

## 3. Activation state machine (built: `services/lifecycle/activationState.js`)

### 3.1 Source of truth

The stage is **derived** from existing durable evidence. Nothing new is stored, so no state can drift from the evidence.

| Evidence | Where | Owner |
|---|---|---|
| Membership (current / upcoming / none / ambiguous) | `entitlements` via `services/numberLifecycle/state.js deriveHouseholdLifecycle` (mirrors 047 SQL) | billing webhooks |
| Billing standing | newest `subscriptions` row (`past_due`, `cancel_at_period_end`) | Stripe webhook |
| Financial hold | `fc_household_holds` (067) | Fortress / admin |
| Number | `households.twilio_number` + `twilio_provisioning_status`, `twilio_number_quarantine` | provisioning / release runner |
| Number assigned at | `routing_assignments.state_changed_at` of the active primary row (062) | identity triggers |
| Forwarding proof | `households.activation_verified_at` | `/voice` |
| App reachable | `voice_client_registered_at` and delivery health ≠ `UNREACHABLE` (`computeProtectionStatus`) | app / delivery health |
| Delivery proof | `households.delivery_verified_at` | `/voice` dial outcome |

### 3.2 Protection gates: all must hold

`accountActive` · `stateKnown` · `entitledNow` · `notOnHold` · `numberActive` · `numberNotQuarantined` · `forwardingVerifiedForCurrentNumber` · `appReachable` · `deliveryVerifiedForCurrentNumber`

`protected` is computed as `PROTECTION_GATES.every(...)`. No code branch sets it. The stage label is checked against that conjunction at runtime, and any disagreement throws. `tests/lifecycle-activation-state.test.mjs` toggles 13 independent failure causes in all 8,192 combinations. Exactly one is protected: the one where nothing is wrong. A mutation check during this session removed one gate at a time (`notOnHold`, `numberNotQuarantined`, `forwardingVerifiedForCurrentNumber`, `entitledNow`), and each mutant was caught.

### 3.3 Stages (first match wins)

```
account_deleted        anonymised household (029)
ambiguous              unknown entitlement status / hold table unreadable  → fail closed
membership_upcoming    scheduled entitlement
signed_up              never had a membership
membership_ended       had one; none in effect (number may still be in grace)
on_hold                Fortress financial hold
number_failed          provisioning failed, no number
awaiting_number        entitled; no active number yet
number_conflict        entitled; its LIVE number is in quarantine (critical)
awaiting_forwarding    no forwarding proof for the CURRENT number
awaiting_app           app never registered / unreachable (no prior delivery)
reconnect_needed       delivery worked before; app now unreachable
awaiting_first_delivery
protected
```

Happy path: `signed_up → awaiting_number → awaiting_forwarding → awaiting_app → awaiting_first_delivery → protected`.

`classifyTransition(prev, next)` names `protection_achieved`, `protection_lost` (with its cause), `progressed`, `went_backwards` and `entered_<stage>`. Leaving `protected` is always flagged as a regression.

### 3.4 Billing standing (orthogonal)

The values are `none`, `upcoming`, `active`, `trial`, `complimentary`, `cancelling`, `payment_issue` and `ambiguous`. `past_due` does **not** remove protection, because the current billing rule keeps access during dunning (`QUALIFYING_SUBSCRIPTION_STATUSES`, `routes/billing.js:40`). It is surfaced as `attention: payment_issue` and as a queue item.

### 3.5 Honesty fields

- `evidence.holdChecked = false` when the 067 table is not deployed (`attention: hold_not_checked`).
- `evidence.numberAssignedAtKnown = false` when 062 is absent. Stale evidence then cannot be detected, and the field says so.
- `evidence.deliveryHealthChecked`.
- `screeningEligible`: whether paid AI screening can run.
- `callsStillReachHcg`: true through the grace period. This is the window a "service ending" message must cover.

---

## 4. "Protected" today: inconsistencies found

| # | Surface | Rule today | Problem |
|---|---|---|---|
| P-1 | `computeProtectionStatus` (`callRouting.js:163-171`) (verified) | `delivery_verified_at && registered && !UNREACHABLE` | Ignores entitlement, number status, quarantine, hold, and evidence age vs the current number |
| P-2 | Fortress hold vs customer | `fc_household_status` returns `held` (067:1579,1597); `fortressAdapter.js:26-72` never reads it (verified) | A held household sees "You're protected" with `callsContinue: true` while even trusted callers are refused |
| P-3 | Re-provisioned household | 047 nulls `twilio_number` but never clears `activation_verified_at` / `delivery_verified_at` | After renumbering, old proof makes a new number look "protected" while the carrier still diverts to the old one |
| P-4 | Mobile Account tab | `hasProvenActivation` = forwarding **OR** delivery (`mobile/lib/homeStatus.ts:71`, `account/index.tsx:70`) (verified) | "Protected" for forwarding-only or UNREACHABLE households, while Home says otherwise |
| P-5 | `/api/v1/activation/verify` | `computeProtectionStatus(req.household, now)` with **no** delivery health (`mobileApi.js:1249`) | "Verified!" ignores UNREACHABLE |
| P-6 | Admin "Protected" | `adminOnboardingStatus.js:205`, `database/adminMetrics.js:169,611` call it without delivery health | Admin view says healthy for dead push tokens |
| P-7 | Mobile Home | Does not render `guidance` | SUSPECT health still shows "You're protected" |
| P-8 | Sign-out | Client unregisters Twilio; no server endpoint clears `voice_client_registered_at` | `deliveryReady` stays true after sign-out |
| P-9 | Forwarding | Never re-verified; a direct dial also counts | Divert later removed by the customer or carrier is never noticed |

The state machine fixes P-1 to P-3 *by definition*. Wiring it in (§5) fixes them for customers.

## 5. Integration plan for the state machine (NOT done: needs Andrew)

The state machine is wired into the **admin** view only. Changing what customers see is launch-critical. This is the same rule this project has applied to every customer-copy change, and it is affected by unapplied migrations: with 067 absent, the hold gate passes but is reported as not checked.

1. Server: in `/dashboard-data` (`server.js:1781`) and `/api/v1/me/dashboard` (`mobileApi.js:578`), load the hold (`fc_household_holds`), the active primary routing assignment and the quarantine rows. Return `activation = deriveActivationState(...)` alongside the existing `protection`, and set `protection.fullyProtected = activation.protected`. This is additive and needs no app release. It would fix P-1 to P-3 on web and on Home immediately, because both read `fullyProtected`.
2. Add `onHold` copy (D-C5). With step 1 alone, a held household falls to the generic "almost there" state.
3. Mobile, next release: make the Account tab use `fullyProtected` (P-4). Render `guidance` for SUSPECT (P-7).
4. Verify endpoint and admin: pass delivery health (P-5, P-6).
5. Sign-out: add an authenticated `POST /api/v1/voice/unregistered` that clears `voice_client_registered_at` (P-8).
6. Optional: add a periodic "forwarding still active" probe. This is a product decision (D-P1). The only signal today is the absence of forwarded calls.

---

## 6. Manual intervention inventory

| # | Intervention | Where | Automation status after this branch |
|---|---|---|---|
| M-1 | Confirm deactivation of **every** quarantined number | `POST /admin/api/households/:id/confirm-deactivation` (API only, no button) | **Planner built** (`numberRetirement.js`), showing eligibility and the £ cost of waiting. Auto-confirm needs decision **D-N2**. A UI button is a small follow-up |
| M-2 | Quarantine rows with `household_id NULL` | none; no route can confirm them | **Queue item** `QUARANTINE_WITHOUT_HOUSEHOLD`. Needs a by-quarantine-id confirm route (follow-up) |
| M-3 | Turn on the lifecycle sweep | env `ENABLE_NUMBER_LIFECYCLE_SWEEP_SCHEDULE=true` | Decision **D-N1**. Until then the queue shows `NUMBER_RETAINED_NO_ENTITLEMENT` |
| M-4 | Retry failed provisioning | `routes/admin.js:136` | Queue item `NUMBER_PROVISIONING_FAILED` |
| M-5 | Release a financial hold | `routes/adminFortress.js:77` | Queue item `HOUSEHOLD_ON_HOLD`. Must stay manual (Andrew-approved design) |
| M-6 | Reset the latched breaker | `adminFortress.js:53` | Manual by design |
| M-7 | Parallel Apple + Stripe payment: refund one | alert `entitlement_parallel_paid_channels` | Manual; refund policy **D-B3** |
| M-8 | RevenueCat ambiguous TRANSFER | console log only (`revenuecatWebhook.js:216-221`) | Manual; should become an alert or queue item (follow-up) |
| M-9 | Subscription refunds and disputes | no code | Manual; **D-B2** |
| M-10 | Top-up partial refunds; top-up with no entitlement | `topUpCredit.js:52,162` | Manual |
| M-11 | Customer stuck in setup | onboarding monitor (never contacts the customer) | Queue `SETUP_STALLED`; comms planner emits `setup_incomplete` (needs copy and a channel) |
| M-12 | Payment issue follow-up | nothing | Queue `PAYMENT_ISSUE` after 3 days (D-B1); comms `payment_issue` |
| M-13 | Failed Stripe events (incl. F-03) | critical alert email | Queue `STRIPE_EVENT_FAILED` / `STRIPE_EVENT_FOR_DELETED_HOUSEHOLD` |
| M-14 | Apple subscription survives account deletion | `appleManualCancellationRequired` | Customer action; tell them (copy) |
| M-15 | Email deletion requests | privacy policy says "handled directly" | No admin deletion route (D-R5) |
| M-16 | Orphan numbers at Twilio, not in the DB | `scripts/number-cost-report.js` (read-only) | Manual; release of untracked numbers is forbidden by `releaseReadiness.js:54` |
| M-17 | Apply migrations 047/052/054/062/067/070 to production | — | Production apply order (Fortress handover R8) |
| M-18 | Daily critical alert for a failed provider release, no backoff | `server.js:3115-3121` | Queue `RECORDED_RELEASE_FAILURE` once `record_twilio_release_attempt` has a caller (it has none today) |

---

## 7. Customer communications review

| Message | Exists? | Channel today | Planner key (built) | Blocked by |
|---|---|---|---|---|
| Welcome | ❌ (signup confirmation only) | Supabase email | `welcome:<hh>` | copy, channel |
| Setup incomplete | in-app only | Home/setup screens | `setup_incomplete:<hh>:<clock>:24h/72h` | copy, channel |
| Protection active | in-app only | Home | `protection_active:<hh>:<number>` (re-sent after renumber) | copy, channel |
| Protection lost | in-app + internal alert | Home | `protection_lost:<hh>:<day>` | copy, channel, push pipeline |
| Allowance warning | ✅ outbox | email if `ALLOWANCE_NOTICE_CHANNELS`; push suppressed | owned by `services/allowance` | copy DRAFT; possible `period_changed` suppression (§12 F-10) |
| Payment issue | label only | in-app; Stripe dunning if enabled (unverified) | `payment_issue:<hh>:<sub>:<period_end>` | copy, channel, D-B1 |
| Cancellation | label only | in-app; Stripe receipt | `cancellation:<hh>:<sub>:<period_end>` | copy, channel |
| Service ending | ❌ | — | `service_ending:<hh>:<release_at>:start/final` (final = 7 days before) | copy, channel, **must include "turn off forwarding" instructions** |
| Service ended | ❌ | — | `service_ended:<hh>:<number>` | copy, channel |
| Account/security | ❌ | Supabase dashboard config (unverified) | not plannable | **no event source**: sign-in, new device and password-change events are not recorded server-side |

The planner (`services/lifecycle/communicationsPlan.js`) is pure. It never messages a deleted account, and every intent comes back `deliverable: false`. A future outbox must store the key with a unique constraint, as `allowance_notice_deliveries` (063) already does. The planner contains **no customer wording**.

---

## 8. Cancellation and number lifecycle

### 8.1 Path

```
entitlement ends ──► pending_release_at = now+30d ──► (daily) grace expired ──► quarantine row
  (Stripe deleted/       (twilioProvisioning.js           releaseExpiredTwilioNumber     deactivation_confirmed = false
   non-qualifying;        :597-626; reactivation           (:405-440)                     ── waits FOREVER ──►
   Apple EXPIRATION)      clears it, 047 trigger)                                         admin confirm (API only)
                                                                                           ──► (daily) Twilio remove()
```

### 8.2 Ways HCG keeps paying indefinitely

| # | Leak | Evidence | Mitigation on this branch | Decision |
|---|---|---|---|---|
| N-1 | Unconfirmed quarantine never auto-releases | 037:23-37; 45/90-day escalation is a dashboard anomaly only (`state.js:47-49`) | Queue + planner with cost exposure | **D-N2** auto-confirm after N days? |
| N-2 | No admin button for confirm | verified | — | follow-up UI |
| N-3 | Quarantine rows with `household_id NULL` cannot be confirmed | `database/twilioQuarantine.js:111-123`; FK `on delete set null` (037:98-100) | Queue item | follow-up route |
| N-4 | Complimentary, Apple and missed-webhook lapses by date alone never schedule a release | sweep only (`numberLifecycleSweep.js:170-176`), off by default | Queue shows `NUMBER_RETAINED_NO_ENTITLEMENT` | **D-N1** enable the sweep |
| N-5 | Returning customer: the old number stays quarantined (billed) **and** a new one is bought; no un-quarantine code | `twilioProvisioning.js:221-229`; `routingLifecycle.js:36` transition unused | Queue `RETURNING_CUSTOMER_OLD_NUMBER_QUARANTINED` | **D-N3** reinstate vs replace |
| N-6 | Numbers at Twilio but not in the DB | `number-cost-report.js` only | — | owner approval per number |
| N-7 | Release failures not persisted | `record_twilio_release_attempt` (052:163) has no caller | — | follow-up |
| N-8 | Deletion-path release blocked while entitled: alert only, no retry | `twilioProvisioning.js:471-479` | — | follow-up |

Cost: set `LIFECYCLE_MONTHLY_NUMBER_COST_GBP` (for example 0.87, from the 2026-09-30 inventory of £8.69/month for 10 numbers) and the queue shows £/month of waiting. Unset, it shows `null`. No guessed default.

**Why auto-confirm is a decision, not a fix.** Confirming releases a number that the ex-customer's carrier may still divert to. Their calls would then fail instead of reaching HCG. The planner's `autoConfirmAfterDays` is `null` (never), and no environment variable can enable it.

---

## 9. Support and admin search

`GET /admin/api/search?q=` (requireAuth + requireAdmin) → `database/adminMetrics.js searchCustomers`. The changes are on this branch.

| Find by | Before | After |
|---|---|---|
| HCG account number | ✅ exact (`HCG-…`, Luhn) | unchanged |
| Email | substring | unchanged (sanitised) |
| Protected phone | substring of E.164, so `07700 900123` **missed** `+447700900123` | any UK/E.164 format → exact E.164 |
| Current HCG routing number | same problem | exact E.164 |
| **Former** routing number | ❌ | ✅ via `routing_assignments` (any state); skipped if 062 is absent |
| Customer name | ❌ (no column) | still ❌. The classifier says so (`note`) instead of mis-searching |
| Household UUID | ✅ | unchanged |
| Filter injection | raw `q` interpolated into `.or()`; `,()` changed the filter | values sanitised (`filterSafe`); test proves an injected clause cannot be added |

New read-only endpoints (requireAuth + requireAdmin, GET only, tested to issue no writes):
- `GET /admin/api/lifecycle/exceptions`: the queue (§10), with a stage census and number-retirement summary.
- `GET /admin/api/lifecycle/households/:id`: one household's activation state, exceptions, due messages, quarantine plan and delivery health.

Still missing: a UI for these endpoints (the JSON is ready); a durable admin action log (`services/adminActionLog.js` is in-memory); and admin actions for deletion, resending confirmation, and contacting a customer.

---

## 10. Operational exception queue (built: `services/lifecycle/exceptionQueue.js`)

The queue is derived on request, so an item disappears when its cause is fixed. It sorts critical → action → watch, then oldest first, and is deduplicated by a stable key. Every item names an **owner** (support / ops / engineering), a **recommended action** (through existing audited routes), and an **automation status** (`manual` / `automatable_after_decision` / `automated_elsewhere`). Fifty healthy households give an **empty** queue (tested), so there is no alert fatigue.

| Code | Sev | Owner | Raised when |
|---|---|---|---|
| `LIFECYCLE_STATE_AMBIGUOUS` | critical | eng | unknown entitlement status / hold unreadable |
| `NUMBER_CONFLICT` | critical | ops | entitled; live number in quarantine |
| `ACCOUNT_DELETED_NUMBER_RETAINED` | critical | ops | anonymised household still has a number |
| `HOUSEHOLD_ON_HOLD` | action | ops | Fortress hold |
| `NUMBER_PROVISIONING_FAILED` | action | ops | provisioning failed |
| `SETUP_STALLED` | action | support | awaiting forwarding/app > 24h after the setup clock |
| `PROTECTION_LOST` | action | support | reconnect_needed |
| `EVIDENCE_PREDATES_CURRENT_NUMBER` | action | support | renumbered; proof is for the old number |
| `PAYMENT_ISSUE` | action | support | past_due/unpaid > 3 days (D-B1) |
| `RETURNING_CUSTOMER_OLD_NUMBER_QUARANTINED` | action | ops | entitled with a new number; old one quarantined |
| `QUARANTINE_WITHOUT_HOUSEHOLD` | action | ops | quarantine row, household gone |
| `STRIPE_EVENT_FAILED` | action | eng | `stripe_webhook_events.status='failed'` |
| `FIRST_DELIVERY_UNCONFIRMED_LONG` | watch | support | ready, no confirmed delivery for 7 days (D-O1) |
| `STRIPE_EVENT_FOR_DELETED_HOUSEHOLD` | watch | eng | F-03 retries |
| + passthrough from `numberLifecycle/state.js` | — | ops | `PROVISIONING_FAILED`, `ENTITLED_WITHOUT_NUMBER`, `ENTITLED_PENDING_RELEASE`, `NUMBER_RETAINED_NO_ENTITLEMENT`, `RELEASE_OVERDUE`, `QUARANTINE_AWAITING_CONFIRMATION(_LONG)`, `QUARANTINE_RELEASE_STUCK`, `QUARANTINED_NUMBER_OF_ENTITLED_HOUSEHOLD`, `RECORDED_RELEASE_FAILURE` |

Not in the queue yet, because no durable data source exists: RevenueCat `BILLING_ISSUE` (not stored), ambiguous TRANSFER (log only), parallel paid channels (alert only), Twilio-only orphan numbers (script only), and SUSPECT/UNREACHABLE delivery health in bulk (computed per household, so it appears only in the household view).

Acknowledging or assigning items needs a table. That is proposed and not built, to avoid a migration-number collision with sibling branches.

---

## 11. Privacy, deletion and retention

**What deletion actually does** (`services/accountDeletion.js`, migration 029):
- revokes the entitlement and cancels Stripe (refusing to continue if that fails);
- quarantines the number;
- **hard-deletes `contacts` and `calls`**;
- anonymises `households` (email rewritten; phone, auth, Stripe and number nulled; `status='cancelled'`). **The row is kept**, so no `on delete cascade` ever fires;
- deletes the Supabase auth user.

**Kept after deletion, linked by `household_id`:**
- `account_number` and the append-only registry;
- device and app versions (045) and carrier fields;
- `terms_acceptances`;
- `call_delivery_events` (064 says these cascade; they **don't**, because the household is never deleted);
- `voice_client_registration_events`;
- `telephony_call_legs` / `financial_entries` (provider call IDs);
- the `fc_*` ledger;
- `allowance_credits`;
- `abuse_decisions` (caller hash plus masked number);
- `subscriptions`, `entitlements` and `stripe_webhook_events` (full payloads);
- classifications;
- `routing_assignments`;
- quarantine rows;
- `acquisition_events`.

`waiting_list_signups` has no deletion path. The Stripe Customer object is not deleted.

**Policy vs code:**
- `public/privacy.html:498` says requests are handled "directly rather than through an automated process" (verified). This **contradicts** the in-app automated deletion.
- It says call records are deleted "other than billing". Diagnostic and abuse records also remain.
- The processors section omits Resend.
- `public/delete-account.html` tells users to email support, and doesn't mention the in-app option or what is kept.

**Decisions required (not invented here):**

| ID | Decision |
|---|---|
| D-R1 | Retention period for `calls` (today: "lifetime of the account") |
| D-R2 | Retention for `call_delivery_events` (90 days proposed in 064, not enforced), `voice_client_registration_events`, `abuse_decisions`, `acquisition_events`, `stripe_webhook_events` payloads |
| D-R3 | On deletion: delete the household row outright (cascades) vs anonymise; whether diagnostic/abuse rows are purged |
| D-R4 | Delete the Stripe Customer object on account deletion? |
| D-R5 | Admin deletion route for emailed requests (with identity verification) |
| D-R6 | Waiting-list email retention and deletion |
| D-R7 | Railway/log retention (052:44 lists it unresolved) |
| D-R8 | Update `privacy.html` §6 and `delete-account.html` to match the in-app flow; add Resend as a processor |
| D-R9 | Ledger and financial records: statutory retention (likely 6 years for accounting, a legal question) vs personal-data minimisation |

---

## 12. Findings

| ID | Sev | Finding | Evidence |
|---|---|---|---|
| F-01 | **High** | Abandoned numbers are never released without a human; there is no UI to do so | §8 N-1/N-2 |
| F-02 | **High** | Held/quarantined/renumbered households are shown as protected | §4 P-1–P-3 |
| F-03 | Medium | Account deletion causes a permanent Stripe `subscription.deleted` failure/retry/alert loop (entitlement already revoked, so no access impact). **Fix (proposed, not applied):** in `routes/billing.js` before `claimWebhookEvent`, if the resolved household is anonymised (`status='cancelled'` and `stripe_customer_id IS NULL`), record the event as `ignored` and return 200. Alternatively, make the RPC return `ignored_deleted_household` for that case | 029:122, 070:50-54/150-157 (verified) |
| F-04 | Medium | `invoice.payment_failed`, disputes, subscription refunds and RevenueCat `BILLING_ISSUE` are ignored | `billing.js:626-635`; `mobileApi.js:1581` (verified) |
| F-05 | Medium | Lapsed complimentary/Apple memberships keep numbers indefinitely while the sweep is off | §8 N-4 |
| F-06 | Medium | Returning customers double-bill numbers (old one quarantined + new purchase) | §8 N-5 |
| F-07 | Medium | No lifecycle email beyond allowance warnings (off): nobody is told their service is ending while forwarding still reaches HCG for 30 days | §7 |
| F-08 | Medium | Privacy policy contradicts the in-app deletion; diagnostic data survives deletion; `call_delivery_events` cascade claim is false | §11 |
| F-09 | Low | Admin search missed local-format phone numbers and allowed `.or()` filter manipulation (admin-only) | **fixed on this branch** |
| F-10 | Low (unconfirmed) | Allowance notice worker may suppress emails as `period_changed` because it compares the Fortress period to the 056 period | `allowanceNotices.js:139-141`, audit-reported, not reproduced |
| F-11 | Low | Mobile Stripe checkout has no reconcile fallback; it depends on the webhook alone | `mobileApi.js:294-390` |
| F-12 | Low | The quarantine script prints "Released" when it only quarantines | `scripts/release-expired-twilio-numbers.js:34` |

---

## 13. Decisions for Andrew

| ID | Decision | Default on this branch |
|---|---|---|
| D-N1 | Enable `ENABLE_NUMBER_LIFECYCLE_SWEEP_SCHEDULE` in production | off (unchanged) |
| D-N2 | Auto-confirm quarantined numbers after N days (the existing 45/90-day escalation suggests a range) | never |
| D-N3 | Returning customer: reinstate the quarantined number vs keep the new one | queue item only |
| D-N4 | Monthly number cost figure for exposure reporting | unset |
| D-B1 | Payment-issue follow-up timing; whether `past_due` should ever pause service | 3 days → queue; access continues |
| D-B2 | Subscription refund and dispute policy (entitlement and number effect) | none |
| D-B3 | Parallel Apple + Stripe: which channel is refunded | manual |
| D-C1…C5 | Which lifecycle messages to send, channel(s), and **all wording**; push pipeline; `on_hold` customer copy | planner only |
| D-O1 | Setup-stalled (24h) and first-delivery (7d) thresholds | as listed |
| D-P1 | Periodic forwarding re-verification | none |
| D-W1 | Wire the state machine into customer surfaces (§5) | admin-only |
| D-R1…R9 | Privacy/retention (§11) | none |

---

## 14. What was built

| File | Kind |
|---|---|
| `services/lifecycle/activationState.js` | pure state machine (§3) |
| `services/lifecycle/exceptionQueue.js` | pure derived queue (§10) |
| `services/lifecycle/communicationsPlan.js` | pure catalogue + planner (§7) |
| `services/lifecycle/numberRetirement.js` | pure quarantine planner (§8) |
| `services/lifecycle/supportSearch.js` | pure query classifier (§9) |
| `database/lifecycleSnapshot.js` | read-only paginated loader; tolerant of unapplied 062/067 |
| `routes/adminLifecycle.js` | 2 GET routes, requireAuth + requireAdmin |
| `database/adminMetrics.js` | `searchCustomers` uses the classifier; former-number lookup |
| `server.js` | mounts the admin lifecycle routes (one line) |
| `tests/lifecycle-activation-state.test.mjs` (38), `tests/lifecycle-journey.test.mjs` (101), `tests/lifecycle-support-search.test.mjs` (23), `tests/admin-lifecycle-routes.test.mjs` (22) | adversarial and lifecycle tests |

**Not built, by design:** any provider action, sending, migration, customer-facing behaviour change, mobile change, or automatic confirm/release.
