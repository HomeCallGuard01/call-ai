# Financial safety architecture: monitored-minute entitlement and hard business protection

Branch `feature/financial-safety-hard-limits`, 2026-09-30.

**Status:**
- Implemented and tested; **nothing deployed, nothing merged, no migration applied anywhere** (staging or production).
- The £4.99 price is unchanged.
- The customer allowance is metered but **not enforced** until Andrew sets `MONITORING_ALLOWANCE_ENFORCED=true`.

Evidence for pricing and allowances: `PRICING_AND_ALLOWANCE_EVIDENCE.md`. Every exposure figure below is produced by `node scripts/failure-scenarios.js` from the configured limits.

## 1. Two separate layers

| | Layer A: customer entitlement | Layer B: business protection |
|---|---|---|
| **Purpose** | The advertised monthly monitored-minute allowance | Stop catastrophic or abnormal spend, whatever the plan says |
| **Measures** | Monitored seconds per billing period | £ exposure: connected minutes (trusted and unknown), monitoring, SMS; call counts |
| **At the limit** | Scam monitoring stops. Calls **continue unmonitored**. | New calls refused with `<Reject>` (unbilled), monitoring stopped, or SMS not sent (see §4) |
| **Customer sees** | `monitoringAllowance`: used, remaining, %, state (Build 20) | Nothing, unless a ceiling pauses monitoring (state `paused`) |
| **Configured in** | `services/usage/plans.js` | `services/usage/safetyConfig.js` |
| **Switch** | `MONITORING_ALLOWANCE_ENFORCED` (default **off**) | Always on once deployed; every value env-overridable |

The two never share a number. Layer B does not use the £3.50 after-fees revenue as a cut-off. Revenue-relative levels are **WATCH and ALERT signals** (§4.4). Hard refusals are set where genuine single-line use is physically implausible.

## 2. Where each piece lives

| Piece | File |
|---|---|
| Counters, sessions, admission and budget RPCs (atomic, idempotent per CallSid) | `supabase/migrations/056_financial_safety_allowance_and_admission.sql` (+ `_rollbacks/056_…`) |
| DB access (throws; the caller decides the fail-safe) | `database/financialSafety.js` |
| Plans / allowance, billing period, cost rates, limits | `services/usage/plans.js`, `billingPeriod.js`, `costModel.js`, `safetyConfig.js` |
| Call admission (Layer B) + in-memory fallback | `services/usage/callAdmission.js`, `callConcurrency.js` |
| Monitoring gate (Layer A + monitoring ceilings) | `services/usage/monitoringGate.js` |
| Metering, warning points, SMS budget, audit | `usageMeter.js`, `usageNotifier.js`, `smsBudget.js`, `safetyEvents.js` |
| Customer allowance view (Build 20 contract) | `allowanceStatus.js`, `householdAllowance.js`; see `BUILD20_MONITORING_ALLOWANCE_API.md` |
| Call-path wiring | `server.js` (/voice, Dial action callbacks, `/webhooks/provider-usage-alert`), `services/liveMonitoring/mediaStreamHandler.js`, `routes/mobileApi.js` |
| Ledger-based monitoring (stale data, anomalies, margin WATCH, estimate-vs-ledger) | `services/finance/spendMonitor.js`, `spendAnomaly.js`, `companySpendProtection.js` (existing, extended) |
| Worst-case figures | `services/finance/failureScenarios.js`, `scripts/failure-scenarios.js` |
| Provider-side alarms (dry run by default) | `scripts/provider-usage-triggers.js` |

This builds on the ledger/spend-guard work (051 ledger, spend guard, anomaly detection, company protection levels); it isn't a second system. The allowance design is the unapplied WIP (`wip/monitoring-allowance-financial-safety-2026-09-26`), ported onto 056 and extended.

## 3. Layer A: monitored-minute entitlement

