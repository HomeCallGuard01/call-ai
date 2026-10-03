# Customer allowance & billing handover — 2026-10-03 (Claude 3)

**Nothing deployed. No production or staging change. No migration applied. Nothing merged.**

## 0. Where things are

| | |
|---|---|
| Branch | `feature/customer-allowance` (pushed to `origin`) |
| Worktree | `/Users/ad/call-ai-customer-allowance` |
| Base | `feature/financial-safety-hard-limits` @ `30d454c` (056 = Financial Fortress Layer A/B). It is **not** based on `main` (`eb43368`), because the allowance consumes 056. |
| Implementation commit | `7f2e068`; this handover is the commit after it |
| State | Clean, pushed. `node_modules` is a local symlink to `/Users/ad/call-ai/node_modules` (untracked, not committed). |
| Fortress (Claude 1) | `security/financial-containment-p0`, worktree `/Users/ad/call-ai-financial-containment-p0`, same base `30d454c`. Its £-budget ledger is **uncommitted and provisional** (`supabase/provisional/…`). I only read it. |

## 1. Billing architecture found (code-verified)

| Area | Behaviour today |
|---|---|
| **Stripe checkout** | One subscription price (`STRIPE_PRICE_ID`), web and in-app (Android). Guards: carrier gate, active entitlement, live Stripe lookup, open-session reuse, 5-minute idempotency key. |
| **Stripe webhook** | Signature verified. Handles only `customer.subscription.created/updated/deleted`. Deduped by `stripe_webhook_events`, with an out-of-order guard (`stripe_event_created`). Writes `subscriptions`. Inserts the entitlement only if no active one exists. `invoice.*` is ignored. |
| **Entitlement end date** | Stripe entitlement rows have `ends_at NULL`, so access depends on the webhook arriving. |
| **Cancellation** | `cancel_at_period_end` keeps access to period end. |
| **`past_due`** | Keeps access. |
| **`unpaid` / `canceled` / `incomplete_expired`** | Expire the entitlement. |
| **RevenueCat (Apple only)** | Plain string compare on `Authorization`. Grants on INITIAL_PURCHASE/RENEWAL/UNCANCELLATION/PRODUCT_CHANGE/TRANSFER; revokes on EXPIRATION. CANCELLATION and BILLING_ISSUE are acknowledged and not stored. **No event dedupe, no ordering guard, no environment check on this base.** |
| **Complimentary** | `admin_manual` / `complimentary` rows with a required `ends_at`, from admin grants and invites. |
| **Who is entitled** | `getActiveEntitlement` (status active, inside `starts_at`/`ends_at`) is the only access decision. |
| **Allowance period** | Fortress `billingPeriod.js`: Stripe `current_period_end`; store `ends_at`; complimentary monthly anniversary; else calendar month. All in UTC instants. |
| **Identity** | One auth user ↔ one household. There is **no account number**; the identity Claude owns that, and I invented none. Everything keys on `household.id`, resolved server-side from the session. |

### Pre-existing risks found (not fixed here: other owners or other branches)

1. **Sandbox leaks into production.**
   - On this base, RevenueCat sandbox/TestFlight purchases create real `paid_subscription` rows.
   - `fix/revenuecat-sandbox-environment-guard` (053) only stops the Twilio number purchase; the entitlement is still granted.
   - **My top-up path refuses sandbox in production** (both app and database level), and plan sync ignores sandbox events.
2. **Cross-source clobbering.** `upsertActiveEntitlementFromRevenueCat` expires *any* active row, including Stripe and complimentary rows. A later Apple EXPIRATION then leaves a paying Stripe customer with no access.
3. **A stale active row blocks Stripe.** Apple and complimentary rows past `ends_at` stay `active` (no sweeper). The Stripe RPC then never inserts its entitlement.
4. **RevenueCat replay or out-of-order delivery** can roll `ends_at` back.
5. **Period-key drift (Fortress):** a `past_due` Stripe subscription whose `current_period_end` has passed falls back to the `starts_at` anniversary. The usage-period key can therefore change mid-month, which looks like a usage reset. Top-up credits follow the same function, so they stay consistent with enforcement either way.
6. **Pre-existing failing test:** `tests/migrations.pglite.test.mjs` → "051 contribution view keeps each currency on its own row". It fails identically on the untouched base `30d454c`.

