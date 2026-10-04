# Launch sprint handover (overnight 2026-10-05)

Branch `integration/soft-launch-candidate-2026-10-04`, pushed. Started at `e225151`.

**Nothing was deployed, applied, built, submitted, purchased or sent.** No provider was contacted or changed: Stripe, App Store, Play, RevenueCat, Twilio and OpenAI are untouched, and so are call forwarding and …1883. The staging handset window was not opened.

## Commits tonight

| SHA | What |
|---|---|
| `4b40316` | Apple/RevenueCat cancellation + billing-issue lifecycle, **migration 073 (DRAFT, not applied)** |
| `2b66c36` | £5.99 in source (website, guides, terms, docs), live price-cutover checklist, production deployment runbook |
| `df0933f` | Genuine-customer notifications: milestones #1–5/10/25/50/100, Resend sender with idempotency, 15-min schedule (all OFF) |
| `2e3463d` | iOS / Android release prep, accounting + ops launch minimum, screenshot capture pipeline (`--final`) |
| `f7a9ecf` | Stop-acquisition switch + invite-only cohort gate; controlled-launch go/no-go runbook |

**Verification at `f7a9ecf`:**
- full suite **208/208 files, 9,049 checks, 0 failures**, including the real-PostgreSQL suites;
- mobile `tsc` **0 errors**;
- migration numbering clean (69 files, 30 rollbacks);
- the launch gate still reports **CLOSED** for an unrestricted launch (correct; no gate weakened).

## Documents to read (in order)

1. `docs/launch/2026-10-05-CONTROLLED-LAUNCH-RUNBOOK.md`: **the master go/no-go** (L-1 cohort decision, M1–M14).
2. `docs/launch/2026-10-05-STAGING-DEVICE-TEST-PLAN.md`: tomorrow's test (unchanged).
3. `docs/launch/2026-10-05-PRODUCTION-DEPLOYMENT-RUNBOOK.md`: 047 → 073, 24 files, no `--include-all`.
4. `docs/launch/2026-10-05-PRICE-CUTOVER-CHECKLIST.md`
5. `docs/launch/2026-10-05-ACCOUNTING-OPS-LAUNCH-MINIMUM.md`
6. `docs/releases/2026-10-05-IOS-102-RELEASE-PREP.md`, `docs/releases/2026-10-05-ANDROID-RELEASE-PREP.md`
7. `docs/operations/2026-10-05-APPLE-STORE-LIFECYCLE-073.md`

---

## MORNING REPORT

### DONE

- **£5.99 audit + source cutover.** Every customer-facing £4.99 is now £5.99: homepage (including the JSON-LD offer), 12 guides (CTAs now price-free), terms (+ Apple payment, cancellation and refund wording, a forwarding warning on cancel), `MARKETING_FACTS`, launch docs, Play description. Silent £4.99 fallbacks in admin/finance now use the economics register. **A test now fails if any homepage, terms or guide page mentions 4.99.** The apps already read the price from StoreKit or Stripe. **Not deployed; no provider changed.**
- **Exact live-cutover order** written, so £4.99 can't be left behind:
  1. backend first;
  2. a new **tax-inclusive** live Stripe Price and the `STRIPE_PRICE_ID` switch;
  3. Stripe Tax, receipts and Portal;
  4. App Store price change **only after 1.0.2 is live**.
- **Apple lifecycle (073):**
  - Apple cancellation shows "Cancelled — protection continues until [date]". Access is never cut early; only EXPIRATION ends it.
  - A billing problem shows "Payment needs attention".
  - Sandbox events can never touch production rows.
  - Refunds are recorded and alerted.
  - One shared membership derivation for web and app (the Stripe logic is byte-for-byte unchanged).
  - 073 was verified free on every branch and worktree; idempotent; the rollback refuses while billing history exists.
- **Genuine-customer notifications:**
  - Each genuine customer is numbered; **#1–5, 10, 25, 50, 100 say "MILESTONE"**.
  - Reviewer, internal, sandbox, unverified, Stripe-test and complimentary accounts never notify.
  - A retry can't double-send (idempotency key).
  - 5 failed attempts → visible as failed.
  - Not on any customer path.
  - Startup refuses email ON without Resend + an operations recipient.
  - Everything is OFF until you switch it on.
- **Production deployment runbook:**
  - The collision analysis is resolved: the candidate's sequence is clean; the cross-branch "collisions" are all superseded side branches.
  - Production is at 046, so 047 → 073 applies monotonically.
  - **070 keeps the exact function signature, so the currently running backend stays compatible during the gap.**
  - The runbook covers backup + restore rehearsal, verification queries, and stop/rollback rules.