- **Metering.** Every monitored stream reports its absolute elapsed seconds every ~10 s. The database adds only the positive delta, so retries, duplicates and restarts can't double-count. Counting is by stream time, not transcription requests.
- **Warning points.** 75%, 90% and 100%, each claimed once per household per period in the database. Crossing several at once delivers only the highest. Delivery (in-app/push/SMS) is Build 20's; no customer wording is written here.
- **At 100% (enforced plans):**
  - New unknown calls connect without a Media Stream, transcription or the "monitored and protected" greeting.
  - The call is logged `not_monitored_allowance_exhausted`.
  - The app gets `state: "exhausted"`, `monitoringActive: false`, `callsContinue: true`.
- **During an active call.** Monitoring continues for the grace period (default 300 s), then stops; the call continues. Worst extra cost is 2 streams × 5 min × £0.008069 = **£0.08**. The call is recorded `monitoring_stopped_allowance_exhausted`. Grace is `MONITORING_ALLOWANCE_GRACE_SECONDS`.
- **No silent AI cost after exhaustion.** No reservation means no transcription: a stream only transcribes after attaching to a reservation made by `/voice`.
- **Reset with the billing period:**
  - Stripe: `subscriptions.current_period_end`.
  - Apple/Google via RevenueCat: `entitlements.ends_at`, which each renewal extends.
  - Complimentary grants: monthly anniversary of `starts_at`.
  - Fallback: calendar month.
  - A renewal moves the period, and a new period row starts at 0.
- **Top-ups and upgrades (hook only; no product invented).**
  - `household_usage_periods.bonus_monitored_seconds` extends the enforced and displayed allowance for that period.
  - `entitlements.plan_code` selects a tier (`plus` is defined but not on sale).

### Interaction with Apple IAP, Google Play Billing and Stripe

- The allowance is a property of HCG's service, not a separate store product. The existing subscription stays the one product, and the allowance follows whichever system renews it (above).
- **Upgrades.** A higher tier would be another subscription product in the same subscription group (Apple), a base plan (Play) or a Stripe price. The RevenueCat or Stripe webhook maps product → `plan_code`.
- **Top-ups.** On iOS, a consumable IAP. On Android, a Play Billing in-app product: in-app Stripe on Android is very likely a Play Payments policy problem (see `project_android_play_billing_compliance`). On web, a Stripe one-off. Every channel's webhook credits `bonus_monitored_seconds` for the current period.
- **Customer terms.** Enforcing an allowance on existing subscribers is a change to their terms. It has to be stated in the store listing and subscription description (Apple 3.1.2, clearly describing what the subscriber gets). It's Andrew's decision and not enforced.
- **Sandbox.** Apple sandbox renews every few minutes, so sandbox periods roll over quickly and allowances reset often. That's harmless.

## 4. Layer B: hard business protection

Rates for real-time enforcement (`costModel.js`):