## 2. Design principle: consume Fortress, never compete

- The customer allowance adds **no second counter and no second enforcement**.
- Every allowance change ends up in the number Fortress enforces on:
  - today, 056 `household_usage_periods.bonus_monitored_seconds`, which `begin_monitoring_session` adds to the plan allowance;
  - later, Fortress `fc_budget_accounts.adjustments_gbp` (see §11).
- The customer read model only **describes** the Fortress state.
- The PGlite test proves this end to end:
  1. allowance used → Fortress refuses monitoring;
  2. a top-up is credited;
  3. Fortress itself allows monitoring again (allowance 900 s, used 600 s);
  4. the next period starts again from the plan allowance.

## 3. What was implemented (files)

| File | Purpose |
|---|---|
| `services/allowance/entitlementState.js` | Canonical membership state: `active`, `trial`, `complimentary`, `cancelling`, `payment_issue`, `expired`, `none`, plus channel and the sandbox `testPurchase` flag |
| `services/allowance/customerAllowance.js` | **The read model** (§6), built on Fortress `getHouseholdAllowance` (056) or `fc_household_status` (`ALLOWANCE_SOURCE=fortress`) |
| `services/allowance/fortressAdapter.js` | Maps Fortress's £ budget status to percentages only (no £ or minutes shown); reservations count as used |
| `services/allowance/productCatalog.js` | Top-up catalogue and higher-tier product map from env JSON; **economics guard** |
| `services/allowance/topUpCredit.js` | Verified Stripe/RevenueCat event → at most one credit; refunds → reversal; Stripe top-up Checkout params |
| `services/allowance/allowanceAdjustments.js` | Audited admin adjustments |
| `services/allowance/allowanceNotices.js` | Warning delivery: enqueue hook and sender (email via Resend; push recorded as suppressed) |
| `services/allowance/planSync.js` | Higher tier: `entitlements.plan_code` follows the paid product |
| `services/allowance/allowanceDeps.js` | Production data dependencies, in one place |
| `database/customerAllowance.js` | 062 data access; Fortress status RPC call |
| `routes/allowance.js` | `GET /api/v1/me/allowance`, `POST /billing/topup-checkout`, `POST /admin/api/households/:id/allowance-adjustment` |
| `routes/billing.js` | Stripe top-up and refund handling, placed *after* signature verification and *before* the unchanged subscription path; plan sync |
| `routes/mobileApi.js` | RevenueCat consumable top-up and refund, placed *after* the Authorization check; plan sync (production events only); `customerAllowance` on the dashboard |
| `server.js` | `customerAllowance` on `/dashboard-data`; warning enqueue hook; sender loop (only when channels are enabled) |
| `services/usage/usageNotifier.js` | **One-line Fortress change:** passes `periodStart` to the `deliver` hook |
| `tests/financial-safety-migration.pglite.test.mjs` | **Fortress test change:** rolls back dependent migrations (062) before 056's rollback |
| `supabase/migrations/062_customer_allowance_credits_and_notices.sql` (+ rollback) | DRAFT (§10) |
| `upload.html`, `mobile/components/AllowanceMeter.tsx`, `mobile/app/(tabs)/index.tsx`, `mobile/lib/{types,api}.ts` | Customer UI (§7) |

## 4. Configuration (all backend env; no app release needed)