- **Controlled-launch runbook:**
  - MUST-before-first-customer, acceptable temporary limitations, MUST-before-scaling;
  - stop-acquisition and incident procedure, with what each lever does to customers' calls;
  - provider-spend, first-customer and weekend monitoring.
- **New controls (built, tested, OFF by default):**
  - `NEW_SUBSCRIPTIONS_PAUSED=true` stops new paid sign-ups;
  - `NEW_SUBSCRIPTIONS_ALLOWLIST` makes checkout invite-only.
  - Existing customers, renewals and calls are unaffected.
- **iOS prep:**
  - corrected, price-free store copy;
  - claims audit (removed "no delays", "ends the call", the trusted-number spoofing implication);
  - Build ≥ 17 checklist;
  - **screenshot pipeline:** frames 03/05/06/07 take real captures, and `--final` exports 6.9" + 6.5". It refuses (DRAFT) while any capture is missing. The approved 8-frame design is unchanged except frame 04's banned "no delays" line.
- **Android prep:** Play payments options assessed, vc ≥ 23 checklist, listing and permission audit, Play Billing gaps identified (the RevenueCat webhook would label a Play purchase as Apple).
- **Accounting/ops:** capture can stay OFF for the first five (Stripe + ASC are the records); separation rules; support/refund gaps listed.

### NEEDS ANDREW (batched: 4 replies)

**Reply 1: decisions (one line each)**
1. **L-1 cohort channel:** (A) Android via Play *Internal* + Stripe, with written risk acceptance [recommended if tomorrow's Motorola test passes] / (B) iOS when Build ≥ 17 is approved / (D) slip.
2. **D-P2:** existing £4.99 subscribers keep £4.99 (recommended).
3. **D-P3:** approve the terms changes as written (`public/terms.html`; the price-change clause is unchanged).
4. **L-5 cohort refund rule:** full refund on request within 14 days, refund + cancel together (recommended).
5. **D-A1:** Apple refund keeps access until support acts (recommended).
6. **B-11:** accept the Android lock-screen banner collapse for the cohort (recommended, recorded).
7. **I-2 / I-3 / I-4 / I-10:** frame 05 captured later on Build 17; show the allowance meter; replace frame 02's "Your bank" card; fix the one Home string "Blocked a suspected scam call". All recommended.

**Reply 2: "GO staging window"** (tomorrow's device test; as in the plan) **plus GO to apply 073 to staging** in the same window.

**Reply 3: provider and console checks (you only; about 15 min)**
- Play Console: what is live on **Production** (B-13)? Was the foreground-service declaration filed?
- ASC: the current live subtitle and keywords.
- Stripe: is Stripe Tax registration active in live mode?
- OpenAI: set a project spend limit.

**Reply 4: the accountant email** (AD-1…4, text in the accounting doc). Send whenever convenient.

### NEEDS DEVICE TEST

- iPhone Build 16 end-to-end (T-series), Motorola vc 22 (M-series).
- Screenshot captures 03/06/07 (and 05, per I-2).
- iPhone `**21*` auto-dial behaviour (decides the forwarding wording).
- Production smoke test on Build 17 / vc 23 after deploy.

### NEEDS PROVIDER

- Stripe: new live £5.99 tax-inclusive Price, Stripe Tax live, receipts on, Billing Portal at period end.
- Twilio: `<Reject/>` fallback on production numbers, a usage trigger.
- OpenAI: project spend limit.
- ASC: £5.99 IAP price, only after 1.0.2 is live.
- Play Console / RevenueCat: Play Billing product + RevenueCat Android app (if A-2).
- Resend / mailbox: operations@ mailbox.

### BLOCKS FIRST 5 CUSTOMERS

Runbook M1–M14, all RED:
- device test passed (M1);
- 073 on staging (M2);
- production backup (M3), migrations (M4), backend + first signed call (M5);
- Fortress production budgets (M6);
- provider exposure bounded/accepted (M7);
- live £5.99 + VAT evidence (M8);
- invite list set (M9) and stop switch tested (M10);
- notifications on (M11);
- support + refund rule (M12);
- a store build for the chosen channel (M13);
- admin login on production (M14).

### BLOCKS SCALING

- Twilio subaccount and a restricted runtime key (master token offline).
- Play Billing.
- iOS 1.0.2 live, with real screenshots and the £5.99 IAP.
- Accounting capture in shadow mode + accountant answers.
- operations@ + notification email.
- Allowance and price-change wording in the terms.
- Staging G-items GREEN.
- A week of clean cohort evidence.

---

## Safety notes from tonight

- An accidental `node -e "require('./server.js')"` was started in the candidate worktree while checking module loading. It had no `.env` or credentials, exited by itself, and nothing was listening. I verified no stray process remained, and an unrelated pre-existing node process (PID 946) was left alone.
- All four research reviews were read-only. Their findings are folded into the documents above.
