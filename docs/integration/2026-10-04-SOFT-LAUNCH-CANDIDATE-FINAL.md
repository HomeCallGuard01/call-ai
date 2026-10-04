# Soft-launch candidate: final integration report (2026-10-04)

Branch `integration/soft-launch-candidate-2026-10-04` · worktree `/Users/ad/call-ai-soft-launch-candidate`
Base `integration/launch-fortress-2026-10-03` @ `2011ab6` · last code commit `1a4fa71` (the exact branch tip is in the handover and the final response).

Nothing has been deployed, applied, built, submitted, sent or contacted. There have been no provider, store or customer changes.

Evidence vocabulary: **PROVEN LOCALLY** · **NEEDS STAGING PROOF** · **NEEDS PRODUCTION PROOF** · **EXTERNAL PROVIDER CONFIRMATION** · **BUSINESS DECISION REQUIRED** · **ACCOUNTANT DECISION REQUIRED** · **BLOCKED**.

---

## 1. Executive conclusion

- **All five workstreams are integrated into one candidate.** Git conflicts were trivial: one adjacent-line conflict in `server.js`. No migration renumbering was needed, because 071 was verified free.
- **Every launch-critical code fix in brief §6 is implemented and tested locally.**
  - SMS spend now needs an explicit financial authorisation.
  - HCG failures no longer cause billable error calls.
  - The `/process` route is no longer an orphan paid route.
  - A verified Twilio usage alert latches the Fortress kill switch.
  - Production and staging refuse to start in an unsafe configuration.
  - One canonical protection status now drives every customer surface.
  - The Stripe deletion retry loop is ended.
  - Accounting can no longer stall or affect entitlement.
  - The economics register is the single source of runtime cost assumptions.
- **The integration also found and closed one further gap.** The cross-instance number-purchase lock (migration 066) existed but was never wired. Ten concurrent server instances bought **ten** numbers for one household; with the lock wired, they buy exactly one.
- **Production investigation (read-only, `2026-10-04-UNKNOWN-ACCOUNT-INVESTIGATION.md`).** The unrecognised "Paying" account from 28 Sep is an Apple/RevenueCat grant:
  - no Stripe record exists and no money is evidenced;
  - a **real Twilio number was bought 2 s after the grant**;
  - the account was never set up and has 0 calls.
  It is very likely a sandbox, TestFlight or App Review purchase. The cause is confirmed: **production has no store-environment guard and labels any paid entitlement type "Paying"**. The candidate now has:
  - one commercial classifier;
  - a provenance guard on every number-purchase path;
  - honest admin labels and counts;
  - a requested **operational-event framework** (new genuine customer, protected, needs attention). It is exactly-once, safe-payload and role-routed, with delivery OFF.
  Until this candidate and migration 053 are deployed, production keeps buying numbers for store test purchases. That is a **launch blocker**.
- **Full suite: 197/197 files, 8,716 checks ✓, 0 ✗.** That includes real multi-connection PostgreSQL race suites. The mobile type-check is clean.
- **The provider level is still RED.** HCG's backend still holds the master Twilio Auth Token, and Twilio documents no hard spend cap. Under credential compromise, HCG's financial loss is **not bounded by anything HCG controls**. The application controls are strong, but they cannot stop someone who holds the master token. Therefore:

| Question | Answer |
|---|---|
| A. Is the SOFTWARE internally ready for staging? | **Yes.** It is ready for the staging programme, subject to the decisions in §14 that staging itself needs. |
| B. Is STAGING ready to begin? | **Not yet.** It needs your go-ahead, a staging backup, and the staging configuration. Staging also still shares the production Twilio account (B-6); until that is fixed, real number purchases stay blocked in staging. |
| C. Is a 5-customer controlled soft launch safe? | **Not today.** It becomes defensible after staging passes, the provider credential and fallback hardening in §16 is done, and you accept a written residual-exposure statement. The application exposure is then small and bounded; the provider exposure is reduced but not proven. |
| D. Is unrestricted public launch safe? | **No.** The gate is CLOSED: provider containment is RED, Android Play Billing is absent, iOS store assets are incomplete, and no 1.0.2 build has been on a handset. |

## 2. Integrated branch / HEAD

- Branch: `integration/soft-launch-candidate-2026-10-04` (new). It is pushed to origin with the same name. See the handover for the final SHA.
- Base: `2011ab6`, verified as the current remote HEAD of `integration/launch-fortress-2026-10-03` on 2026-10-04. No new commits had appeared.
- Changes since the base: 121 files, +12023/−158 lines (5 workstream merges plus the integration commits listed in the handover).

## 3. Workstreams incorporated

| Workstream | Branch @ HEAD (verified) | Method | Conflicts |
|---|---|---|---|
| Provider financial containment | `research/provider-financial-containment` @ `aaa43ba` | `merge --no-ff` | none |
| Unit economics | `finance/unit-economics-v1` @ `f6633ee` | `merge --no-ff` | none |
| Accounting / Xero | `feature/accounting-automation` @ `8e3d0bd` | `merge --no-ff` | none |
| Customer lifecycle | `feature/customer-lifecycle-automation` @ `d6f586a` | `merge --no-ff` | `server.js`: both workstreams added one `app.use` after `adminFortress`. Resolved by keeping both. |
| Release readiness | `release/launch-readiness-2026-10-04` @ `75ff4ac` | `merge --no-ff` | none |