| Variable | Default | Meaning |
|---|---|---|
| `PLAN_STANDARD_ALLOWANCE_MINUTES` / `PLAN_PLUS_…` | 100 / 200 (Fortress **placeholders**) | Included minutes per plan |
| `MONITORING_ALLOWANCE_ENFORCED` | off | Fortress: stop monitoring at 100% |
| `MONITORING_WARNING_POINTS` | `0.75,0.9` (+100%) | Warning thresholds. 056's table only accepts 75/90/100, so other points need a Fortress schema change |
| `ALLOWANCE_SOURCE` | (056 minutes) | `fortress` switches the read model to `fc_household_status` |
| `ALLOWANCE_TOPUPS_ENABLED` | off | Master switch for selling and crediting top-ups |
| `ALLOWANCE_TOPUP_PRODUCTS` | `[]` | JSON array of top-up products: `{code, minutes, priceGbpInclVat, stripePriceId?, appleProductId?, googleProductId?, active?}` |
| `ALLOWANCE_TOPUP_COST_GBP_PER_MIN` | £0.018787 (monitoring + connected minute, **ASSUMPTION**, conservative) | Delivery cost per top-up minute |
| `ALLOWANCE_TARGET_MARGIN` / `ALLOWANCE_SAFETY_RESERVE` / `ALLOWANCE_VAT_RATE` | 0.40 / 0.10 / 0.20 | Inputs to the economics guard |
| `ALLOWANCE_APPLE_FEE_MODEL` | `apple30` | Apple commission model. Set to `store15` only once Small Business Programme enrolment is confirmed |
| `ALLOWANCE_TOPUP_MIN_HOURS_BEFORE_RESET` | 24 | No top-up sales just before a reset |
| `PLAN_PRODUCT_MAP` | `{}` | Map of product/price id → plan code (higher tier). Empty = no-op |
| `ALLOWANCE_NOTICE_CHANNELS` | (none = in-app only) | `email`, `push` |
| `ALLOWANCE_NOTICE_FROM` | `Home Call Guard <notifications@mail.homecallguard.co.uk>` | Sender address. **Verify this sender in Resend first** |
| `ALLOWANCE_ALLOW_SANDBOX_CREDITS` | off | Only honoured with `APP_ENV=staging` |
| `ALLOWANCE_ADMIN_MAX_ADJUSTMENT_MINUTES` | 1000 | Cap on one admin adjustment |

## 5. Economics guard (top-ups)

A product is offered on a channel only if its after-fees revenue covers its cost at the target margin plus the safety reserve:

- net = price ÷ 1.2
- after fees = net − channel fee
- required = cost ÷ (1 − 0.40) × (1 + 0.10)
- offered only if after fees ≥ required

The brief's rule is reproduced in a test: **£1 of cost needs £1.67 net = £2.00 incl. VAT before fees**, and £2.00 then *fails* once Stripe fees are added. The fee models are `services/finance/unitEconomics.js` CHANNELS: Stripe 2.7% + 20p; store 15%; Apple 30%.

**Illustrative minimum viable prices** (not recommendations; default cost assumption £0.018787/min):

| Top-up | Stripe | Apple (30%) | Google (15%) |
|---|---|---|---|
| 15 min | £0.89 | £0.89 | £0.73 |
| 30 min | £1.53 | £1.78 | £1.46 |
| 60 min | £2.82 | £3.55 | £2.92 |

If the true marginal cost is monitoring only (£0.008069/min), 30 minutes is viable at £0.77–£0.80. **No price or quantity was chosen.** Store price tiers also round these.

## 6. Read model contract: `customerAllowance` (version 1)

It appears on:

- `GET /dashboard-data` (web, `platform=web`);
- `GET /api/v1/me/dashboard?platform=ios|android`;
- `GET /api/v1/me/allowance?platform=…`.

It is **additive**: `monitoringAllowance` (Build 20 contract) is unchanged. `platform` only chooses which store's top-ups may be listed; an unknown platform lists none.

