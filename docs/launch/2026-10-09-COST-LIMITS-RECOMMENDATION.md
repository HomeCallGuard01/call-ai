# Cost limits for production launch: recommendation (2026-10-09)

**Status: RECOMMENDATION ONLY.** Nothing here has been executed. No database, env or console setting has changed. This closes decision **AL-2 / C12 / B5** (`2026-10-09-LAUNCH-GO-NO-GO.md`) once Andrew approves the SQL in §3.4.

**Scope.** Cohort ≤ 5 (then ≤ 25), Android + Stripe only, at £5.99 inc. VAT (£4.99 net).

**Verified against:**
- `supabase/migrations/067` (fc_policy defaults, `fc_budget_profiles`, `fc_authorize_call`, `fc_renew_lease`, `fc_global_gate`, `fc_household_auto_hold`, `fc_authorize_spend`, `fc_set_policy` allowed keys);
- `services/containment/policy.js` and `economicPolicy.js`;
- `services/liveMonitoring/costCaps.js` and `monitoringLimit.js`;
- `services/usage/safetyConfig.js` (056 Layer B);
- `services/abuse/abuseConfig.js`;
- `services/acquisitionGate.js`;
- `services/finance/assumptions/hcg-unit-economics.v1.json`;
- `docs/finance/HCG_UNIT_ECONOMICS_V1.md` and `FINANCIAL_CONTAINMENT_P0.md`;
- `docs/launch/2026-10-05-DT2-ALLOWANCE-AND-ECONOMICS.md`.

**Method.** The bounds in §2 and §4 were checked by flood simulations on a scratch PGlite database built from all migrations in this worktree, with the recommended policy applied. The script is `scratchpad/costsim/sim.mjs`. It is not committed and makes no real-service calls.

## 1. Cost model per path

| Path / event | Billed today (ex-VAT) | Fortress enforcement basis (`fc_policy`) | Source |
|---|---|---|---|
| Trusted call (inbound PSTN + `<Dial><Client>` SDK leg) | inbound **£0.007558 per started minute** for the whole conversation. SDK leg billed £0 so far (list price $0.004 = £0.00316) | `connected_rate_gbp_per_min` 0.010718 (inbound + SDK at list) × `estimate_uplift` 1.10 = **£0.01179/min**, 60 s blocks (`billing_granularity_seconds`), + `call_fixed_fee_gbp` £0.0006 per call | register `twilioInboundGbpPerMin`, `twilioAppLeg*`; 067 |
| Unknown caller, monitored | inbound £0.007558 + Media Stream £0.003329 + whisper-1 £0.00474 = **£0.0156/min**, + Polly £0.0006 per call | connected £0.01179 + `monitoring_rate_gbp_per_min` 0.008069 × 1.1 = **£0.02067/min**. Monitoring is at most `monitoring_max_seconds` 1800 per call, and the whole 30-minute window (£0.266) is reserved up front | register; 067; `monitoringLimit.js` |
| Warning SMS | £0.042325 per segment (1 segment) | `sms_unit_gbp` 0.042325 × 1.1 = £0.0466, paid from the household **budget** (never the reserve) | register; `fc_authorize_spend` |
| Number rental | **£0.86917 per number per month**, billed whatever Fortress decides | not metered | register (45 billed number-months) |
| Number purchase | first month's rental | `number_purchase_gbp` £1.15. Counts against the global cap, not the household | 067 |
| AI classifier `/process` | off by default in the candidate | `ai_request_gbp` £0.001 | 067 |
| Refused call (`<Reject>` as first verb) | £0 | £0 | `server.js:1250-1256` |

Per-minute figures **including** started-minute rounding (`HCG_UNIT_ECONOMICS_V1.md` table B):

| Minute type | Expected (billed) | Fortress basis |
|---|---|---|
| Trusted minute | £0.0086 | £0.0134 |
| Monitored minute | £0.0172 | £0.0229 |

## 2. Worst case per household