All five branched directly from `2011ab6`, and their worktrees were clean. A no-ff merge keeps every original SHA, so provenance is preserved. The plan written before the merges is `2026-10-04-SOFT-LAUNCH-INTEGRATION-PLAN.md`.

## 4. Migration map

| # | File | State |
|---|---|---|
| 046–061 | as frozen by the 2026-10-03 reconciliation (048–050 burned) | 046 production+staging; 047, 051, 057–061 staging; others draft |
| 062–070 | identity, allowance, delivery events, iPhone carrier, abuse shared state, **Fortress 067**, credit bridge, classification history, canonical Stripe decision | DRAFT, not applied |
| **071** | `071_accounting_transactions.sql` + `_rollbacks/071_rollback_accounting_transactions.sql` | DRAFT, not applied. **Number verified free** across every local and remote ref. Registered in `tests/migration-allocation.test.mjs`. |
| **072** | `072_operational_events.sql` + rollback (refuses while history exists) | DRAFT, not applied. New in this integration (operational events and notification deliveries). |
| next free | **073** | — |

Collisions on other refs (046/055/058/060/061) exist only on older, unintegrated branches: `release/ios-1.0.2`, `readiness/*`, `docs/price-599-release-audit`, `feature/ios-102-dynamic-pricing` and `feature/admin-control-centre-v2`. They do **not** affect this candidate. However, **no mobile build should come from `release/ios-1.0.2`**: its drafted 060/061 are superseded here by 064/065.

**Deploy-order dependency added by this integration:** **053** must be applied so that store environment is recorded. Without it, every store grant is "environment unverified": not counted as paying, and no new number is bought unless an admin overrides. The backend also now **requires 066** (the number-purchase claim), **067** (Fortress), **070** (the Stripe decision) and the others **before** it is deployed. Without 066, number purchases are *held*: they fail closed rather than proceeding without the lock.

## 5. Architecture after integration (what changed at the edges)

```
Twilio ──signed──► /voice ─► abuse screen ─► Fortress reservation (D3 reject) ─► <Dial timeLimit≤14400><Client>
   │                  └─ any unhandled error ─► 200 <Reject/>  (was: 500 → Twilio-answered "application error", billed)
   │  no household for number ─► <Reject/>  (was: answered apology)
   │  /process (dormant) ─► <Hangup/> unless PROCESS_ROUTE_ENABLED=true (startup-refused in prod/staging)
   │  egress guard: any <Dial> without 1..14400 s timeLimit ─► whole response = unbilled <Reject/>
   │  number purchase ─► guard singleFlight + 066 cross-instance claim (NEW wiring) + Fortress authorize + cap
   └─ usage trigger ─► /webhooks/provider-usage-alert ─signed+account+fresh+designated─► fc_set_kill_switch(on) [latching, admin reset]
SMS ─► guardSmsClient ─► smsBudget: Fortress authorizeSpend (allowed===true only) ─► 056 ceiling (bounded timeout, allowed===true only) ─► provider
Customer surfaces (/dashboard-data, /api/v1/me/dashboard, /api/v1/activation/verify, app Account tab)
   └─► canonicalProtection = legacy ∧ lifecycle state machine (entitled, not held, number active+not quarantined,
       current-number evidence, app reachable, state known); load failure ⇒ NOT protected
Stripe webhook ─► (deleted household? → claim → 'ignored' 200; live sub → alert + queue) ─► 070 RPC
Accounting capture (OFF by default) ─► bounded 2 s, result ignored, never writes entitlement/household/Fortress
Boot ─► launchConfig (prod/staging: fatal on unsafe/missing; named acknowledgement only) ─► legacy validator ─► app
```

## 6. Financial containment status (application: LEVELS 1–3)