```json
{
  "version": 1,
  "status": "ok | low | very_low | used_up | calls_limited | paused | unavailable | inactive",
  "tone": "good | caution | critical | neutral",
  "monitoringActive": true,
  "callsContinue": true,
  "source": "monitoring_minutes | fortress",
  "enforced": false,
  "membership": { "state": "active", "channel": "stripe", "planCode": "standard", "planName": "Home Call Guard",
                  "periodEndsAt": "…", "renews": true, "testPurchase": false },
  "allowance": { "includedMinutes": 100, "topUpMinutes": 0, "adjustmentMinutes": 0, "totalMinutes": 100,
                 "usedMinutes": 42, "remainingMinutes": 58, "usedPercent": 42, "remainingPercent": 58,
                 "reservedPercent": null, "inProgressMonitoredCalls": 0,
                 "periodStartsAt": "…", "resetsAt": "…" },
  "warning": { "level": null, "points": [75, 90, 100] },
  "topUp": { "available": false, "reason": "not_enabled", "products": [], "expiresAtReset": true }
}
```

**Field rules:**

- **`monitoringActive`** is the only field that may justify "monitoring / protected" copy.
- **`callsContinue`** is `false` only on the Fortress source, once both the budget and the delivery reserve are used.
- **Rounding** is in the customer's favour (Fortress rule).
- **Unreadable data:** status `unavailable`, `monitoringActive: null`, numbers `null`.
- **Reserved / current exposure:**
  - 056 source: live monitored calls are metered into "used" every ~10 s, and `inProgressMonitoredCalls` counts live sessions.
  - Fortress source: reservations count as used (conservative), and `reservedPercent` shows the share held by live calls.

## 7. Customer UI

The UI follows the brief: one percentage, one bar, one reset date, and one sentence only when something needs saying. No £, no telephony detail.

**Web** (`upload.html`): a "Call checking this month" card after "Your protection at a glance".

- Hidden for older backends and for inactive memberships.
- Bar colour by tone; an accessible `role="meter"`.
- Shows "Resets on 12 October" (Europe/London date).
- Top-up buttons appear only when the server offers one and usage is low or used up. They post only the product code, and are labelled "Extra minutes last until your allowance resets on …".
- The status card no longer says "monitored while you talk" when `monitoringActive === false`.

**Mobile**: `AllowanceMeter` on Home (theme only, accessible progress bar).

- The hero no longer claims "monitoring unknown callers" when the server says monitoring is off. This fixes the gap noted in `routes/mobileApi.js`, where Home always said it.
- There is **no in-app top-up purchase**: there is no StoreKit consumable or Play in-app product yet.
- TypeScript check passes (`tsc --noEmit`).

**All wording is DRAFT** and needs Andrew's approval. Exhaustion copy deliberately says that the phone still works normally, every call still reaches you, and trusted contacts are unaffected; only unknown-caller scam checking pauses until the reset date. The exception is `calls_limited` (§11), whose copy says forwarded calls *may not get through*.

## 8. Warnings

- **Threshold detection** is Fortress: `usageNotifier` claims 75/90/100 once per household per period in `usage_notifications`. Crossing several points at once delivers only the highest.
- **In-app**: driven by the read model's `status` and `warning.level`, which is state rather than messages, so there is no spam.
- **Email/push**:
  - The `deliver` hook enqueues one `allowance_notice_deliveries` row per enabled channel. The primary key and the FK to the claim mean a warning can't be sent twice, and can't be sent if it was never claimed.
  - The sender leases rows (`FOR UPDATE SKIP LOCKED`, safe across instances).
  - **Before sending it re-reads the live allowance** and suppresses the warning if the period has reset, a higher point was reached, or a top-up made it inapplicable. A failed send retries with backoff and gives up after 5 attempts.
  - **Push** rows are recorded as `suppressed: no_push_pipeline`: HCG has no customer push sender, only Twilio VoIP pushes.
  - **All off by default.**
- **Top-up after a warning**: the 75% claim stays claimed for that period, so there is no second 75% email after a top-up. This is deliberate anti-spam.

## 9. Top-ups

**Credit only when payment is authoritative**:

- Stripe: `checkout.session.completed` with `payment_status: paid`, or `checkout.session.async_payment_succeeded`. "Unpaid" completions (delayed methods) and `async_payment_failed` credit nothing.
- Stores: RevenueCat `NON_RENEWING_PURCHASE` for a configured product.

