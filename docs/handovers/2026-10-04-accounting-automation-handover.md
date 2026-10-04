# Handover: accounting, payments and Xero automation (2026-10-04)

**Nothing was deployed, merged, or applied to any database.**
- No Stripe, RevenueCat, Apple, Google, Xero or Supabase setting was changed.
- No real invoice was created or sent, and no money moved.
- Xero is not connected. Everything Xero-related runs against an in-memory mock or a fake `fetch`.

## 1. Branch, worktree, base
- **Branch:** `feature/accounting-automation`. It is pushed to `origin` with its own upstream, NOT the integration branch.
- **Worktree:** `/Users/ad/call-ai-accounting-automation`.
  - `node_modules` is a symlink to `/Users/ad/call-ai/node_modules` (git-ignored).
  - `mobile/node_modules` is a symlink to `/Users/ad/call-ai-launch-fortress/mobile/node_modules` (git-ignored; needed only by the two Android/TypeScript tests).
- **Base:** `origin/integration/launch-fortress-2026-10-03` @ `2011ab6`. That worktree (`/Users/ad/call-ai-launch-fortress`) was **not modified**.
- **Final HEAD:** the commit that adds this file (`git log -1`).

## 2. What was built
The full design, audit and rationale are in `docs/finance/ACCOUNTING_AUTOMATION.md`. In brief:

| Piece | File(s) |
|---|---|
| Vocabulary + accountant decisions AD-1…AD-11 | `services/accounting/constants.js` |
| Policy (confirmed decisions, account codes, VAT check), with no defaults | `services/accounting/accountingPolicy.js` |
| Stripe / RevenueCat normalisers (one event type per piece of money; RevenueCat is a feed) | `services/accounting/normalizeStripe.js`, `normalizeRevenueCat.js` |
| Engine (three-layer idempotency, refund/dispute linking, out-of-order re-linking, blockers → exceptions, auto-resolution) | `services/accounting/engine.js` |
| Reference store + SQL store (same interface) | `services/accounting/memoryStore.js`, `rpcStore.js` |
| Migration **071** (DRAFT) + rollback | `supabase/migrations/071_accounting_transactions.sql`, `_rollbacks/071_rollback_accounting_transactions.sql` |
| Xero mapping, HTTP adapter (custom connection, disabled by default), mock, error classes | `services/accounting/xero/*` |
| Posting queue (leased claims, per-step progress, find-by-Reference recovery, backoff, failure exceptions, manual retry) | `services/accounting/postingQueue.js` |
| Settlements (Stripe payout line matching + fees; store aggregate vs sub-ledger) | `services/accounting/settlement.js` |
| Money ↔ entitlement reconciliation (report-only) | `services/accounting/reconciliation.js` |
| 051 management-ledger projection (not wired to a writer) | `services/accounting/financialEntriesProjection.js` |
| Household/account resolver | `services/accounting/resolver.js` |
| Webhook capture hook: **OFF** unless `ACCOUNTING_CAPTURE_ENABLED=true`; never throws | `services/accounting/capture.js`; one awaited line in `routes/billing.js` (after signature verification) and in `routes/mobileApi.js` (after authorisation) |
| Read-only admin status: `GET /admin/api/accounting/status`, `GET /admin/api/accounting/exceptions` (requireAuth + requireAdmin; 503 until 071 is applied) | `routes/adminAccounting.js`, mounted in `server.js` |
| Manual worker (read-only by default, not scheduled) | `scripts/accounting-run.js` |

## 3. Authoritative sources (decided in this work)
| Question | Authority |
|---|---|
| Entitlement | existing canonical path (`entitlements`, 070); accounting never changes it |
| Customer payment | Stripe (web/Android); Apple/Google via RevenueCat |
| Accounting revenue | the 071 sub-ledger, posted to Xero (the book of record); store revenue only from reconciled settlements |
| Refunds | Stripe refund objects; RevenueCat CANCELLATION + CUSTOMER_SUPPORT, confirmed by the store report |
| Fees | Stripe payout balance transactions; the store financial report |
| Reconciliation | HCG engine + exception queue; the Xero bank feed for cash |

**No double counting:**
- A RevenueCat event with `store=STRIPE` is superseded by the Stripe webhook.
- Store money is keyed by the store transaction id, not the RevenueCat event id.
- Store transactions are never posted individually.
- `charge.succeeded`, `payment_intent.succeeded` and `invoice.payment_succeeded` are non-economic, because `invoice.paid` or the Checkout Session already carries that money.

## 4. Migration
- **071 `accounting_transactions` is DRAFT and NOT APPLIED ANYWHERE.** It is additive only (5 tables and 20 service-role functions) and touches nothing existing.
- RLS is on, there is no anon/authenticated access, and all functions use `search_path=''`.
- The rollback refuses while anything has been posted to Xero.
- It is allocated in `tests/migration-allocation.test.mjs` (highest = 071).
- **Collision check:** no other pushed branch or local worktree had a 071 at the time of writing. Parallel local branches `feature/customer-lifecycle-automation` and `finance/unit-economics-v1` exist, so re-run `node tests/launch-gate/migration-inventory.mjs --min 046` before allocating anything else.
- 071 depends only on `households` (FK). It does **not** need 062. Until 062 is applied and backfilled, every Stripe transaction is held with `missing_account`, which is the honest state.