| Control | Status | Evidence |
|---|---|---|
| Reservation before spend; lease renewal; termination when authority fails; D3 reject | PROVEN LOCALLY | Fortress suites (unchanged and re-run) |
| Latching global breaker, manual reset only; kill switch | PROVEN LOCALLY | `fortress-kill-switches.pglite`, `defence-in-depth.pglite` |
| Per-household holds; trusted callers cannot bypass them | PROVEN LOCALLY | `fortress-kill-switches.pglite`, `canonical-protection` |
| 10+ simultaneous calls against one household | PROVEN LOCALLY (real PostgreSQL) | `financial-containment-realpg`: 50 racing calls on 12 connections; the household consumed ≤ its £0.20 |
| **SMS: explicit authorisation; unavailable, malformed or timed-out authority means no send** | PROVEN LOCALLY (new) | `sms-fail-closed-adversarial`: 16 refusal cases plus 3 positive controls |
| **HCG failure on a voice route returns an unbilled `<Reject/>`** | PROVEN LOCALLY (new); provider billing of `<Reject>` is EXTERNAL (Q11) | `provider-cost-paths` |
| **No unbounded `<Dial>` from any route** | PROVEN LOCALLY (new structural rule) | `telephony-abuse-controls`, `provider-cost-paths` |
| **`/process` cannot spend** | PROVEN LOCALLY (new) | `provider-cost-paths` |
| **A verified usage alert latches the kill switch; forgery, replay and stale alerts have no effect** | PROVEN LOCALLY (new, against real 067 SQL) | `provider-usage-alert-breaker.pglite` |
| **Duplicate number purchase across instances** | PROVEN LOCALLY (new wiring); NEEDS STAGING PROOF with 066 applied | `number-purchase-race-adversarial`: with claim → 1 purchase; without → 10 (9 released); claim down → 0; cap honoured |
| **Unsafe production or staging configuration refused at boot** | PROVEN LOCALLY (real `server.js` boots) | `launch-config-safety` |
| **Non-production store purchases (Apple sandbox, TestFlight, App Review; Google test) cannot buy a real number on any path** | PROVEN LOCALLY (new); production today: **NOT protected** (confirmed defect) | `ops-events-commercial-classification` §2 |
| Destination policy (premium/international refused before the trusted decision) | PROVEN LOCALLY | `destination-cost-policy`, abuse suites |
| Webhook/callback replay, idempotency | PROVEN LOCALLY | abuse and webhook-integrity suites; `stripe-deleted-household-webhook` |
| All of the above against real Supabase and Twilio | NEEDS STAGING PROOF | staging steps 7–12 |

**Customer-safety trade-off, accepted by rule and stated here:** a protective scam-warning SMS is **not sent** if the financial authority is unavailable or uncertain. Before 2026-10-04 it was sent anyway. This follows your rule that financial uncertainty must reject spend. During a database or Fortress outage, a protected person can therefore miss a warning SMS. The call itself still follows the D3 rules.

## 7. Provider containment status (LEVEL 4): **RED / EXTERNAL**

- **What is unchanged:**
  - Twilio documents no maximum spend setting. Usage triggers are alerts, not caps.
  - Zero-balance suspension is leaky: in-progress calls continue.
  - The backend holds the **master** Auth Token, which can do anything, including deleting triggers and buying numbers.
- **What this integration added is an *application* stop, not a provider cap:** a designated, verified usage alert now latches HCG's kill switch. A stolen credential used **outside** HCG is unaffected by it.
- **What makes LEVEL 4 defensible:**
  - a production subaccount;
  - the master credential kept offline;
  - a restricted runtime key;
  - a prepaid balance with auto-recharge off;
  - an automated suspension service (`TWILIO_CONTAINMENT_CHECKLIST.md`);
  - written answers to Q1–Q12 (§16).
- **Not executed and not contacted.** There is **no** truthful claim today that HCG cannot suffer uncontrolled loss.

## 8. Unit economics status

- The register (`services/finance/assumptions/hcg-unit-economics.v1.json`) is the **one source of runtime cost assumptions**. It feeds `costModel`, `economicPolicy`, the carrier comparison, plans and pricing scenarios. The 067 SQL defaults are pinned to it by a test.
- **New in this integration:**
  - The admin dashboard reads its inbound rate from the register.
  - The lifecycle planner reads the KNOWN number rental from the register.
  - A drift test fails if any runtime file re-states a provider rate.
- **Enforcement vs estimate:**
  - The Fortress keeps its conservative **enforcement** basis: app leg at list price plus a 1.10 uplift. That is about 1.42× the billed trusted-minute cost.
  - Dashboards use the **expected (billed)** basis.
  - A test asserts the enforcement basis is never cheaper than the billed basis.
  - Lower economics estimates never replace enforcement costs.
- **The register is not an allowance authority.** Approved customer allowance stays with the DB policy (Fortress profiles, decision D1).
- **What is still not known:**
  - There is no real usage data.
  - £5.99 is a candidate, not approved. At current Twilio pricing it may not reach the 40% target for illustrative usage.
  - Trusted calls are the dominant cost while HCG pays for their media path.
  - KNOWN / CONFIGURED / ESTIMATED / UNKNOWN labels are preserved.

## 9. Accounting / Xero status

| Item | Status |
|---|---|
| Sub-ledger, exception queue, Xero outbox, reconciliation (071) | PROVEN LOCALLY (PGlite + **real PostgreSQL**); NEEDS STAGING PROOF |
| Capture OFF by default; bounded (2 s); never blocks or changes entitlement; no writes to entitlement, household or Fortress tables | PROVEN LOCALLY (`accounting-integration-safety`) |
| Idempotency at the webhook-event, payment-transaction and Xero-document layers under 12-way races; 240 postings claimed exactly once by 12 workers; lease recovery; posted is terminal | PROVEN LOCALLY (`accounting-posting-realpg`, PostgreSQL 18.4) |
| Xero posting | OFF. Production refuses to start with posting on and no `ACCOUNTING_CONFIRMED_DECISIONS`. Credentials are required only when posting is on. |
| Live Xero connection, Stripe event settings, payout/report readers, missed-event backfill, scheduled worker | EXTERNAL / not built (out of scope without credentials) |
| AD-1…AD-11 | ACCOUNTANT DECISION REQUIRED (§15) |
| One shared exception dashboard | **Not merged.** The lifecycle and accounting queues stay separate admin views. Merging them is presentation only, and was not worth the risk now. |