**Protections:**

| Guarantee | How |
|---|---|
| Idempotent | `credit_allowance` is unique on (source, transaction id, kind) and takes the per-household lock Fortress uses for monitoring admission. Replays, retries and concurrent duplicates credit once (PGlite: 5 simultaneous deliveries → 1 credit). |
| Quantity not client-supplied | Minutes come from HCG's server-stamped Checkout metadata (Stripe) or the catalogue (stores). Customer routes accept only a product choice, re-validated against the server's current offer. |
| Non-production refused | Stripe `livemode:false`, and store SANDBOX or a missing environment, are refused in production by the app **and** by the RPC. Staging needs `APP_ENV=staging` plus an explicit flag. |
| Auditable | `allowance_credits` is append-only: kind, requested and applied seconds, period, source, environment, transaction, event id, product, amount, actor, reason. Even `service_role` can't write it except through the RPC. |
| Refunds | A full Stripe refund (`charge.refunded`, matched by PaymentIntent) or a store CANCELLATION of a consumable reverses the credit, clamped at 0, idempotent. Partial refunds are left for a manual decision. |
| Never silently dropped | Paid but no household, invalid quantity, or the same transaction for a different household all alert. A paid top-up arriving while top-ups are disabled gets HTTP 500, so Stripe retries, plus an alert. |

**Period and expiry**: top-up minutes belong to the period current when payment is **confirmed**, and expire at that period's reset. A delayed payment confirmed after a reset lands in the new period. Sales stop 24 h before a reset. Rollover would be a product decision and a Fortress change.

**Channels**:

- **Web**: Stripe one-off Checkout, with Stripe Tax enabled.
- **iOS and Android**: these need a StoreKit consumable and a Play Billing in-app product. Neither exists. Android must not sell via in-app Stripe (Play Payments policy; see Android billing memory).

## 10. Higher plan

- The mechanism is plans (`plans.js`, already has `plus`) + a product + one `PLAN_PRODUCT_MAP` entry.
- `planSync` sets `plan_code` on the **same-source** active entitlement. It acts only on a processed, non-stale Stripe event for a live subscription, or a PRODUCTION RevenueCat event using the *currently billed* `product_id`. PRODUCTION RevenueCat grants and renewals are synced; a PRODUCT_CHANGE event carries the old `product_id`, so the new plan takes effect with the next renewal event, matching Apple's deferred downgrades.
- With a map set, an unmapped product means Standard, so a larger allowance is never kept by accident. It is a no-op today.
- On the Fortress source the plan maps to a budget profile (`plus` exists there too).

## 11. Financial Fortress dependency and integration

- **Today (056):** credits go to `bonus_monitored_seconds`. Fortress enforces; this branch only reads.
- **Fortress £-budget (provisional) differences:**
  1. Fortress authorises in £ and **ends or refuses calls** when the budget and delivery reserve are exhausted, not just monitoring. The read model surfaces this as `status: calls_limited`, `callsContinue: false`.
     - **This conflicts with the forwarding hard requirement** recorded on 2026-09-30: £-refusals of forwarded calls mean the customer misses calls.
     - Andrew must decide whether a customer can ever reach `calls_limited`.
  2. Its write path for top-ups already exists: `fc_admin_adjust(source='topup', idempotency key, ±£50)`.
     - **Integration step:** once Fortress is merged, `credit_allowance` should call `fc_admin_adjust` *inside the same transaction*, so the audit row and the budget change are atomic. A top-up product then needs a `budgetGbp` value as well as minutes.
     - Not built now, because the Fortress schema is uncommitted.
  3. `ALLOWANCE_SOURCE=fortress` plus `getFortressHouseholdStatus` (`fc_household_status`) switches the customer UI with no app change. It is tested against that function's payload shape.

## 12. Stripe / Apple / RevenueCat: allowance period mapping