The attacker model is a flood of long calls from many spoofed numbers, re-dialled the moment any call ends. Concurrency in code:
- `ABUSE_MAX_CONCURRENT_PER_HOUSEHOLD` = 3 and `SAFETY_MAX_CALLS_PER_HOUSEHOLD` = 3;
- monitored streams per household = 2 (`costCaps` / 056).

| Scenario | Per hour | Per day | Per month (30 d) |
|---|---|---|---|
| **No £ limits, concurrency 3 (2 monitored)**, billed today | £2.33 | £55.90 | £1,677 |
| Same, SDK leg billed at list | £2.90 | £69.50 | £2,086 |
| **Production today (`eb43368`):** no Fortress, no `timeLimit`, no per-household concurrency | about £0.45–£0.64 per concurrent call, plus £0.48 per monitored stream | unbounded (linear in concurrent calls; forged `/media-stream` × 200 ≈ £57/h of OpenAI alone) | unbounded |
| 056 Layer B only (`householdDailyHardGbp` £10, `householdPeriodHardGbp` £40) | about £2.90 | £10 | £40 |
| **Recommended (§3), no admin action** | ≤ £2.25: the hold trips at £2.00 and in-flight leases end (sim: £2.08) | **≤ £2.25** (held until an admin releases) | ≤ £2.25 |
| **Recommended, admin releases every hold immediately** (worst operator case) | same | ≤ £3.00 | **≤ £3.60 + ≤ £0.10 overrun** (sim: £3.43 mixed, £3.50 all-trusted) |

The £ bound does not depend on concurrency. The budget, the 24 h hold and `backstop_share` bound the money. Concurrency only changes how fast the money is reached.

## 3. Recommended values

### 3.1 Per household: `fc_budget_profiles` via `fc_set_budget_profile`

| Profile | `period_budget_gbp` | `delivery_reserve_gbp` | `delivery_reserve_scope` | `essential_reserve_gbp` | `monitoring_allowed` | Total |
|---|---|---|---|---|---|---|
| `standard`, `plus`, `complimentary`, `internal_test` | **3.00** | **0.50** | `trusted_only` | **0.10** | true | **£3.60 per period** (≤ 35 days, `max_period_days`) |
| `unentitled` | 0.00 | 0.10 | `all` | 0.10 | false | £0.20 (seed, unchanged) |
| `sandbox` | 0.00 | 0.10 | `all` | 0.00 | false | £0.10 (seed, unchanged) |

**Why £3.60.** It is the usage room at the Stripe LOSS line, on the *pessimistic* rate basis:
- £4.99 net − Stripe fee £0.36 − 2% leakage £0.10 − fixed £1.16 (rental + churn overhang + infrastructure) = **£3.37 billed**;
- Fortress charges ≥ actual (the estimate is ×1.1 with the SDK leg at list), so £3.60 of Fortress estimate is ≤ £3.27 of real cost even if the SDK leg starts being billed.

A capped household can therefore never cost more than it pays, on any rate the evidence allows (§5).

**What the £3.60 buys:**
- the illustrative typical household (150 trusted + 40 monitored minutes ≈ £2.97 on the Fortress basis) fits inside the **budget**;
- about 130–145 monitored minutes (from the budget only), or about 260–300 trusted minutes (budget + reserve).

### 3.2 Per household: other limits