## 10. Customer lifecycle status

| Item | Status |
|---|---|
| **One canonical "protected"** (F-02, P-1…P-5): web, mobile dashboard, verify route, checklist | PROVEN LOCALLY (`canonical-protection`: held, unentitled, quarantined, old-number proof, unreachable, deleted, unreadable state → never protected; the old rule said "protected" for a held household). Backward compatible: same fields, so shipped apps become strict without a release. |
| Mobile Account tab (P-4) | Fixed in code. Ships with the next build. `tsc` is clean. |
| **Stripe `subscription.deleted` loop after deletion (F-03)** | PROVEN LOCALLY through the real route with genuine signatures: acknowledged once, recorded `ignored`, never re-entitles, replay idempotent. A live subscription for a deleted account is alerted and queued (`DELETED_HOUSEHOLD_SUBSCRIPTION_LIVE`). |
| Billed quarantines visible with £ exposure | Done. The default comes from the register's KNOWN £0.86917/month. Never auto-released (D-N2). |
| Lifecycle communications | Planner only. **There is no send path** (asserted by a test). Sending stays off until the wording and channel decisions are made. |
| Admin bulk "protected" counters (`adminMetrics`, `businessControl`) | Still the legacy rule (admin-only). The admin lifecycle view is canonical. Follow-up. |
| Copy for held, renumbered or other new states | BUSINESS DECISION REQUIRED (D-C5). No wording was invented: such a customer now sees the existing "not yet protected" path. |
| **Genuine-paying classification** | One classifier (`services/commercial/commercialStatus.js`). "Paying" means only Stripe live or store **production**. The classes are: Apple sandbox (incl. TestFlight and App Review, which RevenueCat cannot tell apart), Google test, Stripe test mode, store environment **unverified** (pre-053 rows, e.g. the 28 Sep account), complimentary, trial, and internal/test/reviewer. Used by admin labels and counts, the exception queue, number purchase and operational events. |
| **Operational events / notifications** | `NEW_GENUINE_CUSTOMER`, `CUSTOMER_PROTECTED`, `CUSTOMER_NEEDS_ATTENTION`:<br>• exactly once by event key; deliveries per channel and role, retries never duplicating the event;<br>• the payload has no email, phone or payment id (code assert + 072 CHECK);<br>• the admin endpoint shows unseen events and failed deliveries;<br>• email to configured **roles** (`operations` for the future operations@ mailbox, plus `founder` during early launch), with no address hard-coded;<br>• push modelled for the future admin app.<br>**Sending OFF, no live provider adapter, runner not scheduled.** 072 DRAFT. |

**Safe manual number-retirement workflow (design; no automation):**
1. The exception queue lists every unreleased quarantine with its age and £ accrued.
2. The operator checks that the household is not entitled. Migration 047 also refuses the release while entitled.
3. The operator confirms with `POST /admin/api/households/:id/confirm-deactivation`. This is API-only today; a UI button is a small follow-up.
4. The daily runner releases the number at the provider through the row-locked RPC.
5. `QUARANTINE_WITHOUT_HOUSEHOLD` needs a by-quarantine-id confirm route (follow-up).
6. A returning customer is decided per case: reinstate the old number or confirm its release.

## 11. Mobile / store status

| Item | Position |
|---|---|
| Android RC | This integration's final HEAD (`mobile/` = 2011ab6 + Account-tab fix + 2 optional type fields). **1.0.2, versionCode ≥ 22** (vc 21 is already used). NEEDS STAGING PROOF |
| iOS RC | Same commit. **1.0.2 Build 15**. Not `release/ios-1.0.2` (migration drift). NEEDS STAGING PROOF |
| Do backend changes require a mobile change? | **No for compatibility**: all API changes are additive or stricter, so old builds keep working and simply show "protected" less often. **Yes for correctness on Account**: the P-4 fix needs the new build. |
| Order | Backend, then migrations and config, then mobile. The new apps already need the new backend (`device-readiness`, `customerAllowance`). |
| Android Play Billing | Required for **Play Production** (calls are consumed in-app; Stripe in-app is very likely a Payments-policy violation). **Not** required for Internal or Closed testing with invited users. BLOCKED for Production. |
| RevenueCat / IAP | iOS only (`hcg_protected`, `co.uk.homecallguard.app.monthly`, £4.99). There is no Android RevenueCat key. A £5.99 change needs ASC, RevenueCat and Stripe changes plus terms notice. |
| Screenshots / metadata | iOS: all 5 live frames are obsolete (£4.99, the withdrawn guarantee, a sandbox dialog, a TestFlight bar); only frame 01 has been regenerated. Play: frames 02/04/06/07/08 show the old UI. BLOCKED / BUSINESS DECISION |
| £4.99 vs £5.99 | Every customer surface says £4.99 (website, terms §4, 11 guides; the live app on main). The register and Fortress seeds assume £5.99. See `2026-10-04-COMMERCIAL-FIGURE-INVENTORY.md`. BUSINESS DECISION REQUIRED |
| Real device | No 1.0.2 build has ever been on a handset. No iPhone test exists. NEEDS STAGING PROOF |

