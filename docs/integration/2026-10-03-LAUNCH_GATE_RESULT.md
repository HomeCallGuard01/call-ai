# Launch-gate result — integrated candidate (2026-10-03)

**Branch:** `integration/launch-fortress-2026-10-03` · **Tree evaluated:** HEAD of that branch (see the handover for the SHA).

## 2026-10-04 update (Andrew-approved decisions implemented)

- **D3 = REJECT** is the production policy: with the financial authority unreachable no new
  HCG-funded call is admitted. `bounded` exists only for tests/local development (needs
  `FC_ALLOW_BOUNDED_DEGRADED_MODE=true` **and** `NODE_ENV=test|development`); production,
  staging and an unset NODE_ENV always reject. **FC-6 now PASSES.**
- **Global breaker LATCHES** on every spend/rate trip; latching and "end live calls" can no
  longer be switched off by policy (CHECK constraints). Reset only by `fc_reset_breaker`, which
  an admin can call through an authenticated, authorised, JSON-only, confirmation-gated route;
  audited with the authenticated admin as actor.
- **Per-household financial hold** (kill switch): enforced inside the Fortress for calls (trusted,
  unknown, reserve, essential), renewals, monitoring start, SMS, AI, number purchases; manual
  (admin) or automatic (24 h spend anomaly; provider actual ≫ estimate; repeated number
  provisioning); only an admin releases; append-only audit incl. refused releases.
- **Expensive-destination policy**: per-purpose class allowlists **plus a fail-safe cost
  ceiling** (no known rate ⇒ refused); trusted contacts validated server-side at creation on every
  write path; call-time re-check remains authoritative; provider-metadata port (not wired).
- **Provider-level containment (LEVEL 4) is a RED launch blocker** — no evidence of any hard
  provider ceiling: `docs/integration/2026-10-04-PROVIDER_FINANCIAL_CONTAINMENT.md`.

## Verdict

**GATE: CLOSED. HCG is NOT launch-safe on this evidence.** The independent judge
(`node tests/launch-gate/run.mjs --enforce`) exits **1**. The integrated code closes most
code-level gaps and is heavily tested locally, but **nothing here is staging-proven or
production-proven**: the migrations it depends on are applied nowhere, the code is deployed
nowhere, no provider console setting has been evidenced, and no actual provider billing
data is connected.

| Proof level | Meaning | Items at this level |
|---|---|---|
| Code-complete | implemented on this branch | everything marked PASS or PARTIAL below |
| Test-proven (local) | automated test exercises the enforced control (PGlite and/or real PostgreSQL 18.4, real server.js) | rows marked **PASS** |
| Staging-proven | executed on staging with evidence | **none** |
| Production-proven | observed in production | **none** |

## 1. Judge output (unchanged framework, run on the integrated tree)

`LAUNCH_GATE_FINANCIAL_ADAPTER=tests/launch-gate/adapters/fortress-pglite.mjs node tests/launch-gate/run.mjs` (production policy, D3 = reject; re-run 2026-10-04)

| Probe / contract | Main (eb43368) | Integrated | Note |
|---|---|---|---|
| PR-01 webhook signatures enforced | FAIL | **PASS** | |
| PR-02 /media-stream identity not client-supplied | FAIL | **PASS** | integration also removed a merge-reintroduced client field |
| PR-03 no cross-country tail collision | FAIL | **PASS** | |
| PR-04 high-cost ranges rejected as destination | FAIL | **PASS** | |
| PR-05 no outbound PSTN leg | PASS | **PASS** | |
| PR-06 every `<Dial>` has timeLimit | FAIL | **PASS** | |
| PR-07 orphan released when assign throws | FAIL | **FAIL** | deliberate: released when the DB *confirms* unassigned; kept (tagged, adopted on retry, alerted) when the DB is unreadable — releasing a possibly-live number would kill a customer's forwarding target |
| PR-08 RevenueCat provisioning gated on environment | FAIL | **PASS** | |
| PR-09 indexed household lookup | FAIL | **PASS** | |
| PR-10 unique migration numbers | PASS | **PASS** | 66 files 046→070 frozen by `tests/migration-allocation.test.mjs` |
| PR-11 auth endpoint rate limits | FAIL | **FAIL (judge)** / PARTIAL (evaluated) | limiter implemented + behaviour-tested (`tests/auth-rate-limit.test.mjs`); the probe's static grep (`rateLimit(` / `express-rate-limit`) does not match `authRateLimiter.limit(`. Not renamed to game it. Process-local counters → PARTIAL |
| PR-12 server-side emergency stop | FAIL | **PASS** | manual M-G6 still required |
| FC-1 zero allowance never admitted | UNPROVEN | **PASS** | bound to the real app-layer service + real SQL |
| FC-2 10 simultaneous calls, 45 s left | UNPROVEN | **PASS** | |
| FC-3 duplicate usage applied once | UNPROVEN | **FAIL (judge)** | applied once and charged once (proven in `tests/launch-fortress-contract.test.mjs`); the contract measures allowance in seconds and assumes cost never affects it, while Fortress charges max(estimate, actual) (I7) |
| FC-4 malformed/overflow cost & duration rejected | UNPROVEN | **PASS** | 18/18 refused |
| FC-5 usage can never increase allowance | UNPROVEN | **PASS** | |
| FC-6 store outage ⇒ fail closed | UNPROVEN | **PASS** | decision **D3 = REJECT** (2026-10-04). The test-only bounded mode still fails FC-6 by design and cannot be enabled outside NODE_ENV=test/development (`tests/launch-fortress-contract.test.mjs`) |
| FC-7 global ceiling ⇒ no admission | UNPROVEN | **PASS** | |
| FC-8 rate-of-spend breaker | UNPROVEN | **PASS** | |