| Limit | Value | Field / setting |
|---|---|---|
| Daily £ cap (automatic financial hold, latched, admin-only release) | **£2.00 in a rolling 24 h** (default £5). It sits below the budget, so a flood is stopped with about £1.00 budget + £0.50 reserve left for genuine calls after review | `fc_policy.household_auto_hold_daily_gbp` |
| Hourly £ cap | No per-household hourly field exists. The hold above is the effective hourly bound (≤ £2.25 incl. in-flight leases) | — |
| Max call length (provider `<Dial timeLimit>` backstop) | **7200 s** (default 14400). Each call's backstop is also ≤ `backstop_share` 0.5 of the remaining headroom | `fc_policy.max_call_seconds`; keep `backstop_share` 0.5, `lease_seconds` 300, `termination_grace_seconds` 60 |
| Max concurrent calls | **3** (unchanged), 2 monitored streams | env `ABUSE_MAX_CONCURRENT_PER_HOUSEHOLD`=3, `SAFETY_MAX_CALLS_PER_HOUSEHOLD`=3, `MEDIA_STREAM_MAX_STREAMS_PER_HOUSEHOLD`=2 |
| Monitored minutes | 30 per call. About 130 per month at most, bounded by £ not minutes. Do not promise minutes (DT-2) | `monitoring_max_seconds` 1800; env `ALLOWANCE_SOURCE=fortress` |
| SMS | **3/day** per household, **10/h** globally (default 30). Each is funded from the budget | env `MEDIA_STREAM_MAX_SMS_PER_HOUSEHOLD_PER_DAY`=3, `MEDIA_STREAM_MAX_SMS_PER_HOUR`=10, `SAFETY_HOUSEHOLD_DAILY_SMS`=3, `SAFETY_HOUSEHOLD_PERIOD_SMS`=10 |
| 056 Layer B backstop | sits under Fortress, slightly looser, so it only matters if Fortress is misconfigured | `SAFETY_HOUSEHOLD_DAILY_HARD_GBP`=2.50, `SAFETY_HOUSEHOLD_PERIOD_HARD_GBP`=5, `SAFETY_HOUSEHOLD_PERIOD_UNKNOWN_BLOCK_GBP`=4 |

### 3.3 Trusted delivery reserve: the tradeoff

Two requirements cannot both be met on Twilio today, because trusted minutes are on HCG's bill:
- "forwarded calls keep being delivered";
- "never uncontrolled spend".

Only C5 (network-side routing) removes this conflict.

| Option | Reserve | What happens after the budget is gone | Worst cash loss per customer per month |
|---|---|---|---|
| **A (recommended)** | £0.50 `trusted_only` | Trusted callers continue for about 40 more minutes. After that, every call gets `<Reject>` (busy) until the period renews, or until **Andrew tops the household up with `fc_admin_adjust`** (audited, ≤ £50 per call). The customer has been warned at 75/90/100%, and the 100% email explains how to switch forwarding off | ≈ £0 (§5) |
| B (delivery-first) | £6.40 `trusted_only` (total £9.90) | Trusted delivery continues to about 840 Fortress-minutes per month | ≈ −£6.30. Cohort of 5: ≤ £32/month; 25: ≤ £160/month |
| C | `all` scope | Unknown callers also use the reserve. A flood locks out trusted callers | rejected (victim lockout; integration 2026-10-03) |

**Recommendation: A.** With ≤ 5 to 25 attended customers, the "keep delivering" decision becomes an explicit, audited £ decision per household, prompted by the first `funding='reserve'` call and the 90% warning, instead of an open-ended liability. Heavy households (about 400 trusted minutes or more) lose money at £5.99 whatever the cap (−£1.60/month, uncapped). The cap turns that loss into refusals plus a top-up decision.

### 3.4 Global limits (`fc_policy` via `fc_set_policy`)

`N` is the entitled-household count, computed by the database.

| Field | Default | **Recommended** | Effective at N = 5 | Effective at N = 25 |
|---|---|---|---|---|
| `global_hourly_floor_gbp` / `_per_household_gbp` | 4 / 0.03 | **4 / 0.24** | **£4/h** (latches the breaker) | **£6/h** |
| `global_daily_floor_gbp` / `_per_household_gbp` | 15 / 0.20 | **10 / 0.60** | **£10/day** (latches) | **£15/day** |
| `global_daily_absolute_max_gbp` | 1000 | **25** | caps scaling if N is inflated | £25 |
| `global_exposure_floor_gbp` / `_per_household_gbp` | 5 / 0.05 | 5 / **0.20** | £5 live reserved | £5 |
| `global_worst_case_floor_gbp` / `_per_household_gbp` | 40 / 0.50 | **20 / 0.80** | £20 | £20 |
| `global_active_floor` / `global_active_households_per_call` | 20 / 5 | **10 / 3** | 10 live calls | 10 |
| `global_monitoring_hourly_floor_gbp` / `_per_household_gbp` | 1.5 / 0.02 | **2.5 / 0.10** | £2.50/h (soft: new calls unmonitored) | £2.50/h |
| `global_unattributed_daily_gbp` | 2 | **0.25** | about 7 calls/day to numbers with no household | same |
| `global_number_purchases_per_day` | 10 | **3** (raise to **5** at the 25 stage) | 3 | 5 |
| Abuse layer (env) | 10/h, 40/day, 2 per household per 30 d | `ABUSE_MAX_PURCHASES_GLOBAL_PER_HOUR`=2, `…_PER_DAY`=3 (5 at the 25 stage), `…_PER_HOUSEHOLD_30D`=2 | | |
| Unchanged | — | `enforcement_mode` `enforce` (env `FC_ALLOW_SHADOW` unset), rates 0.010718 / 0.008069, `estimate_uplift` 1.10, `FC_DEGRADED_MODE` `reject` | | |

