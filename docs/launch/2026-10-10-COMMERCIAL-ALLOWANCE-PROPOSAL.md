# Commercial allowance proposal: £5.99 launch (2026-10-10)

**Status: PROPOSAL ONLY.** WS2, branch `launch/ws2-financial-protection`, built on c02daa9. Nothing has been deployed, applied or changed: no database row, policy, env, console or price. The SQL in §7.4 is for Andrew to approve.

**Where the numbers come from:**
- Every figure is reproduced by `node scripts/finance/commercial-allowance.js`. The script is deterministic and seeded, and makes no network calls. All rates come from the unit-economics register.
- The full tables are in `docs/launch/2026-10-10-COMMERCIAL-ALLOWANCE-TABLES.md`, referred to below as T1–T9.
- `tests/commercial-allowance.test.mjs` pins the headline claims and fails if the tables file goes stale.

---

## Plain-language summary

1. Today's proposed £3.00 allowance is about what a typical household uses in a month. Screening stops £0.34 *before* the budget is empty, so in the model **about 80% of typical households would see screening paused at some point in the month**, mostly in the last ten days. The earlier "about half" figure was measured against the whole £3.00, not the pause point.
2. Option 1 puts everything in one bigger pool: £4.20, plus £0.10 for emergency call-backs. That gives **about 91% of typical households a full month of screening**. A customer who uses every penny still **costs HCG no more than they pay**, on what Twilio bills today.
3. If Twilio starts charging for the app leg, that worst case becomes a loss of up to **£0.67 per customer per month**. The loss is bounded, and the daily reconciliation would show the change within a day.
4. **A 40% blended margin is NOT achievable at £5.99 while every call is forwarded through HCG.** On the assumed usage the expected blend is **≈ 34%**, and a typical household on its own is 26%. Family calls set the cost, not the AI.
5. Three things reach 40%:
   - real usage turns out lower (≤ ~75 family minutes a month for a typical household);
   - the price goes to £6.99 (41%);
   - the trusted-caller bypass works (≈ 53% at £5.99; **conditional, unproven**).
6. Heavy households (about 15%, 400+ family minutes a month) hit the hard limit mid-month on any £5.99 plan. **With 5 customers there is a 56% chance at least one of them is heavy**, so handle them personally.
7. **Recommendation:** launch the first 5 on Option 1 at £5.99. Measure for 30–45 days, then decide price and tier on real data. Switch to the bypass profile only after Test A/B passes.

---

## 0. Requirements checklist (unconditional forwarding "A", £5.99, Stripe)

| # | Requirement (Andrew) | Option 1 | Evidence |
|---|---|---|---|
| R1 | 40% margin target | **FAIL: 34.1% blended** (billed today); 22.6% if the SDK leg is billed; 17.1% on the Fortress basis | T7 opt1; §3 |
| R2 | No uncontrolled losses: per-customer cap ≤ what revenue supports | **PASS on today's billing:** worst case £3.36 billed against £3.37 of room, so ≥ £0.01 contribution. **Bounded loss ≤ £0.67** per maxed customer per month if the SDK leg starts billing | T7 opt1; §6 |
| R3 | "Half of typical households exhaust £3.00" is not acceptable; target ≥ 90% never pause | **PASS (edge): 91.5%**, or **87.3%** if call lengths are heavier-tailed | T7 opt1 / opt1_heavyTail |
| R4 | £4.99 subscribers grandfathered | Price kept (WS4 proof). They share the `standard` profile, so a maxed £4.99 household can cost up to £0.78/month more than it pays (§6.5) | WS4 report §4; T7 opt1_grandfathered499 |
| R5 | No reliance on unproven network behaviour | **PASS.** Option 1 assumes unconditional forwarding. The bypass appears only in §2/§3 (B columns) and §7.2, as conditional | — |

**Stated plainly: no allowance at £5.99 under A meets R1, R2 and R3 together.** R3 forces the pool to £4.15–4.35. On the assumed usage, that leaves the blended margin at about 34%. The cost driver is the 150 trusted minutes a typical household forwards through Twilio. Making the cap tighter raises the margin (36% at £3.00) only by pausing about 80% of typical households.