## 12. Test evidence

Environment: offline dummy environment (no real credentials), a cloned `mobile/node_modules`, and `FC_REALPG_MODULES` pointing at embedded PostgreSQL. This is the same method the Fortress used.

| Run | Files | Checks |
|---|---|---|
| Untouched base 2011ab6 | 178 / 178 | ✓ 7,694 · ✗ 0 |
| After the 5 merges (4a90763) | 187 / 187 | ✓ 8,411 · ✗ 0 |
| **Final candidate** | **197 / 197** | **✓ 8,716 · ✗ 0** (incl. 3 real-PostgreSQL race suites) |
| Mobile `tsc --noEmit` | — | 0 errors |
| Launch-gate runner (Fortress adapter) | PR-01…PR-12 all PASS (PR-07 and PR-11 probes corrected: they were stale and failed identically on base); FC-1…FC-8: 7 PASS, **FC-3 FAIL** (see below) | controls PROVEN 0 / PARTIAL 28 / UNPROVEN 19 / FAIL 30; **GATE CLOSED** (the registry scores the `main` baseline) |
| Migration inventory | 071 unique to accounting and this branch; collisions only on unintegrated refs | — |

New suites in this integration:
- `sms-fail-closed-adversarial` · `provider-cost-paths` · `provider-usage-alert-breaker.pglite`
- `launch-config-safety` (including real `server.js` refuse and start boots)
- `stripe-deleted-household-webhook` · `canonical-protection`
- `accounting-integration-safety` · `accounting-posting-realpg` · `number-purchase-race-adversarial`

Updated suites, which now pin the *new* intended behaviour (none weakened):
- `financial-safety-callpath`: SMS fail-open → fail-closed; usage-alert route.
- `telephony-abuse-controls`: the real `/voice` shape includes `timeLimit`.
- `activation-verify-delivery-confirmed`, `customer-delivery-visibility` and `mobile-dashboard-protection-steps`: canonical call.
- `admin-lifecycle-routes`: register cost default.
- `economics-register`: duplicate-rate drift check.

**FC-3, not a regression and not loosened.** It fails identically on base. Only 1 of 5 duplicate deliveries is applied, so idempotency holds. The contract then reports a provider *actual* cost of 5p for a 60 s call, and the Fortress charges reported actuals in £. At Fortress rates, 5p is about 4.2 minutes. "Remaining" therefore reads 300 s, not 540 s. The adapter's seconds↔£ translation needs a realistic actual cost; that is a gate-tooling follow-up.

Adversarial scenarios from brief §8 and where each is proven:

| Scenario | Evidence |
|---|---|
| 10+ simultaneous calls, one household | `financial-containment-realpg` (50 calls, 12 connections) |
| Allowance exhausted mid-call | `defence-in-depth.pglite`, `allowance-economic-bridge.pglite` |
| Financial authority unavailable | `financial-containment-e2e.pglite` (D3 reject), FC-6 |
| Breaker latches during live calls | `fortress-kill-switches.pglite`; usage alert → terminate at renewal (`provider-usage-alert-breaker`) |
| Trusted caller during hold | `fortress-kill-switches.pglite`, `canonical-protection` |
| SMS authority throws | `sms-fail-closed-adversarial` |
| Usage-alert replay/forgery | `provider-usage-alert-breaker.pglite` |
| Duplicate Stripe / RevenueCat events | `stripe-deleted-household-webhook`, `customer-allowance-webhooks`, `entitlement-canonical`, accounting scenarios |
| Refund before/after payment | accounting scenarios (`accounting-units`, store parity) |
| Deletion → `subscription.deleted` | `stripe-deleted-household-webhook` |
| Old routing number / forwarding proof; quarantined number; returning customer | `canonical-protection`, `lifecycle-journey`, `lifecycle-activation-state` (8,192 gate combinations) |
| Protected while held | `canonical-protection` (regression guard) |
| Absent/compromised hash secret; missing proxy config | `launch-config-safety` |
| Duplicate number purchase | `number-purchase-race-adversarial`, `provisioning-orphan`, PR-07 |
| Provider callback replay | webhook-integrity suites, `voice-surface-security` |
| Accounting/Xero unavailable; Xero retry/idempotency | `accounting-units` (unavailable, rate_limited, unknown_outcome), `accounting-posting-realpg` |
| Accounting worker concurrency | `accounting-posting-realpg` |

Skipped: none. Both real-PG suites ran. The Android manifest/notification suites ran against the cloned `mobile/node_modules`.

## 13. Launch-gate table (integration view)