The per-household factors make **one policy serve both stages**. Only the number-purchase cap changes at 25.

**For Andrew to approve. Do not execute before migrations 067/068 are applied (B1) and before the first production call, because a profile applies only to period accounts opened after the change.**

```sql
select public.fc_set_policy('{
  "max_call_seconds": 7200, "household_auto_hold_daily_gbp": 2.00,
  "global_hourly_floor_gbp": 4, "global_hourly_per_household_gbp": 0.24,
  "global_daily_floor_gbp": 10, "global_daily_per_household_gbp": 0.60, "global_daily_absolute_max_gbp": 25,
  "global_exposure_floor_gbp": 5, "global_exposure_per_household_gbp": 0.20,
  "global_worst_case_floor_gbp": 20, "global_worst_case_per_household_gbp": 0.80,
  "global_active_floor": 10, "global_active_households_per_call": 3,
  "global_monitoring_hourly_floor_gbp": 2.5, "global_monitoring_hourly_per_household_gbp": 0.10,
  "global_unattributed_daily_gbp": 0.25, "global_number_purchases_per_day": 3
}'::jsonb, 'AL-2/C12 launch cost limits 2026-10-09, cohort <=5', 'andrew');
select public.fc_set_budget_profile(p, 3.00, 0.50, 'trusted_only', 0.10, true,
  'AL-2/C12 option A: LOSS-line profile at £5.99', 'andrew')
  from unnest(array['standard','plus','complimentary','internal_test']) p;
select public.fc_refresh_entitled_count(now());
-- 25 stage: select public.fc_set_policy('{"global_number_purchases_per_day": 5}'::jsonb, 'cohort 25', 'andrew');
```

### 3.5 Kill-switch trip thresholds

**Automatic (latched, reset only with `fc_reset_breaker`):** the hourly and daily caps above.

**Manual `fc_set_kill_switch(true, …)`** (live calls end within one lease) if any of these happens:
1. The breaker trips twice in 24 h, or its cause is not explained within 30 minutes.
2. A Twilio usage trigger fires: **£10/day or £60/month** at N ≤ 5 (£25 / £150 at 25).
3. OpenAI spend passes **£2/day**.
4. A number is bought that does not match an allowlisted sign-up.
5. `fc_check_invariants()` fails.
6. Two or more automatic holds (`household_hold_automatic` or `estimate_undercount`) fire in one day.

`NEW_SUBSCRIPTIONS_PAUSED=true` comes first in every case. Run a production off/on/off test of the kill switch (B5).

## 4. Resulting maximum loss bound

| Scope | Bound (Fortress-controlled spend) | Evidence |
|---|---|---|
| Per paying customer per month | ≤ **£3.70** of usage (£3.60 + overrun). Total cost ≤ £3.70 + rental £0.87 (month 1: purchase £1.15) + Stripe £0.36, against £4.99 net | sim: £3.43 to £3.50 with every hold released |
| Per complimentary / test household | ≤ £3.70 + £0.87 (no revenue) | — |
| Global per day | **≤ £10** (N = 5) / **≤ £15** (N = 25), absolute ceiling £25 | sim: 5 households flooded together tripped the breaker at £3.30 (N = 5) and £5.72 (N = 25). With every breaker and hold reset as soon as it fired: day 1 £9.68 (≤ £10) |
| Global per month | ≤ Σ households × £3.70 + unattributed £7.50 + purchases. **N = 5: ≈ £26 + ≤ 10 purchases (£11.50). N = 25: ≈ £100 + ≤ 50 purchases (£57.50)**, plus £0.87 per month for each extra number held | sim: 5 households over 3 days with everything reset = £17.40 (≤ 5 × £3.50) |

