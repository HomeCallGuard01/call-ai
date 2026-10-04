# Provider spend protection — design (2026-09-27)

Status: design only. There is one pure alert evaluator, `services/finance/spendGuard.js`, with tests.
No provider configuration has been changed and nothing is enforced.

**2026-09-28 update:** the rest of the alerting layer now exists (not wired): household cost accumulation, anomaly detection, company protection levels, the monitor job and the worst-case exposure model. See `FINANCIAL_SAFETY_CONTROLS.md`. Twilio Support has confirmed that the inbound PSTN leg is billable for the whole connected call, including `<Dial><Client>` bridging, so trusted calls are not free.

## Where spend is uncontrolled today (evidence)

| Exposure | Current control | Evidence |
|---|---|---|
| Account-wide Twilio spend | **None.** 0 usage triggers; no spend alert. | `usage/triggers` list returned 0 (2026-09-27) |
| Numbers bought outside production | None on `main` | 7 of 19 numbers are staging's (see `NONPRODUCTION_PROVISIONING_CONTROL.md`) |
| Sandbox purchases buying real numbers | None | RevenueCat webhook ignores `environment` (P0 handoff) |
| Length of one call (trusted or unknown) | **Twilio default only: 4 h.** `server.js` `dialHouseholdOrFailClosed` sets `timeout: 20` but no `timeLimit`. | The 30-min `MONITORING_MAX_DURATION_MINUTES` ends only the Media Stream; the call continues (`monitoringLimit.js`). |
| Concurrent Media Streams | 200 (`MEDIA_STREAM_MAX_CONCURRENT_STREAMS`) | `monitoringLimit.js` |
| Minutes per household per month | None (allowance work is call-ai-4b's) | — |
| OpenAI spend | None visible: the project key can't read costs; no budget known | — |
| SMS | Low volume, but **every warning SMS currently fails** (voice-only numbers, error 21661) | 2 failed-message fees in the ledger |

The worst case for one call is 240 min. That costs £1.81 on the inbound leg, plus about £0.76 if Twilio starts billing the app leg. Nothing bounds how many such calls a household makes.

## Controls: who can enforce what

| # | Control | Mechanism | Needs provider config? | HCG code? | Owner | Blocks or alerts |
|---|---|---|---|---|---|---|
| 1 | Account spend alert, daily and monthly | Twilio Usage Triggers on `totalprice` (daily recurring, e.g. £5; monthly, e.g. £60) posting to an HCG webhook or email | **Yes** | Optional receiver endpoint (must authenticate with Twilio signature validation) | Andrew (config) | Alert only. Twilio has no hard account cap. |
| 2 | Abnormal number count | Twilio Usage Trigger on `phonenumbers` count, **and** `evaluateSpend` NUMBERS_ABOVE_ENTITLED from owned numbers vs entitled households | Trigger: yes. Evaluator: no. | `spendGuard.js` (done) plus a scheduled job | Finance + P0 (lifecycle) | Alert |
| 3 | Daily telephony spend | `evaluateSpend` DAILY_TELEPHONY_SPEND on ledger `supplierDailyTotals` (threshold scales with entitled households) | No | done (evaluator) | Finance | Alert |
| 4 | Monthly budget | `evaluateSpend` MONTHLY_BUDGET (80% WARNING / 100% CRITICAL) | No (the budget is an HCG setting) | done | Finance | Alert |
| 5 | AI spend | OpenAI project monthly budget and notification threshold | **Yes** (org owner/admin; the project key can't) | Evaluator DAILY_AI_SPEND from HCG's own transcription estimates | Andrew (config) | Stops requests **only if "Enforce a hard limit" is on** (org/project hard spend limits, July 2026); a plain budget/spend alert is alert-only — see `docs/integration/2026-10-04-PROVIDER_FINANCIAL_CONTAINMENT_FINAL.md` §3. The app already fails open without transcription |
| 6 | SMS volume and delivery | `evaluateSpend` SMS_VOLUME; SMS_DELIVERY_FAILING (CRITICAL) on any failed-message fee | No | done | Finance (alert); P0/product (sender fix) | Alert |
| 7 | Abnormal per-household usage | `evaluateSpend` HOUSEHOLD_DAILY_MINUTES / HOUSEHOLD_MONTH_MINUTES / LONG_CALL from ledger legs | No | done | Finance | Alert |
| 8 | Per-call ceiling (trusted and unknown) | `<Dial timeLimit="…">` in `dialHouseholdOrFailClosed` | No | One attribute | **P0/product** (changes call behaviour) | **Blocks.** The call ends at the limit. |
| 9 | Household monthly allowance | Monitored-minute allowance | No | call-ai-4b branch | call-ai-4b | Blocks or degrades |
| 10 | Trusted-call circuit breaker | See below | No | New | P0/product decision | Degrades |
| 11 | Staging/sandbox purchases | Provisioning guard (`feature/nonprod-provisioning-guard`); RevenueCat environment handling | No | Guard done; RevenueCat is P0's | Finance (guard) / P0 | Blocks |

## Trusted-call circuit breaker (design; DECISION REQUIRED)

Trusted calls cost one inbound leg per minute (£0.007558) plus, potentially, the app leg. They are not monitored, so the monitored-minute allowance doesn't cover them.

Principles:
- **Never** drop, refuse or silently degrade a trusted call because of HCG's own budget. The product promise is that known callers always get through.
- A breaker may:
  - cap the length of a single call (#8, e.g. 120 min, with a spoken warning before the end if feasible);
  - raise alerts at the account and household level (#3, #7);
  - trigger a human review of a household whose trusted-call minutes exceed a threshold (fair-use conversation, not automatic cut-off).
- An account-wide emergency switch, e.g. `EMERGENCY_DISABLE_MONITORING`, should reduce *monitoring* cost (stop starting Media Streams and transcription) and never block call delivery.

## Recommended thresholds

These are the defaults in `spendGuard.js`. All need confirmation (DECISION REQUIRED).

- Numbers above entitled households: WARNING at 3 or more spare, CRITICAL at 10 or more. Today: 19 owned, and at most 9 belong to production households (not all of them entitled), so **CRITICAL** on any count.
- Daily telephony spend: WARNING at max(£3, entitled × £0.15), which is about 2× the break-even run-rate. CRITICAL at 3× that.
- Monthly budget: max(£90, entitled × £2.50) unless set. WARNING at 80%.
- Daily AI spend: max(£1, entitled × £0.05). CRITICAL at 3×.
- SMS: max(10, entitled) per day. Any failed-message fee is CRITICAL.
- Per household: 120 / 300 min in a day; 250 (about break-even) / 500 min in a month; a single call of 60 / 180 min.
- Twilio Usage Triggers (provider config): daily `totalprice` at £5 and monthly at £60 at the current scale. Revisit at 100 households.

## Wiring (not done; sequence)

1. **Now (provider config, Andrew):**
   - Twilio Usage Triggers for daily and monthly `totalprice`, with email/webhook callback.
   - OpenAI project budget.
   - Both are alert-only and take minutes to set up.
2. **After ledger 051 is in production:**
   - a daily job (the ledger `dailyReconciliation` run) calls `evaluateSpend` with the day's `supplierDailyTotals`, owned-number count, entitled-household count and per-household minutes from `telephony_call_legs`;
   - CRITICAL results go to `sendCriticalAlert` (rate-limited, existing);
   - WARNING results appear on the dashboard.
3. **P0/product:** `<Dial timeLimit>` and the emergency monitoring switch.
4. **call-ai-4b:** allowance enforcement, using the same per-household minute source.

Tests: `tests/spend-guard.test.mjs`, 17 checks.