| Channel | Allowance period | Duplicate entitlement / credit protection | Sandbox |
|---|---|---|---|
| Stripe subscription | `[current_period_end − 1 month, current_period_end)`; renewal starts a new period at 0 | Subscription: existing event dedupe + ordering. Top-up: PaymentIntent uniqueness | `livemode:false` never credits |
| Apple (RevenueCat) | `[ends_at − 1 month, ends_at)`; each RENEWAL extends `ends_at` | Top-up: store transaction uniqueness. Subscription replay risk is pre-existing (§1) | SANDBOX never credits or changes a plan; entitlement leak is pre-existing (§1) |
| Google (RevenueCat) | Same as Apple once a Play product exists (`source` would be `google_revenuecat`) | Same | Same |
| Complimentary | Monthly anniversary of `starts_at` | Admin RPC refuses over paid rows | n/a |

## 13. Xero boundary (not implemented)

**Event the later Xero workflow should consume:**

- **Top-up revenue:** one row per `allowance_credits` record with kind `topup` (revenue) or `topup_reversal` (credit note).
- **Stable idempotency key:** (`source`, `provider_transaction_id`, `kind`). Stripe uses the PaymentIntent; stores use the transaction id.
- **Fields:** household id, `amount_minor`, currency, `product_code`, `created_at`, `provider_event_id`, environment. **Only `environment = 'production'`** rows are revenue.
- **Amounts are gross as reported by the provider.** Xero should take net, VAT and fees from:
  - Stripe: the balance transaction or invoice (Stripe Tax is on);
  - Apple/Google: store payouts, which are net of commission, with Apple as merchant of record and VAT handled by the store.
- **Which system invoices:** never issue an HCG invoice for store purchases; the stores do. For Stripe, the Stripe invoice/receipt is the document.
- **Subscriptions:** source from Stripe `invoice.paid` (Stripe) and RevenueCat RENEWAL/INITIAL_PURCHASE (stores). Neither is persisted as a revenue event today. Add a `billing_revenue_events` outbox keyed by provider event id when Xero work starts, so nothing is double-booked across Stripe and Apple.
- **Customer key:** household id. Swap in the permanent HCG account id from the identity workstream when it lands.

## 14. Tests

| File | Checks | Result |
|---|---|---|
| `tests/customer-allowance.test.mjs` | 111 | all pass |
| `tests/customer-allowance-migration.pglite.test.mjs` (real Postgres) | 33 | all pass |
| `tests/customer-allowance-ui.test.mjs` (structure + executed web render) | 26 | all pass |
| `tests/customer-allowance-webhooks.test.mjs` (real Express routes, real Stripe signature verification, in-memory DB) | 18 | all pass |
| Fortress `financial-safety-migration.pglite` / `financial-safety-callpath` | 37 / 62 | all pass |
| Full `npm test` chain, file by file | — | Only `migrations.pglite` fails (the pre-existing 051 check). 9 files need `SUPABASE_URL`, which is absent from the worktree; they **pass with dummy env** on both this branch and the base. |
| Mobile | `tsc --noEmit` | 0 errors |

**Brief scenarios covered:**

- Membership lifecycle:
  - first subscription;
  - renewal → new period;
  - reset at an exact instant, including the 1 ms boundary and a BST local-midnight renewal;
  - cancelled but active;
  - expired;
  - `past_due` → payment issue;
  - complimentary.
- Warnings and allowance state:
  - warning thresholds;
  - duplicate warning, across repeated progress and a new period;
  - exhausted, both enforced and not enforced.
- Top-up payments:
  - top-up success;
  - duplicate webhook (sequential and 5× concurrent);
  - failed top-up;
  - delayed payment;
  - refund.
- Channels and environment:
  - Apple vs Stripe;
  - RevenueCat sandbox guard;
  - Stripe test mode.
- Fortress interaction:
  - concurrent calls changing usage;
  - Fortress reservation and live sessions reflected;
  - Fortress `begin_monitoring_session` honouring top-ups.
