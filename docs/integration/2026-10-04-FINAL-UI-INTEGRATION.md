# Final UI integration: Admin Control Centre + Mobile 1.0.2 (2026-10-04)

Branch `integration/soft-launch-candidate-2026-10-04`. Nothing in this pass was deployed, submitted, built or applied to production.

## 1. What was integrated

| Branch | SHA | Merge | Conflicts |
|---|---|---|---|
| `feature/admin-control-centre-redesign` | e349668 | b991332 | none (textual); `server.js` safety markers re-verified |
| `feature/mobile-1.0.2-customer-experience` | a77801b | 1b3d844 | none (textual) |

The candidate stays authoritative for security, financial containment, lifecycle classification and backend behaviour. Neither branch adds a migration.

## 2. Reconciliations (semantic, not textual)

| # | Requirement | Result |
|---|---|---|
| 1 | ONE genuine-customer definition | `services/commercial/householdCommercialIndex.js` feeds every admin/business surface from `classifyCommercialStatus`: overview, MRR attribution (MI-1a), finance, subscriptions, usage safety, acquisition, classification, number inventory, release readiness, due-diligence snapshot. A classification label is only an exclusion input. `hasGenuinePaymentHistory` is the history counterpart (Stripe live or store production only). The "Paid but unclassified" card is replaced by "Paid membership recorded, money not proven". The "classification" attention topic and the duplicate glossary rows are removed (MI-1d). |
| 1b | **Stripe TEST purchases** were classified `stripe_live`, because entitlements don't record livemode. That would have made a staging test purchase "genuine" and raised `NEW_GENUINE_CUSTOMER`. | Fixed: `configuredStripeLivemode()`. Where the row has no recorded livemode, the deployment's own key decides (`sk_test`/`rk_test` → `stripe_test`). An explicit livemode on the row still wins, and an unset/unknown key leaves behaviour unchanged. Effects on a test-key deployment: not genuine, no genuine-customer event, no real number purchase (tested). |
| 2 | ONE protected definition | Admin onboarding, health, customers and household detail merge `deriveActivationState` (all nine gates) via `mergeProtection` (MI-2a). Hold, quarantine and old-number evidence are never "Protected". MI-2b: admin `STAGE_DISPLAY`/`BLOCKER_TEXT` and the app checklist read the same `activationStage`/`protectionBlockers` codes. Pinned by `tests/protection-vocabulary-parity.test.mjs`. |
| 3 | Finding-1 no-app fail-safe | Preserved (`/voice` unbilled `<Reject/>` before any reservation/announcement; needs-attention reporting). Tests green. |
| 4 | Financial controls / staging limits | Unchanged: Fortress (067), latching breaker, kill switch, holds, D3 reject; staging £0.30 household, £0.50/h, £1/day, 0 purchases/day, 600 s. £5.99 TEST price only in the private staging env. Live Stripe untouched. |
| 5 | …1883 | Not touched, not released; no telephony window started. Reserved-number protection in the admin redesign test still passes. |
| 6 | Admin redesign MI-1…MI-5 | MI-1/MI-2 above. MI-3: `admin-control-centre-redesign` 77/77 on the integrated tree. A staging server-only boot verified the admin API and `/admin/business` fail closed (no/bad token → redirect to login, no data). **A real admin login was not done** (needs Andrew's credentials). MI-4: no new migrations. MI-5: typed-confirmation audited emergency endpoints, `requireAuth`+`requireAdmin`, notifications OFF: unchanged. |
| 7 | Mobile 1.0.2 | Kept: server-confirmed checklist, needs-attention/Reconnect, Membership tab, HCG account number, Help, trusted-contact explanation, navigation. `tsc` 0 errors. |
| 8 | Apple lifecycle gap | **Not fixed. Blocker documented in §3.** |
| 9 | Sandbox/TestFlight purchase guard | Present in four layers: webhook `resolveEventIsSandbox` fails closed; entitlement environment (053); `decideNumberPurchaseByProvenance`; the classifier. No TestFlight purchase was made. |
| 10 | Duplicate checklist terminology | The "Protection status" screen rendered a second, differently-worded 5-step list. It now renders Home's canonical checklist (same component, same server gates). The Home link is now "See setup steps"; the screen title is "Setup steps". The server's legacy `protection.steps` stay in the API for shipped 1.0.1. |
| 11 | iOS 1.0.1 status | §4 |
| 12 | D-C5 paused wording | §5 |

## 3. Apple cancellation / billing-issue blocker (item 8)

The RevenueCat webhook acknowledges `CANCELLATION` and `BILLING_ISSUE` with no record (`routes/mobileApi.js`, "acknowledged_no_change"). Only `EXPIRATION` revokes. The membership read model (`membershipStatus`) reads `subscriptions.cancel_at_period_end`/`past_due`, and that table is Stripe-only (`stripe_subscription_id NOT NULL`). There is **no column** that can hold Apple's will-not-renew or billing-retry state. Writing it into `notes` or into the Stripe table would be invented state, so nothing was changed.

Customer impact today: an Apple customer who cancels still sees "Active" until expiry. That is true, because access continues. The Membership tab shows no renewal date for Apple (`nextBillingDate` is Stripe-only), so nothing false is promised. Admin churn counts an Apple cancellation only at expiry.

Proposed fix (needs Andrew's approval: new migration **073**, staging first):
1. `entitlements.store_will_renew boolean null`, `store_billing_issue_at timestamptz null`, `store_state_event_at timestamptz null` (ordering guard, as in 019).
2. RC webhook, production events only: `CANCELLATION` → `will_renew=false`; `UNCANCELLATION`/`RENEWAL` → `true` and clear the billing issue; `BILLING_ISSUE` → set `billing_issue_at`. Ignore stale events by `event_timestamp_ms`. Never revoke.
3. Read model (`/api/v1/me/dashboard` + `/dashboard-data`): Apple `will_renew=false` → `cancelled` with `accessUntil=ends_at`; a billing issue → `payment_issue`. Admin `classifyHouseholdForBusiness` reads the same fields.

## 4. iOS 1.0.1 discrepancy (read-only)

- Public App Store lookup (GB, bundle `co.uk.homecallguard.app`): **version 1.0.1 live, `currentVersionReleaseDate` 2026-09-28T18:20:33Z**. Release notes: "Minor update to support App Store subscription availability."
- EAS (`build:list`, read-only): Build 14 = 1.0.1, commit `1f24483`, finished 2026-09-22. It is the newest iOS build, and the only 1.0.1 build. No Build 15 exists.
- Conclusion: 1.0.1 (Build 14) **is live**. The "held" statement is out of date. Not visible without App Store Connect: whether the subscription IAP was approved alongside it. The next iOS build is 1.0.2 Build 15 (remote autoIncrement). Live 1.0.1 still hard-codes £4.99.

## 5. D-C5: paused-account wording (recommendation; Andrew owns the copy)

Verified behaviour: on a household hold, `/voice` returns `<Reject reason="busy"/>` for **every** forwarded call, trusted contacts included (`server.js` financial-safety and containment refusals). The draft copy "Protection on your account is paused. Please contact us and we'll sort it out." does not tell the customer that their calls are not reaching them.

Recommended (headline unchanged: "PROTECTION NEEDS ATTENTION"; action: "Contact support"):

> **Protection is paused on your account, so forwarded calls can't reach you right now. Callers hear a busy tone. Contact us and we'll sort it out. If you need your calls straight away, turn off call forwarding.**

**APPROVED by Andrew (2026-10-04) and APPLIED** in `mobile/lib/protectionView.ts` (`on_hold`), with an exact-text test in `tests/mobile-protection-view.test.mjs`. The web dashboard has no hold-specific copy today: a held household sees the generic "not yet protected" path, which is still never "protected". Adding the sentence there is a separate web change.

## 6. Verification

| Check | Result |
|---|---|
| Full suite (inert local env, real-PG modules on) | **202/202 files, 8,925 ✓, 0 ✗** |
| Real PostgreSQL (embedded, throwaway) | financial-containment 15 ✓, launch-fortress 10 ✓, accounting-posting 9 ✓ |
| Admin redesign | 77 ✓ |
| Mobile `tsc --noEmit` | 0 errors |
| Migration numbering | 68 files, no duplicates; 29 rollbacks matched; highest 072; next free 073 |
| Staging server-only boot (no ngrok, Twilio/OpenAI placeholders) | `check-launch-config` → START; unsigned `/voice` → 403; admin API + page fail closed. Stopped (verified PID, port free). |
| Staging admin login as a real admin | **Not done**: needs Andrew |

Migration state is unchanged by this pass. Staging: 052–072 applied. Production: none of 053–072.