| Rate | Components | £/min |
|---|---|---|
| Connected minute `c` | Inbound £0.007558 + app leg at Twilio list £0.00316 (billed £0 today; included **conservatively** so the limits can't loosen if Twilio starts billing it) | **£0.010718** |
| Monitoring minute `m` | Stream £0.003329 + transcription £0.00474 | **£0.008069** |

The ledger reconciles real cost. If a completed day's supplier cost exceeds the real-time estimate by more than 20% + £0.50, `SAFETY_ESTIMATE_UNDERCOUNT` is CRITICAL.

### 4.1 Thresholds and the maths

| Control | Default | Why this value | Action |
|---|---|---|---|
| Max call duration | 240 min | Twilio's default made explicit, so an account-level 24-hour setting can't lengthen it. One call ≤ 240·c = £2.57. 120 min would halve that but cut genuine long calls. | `<Dial timeLimit>`; Twilio ends the leg |
| Simultaneous calls / household | 3 | A handset holds one call plus one waiting; a third simultaneous call is already implausible | 4th+ refused (`<Reject>`, unbilled) |
| Burst | 10 attempts / 120 s | A person can't receive 10 calls in 2 min; a loop or flood does. Refused attempts count, so a flood stays refused while it lasts. | Refuse |
| Caller flood | 6 attempts / 10 min from one number | Above redial behaviour after dropped calls. Withheld numbers are excluded (covered by burst). | Refuse that caller |
| Forwarding loop | Caller is an HCG number, or the dialled number itself | HCG numbers never originate calls, so this can only be HCG traffic coming back | Refuse |
| Household £ today, WATCH | £3 (≈ 4.7 h of talk) | Abnormal but possible | Refused **only** while the company is in EMERGENCY |
| Household £ today, HARD | £10 | ≈ 933 connected min (15.5 h) in one day. Beyond one genuine line; in practice needs simultaneous calls. | Refuse all new calls for the rest of the UTC day |
| Household £ period, unknown block | £20 | ≈ 4× the £4.99–£6.99 after-fees revenue: a business-use or abuse case, not a margin question | Refuse new **unknown** callers for the rest of the period; trusted still delivered |
| Household £ period, HARD | £40 | ≈ 3,730 connected min (≈ 2 h/day, every day) | Refuse all new calls for the rest of the period |
| Monitoring £, household | £1.50/day (≈ 186 min), £5/period (≈ 620 min, ≈ 6× a 100-min allowance) | Bounds AI and stream cost even while the allowance is not enforced | Stop new monitoring; stop mid-call |
| Monitored streams | 2 per household; max(20, N/10) company-wide | WIP values | No monitoring for extra calls |
| Company £ today, EMERGENCY | max(£25, N × £0.75) (≈ 10× a normal day at ≈ £0.10/household/day); hourly = ÷4 | Scales with entitled households N | Refuse new calls **only** for households already over their £3 WATCH today |
| Company £ today, HARD | max(£100, N × £2) | Catastrophic | Refuse all new **unknown** calls everywhere; trusted still delivered |
| Company monitoring £ | max(£30, N × £0.30)/day, ÷6 per hour | | Stop new monitoring company-wide |
| SMS | 5/household/day, 30/period, max(50, N)/company/day | | Not sent, audited |
| Kill switches | `financial_safety_state.telephony_suspended` / `monitoring_suspended` (database, manual); `MONITORING_EMERGENCY_DISABLED` (env) | | Refuse all calls / stop all monitoring |

Every value is DECISION REQUIRED and env-overridable (`SAFETY_*`).

### 4.2 What each control can stop

| Cost | Stopped by HCG software? | How |
|---|---|---|
| Monitoring (Media Streams) | **Yes** | Gate before the stream starts; mid-call stop closes the stream (the call is untouched); 30-min cap; heartbeat/stale detection |
| Transcription / OpenAI | **Yes, in minutes** | Only transcribes streams attached to a reservation; rate-anomaly guard; £ ceilings. **Not in £:** HCG can't see OpenAI's real price (no billing access). A price rise is invisible until the invoice. |
| PSTN inbound | **Yes, for new calls** | Admission refuses with `<Reject>` as the first verb (unbilled); `<Dial timeLimit>` ends calls in progress |
| SMS | **Yes** | SMS budget before every send |
| Simultaneous-call / flood | **Yes** | Concurrency, burst, caller-flood and loop rules at admission |

### 4.3 Costs HCG software cannot stop once incurred

- **The first started minute of every admitted call**, and every minute of an admitted call up to its time limit. Calls in progress are not hung up by the £ ceilings; only new calls are refused.
- **Calls that arrive while HCG is unreachable.** Twilio bills ~1 started minute each (£0.0076) and plays an error. Only provider settings help: a static `<Reject>` voice fallback URL (unbilled) and usage triggers.
- **Number rental** (£0.869/number/month) until the number is released.
- **SMS already sent**, and failed-message processing fees.
- **OpenAI price changes.** Only an OpenAI project budget (provider side) is a hard stop.
- **Twilio has no hard account spend cap.** Usage Triggers only notify, about a minute after the threshold. The only provider-side hard stop is a **prepaid balance with auto-recharge off**, which suspends *all* service when exhausted (DECISION REQUIRED).

### 4.4 NORMAL → WATCH → ALERT → EMERGENCY

| Level | Per household (monthly, from the ledger: `spendMonitor`) | Company | Enforcement |
|---|---|---|---|
| NORMAL | Inside the target margin | Normal run-rate | None |
| WATCH | `HOUSEHOLD_BELOW_TARGET_MARGIN`: projected cost > net × (1 − 40%) − fee, e.g. **£1.87** at £4.99 store, £2.62 at £6.99 store | Any WARNING | Dashboard only |
| ALERT | `HOUSEHOLD_PROJECTED_LOSS`: projected cost > after-fees revenue, e.g. **£3.53** at £4.99 store | Any CRITICAL; ledger stale or missing (never £0) | Page; fair-use review; no customer effect |
| EMERGENCY | Hard ceilings in §4.1 reached (£10/day, £20 and £40/period) | Company £ ≥ EMERGENCY or HARD | **Enforced at admission** (real-time counters, not the ledger) |

The real-time counters enforce; the ledger checks them. A stale ledger raises ALERT but never relaxes enforcement.

## 5. Maximum exposure per failure scenario

Per household unless stated. Upper bounds use the conservative rate `c`.

| Scenario | Stopped by | Max exposure before the safeguard intervenes |
|---|---|---|
| Plumber / business user, unknown calls all day | Monitoring ceilings; unknown callers refused at £20/period; everything at £40 | **£18.20/day** (theoretical), **£49.47/period**. Genuine 10 h/day ≈ £6.43 + ≤ £1.50 monitoring. |
| Call accidentally left connected | `<Dial timeLimit>` 240 min; monitoring stops at 30 min | **£2.81** per call |
| 24-hour connected call | Impossible: ends at 240 min | **£2.81** (vs £15.68 with no limit) |
| Forwarding loop | Caller = HCG number: refused at the first looped leg. Otherwise burst rule + concurrency + £10/day. | **£2.57** (one leg) up to **£18.20/day** |
| 10 simultaneous calls | 3 admitted, 7 refused (unbilled) | **£8.20** per wave; **£18.20/day**; **£48.20/period** |
| 100 simultaneous calls | 3 admitted, 97 refused (unbilled) | Same as 10: **£18.20/day**, **£48.20/period** |
| Malicious attack on one HCG number | Concurrency, caller-flood, burst, £10/day, unknown block at £20 | **£18.20/day**; **£28.20/period** (£48.20 if trusted numbers are spoofed) |
| Coordinated attack on many numbers | Per household as above; company EMERGENCY limits attacked households to their £3 WATCH; company HARD refuses all unknown calls | **£11.20** per attacked household after EMERGENCY; company ≈ **£100/day** HARD + calls in flight (N = 10) |
| Monitoring malfunction | 30-min cap, stale heartbeat, rate-anomaly guard, unrecordable-usage stop, £ ceilings, company monitoring cap | **£1.98/day** per household; **£34.84/day** company; **£15.98** if the server hangs with streams open (bounded by call length) |
| Transcription provider charges more (e.g. 5×) | **Not detectable by HCG**; minutes stay bounded | **£16.75/period** per household at 5×. Only the OpenAI budget stops it in £. |
| Twilio starts charging the app leg | Already priced into every limit; the ledger flags `NEW_COST_CATEGORY` CRITICAL | **£0** extra safety exposure (commercial: +£0.00316 per connected minute) |
| Ledger / usage data stops updating | Ledger stale → ALERT (never £0). Real-time DB down → in-memory limits (≤ 2× concurrency if the provider can't be asked), monitoring fails closed, CRITICAL alert. | **£3.86/hour** per household under attack during a DB outage; genuine households unaffected |
| Allowance reached during an active call | 300 s grace, then monitoring stops; the call continues | **£0.08** |
| HCG server unreachable | Nothing in HCG software | **£0.0076** per arriving call, unbounded in count. Provider-side `<Reject>` fallback URL needed. |

## 6. Fail-safe behaviour

| Failure | Behaviour |
|---|---|
| Admission RPC slow or erroring | In-memory limits (concurrency, burst, caller flood) + CRITICAL alert. If the provider can't confirm the counted calls, still bounded at 2× the concurrency limit. The £ ceilings are not evaluated, and are **not assumed to be £0**; the per-call time limit still applies because it's in the TwiML. |
| Monitoring gate slow or erroring | No monitoring (fail closed); the call connects |
| Usage can't be recorded for 60 s mid-call | Monitoring stops for that call |
| Unsigned `/voice` | Answered normally, **not counted** (forged requests can't exhaust a household's limits), no paid monitoring, CRITICAL alert |
| Forged Media Stream "start" | No reservation → never transcribed |
| End-of-call callback lost | Closed conservatively at the call's **full maximum** at the household's next admission |
| Ledger stale or missing | ALERT; never read as £0; enforcement unaffected |
| Allowance unreadable in the app API | `state: "unavailable"`, `monitoringActive: null`, never "protected" |

## 7. What is enforced vs advisory

**Enforced once deployed and 056 applied:**
- `<Dial timeLimit>`;
- simultaneous-call, burst, caller-flood and loop refusals;
- household £ day and period ceilings;
- company EMERGENCY and HARD admission rules;
- monitoring gate: stream caps and £ ceilings;
- mid-call monitoring stops;
- transcription only with a reservation;
- SMS budget;
- kill switches.

**Advisory (alert or dashboard only):**
- ledger-based spend guard;
- anomaly detection;
- margin WATCH and projected-loss ALERT;
- estimate-vs-ledger check;
- company protection level actions;
- provider usage triggers (which notify only).

**Built but switched off pending decisions:**
- Layer A enforcement (`MONITORING_ALLOWANCE_ENFORCED`);
- warning delivery to customers;
- stop-SMS wording (`safetyStopMessage`);
- Twilio usage triggers (script dry-run only).

## 8. Deployment prerequisites (none done; each needs approval)

1. **Order matters.** Apply 056 **before** deploying this code. Otherwise:
   - `logCall` writes `monitoring_status` to a missing column, and calls go unlogged;
   - the monitoring gate fails closed, so no monitoring for anyone.
2. **Confirm Twilio signature validation passes in production for real calls.** Check that the log line `ACTIVATION VERIFIED AUTO-STAMP SKIPPED: Twilio signature did not validate` does not appear for genuine calls. If it does, counting stops and monitoring is withheld (alerted), and the cause must be fixed first. The escape hatch is `SAFETY_ADMISSION_REQUIRES_SIGNATURE=false`.
3. **Migration order** against production history (040–046 applied): 047 → 051 (ledger) → 052 → 053 → 054 → 055 (**two different 055s exist on other branches; one must renumber**) → 056. Staging first.
4. **Set a secret `SAFETY_CALLER_KEY_SECRET`**, so caller hashes can't be reversed by enumerating numbers.
5. **Provider settings (Andrew):**
   - Twilio usage triggers (`scripts/provider-usage-triggers.js`);
   - a Twilio voice fallback URL returning static `<Reject>`;
   - an OpenAI project budget;
   - optionally, a prepaid balance with auto-recharge off.
6. **Latency.** `/voice` now makes one admission RPC and one loop lookup, each bounded at 1.5 s, and fetches the entitlement for trusted calls too. Measure on staging.

## 9. Test coverage

| Test file | Checks | What it covers |
|---|---|---|
| `tests/financial-safety-migration.pglite.test.mjs` | 37 | Real Postgres (PGlite): every admission rule; idempotent retries; a 10-call burst (exactly 3 admitted); in-progress calls counted; lost calls closed at the maximum; Layer A metering; claims; SMS budget; grants; RLS; rollback and re-apply |
| `tests/financial-safety-callpath.test.mjs` | 62 | Plans; periods; rates; SQL/app limit-key parity; admission incl. fallback races, loop and timeouts; gate; warning points; Build 20 contract; SMS budget; mid-call handler rules; server wiring invariants |
| `tests/failure-scenarios.test.mjs` | 13 | Every scenario bounded; bounds follow the config; margin WATCH vs loss |
| `tests/financial-safety.test.mjs` | 69 | Ledger-side monitor (existing 65 + estimate-vs-ledger and loader checks) |
| `tests/pricing-scenarios.test.mjs` | 12 | Hand-reconciled economics |

**Limitation:** PGlite is a single connection. Races are proven at the rule level and in-process; true multi-connection lock contention relies on the per-household advisory locks and is untested locally (no Postgres/Docker available).