| Area | Status |
|---|---|
| Application financial controls (LEVELS 1–3) | PROVEN LOCALLY → NEEDS STAGING PROOF |
| Provider containment (LEVEL 4) | **RED**: EXTERNAL PROVIDER CONFIRMATION + BUSINESS DECISION (subaccount, credentials, prepaid) |
| Voice fallback `<Reject/>` on every number | Code ready for new numbers; existing numbers need a provider change. EXTERNAL (Q11) |
| Usage triggers created and designated | Not created. BUSINESS DECISION + staging |
| Migrations 052-repair, 053…071 | NEEDS STAGING PROOF; production order BUSINESS DECISION (B-4) |
| Signed production-host calls | NEEDS PRODUCTION PROOF |
| Canonical protection with real data | NEEDS STAGING PROOF |
| Stripe deletion path end to end | NEEDS STAGING PROOF |
| Accounting capture ON | NEEDS STAGING PROOF (071 applied); posting ACCOUNTANT DECISION REQUIRED |
| Pricing £4.99 / £5.99, allowance minutes, budgets D1 | BUSINESS DECISION REQUIRED |
| **Store test purchases buying real numbers / shown as "Paying" in production** | **BLOCKED in production today** (confirmed). Fixed in the candidate; NEEDS STAGING PROOF with 053 + a TestFlight purchase |
| New-genuine-customer / protected / needs-attention notifications | Framework PROVEN LOCALLY; NEEDS STAGING PROOF (072); email provider + recipients BUSINESS DECISION |
| Android Play Billing | BLOCKED for Play Production |
| iOS screenshots / metadata / terms | BLOCKED (assets) + BUSINESS DECISION |
| 1.0.2 handset proof (Android + iPhone) | NEEDS STAGING PROOF |
| Staging/production Twilio isolation | BLOCKED until a staging subaccount exists (B-6) |

## 14. Business decisions required from Andrew

1. ~~Launch price~~ **DECIDED 2026-10-04: £5.99/month incl VAT.** The transition (Stripe Price, ASC/RevenueCat, terms notice, website, guides, store listings) is coordinated by the Mobile 1.0.2/store workstream.
2. **D1 Fortress budgets per profile** (seeds £0.50 / £0.25 / £0.10), and whether any minute allowance is promised to customers.
3. **LEVEL 4:**
   - Approve the subaccount, master-token-offline and prepaid architecture.
   - Approve sending Q1–Q12 to Twilio. **I have not contacted Twilio.**
   - Accept, in writing, the residual exposure for a 5-customer cohort.
4. **Which Twilio usage triggers stop the service.** That means setting `PROVIDER_USAGE_ALERT_TRIP_TRIGGER_SIDS`. A trip also stops trusted-call delivery until you reset it.
5. **Staging Twilio subaccount (B-6).**
6. **Production migration order (B-4).** Note that 066 is now a hard prerequisite of this backend.
7. **SMS trade-off:** keep fail-closed (the current rule), or define an explicit, bounded protective-SMS exception.
8. **Customer copy** for the new non-protected states (D-C5: on hold, renumbered).
9. **Android:** stay on Closed testing for the soft launch, or build Play Billing first (B-8). Also accept or fix the lock-screen banner (B-11).
10. **Store assets and terms approval (B-14).** Whether to include transcription-no-overlap `8d5e439` (B-12).
11. **Number retirement:** keep it manual (recommended) or set an auto-confirm policy (D-N2).
12. **The 28 Sep account and related accounts** (investigation doc):
    - Confirm sandbox vs production in RevenueCat.
    - Decide whether to keep or release the numbers held by `op2…`, `sni…` and `sim…`.
    - Classify the unclassified accounts.
    - Check whether `sim…@icloud.com`'s live £4.99 charge (6 Sep) settled or was refunded.
13. **Notifications:**
    - the onboarding window for "needs attention" (D-OPS1; default 24 h);
    - the operations@ mailbox and the email provider;
    - whether the founder role is on during early launch;
    - when to schedule the event runner (after 072).

## 15. Accountant decisions required

- **AD-1:** VAT registration date, scheme and periods.
- **AD-2:** treatment of Stripe charges made before 2026-09-20 with no VAT.
- **AD-3:** Apple/Google as deemed supplier.
- **AD-4:** store revenue gross or net.
- **AD-5:** recognition timing.
- **AD-6:** Xero granularity.
- **AD-7:** chart of accounts and tax codes.
- **AD-8:** chargebacks.
- **AD-9:** credit-note VAT.
- **AD-10:** the HCG account number as the Xero contact.
- **AD-11:** FX.

None of these was decided here.

## 16. External / provider confirmations required (not contacted)

**Twilio Q1–Q12** (full text in `2026-10-04-PROVIDER_FINANCIAL_CONTAINMENT_FINAL.md` §5):
- the suspension point and in-progress calls;
- real-time debiting;
- any hard limit or concurrent-call limit;
- whether settings can be changed by API;
- subaccount credential powers;
- triggers across subaccounts;
- inbound behaviour when suspended;
- Restricted Keys and the Voice SDK;
- SharedKeys for Voice and Media Streams;
- geo permissions for SDK `<Dial><Number>`;
- **whether a fallback `<Reject>` is billed**;
- toll-fraud liability.