**Attacker scenarios:**
- **Compromised account or flooded number** (including a spoofed trusted CLI): ≤ £2.25 before the hold, ≤ £3.70 per period. Also at most 2 replacement numbers per 30 days, and no SMS, AI or purchase while held. The profile is resolved server-side and cannot be raised from the account.
- **Mass sign-ups:** Stripe checkout is refused unless the email is in `NEW_SUBSCRIPTIONS_ALLOWLIST`. Unpaid accounts have no number, so £0 telephony. **iOS IAP cannot be gated**, so keep iOS off sale. Sandbox purchases fall under the `sandbox` profile (£0.10). `fc_refresh_entitled_count` counts *every* active entitlement, so inflated sign-ups would raise the per-household-scaled caps. `global_daily_absolute_max_gbp` = 25 bounds that, as do 3 purchases/day (≤ £3.45/day + £0.87/month each).
- **Stolen-card paid fraud** (only if the allowlist is off): ≤ £3.70 + £1.15 each, plus a £20 Stripe dispute fee, which is outside Fortress.

**Outside these limits** (covered by `docs/launch/2026-10-09-PROVIDER-CONTAINMENT-CHECKLIST.md`, `docs/integration/2026-10-04-TWILIO_CONTAINMENT_CHECKLIST.md` and `…PROVIDER_FINANCIAL_CONTAINMENT_FINAL.md`, GO/NO-GO B4):
- Twilio has **no hard spend cap**; usage triggers only notify. The only provider-side hard stop is a low prepaid balance with auto-recharge off; keep it ≤ £50 at N ≤ 5.
- The **master auth token** in the backend can buy numbers or place calls directly, bypassing Fortress.
- Calls that arrive while HCG is down bill about one started minute each, unless every number has a `<Reject/>` fallback URL.
- Rental on the held inventory (10 numbers, £8.69/month).
- OpenAI price changes; set a project hard limit.
- Stripe dispute fees.
- **Production `eb43368` today has none of the controls above** (GO/NO-GO P0).

## 5. Margin check at £5.99 (Stripe)

**Revenue side:** £5.99 − VAT £1.00 = **£4.99 net**, then:
- Stripe 2.7% + 20p = £0.36;
- leakage £0.10;
- fixed £1.16.

That leaves **£3.37 for usage**, which is the LOSS line.

| Household | Usage cost | Contribution | Margin |
|---|---|---|---|
| Light (60 trusted / 15 unknown minutes) | £0.81 | **£2.56** | 51% |
| Typical (150 / 40) | £2.08 | **£1.28** | 26% |
| Heavy (400 / 80), uncapped | £4.97 | −£1.60 | −32% |
| **Capped worst case, today's billing** (SDK leg £0) | ≤ £2.70 (£3.60 Fortress ≈ 0.64–0.75 billed) | **≥ £0.60** | ≥ 12% |
| **Capped worst case, SDK leg billed at list** | ≤ £3.37 (£3.70 ÷ 1.1) | **≈ £0.00** | 0% |
| Month 1 adjustment | purchase £1.15 instead of rental £0.87 | −£0.28 | |

Light, typical and heavy figures are from `HCG_UNIT_ECONOMICS_V1.md` §5.1.

**Conclusions:**
- The caps make the worst case break-even, not profitable.
- The 40% target is still missed by a typical household at £5.99 (26%); only price (C4) or architecture (C5) fixes that.
- On a 15% store channel the fee is £0.75 instead of £0.36, so the same profile's pessimistic worst case is about −£0.40. Apple at 30% is worse, which is another reason iOS stays out of this cohort.