Registry (static, evidence-gated): controls `PROVEN 0 / PARTIAL 28 / UNPROVEN 19 / FAIL 30`;
scenarios `PROVEN 0 / PARTIAL 8 / UNPROVEN 5 / FAIL 17` (2026-10-04 run). These are the framework's recorded
statuses; promotion to PROVEN requires recorded staging/manual evidence (ADVERSARIAL_TEST_SPEC
M-01…M-17), which this integration did not — and must not — fabricate. Framework self-test:
299/299.

## 2. Adversarial scenarios (brief §18) — local evidence

PASS = test-proven locally. Staging-proven: **no** for every row.

| # | Scenario | Status | Max HCG exposure (estimate) | Evidence |
|---|---|---|---|---|
| 1 | 10 simultaneous calls, nearly exhausted budget | PASS | ≤ remaining budget | integration S1; realpg 5×10 rounds |
| 2 | 10 simultaneous calls, same caller | PASS | ≤ 3 calls (056 DB limit backstops abuse layer, which fails open if Twilio REST is unreachable) | integration S2 |
| 3 | many callers flood one household | PARTIAL | ≤ household budget + reserve per period; household's **unknown** callers refused for the rest of the period | integration S3 |
| 4 | trusted caller, exhausted budget | PASS | ≤ trusted-only reserve | integration S4 |
| 5 | trusted caller, global breaker / kill switch | PASS | £0 new | integration S5/S50 |
| 6 | trusted caller, spoofed/malformed CLI | PARTIAL | one quiet well-spoofed trusted CLI still gets the bypass (no UK STIR/SHAKEN) — budget still applies | integration S6, attacks |
| 7 | +33 collision with UK trusted number | PASS | — | integration S7, PR-03 |
| 8 | 070/076/087/09 attempts | PASS | £0 (no outbound leg; never trusted; refused as destination) | integration S8, PR-04/05 |
| 9 | international/high-cost destination | PASS | £0 (no HCG PSTN leg; egress guard) | PR-05, attacks |
| 10 | forwarding loop | PASS | carrier-internal loops invisible but bounded by per-caller limits + budget | integration S10, attacks |
| 11 | duplicate /voice | PASS | £0 extra | integration S11; realpg 12-way |
| 12 | captured signed replay | PASS (≤30 min) / PARTIAL (after window/restart) | reservation idempotent per CallSid ⇒ £0 extra | integration S12 |
| 13 | unsigned webhook | PASS | £0 | integration S13 |
| 14 | forged media stream | PASS | £0 | voice-surface-security |
| 15 | duplicate stream start | PASS | £0 | ledger pglite |
| 16 | forged call-ended | PASS | £0 | integration S16 |
| 17 | duplicate provider cost callback | PASS | charged once | realpg 12× actual |
| 18–20 | malformed / negative / overflow cost | PASS | refused | FC-4, ledger, bridge |
| 21 | DB outage at admission | PASS (D3 = reject) | £0 new spend; every new call refused (customers miss calls during the outage); live calls end at lease + grace | integration S21; e2e; FC-6 |
| 22 | DB outage mid-call | PASS (local) | ≤ lease + 60 s per call; then provider timeLimit | e2e |
| 23 | server restart mid-call | PASS (local) | ≤ 1 lease | e2e |
| 24 | provider API timeout | PASS (local) | renew conservatively; timeLimit backstop | e2e |
| 25 | sweeper crash/restart | PASS (local) | ≤ 1 lease | e2e; realpg 4 sweepers |
| 26 | call longer than reserved | PASS (local) | ended at lease end; overrun committed and reported | e2e, ledger |
| 27 | global spend ceiling | PASS | ≤ cap (policy floors are D9 placeholders) | FC-7; realpg storm |
| 28 | rate-of-spend breaker | PASS | ≤ hourly cap; latches | FC-8; realpg storm |
| 29 | customer below cap, global reached | PASS | — | integration S29 |
| 30 | global below cap, customer reached | PASS | — | integration S1 |
| 31 | number purchase double-click | PASS | 1 purchase | realpg claim; abuse controls |
| 32 | purchase timeout after provider bought | PASS | adopt-before-buy ⇒ no second purchase | provisioning-orphan |
| 33 | DB failure after purchase | PARTIAL | ~£0.87/month per orphan until reconciled (no scheduled orphan reconciliation) | provisioning-orphan; PR-07 |
| 34 | mass signup / provisioning | PARTIAL | no paid resource at sign-up; ≤ 10 purchases/day globally; rate limits process-local; payment/IP/device signals not implemented | auth-rate-limit; abuse controls |
| 35 | RevenueCat sandbox purchase | PASS | no number; unfunded profile | entitlement-canonical; revenuecat tests |
| 36 | RevenueCat replay | PASS | effects idempotent (no event-id dedupe table) | entitlement-canonical |
| 37 | RevenueCat out-of-order | PASS | ends_at never backwards; older EXPIRATION ignored | entitlement-canonical |
| 38 | Stripe duplicate event | PASS | claim-layer unique id | entitlement-canonical |
| 39 | Stripe refund | PARTIAL | top-up refunds reverse £; a subscription refund revokes access only via the subscription status event | allowance webhooks; entitlement-canonical |
| 40 | Apple + Stripe conflict | PASS | neither channel revokes the other; support alerted | entitlement-canonical |
| 41 | top-up replay | PASS | credited once (12 connections) | realpg S41; bridge |
| 42 | top-up while exhausted | PASS | — | bridge |
| 43 | top-up margin guard | PASS | £ ≤ afterFees×(1−margin)÷(1+reserve) | bridge |
| 44 | account-number forgery | PASS | not a credential; grants + trigger | customer-identity tests |
| 45 | account-number race | PASS | — | realpg 60 sign-ups / 12 connections |
| 46 | routing-number replacement keeps identity | PASS | — | customer-identity pglite; realpg routing race |
| 47 | provider replacement keeps subscription/history | PASS (model) | — | customer-identity pglite (no live adapter but Twilio) |
| 48 | account hold | PASS | — | integration S48 |
| 49 | incident containment mode | PASS | — | integration S49 |
| 50 | full emergency stop | PASS (local) | live calls end within one lease | integration S50; e2e kill switch |