**Strategic Twilio questions:**
- committed-volume UK pricing;
- upstream trusted/unknown routing;
- trusted-call hand-off so HCG stops paying the media and PSTN legs;
- stronger financial isolation;
- written maximum-overrun behaviour;
- the best subaccount and credential architecture.

AQL, Magrathea and Telnyx remain alternatives. The permanent HCG account number and carrier abstraction keep customer identity independent of the carrier.

**Other external items:**
- OpenAI organisation/project spend limits: configure and evidence.
- Stripe webhook event subscriptions for accounting.
- Play Console Production-track state (B-13).

## 17. Exact staging plan

This follows `docs/release/2026-10-04-SOFT_LAUNCH_READINESS.md` §6 steps 0–17, with these integration amendments:

- **Step 2:** migrations through **071**, applying 066/067/070 before the backend. After 071, run `accounting-posting-realpg`-equivalent checks with SQL against staging (read-only probes).
- **Step 3:**
  - Run `HCG_DEPLOYMENT=staging node scripts/check-launch-config.js` until it reports **would START**.
  - Set both hash secrets (≥32 characters, distinct), `TRUST_PROXY_HOPS`, `OPENAI_API_KEY` and `Resend_API_Key`.
  - Keep `PROCESS_ROUTE_ENABLED`, `ACCOUNTING_CAPTURE_ENABLED` and `ACCOUNTING_XERO_POSTING_ENABLED` unset.
- **Step 4:** deploy the final HEAD of this branch. Confirm that a deliberately missing secret makes the service **refuse to start** (exit 1). Then restore it.
- **New step 7a:** force a voice-route error (for example a malformed body on a test number) and confirm Twilio logs a `<Reject>`, not an application error.
- **New step 9a:** make the SMS authority unavailable, then trigger a warning. Confirm **no SMS** is sent and an intervention row exists.
- **New step 12a:** create one low-threshold usage trigger on the staging subaccount, designate its SID and fire it. Confirm the kill switch latches, live calls end at renewal, a replay does not re-latch after reset, and only the admin reset reopens.
- **New step 15a:**
  - Delete a test account with an active test-mode subscription; cancel in Stripe. Confirm one `ignored` row, a 200 response and no retries.
  - Confirm the dashboard shows "not protected" while held and after renumbering.
- **New step 15c (store provenance):** with 053 applied, make a **TestFlight** purchase. Confirm the entitlement shows `revenuecat_environment='sandbox'`, the admin label "Store sandbox / TestFlight / review — not paying", **no Twilio purchase**, and no `NEW_GENUINE_CUSTOMER` event. Then make a Stripe test-mode checkout on staging and confirm the expected classification.
- **New step 15d (operational events):** with 072 applied, run the scanner once by hand (`runOpsEventScan`; not scheduled) against staging. Confirm one event per genuine test customer, that a re-run creates none, and that `GET /admin/api/ops-events` shows unseen events. Delivery stays disabled unless approved, and then goes only to a staging role address.
- **New step 15b:** set `ACCOUNTING_CAPTURE_ENABLED=true` only after 071. Replay Stripe and RevenueCat test events. Confirm one transaction per economic key and no effect on entitlement timing.

## 18. 5 → 10 → 25 → 50 → 100 rollout plan (prepared, not executed)

Application-enforced exposure comes from the 067 defaults. These are DB policy values and can be tightened per stage. Provider exposure is **not** bounded until LEVEL 4 is evidenced.

| Stage | Customers | Entry criteria | Max application exposure (enforced) | Fixed | Stop criteria | Evidence to progress |
|---|---|---|---|---|---|---|
| 0 | internal + staging | §17 complete; gate items for staging PROVEN; LEVEL 4 architecture in place, or exposure accepted in writing | per household seed £0.85/period; daily breaker £15; hourly £4; live worst-case £40 | ≈ £0.87 per number per month | any unexplained Twilio line item; any failed refusal | staging evidence pack signed off |
| 1 | 5 genuine | Stage 0 + production migrations + `check-launch-config` START in production + fallback `<Reject>` on every number + designated usage trigger + backups | £15/day app cap (one breaker incident ≈ ≤ £15 + one lease overrun, then manual reset) | ≈ £4.35/mo | breaker or kill switch trips without cause; any household > £5/24 h (auto-hold); any mismatch > 20% between the Twilio invoice and the ledger; any support case about missed calls | 14 days; daily manual Twilio usage review; per-household actual vs estimate; zero unexplained spend |
| 2 | 10 | Stage 1 clean; first real usage written into the register as **evidence** (not a replacement); D1 reviewed | £15/day | ≈ £8.70/mo | same | 14 days; cost per customer within the D1 budget |
| 3 | 25 | Stage 2 clean; price decided and consistent everywhere; Android path decided | £15/day (`0.20×25 = £5` < floor) | ≈ £21.70/mo | same + chargeback or dispute | 21 days; support review; fraud review (abuse audit) |
| 4 | 50 | Stage 3 clean; LEVEL 4 answers received; accountant decisions for posting | £15/day | ≈ £43.50/mo | same | 30 days; reconciliation clean (if capture is on) |
| 5 | 100 | Stage 4 clean; Play Billing if on Play Production; store assets | max(£15, £0.20×100) = **£20/day** | ≈ £86.90/mo | same | — |