## 5. Accountant decisions (all OPEN)
These are listed in full in the main doc §10 and in the admin status.

| ID | Decision |
|---|---|
| AD-1 | VAT registration details |
| AD-2 | Stripe VAT, incl. **charges before 2026-09-20 that Stripe collected with no VAT calculated** |
| AD-3 | Store as deemed supplier |
| AD-4 | Store revenue: gross or net |
| AD-5 | Recognition timing |
| AD-6 | Xero granularity |
| AD-7 | Chart of accounts / tax codes |
| AD-8 | Chargebacks |
| AD-9 | Refund VAT |
| AD-10 | Account number as the Xero contact |
| AD-11 | FX |

Posting is blocked until each relevant decision is listed in `ACCOUNTING_CONFIRMED_DECISIONS` and the codes are supplied. **Nothing was assumed.**

## 6. Tests
Full suite, run as `npm test` with the documented offline dummy environment:
`env -i PATH HOME NODE_ENV=test SUPABASE_URL=http://127.0.0.1:9 SUPABASE_ANON_KEY=x SUPABASE_SERVICE_ROLE_KEY=x APP_URL=https://example.test node scripts/run-all-tests.mjs`

- **Baseline** (2011ab6, same environment): **178 files, 178 passed; 7,669 ✓, 0 ✗.**
- **This branch:** **182 files, 182 passed, 0 failed; 8,149 ✓, 0 ✗.**
  - +4 new files (353 checks).
  - `migration-allocation` +3.
  - `migrations.pglite` +124: the existing security-definer grant audit now also covers all 071 functions. PUBLIC, anon and authenticated have no EXECUTE; service_role does.
  - No existing suite changed its result.

New suites:
| Suite | Checks |
|---|---|
| `accounting-engine` | 118 (29 scenarios, reference store) |
| `accounting-store-parity.pglite` | 140 (the same 29 scenarios through SQL, plus SQL guards) |
| `accounting-units` | 87 |
| `accounting-ledger-projection.pglite` | 8 |

The required cases are all covered: duplicate Stripe webhook; duplicate RevenueCat event; Apple/RevenueCat + accounting transaction; refund; chargeback; cancellation; payment failure; multiple channels; complimentary; sandbox/test; VAT; replay and out-of-order; Xero unavailable; retry after Xero failure; no duplicate accounting entry. The mapping is in main doc §15.

**Caveats:**
- PGlite is a single connection, so `FOR UPDATE SKIP LOCKED` multi-worker claiming must be re-proven on real PostgreSQL / staging.
- Without the dummy environment, 21 pre-existing suites fail at import with `supabaseUrl is required`. That is environmental, not a regression, and identical on the base.

## 7. Not done / open risks
Main doc §13 has the details.
1. The Stripe webhook endpoint must be subscribed to `invoice.paid`, `charge.refunded` and `charge.dispute.funds_withdrawn/reinstated`. That is a **provider setting and was NOT changed**.
2. Check the Stripe webhook API version (newer versions move invoice↔charge links).
3. No real-file parsers for Stripe payout reports or Apple/Google financial reports. There is no App Store Connect API key and no Play Billing.
4. Capture failures are alerted, not provider-retried. A Stripe Events API backfill script is not written.
5. Not wired: the 051 writer, the scheduled worker, and admin write actions (resolve/dismiss/retry) — the functions exist; the routes are deliberately not built.
6. Verify the RevenueCat `commission_percentage` / `tax_percentage` fields on a real production event.
7. GBP only.

## 8. Activation runbook
Main doc §14. In order:
1. Accountant decisions.
2. Xero custom connection (demo organisation first).
3. 062 + 071 on staging, then the backfill.
4. Capture on staging plus the Stripe event subscription.
5. Report and exceptions review.
6. Demo-company posting.
7. Production capture only, for a full month, with a manual cross-check.
8. Only then production posting.

## 9. Resume
```
cd /Users/ad/call-ai-accounting-automation && git status && git log --oneline -3
node tests/accounting-engine.test.mjs
node tests/accounting-store-parity.pglite.test.mjs
node tests/accounting-units.test.mjs
node tests/accounting-ledger-projection.pglite.test.mjs
```

## 10. Confirmation
- No deploy, merge, PR or migration apply.
- No production or staging read or write.
- No provider change.
- No real invoice; no real money.
- The existing integration worktree is untouched.
- The secret scan of the new files found nothing (patterns: `sk_live`, `sk_test_…`, `whsec_…`, JWTs, `AKIA`).
- All Xero account codes in tests are labelled TEST VALUES.

## 11. Final verification
- Full suite with the dummy environment: 182/182 files, 8,149 ✓ / 0 ✗.
- The branch is pushed to `origin/feature/accounting-automation`, and the worktree was clean after the push.
- The final HEAD is the commit that adds this file.