### 2026-10-04 adversarial additions (all test-proven locally)

| Scenario | Status | Evidence |
|---|---|---|
| Trusted premium-rate contact | PASS — refused at creation; never trusted at call time; no outbound leg | destination-cost-policy; integration S8 |
| Unknown premium-rate caller | PASS — no outbound/expensive leg | integration D5 |
| Prohibited number inserted directly into the DB | PASS — never trusted; detected for support (`findProhibitedContacts`) | integration S8; destination-cost-policy |
| Trusted contact changed after validation | PASS — call-time re-check | integration D4 |
| Global breaker trip | PASS — latches; cap back to normal still refused | fortress-kill-switches; integration D1; realpg storm |
| Manual global breaker reset authorisation | PASS — unauthenticated / non-admin / no confirmation / no reason / non-JSON refused; actor = authenticated admin | admin-fortress-controls |
| Household kill switch | PASS | fortress-kill-switches; integration D2; defence-in-depth |
| Bypass attempts on the household kill switch (contacts, repeats, simultaneous, number purchase, payment channel, retries, monitoring, top-up) | PASS | fortress-kill-switches; integration D2; realpg hold race |
| Simultaneous accounts during the global breaker | PASS | fortress-kill-switches; integration D1 |
| Expensive destination omitted from a blocklist but caught server-side | PASS — fail-safe cost ceiling (`cost_unknown`) | destination-cost-policy |
| Each HCG level stops spend on its own (L1, L2, L3) | PASS; **L4 UNPROVEN** | defence-in-depth |

## 3. GREEN — proven locally / no blocker found in code

Webhook authenticity + replay; one financial authority; reserve-before-spend; atomic household
budget under real 12-connection races; leases + provider timeLimit; global breaker / kill switch;
idempotent accounting; malformed input; destination policy before trust; full-E.164 trust;
loops; no outbound PSTN leg; egress guard; abuse concurrency atomic; trusted callers survive
floods; canonical entitlement decision; sandbox unfunded; top-ups credit the enforced £;
margin guard; account-number integrity and race safety; migration allocation frozen; admin
read-only and labelled.