---

## 1. Usage distribution assumptions

**The real distribution is UNKNOWN.** HCG has no genuine paying customers yet (admin/usage audit, 2026-09-27). The profiles below are the register's illustrative profiles (`usageProfiles`, ESTIMATED). The mix is the WS2 scale simulation's 40/45/10/5. WS5's bypass document (`docs/routing/2026-10-10-WS5-TRUSTED-BYPASS-EXPERIMENT.md`) did not exist in `/Users/ad/call-ai-ws5-trusted-bypass` when this was written, so the same register profiles are used for B. If WS5 publishes different minutes, edit `SEGMENTS` and re-run.

| Segment | Share (percentile band) | Trusted calls / min per month | Unknown calls / min (all monitored) | Warning SMS | Source |
|---|---|---|---|---|---|
| Light | 40% (≈ P0–P40) | 20 / 60 | 6 / 15 | 0 | register `light` |
| Typical | 45% (≈ P40–P85) | 45 / 150 | 15 / 40 | 1 | register `typical` |
| Heavy | 10% (≈ P85–P95) | 100 / 400 | 30 / 80 | 2 | register `heavy` |
| Extreme | 5% (≈ P95–P100) | 200 / 800 | 60 / 200 | 3 | register `veryHeavy` |

**How variation is modelled:**
- Each household-month draws Poisson call counts and per-call durations.
- Durations are exponential, as in the WS2 sim. Rows marked *heavy tail* use lognormal durations with CV 1.5.
- Costs are applied per call with 60-second rounding, exactly as Twilio bills and as Fortress charges.
- There are 6,000 household-months per segment, seed 20261010, with common random numbers across cases.

**External anchor:** Ofcom's average *outgoing* use is 146 min/month. HCG pays for *incoming* minutes, which Ofcom does not publish.

### What to measure in the first 5–25 customers

| # | Metric (per household per month unless stated) | Source (already recorded) | Why it matters |
|---|---|---|---|
| M1 | Trusted forwarded calls and minutes | `fc_reservations` settled seconds where `is_known` | **The single number that decides price.** At 40% blended on £5.99, a typical household must forward ≤ ~75 trusted minutes (T9) |
| M2 | Unknown calls and minutes; monitored vs unmonitored share | `fc_reservations` (`monitored`, funding) | Sizes the screening part of the pool and the bypass case |
| M3 | Call-duration distribution, per call (tail CV; share of calls over 15 and 30 minutes) | settlements | Many samples even at N = 5. Decides whether the 91% or the 87% figure applies |
| M4 | Fortress committed vs Twilio/OpenAI billed | offline `providerReconciliation` against a daily Twilio export | Confirms the 0.66–0.76 billed÷Fortress ratio. **The `model_gap` flag is the SDK-billing tripwire (§6.3)** |
| M5 | Day of first `screening_low`, `screening_paused`, `hard_ceiling` | `fortress_allowance_state_log` | Shows directly whether R3 holds |
| M6 | Short calls (< 60 s) and unanswered calls | settlements | Drives the rounding cost (0.55 started minutes per call) |
| M7 | Contacts count, carrier, handset | households/contacts | Explains heavy households; screening for the bypass |

**Checkpoint:** 25 household-months, or day 45, whichever comes first.
- Five households can't give a P90.
- Use the per-household means for M1/M2 and the call-level distribution (M3) for the tail.

---

## 2. Cost per household per month (uncapped demand, means; T3)

**Rates (register, verified):**

| Item | Billed today | Fortress enforcement basis |
|---|---|---|
| Trusted inbound | £0.007558 per started minute, for the whole call | £0.010718 × 1.10 = £0.01179 per started minute, + £0.0006 per call |
| SDK leg | £0 billed so far (list £0.00316/min) | inside the £0.010718 above |
| Unknown monitored | £0.0156/min (inbound + stream £0.003329 + whisper £0.00474) + Polly £0.0006 per call | £0.02067/min + £0.0006 per call |
| SMS | £0.0423 | £0.0466 |
| Number | £0.869/month | not metered |