- **Operations notifications (requirement, 2026-10-04):**
  - From Stage 1, every genuine new customer, first protection, and needs-attention condition must be visible as an **operational event**, unseen until acknowledged.
  - During Stages 1–3, email goes to the operations role and, if approved, to the founder role.
  - Entry criterion for Stage 1: 072 applied; scanner scheduled; a test proving that a sandbox purchase creates no `NEW_GENUINE_CUSTOMER` event.
  - Stop criterion: any `CUSTOMER_NEEDS_ATTENTION` unacknowledged for more than 24 h, or any failed delivery left unresolved.
- **Monitoring at every stage:**
  - the Fortress admin overview;
  - daily Twilio usage against the ledger;
  - critical-alert email (needs `Resend_API_Key`);
  - the lifecycle exception queue;
  - quarantine £ exposure;
  - the accounting exception queue once capture is on.
- **Rollback at every stage:** kill switch on, then redeploy the previous backend (070 must be rolled back with the code; see §19). Stop new sign-ups by keeping invites closed.

## 19. Rollback plan

1. **Stop spend:** turn the kill switch on (admin). It latches, refuses all new spend and ends live calls at renewal.
2. **Code:** redeploy the previous backend (`2011ab6`, or production `eb43368`). The old code ignores the additive tables 047–069 and 071. **070 replaces `process_stripe_webhook_event`**, so roll back 070 (`_rollbacks/070_…`) with, or before, the code.
3. **Config:** removing the new variables is harmless for the old code. The new code refuses to start without them.
4. **Migrations:** reverse rollbacks 071 → 053 **only on a restored copy first** (staging step 16). 062 is irreversible once an account number has been shown, 063 after a real top-up, and 067 only with the kill switch on.
5. **Mobile:** do not release 1.0.2 until the backend is stable. Old builds work against both backends.

## 20. Known residual risks

- **Master Twilio token in the backend.** Credential compromise means unbounded provider spend (RED).
- **Calls that never reach HCG** are billed until `voiceFallbackUrl` is set on **existing** numbers (provider change) and Q11 confirms a `<Reject>` is unbilled.
- **Protective SMS** can be lost during a financial-authority outage (accepted trade-off, §6).
- **A designated usage trigger** stops trusted-call delivery too, until the admin reset.
- **Process-local counters** (abuse velocity, transcription and SMS rate) are per instance. The Fortress DB caps are authoritative. Keep a single Railway instance (R6).
- **Admin bulk "protected" counters** still use the legacy rule.
- **Gate tooling:** FC-3's units mismatch remains, and the registry is scored against `main`.
- **Economics:** no real usage data; £5.99 may miss the 40% target; trusted-call media is paid by HCG.
- **Pricing:** £4.99 on every customer surface vs £5.99 economics.
- **Android:** Play Billing absent; lock-screen banner collapse.
- **Unproven on devices and staging:** no 1.0.2 handset proof; staging and production share a Twilio account.
- **Production today** labels store sandbox, TestFlight and App Review grants as "Paying" and buys real numbers for them. At least two numbers (`op2…`, `sni…`) are probably held for non-production purchases, plus the number of an ex-Stripe subscriber (`sim…`).
- **No settlement data:** HCG cannot see Apple or Google settlement or the store environment for pre-053 grants without RevenueCat or App Store Connect access.
- **Mixed-entitlement edge case:** the provenance guard allows a purchase if *any* active entitlement is Stripe live, store production, complimentary or trial. So a complimentary grant on a sandbox tester's account still provisions. That is intentional, since complimentary access is HCG-decided.

## 21. What prevents us taking Customer #1 today?

1. **Nothing in this branch is deployed or applied.** Production still runs `eb43368` without the Fortress, the canonical protection status or today's fixes. Staging has not run.
2. **Provider containment is RED.** The production backend holds the master Twilio token; there is no subaccount, no prepaid ceiling and no designated trigger. Existing numbers have no `<Reject>` fallback. You have not accepted a written residual-exposure statement.
3. **Commercial terms are undecided:** £4.99 vs £5.99, the D1 budgets, and the minutes promise. The terms hard-code £4.99.
4. **No 1.0.2 build exists or has been tested on a handset.** The live apps predate the sign-out, readiness and allowance fixes.
5. **Staging Twilio isolation** (a subaccount) does not exist, so real purchase paths cannot be proven safely.
6. **Production would misclassify Customer #1's environment.** Store test purchases look like paying customers and buy real numbers until the candidate and 053 are deployed. There is also no operational notification of a new genuine customer until 072 and the event runner are live.

When 1–5 are cleared, a 5-customer invite-only cohort on Android Closed testing and iOS 1.0.2 is the first defensible step. Until LEVEL 4 is evidenced, it would still carry an explicitly accepted provider-level residual risk.