- Forgery:
  - the customer cannot execute `credit_allowance`;
  - no customer route accepts figures;
  - unsigned or unauthorised webhooks credit nothing.

**Limitation:** PGlite is a single connection. Real multi-connection contention relies on the advisory lock, as in 056.

## 15. Migrations

- **062 is new and DRAFT; it is not applied anywhere.**
- 062 depends on 056 (DRAFT). 056 depends on 051.
- Inventory on 2026-10-03:
  - prod has 000–046;
  - staging also has 047, 051 and 057–061;
  - 062 and above are unused on every branch; 050 is avoided because of untracked staging objects.
- **Number conflicts on other branches:**

  | No. | Branches with different files |
  |---|---|
  | 044, 045 | `research/landline-poc` |
  | 046 | the old allowance WIP |
  | 055 | `call_delivery_evidence` vs `account_classification_history` |
  | 058, 060 | `call_delivery_events` vs the security 058/060 |
  | 061 | `household_iphone_carrier` vs the security 061 |

  The security branch's 057–061 are applied on staging, so the call-delivery and iPhone-carrier files are the ones to renumber.
- **Re-check 062 before applying:** Fortress's provisional ledger is unnumbered.
- **Apply order** (staging first): 047 → 051 → … → 056 → (Fortress ledger) → 062.
- **Rollback order:** 062 before 056, because of the FK to `usage_notifications`.

## 16. Unresolved cost assumptions (DECISION REQUIRED)

1. **The included allowance (100 min) is Fortress's placeholder.** I did not set a minute allowance for £5.99. The brief notes £5.99 ≈ £4.99 ex VAT, and the allowance must leave room for telephony, AI, infrastructure, retries, fees and the reserve. Carrier economics are still open.
2. **Top-up delivery cost per minute** (connected + monitoring vs monitoring only).
3. Apple commission (30% vs 15% SBP).
4. Top-up quantities and prices: none configured.
5. Whether top-ups expire at reset (implemented) or roll over.
6. Whether `calls_limited` may ever happen to a customer (§11).
7. Customer wording: UI and emails are all DRAFT. The email sender address also needs verifying.

## 17. Remaining launch blockers for this workstream

1. Andrew's allowance, price and top-up decisions (§16).
2. Fortress merged and its design settled. In particular, whether top-ups credit 056 or `fc_admin_adjust`.
3. RevenueCat sandbox entitlement leak and cross-source clobbering (§1). This needs the billing/RevenueCat owner.
4. In-app top-ups need a StoreKit consumable and Play Billing products. Android Play Billing compliance is also needed for the subscription itself.
5. Terms and store listing must describe the allowance and top-ups before enforcement (Apple 3.1.2).
6. A Build that understands `customerAllowance` / `monitoringAllowance.state: exhausted` must be live before `MONITORING_ALLOWANCE_ENFORCED=true`.

## 18. Integration order (proposed)

1. Fortress (Claude 1) settles 056 vs the £ ledger.
2. Rebase this branch onto Fortress's merged branch and re-check migration numbers.
3. Apply 056 (+ Fortress) then 062 on **staging**; run `tests/customer-allowance-*.mjs`.
4. Deploy the backend to staging with every flag off. The read model then appears on the dashboards with no behaviour change.
5. Approve wording; enable `ALLOWANCE_NOTICE_CHANNELS=email` on staging; verify one real email.
6. Configure one top-up product in Stripe **test** mode on staging (`APP_ENV=staging`, `ALLOWANCE_ALLOW_SANDBOX_CREDITS=true`), then buy, refund and replay it.
7. Production only after Andrew's approval: migrations, then the code, with flags off; then turn flags on one at a time.

## 19. Confirmation

- No deployment.
- No production or staging database or provider change.
- No migration applied.
- No merge.
- No collaborators added.
- Secrets scan of the branch diff: no keys, tokens, webhook secrets or project refs. Test files use obvious fakes (`sk_test_allowance_fake`, `whsec_allowance_test_secret`).
- Work stopped after this handover.