Including rounding, that is a trusted minute at £0.0086 billed / £0.0134 Fortress, and a monitored minute at £0.0172 / £0.0229.

| Segment | **A** billed today | A, SDK billed at list | A Fortress (P90) | **B** billed today | B, SDK billed | B Fortress (P90) |
|---|---|---|---|---|---|---|
| Light | **£0.80** | £1.08 | £1.22 (£1.64) | **£0.27** | £0.33 | £0.38 (£0.64) |
| Typical | **£2.07** | £2.77 | £3.12 (£3.81) | **£0.76** | £0.91 | £1.04 (£1.48) |
| Heavy | **£4.95** | £6.68 | £7.49 (£8.60) | **£1.53** | £1.84 | £2.10 (£2.72) |
| Extreme | **£10.46** | £14.05 | £15.73 (£17.46) | **£3.62** | £4.36 | £4.95 (£6.03) |

**How to read this table:**
- **A** is today's unconditional forwarding.
- **B** is the trusted-caller bypass: trusted minutes cost HCG £0; unknown calls are still forwarded on no-answer and monitored. **B is conditional on Test A/B and not used for the launch proposal.**
- Usage only. Add the fixed £1.16 (number £0.869 + churned-number overhang £0.043 + infrastructure allocation £0.25). Month 1 has a £1.15 purchase instead of £0.87 rental.
- With heavy-tailed durations, the means are unchanged and the typical Fortress P90 rises to £3.96 (A) and £1.58 (B).

**Under A, about 63% of a typical household's billed cost is trusted minutes:** 150 minutes + 45 calls × 0.55 rounding = 174.75 started minutes × £0.007558 = £1.32 of £2.07. Monitoring proper (stream + transcription + greeting) is about £0.36. This is why B changes everything and monitoring tweaks change almost nothing.

---

## 3. Margin at £5.99

**Definition (identical to the register, `HCG_UNIT_ECONOMICS_V1.md` §4):**

    margin = (net − payment fee − 2% leakage − number − churned-number overhang − £0.25 infra − usage) ÷ net

- net = £5.99 ÷ 1.2 = £4.99.
- Stripe fee = 1.5% + 20p card, + 0.7% Billing, + 0.5% Tax = £0.36. Play = 15% of net = £0.75.
- Staff and marketing are not deducted.
- Break-even ("LOSS line") usage room is **£3.37 on Stripe** and £2.98 on Play.
- The infra £0.25 is the register's convention. At 5 customers the real share is about £8 each, so cohort-level margin is a unit-economics figure, not a P&L.

Each cell below shows billed today / SDK billed / Fortress basis (T4).

| Segment | A, Stripe | A, Play 15% | B, Stripe | B, Play 15% |
|---|---|---|---|---|
| Light | 51.4 / 45.8 / 43.0% | 43.6 / 38.0 / 35.3% | 62.0 / 60.8 / 59.9% | 54.2 / 53.1 / 52.1% |
| Typical | **26.0** / 11.9 / 5.0% | 18.2 / 4.2 / −2.7% | **52.3** / 49.2 / 46.6% | 44.5 / 41.5 / 38.9% |
| Heavy | −31.7 / −66.4 / −82.6% | −39.4% … | 36.8 / 30.7 / 25.4% | 29.0% … |
| Extreme | −142% … | −150% … | −5.2 / −19.8 / −31.7% | −12.9% … |
| **Blended, uncapped** | **22.0** / 6.3 / −1.2% | 14.2 / −1.4 / −8.9% | **51.7** / 48.6 / 45.9% | 44.0 / 40.8 / 38.1% |

**Capped by a profile** (Option 1 under A; bypass profile under B), the blends become:

| | Billed today | SDK billed | Fortress basis |
|---|---|---|---|
| Option 1, A | **34.1%** | 22.6% | 17.1% |
| Bypass profile, B | **53.5%** | 50.6% | 48.2% |