## 4. RED — known launch blockers

| # | Issue | Why it matters | Max plausible impact | Owner | Next evidence |
|---|---|---|---|---|---|
| R1 | Migrations 053–056, 062–070 applied nowhere; the code requires 056/067 | Deploying this code without them makes Fortress unreachable ⇒ degraded envelope ⇒ **every call refused after 15 min** | total call loss | Andrew + migration owner | staging apply + `fc_check_invariants()` (staging plan §2) |
| R2 | No provider billing feed (`fc_record_actual` unwired) | Budgets are sized on estimated rates; a wrong rate silently mis-sizes every limit | systematic under/over-run of the envelope | finance/billing | ingestion of Twilio usage records; reconcile estimate vs actual on staging |
| R3 | **No verified provider-level hard financial containment (LEVEL 4).** Master Twilio token in the backend; 0 usage triggers (2026-09-27; and triggers are alerts, not limits); no confirmed hard ceiling; single account, no sub-accounts; auto-recharge / SMS geo pending; no OpenAI hard budget evidenced | A stolen credential, an app bypass or a provider routing error bypasses levels 1–3 entirely | **unbounded by HCG code** | Andrew (Console + written Twilio answers) | `2026-10-04-PROVIDER_FINANCIAL_CONTAINMENT.md` §3–§5 |
| R4 | Behaviour when HCG is unreachable (Twilio fallback URL) unverified | Calls may be answered/billed with no HCG control | unknown | Andrew (Console) | set/verify a static `<Reject>` fallback on staging |
| R5 | Commercial values undecided (D1 £ budgets; 100-minute placeholder costs ≈ £2.07 vs £0.50 budget; £5.99 not approved) | Customer promise ≠ enforced economics | customer-facing over-promise | Andrew | decisions §6 |
| R6 | Abuse-layer shared state (066) has no adapters — counters, cooldowns, holds, incident flag are process-local | Multi-instance or restart resets velocity/cooldowns (DB-backed 056 limits remain as backstop) | per-caller limits ×N instances | engineering | adapters + single-instance confirmation |
| R7 | Production signature validation must pass on the real host | `FC_REQUIRE_SIGNED_VOICE` + enforce mode reject **every** call if APP_URL/host mismatch | total call loss | engineering | staging signed calls (plan §4) |
| R8 | Production apply-order decision 057–061 vs 047–056 | out-of-order history | migration failure | Andrew | launch-gate INTEGRATION_PLAN §5 |

Held elsewhere (not re-verified here): Android Play Billing compliance; screened-call quality gate; landline delivery hold.

## 5. AMBER — needs staging / provider / manual proof

Parent-call hang-up (`calls(sid).update(completed)`) stops all legs and billing; `<Dial timeLimit>`
counts from child vs parent; `/voice` p95 latency with one more RPC under a global row lock;
two Railway instances sweeping; breaker floors under realistic load (D9); real handsets
(Motorola continuation); RevenueCat sandbox and Stripe test-mode end-to-end; number provisioning
failure paths on the non-production account; account-number race on staging Postgres; rate
limiter behind Railway's proxy (`TRUST_PROXY_HOPS`); alert delivery; abuse concurrency
verification against Twilio REST.

## 6. COMMERCIAL / POLICY DECISIONS (Andrew)

**Decided 2026-10-04:** D3 = reject; global breaker latching with manual audited reset;
per-household kill switch; expensive-destination policy; provider containment as a launch gate.

Still open: D1 per-plan £ budget / reserve / essential (placeholders £0.50/£0.25/£0.10; derived envelope at
default inputs **£0.858** — the brief's "≈ £1.25" is not reproduced by the default inputs) ·
automatic household-hold policy (24 h threshold £5 default; which fraud signals hold — today only
repeated number provisioning) · whether the household hold should also block essential callers
(today: yes) · international / Crown Dependency numbers as trusted contacts (today: allowed —
caller-ID only, never dialled) · destination unit-cost table and ceilings (list estimates) ·
whether to pay for a provider line-type lookup ·
included minutes (100/200 placeholders the £ cannot fund) · top-up £ capacity, prices, rollover ·
higher-tier price · launch price £5.99 · D4 essential callers / withheld emergency call-backs · D5 reversal of
"never stop delivery" · D6 cut-off announcement wording · D9 global cap floors · delivery-reserve
scope `trusted_only` (changed in integration; reversible) · sandbox profile funding · all
customer copy (DRAFT) · production migration apply order.