The cap lifts the A blend only because heavy and extreme households are **refused service** once their pool runs out.

---

## 4. Why the £3.00 profile pauses most typical households (verified in 067/076 SQL)

1. **Budget-first funding.** Trusted calls are paid from `period_budget_gbp` first. The `trusted_only` delivery reserve is only headroom *below zero* (`v_avail_reserve = v_avail_budget + delivery_reserve`; 076:276-277). Family calls therefore spend the screening budget.
2. **Screening needs £0.3376 of headroom up front:** the first lease (£0.0713) plus the whole 30-minute monitoring window (£0.2663; 076:288-296). The state becomes `screening_paused` once the budget falls below that, which is £2.66 used at B = £3.00.
3. Typical Fortress demand is a **mean of £3.12 (P90 £3.81)**, against a pause point of £2.66. So **80% of typical households pause** (T7 `current`; 9% before day 20) and 11% get a trusted refusal. The WS2 sim's 48% counted only households projected above £3.00, and came from a 7-day window. The pause point is the stricter, customer-visible measure.

**Smallest budget at which ≥ 90% of typical households never pause (T5):**

| Case | Budget |
|---|---|
| A | £4.15 (heavy tail £4.35) |
| A with a 15-minute monitoring window | £4.05 |
| B | £1.85 (heavy tail £1.95) |

---

## 5. Levers evaluated (none relies on network behaviour unless marked B)

| Lever | Effect (typical household / blend) | Verdict |
|---|---|---|
| **Bigger single pool, sized from usage** | £4.20 gives 91.5% never paused, and the worst case still breaks even today | **Use (Option 1)** |
| **Separate the trusted reserve, drawn first** (screening budget vs trusted delivery) | At the same £4.30, a £2.10 trusted reserve that an unknown-caller flood **cannot drain**. Pause rate is about the same (90.4% vs 91.5%, because an unspent reserve can't fund screening). Margin is unchanged | **Worth building before more than 5 customers** (076 is still DRAFT): it replaces Option 1's £0 trusted continuity with £2.10. Needs `fc_authorize_call` and `fc_renew_lease` funding-order changes, state-machine thresholds and tests. Not built here |
| **Monitoring window 30 → 15 minutes** (`monitoring_max_seconds` 900) | Admission headroom £0.3376 → £0.2045, so +0.9 points never-paused (opt1m 92.4%). Billed saving **£0.001/month** (T6), because typical unknown calls average 2.7 minutes | **Don't, for launch.** It removes coverage from the long calls that are most often scams. It also needs `MONITORING_MAX_DURATION_MINUTES=15` changed **together** with the policy: nothing checks the two agree, so lowering only Fortress would under-count monitoring (no `fc_record_actual` caller, G-1). A boot check is a small follow-up |
| **Stop monitoring once a call is judged safe** | **Does not exist.** `services/liveMonitoring` has only the 30-minute cap (`monitoringLimit.js`) and safety stops. Estimate: 60% of unknown minutes benign and judged at 2 minutes ⇒ about 11 minutes × £0.00807 ≈ **£0.09/month**. It never touches the connected leg | Not worth the protection risk at launch |
| **Incremental monitoring reservation** (lease the window 5 minutes at a time) | Admission £0.3376 → about £0.116, worth about £0.22 of headroom (an estimated +3–5 points never-paused) with no loss of coverage | Good follow-up (076 change + stream stop on refused renewal). Not built |
| **Cheaper number** (£0.869 now) | Saves at most £0.37/month, about +7 margin points. Magrathea £0.50 needs a £100/month minimum, so it only pays from about 270 numbers. Telnyx's number price is unknown | Option only; a carrier change, not launch |
| **Price tier** (Family on the existing `plus` profile; `fc_resolve_profile` already maps `plan_code='plus'`) | Family £9.99 with a £7.20 pool: blend 33.7%, heavy households 23% never paused. Family £10.99 with a £9.00 pool: heavy 91% never paused at 26% margin, worst case break-even today. 40% on heavy households needs about £14.99 | Improves the heavy experience, **not** the blend. Needs a second Stripe Price |
| **£6.99 standard** | Blend 41.1%, typical 98.6% never paused (96.0% heavy tail), worst case +£0.04 today | **The only A lever that meets 40%** (Option 3) |
| **Annual plan** | After fees: £69.99/yr = £4.59/month, £64.99 = £4.26, against £4.53 monthly. Break-even about £68.99. It also adds 12-month refund exposure | No margin gain unless priced ≥ £69. Not for the first 5 |
| **Top-ups** | 077 caps credit at ≤ 0.60 × net, so a top-up is margin-positive and adds no exposure | The natural relief valve at the ceiling (website only on Android). **Keep off until tested** |
| **B: trusted-caller bypass** | Typical cost £2.07 → £0.76; blend 53.5%; heavy 66% never paused (0% under A) | **Conditional on Test A/B**; §7.2 |

---

## 6. Options (exact Fortress profile values)

**Profile fields:** `period_budget_gbp` (B), `delivery_reserve_gbp` (T, scope `trusted_only`), `unscreened_reserve_gbp` (U, migration 076), `essential_reserve_gbp` (E, which funds only `FC_ESSENTIAL_CALLERS` emergency call-backs).

**How the worst case is calculated:**
- Worst case = B + T + U + E + an overrun of one 360-second lease (£0.0713) per reachable pool. This is stricter than the register's flat £0.10.
- Billed ≤ 0.756 × Fortress today, and ≤ Fortress ÷ 1.1 if the SDK leg is billed (T1).

| Option | B | T | U | E | Monitoring max | Worst case per customer (Fortress → billed today / SDK billed) | Typical never pause | Blend (billed / SDK) | Meets |
|---|---|---|---|---|---|---|---|---|---|
| Current (cost-limits 2026-10-09) | 3.00 | 0.50 | 0 | 0.10 | 1800 | £3.74 → £2.83 (+£0.54) / £3.40 (−£0.04) | 20.0% | 36.4 / 25.6% | R2 only |
| **1. Launch, no code change** | **4.20** | **0.00** | **0** | **0.10** | 1800 | **£4.44 → £3.36 (+£0.01) / £4.04 (−£0.67)** | **91.5%** (87.3% heavy tail) | **34.1 / 22.6%** | R2 (today), R3 |
| 1-S. Same £, trusted reserve first (076 change) | 2.10 | 2.10 | 0 | 0.10 | 1800 | same as Option 1 | 90.4% (85.7%) | 34.1 / 22.6% | R2 (today), R3 (edge) + flood-proof trusted continuity |
| 2. Break-even even if the SDK leg is billed | 3.25 | 0.20 | 0 | 0.10 | 1800 | £3.69 → £2.79 (+£0.57) / £3.36 (+£0.01) | 35.6% | 36.3 / 25.5% | R2 (both bases) |
| **3. £6.99 standard** | **4.70** | **0.50** | **0** | **0.10** | 1800 | **£5.44 → £4.12 (+£0.04) / £4.95 (−£0.79)** | **98.6%** (96.0%) | **41.1 / 30.6%** | **R1, R2 (today), R3** |
| Bypass profile (B only) | 2.60 | 0.50 | 0.20 | 0.10 | 1800 | £3.61 → £2.73 (+£0.63) / £3.29 (+£0.08) | 99.9% (98.8%) | 53.5 / 50.6% | **R1, R2 (both), R3** (conditional) |

### 6.1 What Option 1 means for each household type

| Household | What happens |
|---|---|
| Light | Never limited |
| Typical | 91.5% never pause. Those that do, pause in the last days of the month; 2.1% get a trusted refusal |
| Heavy and extreme (≈ 15%) | **All reach the hard ceiling**, 95% of heavy households before day 20. **There is no trusted continuity after the budget (T = 0):** callers hear busy until the period resets, Andrew adds credit with `fc_admin_adjust`, a top-up is bought, or the customer turns forwarding off. Their contribution stays positive today (+12% margin, because a trusted-heavy maxed household is billed only about 0.66 × Fortress) |

### 6.2 Why T = 0 in Option 1

Under today's budget-first funding, every £ of T is £ that can never fund screening. At equal worst case, moving the £0.50 reserve into B is what lifts typical never-pause from about 80% to 91%.

**The cost:** an unknown-caller flood can drain the whole pool. It is bounded by the £2.00/24 h automatic hold, which alerts Andrew. Option 1-S removes that weakness at the same price, once built.

### 6.3 SDK-leg tripwire

If daily reconciliation shows `model_gap` on SDK legs, Twilio has started billing the app leg. The response:
1. **Same day:** run `fc_set_budget_profile` with the Option 2 values.
2. Profile changes apply only to period accounts opened afterwards. Open periods therefore keep Option 1 until renewal.

**Maximum exposure:** ≤ £0.67 per maxed customer for at most one period. That is ≤ £3.35 for a cohort of 5 and ≤ £17 at 25.

### 6.4 Play 15% (later)

On Play, Option 1's worst case is −£0.38 today and −£1.06 if the SDK leg is billed; the blend is 26.3%.
- Profiles are keyed by **plan, not channel**. Before Play Billing goes live, Play subscribers need either their own `plan_code` and profile (pool ≤ £3.94 for break-even today) or a Play price of about £6.49 or more.
- Under B, Play blends 45.7%.

### 6.5 Grandfathered £4.99

They resolve to `standard`, the same pool. At £4.99, break-even room is £2.58.
- A maxed £4.99 household can cost up to **£0.78/month** more than it pays today (£1.46 if the SDK leg is billed). Typical margin at £4.99 is 12%.
- There are believed to be 0–1 genuine £4.99 subscribers (0 genuine payers at the 2026-09-27 audit, plus the unexplained Apple grant).

**Options:**
- **(a) Accept:** exposure ≤ £0.78 × count per month, alerted by the operator LOSS line.
- **(b)** A `legacy` profile with a £3.40 pool, keyed on the subscription's stored Stripe price. This is a small `fc_resolve_profile` change and has not been built.

---

## 7. Recommendation

### 7.1 First 5 customers: unconditional forwarding (A), £5.99, Stripe/Android only

1. **Profile: Option 1** (B £4.20, T £0, U £0, E £0.10, scope `trusted_only`, monitoring unchanged at 1,800 s) for `standard` and `plus`.
   - Keep `complimentary` and `internal_test` at the cost-limits values (£3.00 / £0.50 / £0.10). They bring no revenue.
   - Apply it **before the first production call**. A profile binds only periods opened after it.
2. **Everything else in the cost-limits recommendation stays as it is:**
   - the £2.00/24 h household hold;
   - 7,200 s maximum call length;
   - global caps scaled per household, with the 0.60 × N daily ceiling correction.
3. **Set `FINANCE_HEAVY_PROJECTED_USAGE_GBP` to 3.80** (typical P90, Fortress basis). At 3.0 the admin view would flag most typical households as heavy.
4. **Heavy households:** ask about family call volume at onboarding.
   - For a heavy household, Andrew decides in advance between (a) a personal `fc_admin_adjust` top-up when it reaches 80%, and (b) explaining the limit, including turning forwarding off.
   - With 5 customers, P(at least one heavy) = 56%.
5. **Run the measurement plan in §1** (M1–M7) and the daily reconciliation, including the SDK tripwire in §6.3.
6. **Be explicit internally that this cohort runs at about 34% blended, not 40%.** It is a measurement cohort, and its maximum loss is bounded.

### 7.2 If the bypass passes Test A/B (on the launch carriers)

- **No profile change is needed while the cohort is mixed.** Under Option 1, bypass households never pause (typical and heavy 100%), and the blend rises to 52.4%. The worst case is unchanged.
- **Once every household is on the bypass, switch to the bypass profile** (B £2.60, T £0.50, U £0.20, E £0.10). This gives:
  - break-even worst case even if the SDK leg is billed (+£0.08);
  - typical 99.9% never paused, heavy 65.5%;
  - blend **53.5%** on Stripe and 45.7% on Play;
  - 40% at £5.99 without a price rise.
- **Caveats:**
  - Missed trusted calls still forward on no-answer to HCG. That cost is not modelled; T = £0.50 covers about 37 Fortress-minutes.
  - Unknown callers who hang up during the silent ring reduce HCG's cost. That upside is not counted.
  - The iPhone path is separate.

### 7.3 Decision points for Andrew

| # | Decision | Recommendation |
|---|---|---|
| CA-1 | Profile for the first 5 | **Option 1** (replaces the £3.00 / £0.50 line in the cost-limits SQL) |
| CA-2 | Accept about 34% blended (not 40%) for the measurement cohort at £5.99 | Yes, with the tripwire and checkpoint below. The alternative is £6.99 now (Option 3) |
| CA-3 | Heavy households in the first 5 | Onboarding question + pre-decided personal adjustment. No Family tier yet |
| CA-4 | Grandfathered £4.99 | (a) accept, bounded at ≤ £0.78/month each |
| CA-5 | Build Option 1-S (trusted reserve drawn first) | Yes, before going past 5 customers: same cost, £2.10 flood-proof trusted continuity |
| CA-6 | **Price checkpoint** (25 household-months or day 45), on measured M1 | Typical trusted ≤ 75 min: stay at £5.99 (≈ 40%). 75–120 min: £6.99 for new sign-ups (Option 3; grandfather earlier ones). Over 120 min, or heavy + extreme share over 15%: do not scale under A; the bypass or a price rise is required |
| CA-7 | Bypass result | Pass: §7.2. Fail: CA-6 decides alone |
| CA-8 | Play Billing | Its own plan and profile, or a price of about £6.49+, before Play Production |
| CA-9 | 15-minute monitoring window | No, for launch. Instead, add the env/policy agreement check and incremental monitoring reservation as follow-ups |

### 7.4 SQL for approval (NOT executed; after 067/068/076 are applied, before the first production call)

```sql
select public.fc_set_budget_profile(p, 4.20, 0.00, 'trusted_only', 0.10, true,
  'CA-1 commercial allowance Option 1 (£5.99, unconditional forwarding) 2026-10-10', 'andrew')
  from unnest(array['standard','plus']) p;
-- complimentary / internal_test: unchanged from the cost-limits SQL (3.00 / 0.50 / trusted_only / 0.10).
-- unscreened_reserve_gbp stays at its 076 default of 0 (no call needed).
-- SDK tripwire (§6.3), only if reconciliation shows the app leg billed:
-- select public.fc_set_budget_profile(p, 3.25, 0.20, 'trusted_only', 0.10, true, 'CA tripwire: SDK leg billed', 'andrew') from unnest(array['standard','plus']) p;
```

---

## 8. Caveats

- **Usage is assumed, not measured.** Every margin above moves with M1. T9 shows the sensitivity at £5.99 (Option 1), by typical trusted minutes per month:

  | Typical trusted min/month | Blended margin | Typical paused |
  |---|---|---|
  | 75 | 40.0% | 0.1% |
  | 101 | 37.9% | 0.4% |
  | 150 | 34.1% | 8.5% |
  | 200 | 30.8% | 43.5% |

- **Fortress-basis margins** (17% for Option 1) are what the admin profitability view will show, because it uses committed Fortress cost. They overstate cost by 1.33–1.56×. The register's margin is on the billed basis.
- **Not modelled:** the essential pool (`FC_ESSENTIAL_CALLERS` is empty at launch), live-call contingents (calls are treated as sequential), OpenAI retries, refunds and chargebacks beyond 2% leakage, and per-instance concurrency. The per-call cut at pool + one lease approximates the lease and backstop mechanics; the test proves spend ≤ pools + overrun.
- **The Fortress basis has rate headroom.** Changing `connected_rate_gbp_per_min` to the billed rate would fund about 1.4× the minutes, but it removes the SDK-billing protection and is a policy loosening. Not proposed.
