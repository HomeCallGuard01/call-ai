# Agent 4: Financial model (business decision, 2026-10-10)

**Status: RESEARCH ONLY.** Nothing was deployed, applied, called or changed.
- Every number here comes from `node scripts/research/business-decision-model.mjs`. It is deterministic (two runs give the same md5), plain Node, and makes no network calls.
- Provider rates are read from `services/finance/assumptions/hcg-unit-economics.v1.json`.
- Tables are pasted verbatim. The script also prints fuller per-price and capacity tables.

## Summary for the founder

1. **Launch now on Twilio (A) at £5.99 gives about 30% contribution, not 40%.** Fully loaded it loses about £90/month at 100 customers and never breaks even. 40% contribution needs **£7.75 (about £7.99)**.
2. **Variable cost is bounded on every architecture.** A customer who uses the whole pool costs at most £0 of contribution on the worst channel, even if Twilio bills the SDK leg. The real risks are fixed cost and support time.
3. **Short change, pooled Twilio numbers (C):** 45% at £5.99, but it depends on identifying the household from forwarded-call headers, which is unproven per carrier.
4. **Self-hosted SIP delivery (B2):** 66% contribution, with about £425/month fixed. It breaks even at about 200 customers. Not built (weeks of work).
5. **On-device only (D):** 82%, breaking even at 23 customers. It is a different product (no live AI) and willingness to pay is unproven.
6. **Network-side screening (E):** 38%, and only if the partner fee is ≤ £0.38 per subscriber. **AQL is INCOMPLETE: the rate card is missing.**
7. **Support time (assumed 4 min, £1.67 per customer per month) decides fully-loaded margin.** Halving it adds about 16 points.
8. **Recommendation:** run the first cohort on A as a bounded measurement exercise, then choose £7.99 or C/B2 from the measured trusted minutes.

## 1. Assumptions

| Item | Value | Source | Confidence |
|---|---|---|---|
| VAT | 20%; margins on ex-VAT | register | KNOWN |
| Stripe | 1.5% + 20p + 0.7% Billing + 0.5% Tax | register, `profitability.js` | PROVIDER CONFIRMATION REQUIRED |
| Play / Apple | 15% / 15% SBP (sensitivity 30%) | register; SBP enrolment UNKNOWN | PROVIDER CONFIRMATION REQUIRED |
| RevenueCat | 1% above $2,500 MTR | register | PROVIDER CONFIRMATION REQUIRED |
| Channel mix | Stripe 50 / Play 30 / Apple 20 | assumption (no Play Billing yet) | ESTIMATED |
| Leakage | 2% of net | register | UNKNOWN |
| Disputes | 0.2% × £20 | assumption | ESTIMATED |
| Fraud | 0.5% of Stripe customer-months: pool used, revenue reversed, £20 fee | assumption | ESTIMATED |
| Payment failure | 3%, with 0.25 month served | assumption | ESTIMATED |
| Twilio | inbound £0.007558 per started minute; SDK £0 billed (list £0.00316); stream £0.003329; Whisper £0.00474; Polly £0.0006; SMS £0.042325; number £0.86917 | register (billed) | KNOWN (Whisper ESTIMATED) |
| Twilio BYOC (B1) | $0.004/min | Twilio list, not in the repo | ESTIMATED |
| Magrathea | free inbound, £0.50/number, 10 channels/number, £100/month minimum (rentals assumed to count) | `CARRIER_ROUTING_LAB.md`; TRANSFER-READINESS P6 | PUBLISHED / CONFIRMED; whether rentals count is UNKNOWN |
| Telnyx | $0.005 + $0.002 + $0.002/min; channels $15→$10 | carrier-routing-v2 sources | LIST |
| **AQL** | **INCOMPLETE: rate card missing.** No file under `~/` or `/Users/ad/call-ai-*`; LEBARA-FORWARDING-EVIDENCE:73 says "rate card received" but it is not stored. No AQL price is used | search 2026-10-10 | MISSING |
| E partner fee | £0.50 placeholder; R12 gives the maximum viable fee | assumption | UNKNOWN |
| Usage | trusted + monitored min/month: light 60+15, typical 150+40, heavy 400+80, extreme 800+200; mix 30/45/15/10 (sensitivity: WS2 40/45/10/5) | register profiles | ESTIMATED; **measure later** (0 genuine payers) |
| Rounding | +0.55 min per call (60 s billing), +0.1 (per-second billing) | register | ESTIMATED |
| Churn | 5%/month; number held 1 month after churn | register | UNKNOWN |
| Infrastructure | £75/month platform; +£150 SIP edge HA (B1); +£250 SIP + media + push HA (B2); per customer £0.05–0.15 | register £40 + unverified invoices; Magrathea trial VM | ESTIMATED |
| Support | £25/h × 4 min (A/B/C), 3 (E), 2 (D) per customer per month | assumption | LOW |

**Definitions:**
- **Contribution** = net − fees − leakage − disputes − fraud − payment failures − numbers (incl. churn overhang) − capped usage − variable infrastructure − partner fee.
- **Fully loaded** = contribution − fixed infrastructure − carrier minimum − support. Marketing and salary are excluded.
- **Worst-case month** = every customer uses its whole pool, with the SDK leg billed at list.

**Architectures:**
- **A:** Twilio today.
- **B1:** Magrathea → HCG SIP edge → Twilio BYOC + SDK leg.
- **B2:** Magrathea + HCG-hosted SIP, media and push. No Twilio; Whisper only.
- **C:** A with ⌈N/50⌉ pooled numbers (minimum 2).
- **D:** on-device. No forwarding, number or live AI.
- **E:** only unknown calls reach HCG (Twilio rates) + partner fee.

## 2. Results

Net revenue per month is N × price ÷ 1.2. At £5.99 that is £499 at 100 customers and £4,992 at 1,000.

### R1. Per-customer unit economics at 100 customers, £5.99, base mix (£/customer/month, billed today)
| Arch | Net | Fees+RC | Leak+disp+fraud+payfail | Number | Usage (capped) | Var infra + network fee | **Contribution** | Support | Pool (Fortress £) |
|---|---|---|---|---|---|---|---|---|---|
| A Twilio today | 4.99 | 0.56 | 0.21 | 0.91 | 1.75 | 0.05 | **1.51** | 1.67 | 3.36 |
| B1 Magrathea + BYOC, Twilio SDK leg | 4.99 | 0.56 | 0.20 | 0.53 | 1.13 | 0.08 | **2.50** | 1.67 | 3.75 |
| B2 Magrathea + self-hosted delivery | 4.99 | 0.56 | 0.19 | 0.53 | 0.30 | 0.10 | **3.32** | 1.67 | 1.18 |
| C Twilio, pooled numbers (50 hh/number) | 4.99 | 0.56 | 0.21 | 0.02 | 1.91 | 0.05 | **2.25** | 1.67 | 4.34 |
| D on-device, no Twilio/no forwarding | 4.99 | 0.56 | 0.18 | 0.00 | 0.00 | 0.15 | **4.10** | 0.83 | 0.00 |
| E network-side screening (unknown only; generic £0.50 fee placeholder — AQL INCOMPLETE, rate card missing) | 4.99 | 0.56 | 0.20 | 0.91 | 0.87 | 0.55 | **1.90** | 1.25 | 2.81 |

### R3d. Headline grid — N=100 and N=1,000: contribution £ (CM%) | fully-loaded £ (FL%) | worst-case month £; break-even N (FL ≥ 0)
| Arch | Price | N=100 contribution | N=100 fully loaded | N=100 worst | N=1,000 contribution | N=1,000 fully loaded | N=1,000 worst | Break-even N |
|---|---|---|---|---|---|---|---|---|
| A | £5.99 | 151 (30.3%) | -90 (-18.1%) | -235 | 1,504 (30.1%) | -237 (-4.8%) | -1,682 | never |
| A | £7.99 | 273 (41.0%) | 31 (4.7%) | -227 | 2,710 (40.7%) | 968 (14.5%) | -1,612 | 71 |
| A | £8.99 | 334 (44.5%) | 92 (12.3%) | -223 | 3,312 (44.2%) | 1,571 (21.0%) | -1,577 | 45 |
| A | £9.99 | 395 (47.4%) | 153 (18.4%) | -219 | 3,915 (47.0%) | 2,173 (26.1%) | -1,542 | 33 |
| B1 | £5.99 | 250 (50.0%) | -192 (-38.5%) | -435 | 2,486 (49.8%) | 594 (11.9%) | -1,831 | 272 |
| B1 | £7.99 | 381 (57.2%) | -61 (-9.2%) | -427 | 3,787 (56.9%) | 1,895 (28.5%) | -1,761 | 124 |
| B1 | £8.99 | 450 (60.1%) | 9 (1.1%) | -423 | 4,477 (59.8%) | 2,585 (34.5%) | -1,726 | 98 |
| B1 | £9.99 | 520 (62.4%) | 78 (9.4%) | -419 | 5,167 (62.1%) | 3,275 (39.3%) | -1,691 | 81 |
| B2 | £5.99 | 332 (66.4%) | -210 (-42.1%) | -301 | 3,306 (66.2%) | 1,314 (26.3%) | 405 | 198 |
| B2 | £7.99 | 479 (72.0%) | -62 (-9.4%) | -153 | 4,773 (71.7%) | 2,781 (41.8%) | 1,873 | 118 |
| B2 | £8.99 | 553 (73.8%) | 11 (1.5%) | -79 | 5,506 (73.5%) | 3,515 (46.9%) | 2,606 | 98 |
| B2 | £9.99 | 627 (75.3%) | 85 (10.3%) | -6 | 6,240 (75.0%) | 4,248 (51.0%) | 3,340 | 84 |
| C | £5.99 | 225 (45.1%) | -17 (-3.4%) | -235 | 2,239 (44.9%) | 497 (10.0%) | -1,682 | 130 |
| C | £7.99 | 346 (52.0%) | 105 (15.7%) | -227 | 3,444 (51.7%) | 1,703 (25.6%) | -1,612 | 43 |
| C | £8.99 | 407 (54.4%) | 166 (22.1%) | -223 | 4,047 (54.0%) | 2,305 (30.8%) | -1,577 | 32 |
| C | £9.99 | 468 (56.2%) | 226 (27.2%) | -219 | 4,650 (55.9%) | 2,908 (34.9%) | -1,542 | 26 |
| D | £5.99 | 410 (82.2%) | 252 (50.5%) | 252 | 4,094 (82.0%) | 3,186 (63.8%) | 3,186 | 23 |
| D | £7.99 | 558 (83.8%) | 400 (60.0%) | 400 | 5,561 (83.5%) | 4,653 (69.9%) | 4,653 | 16 |
| D | £8.99 | 632 (84.4%) | 474 (63.2%) | 474 | 6,295 (84.0%) | 5,386 (71.9%) | 5,386 | 14 |
| D | £9.99 | 706 (84.8%) | 548 (65.8%) | 548 | 7,028 (84.4%) | 6,120 (73.5%) | 6,120 | 13 |
| E | £5.99 | 190 (38.1%) | -10 (-2.0%) | -192 | 1,892 (37.9%) | 567 (11.4%) | -1,260 | 115 |
| E | £7.99 | 326 (49.0%) | 126 (18.9%) | -184 | 3,240 (48.7%) | 1,915 (28.8%) | -1,190 | 38 |
| E | £8.99 | 396 (52.9%) | 196 (26.2%) | -155 | 3,936 (52.5%) | 2,611 (34.8%) | -901 | 28 |
| E | £9.99 | 470 (56.4%) | 270 (32.4%) | -81 | 4,669 (56.1%) | 3,344 (40.2%) | -167 | 22 |

## 3. The three decision options

| Option | What it involves | Effort |
|---|---|---|
| **1. Launch now** | A as is | None beyond the allowance profile and per-stage scaling of the global caps |
| **2. Short change** | C: forward all households to a small number pool; attribute each call from Twilio `ForwardedFrom` / SIP Diversion; per-household number fallback where a carrier omits it; refuse unattributable calls (`global_unattributed_cap`) | Days to 2 weeks. Attribution **UNPROVEN** (Diversion seen once, Lebara via Magrathea, 9 Oct) |
| **3a. Delay** | B2 build | Weeks, plus ongoing operations |
| **3b. Delay** | E partnership | Months; partner-dependent |

### R14. Decision options at £5.99 (monthly £; contribution / CM% / fully-loaded) and the price needed for 40%
| Option | Architecture | Engineering change | N | Net revenue | Variable cost | Contribution (CM%) | Fixed + support | Fully loaded (FL%) | Price for CM ≥ 40% | Price for FL ≥ 40% |
|---|---|---|---|---|---|---|---|---|---|---|
| 1. Launch now | A | none | 100 | 499 | 348 | 151 (30.3%) | 242 | -90 (-18.1%) | £7.75 | £15.40 |
| 1. Launch now | A | none | 1000 | 4,992 | 3,487 | 1,504 (30.1%) | 1,742 | -237 (-4.8%) | £7.82 | £13.62 |
| 2. Short change | C | number pooling + attribution | 100 | 499 | 274 | 225 (45.1%) | 242 | -17 (-3.4%) | £5.07 | £13.03 |
| 2. Short change | C | number pooling + attribution | 1000 | 4,992 | 2,753 | 2,239 (44.9%) | 1,742 | 497 (10.0%) | £5.09 | £11.21 |
| 3a. Delay (weeks) | B2 | self-hosted SIP delivery | 100 | 499 | 168 | 332 (66.4%) | 542 | -210 (-42.1%) | ≤ £3.00 | £16.11 |
| 3a. Delay (weeks) | B2 | self-hosted SIP delivery | 1000 | 4,992 | 1,686 | 3,306 (66.2%) | 1,992 | 1,314 (26.3%) | ≤ £3.00 | £7.70 |
| 3b. Delay (months) | E | network partner (AQL INCOMPLETE) | 100 | 499 | 309 | 190 (38.1%) | 200 | -10 (-2.0%) | £6.27 | £11.55 |
| 3b. Delay (months) | E | network partner (AQL INCOMPLETE) | 1000 | 4,992 | 3,100 | 1,892 (37.9%) | 1,325 | 567 (11.4%) | £6.30 | £9.96 |

## 4. Allowance design and hard caps

**How the pool is sized:**
- The pool is the Fortress total B + T + E.
- It is sized so that a customer who uses all of it, plus one lease overrun per pool, is break-even on the worst channel with the SDK leg billed at list.
- It is capped at max(1.2 × heavy, extreme).

**How the pool is split:**
- E = £0.10.
- B and T split 50/50 where trusted minutes cost money (1-S: trusted reserve drawn first, so an unknown-caller flood cannot drain it).
- Otherwise T = £0.20.

**Caveats:**
- **"Served" is a mean, so it overstates the experience.** WS2's Monte Carlo shows that a pool of about £3.4 under A pauses many typical households; ≥ 90% never-paused needs about £4.20, which is safe only on Stripe and today's billing. **At £5.99 under A, Play-safe break-even and a good typical experience are mutually exclusive.**
- **A maxed stolen-card customer** costs about −£22 to −£27 on every architecture. It is dominated by the £20 dispute fee.

### R6c. Allowance design, £5.99 and £7.99 (N=100; worst maxed customer on worst channel, SDK at list)
| Arch | Price | Pool F£ | B / T / E | Monitored min in B | Served typ / heavy / extreme | Worst maxed customer £ |
|---|---|---|---|---|---|---|
| A | £5.99 | 3.36 | 1.63 / 1.63 / 0.10 | 79 | 100.0% / 45.5% / 21.6% | 0.00 |
| A | £7.99 | 4.88 | 2.39 / 2.39 / 0.10 | 116 | 100.0% / 66.1% / 31.4% | 0.00 |
| B1 | £5.99 | 3.75 | 1.82 / 1.82 / 0.10 | 115 | 100.0% / 79.6% / 37.5% | 0.00 |
| B1 | £7.99 | 5.27 | 2.59 / 2.59 / 0.10 | 163 | 100.0% / 100.0% / 52.7% | 0.00 |
| B2 | £5.99 | 1.18 | 0.88 / 0.20 / 0.10 | 169 | 100.0% / 100.0% / 100.0% | 2.31 |
| B2 | £7.99 | 1.18 | 0.88 / 0.20 / 0.10 | 169 | 100.0% / 100.0% / 100.0% | 3.70 |
| C | £5.99 | 4.34 | 2.12 / 2.12 / 0.10 | 103 | 100.0% / 58.8% / 27.9% | 0.00 |
| C | £7.99 | 5.86 | 2.88 / 2.88 / 0.10 | 139 | 100.0% / 79.4% / 37.7% | 0.00 |
| E | £5.99 | 2.81 | 2.51 / 0.20 / 0.10 | 121 | 100.0% / 100.0% / 58.3% | 0.00 |
| E | £7.99 | 4.33 | 4.03 / 0.20 / 0.10 | 195 | 100.0% / 100.0% / 89.9% | 0.00 |

**Prepaid credit:**
- Credit is granted only after a settled payment, and is ≤ gross ÷ 1.2 × 0.60 (migration 077).
- A fully used top-up keeps 34–40%. A used-then-charged-back top-up loses about £22–£25.

### R10. Prepaid credit (top-up) bounds — Stripe, credit only after settled payment, credit ≤ gross ÷ 1.2 × 0.60 (077)
| Top-up gross | Net | Stripe fee | Max credit (Fortress £) | Max billed cost | Contribution if fully used | Loss if used then charged back |
|---|---|---|---|---|---|---|
| £2.99 | 2.49 | 0.28 | 1.50 | 1.36 | 0.85 (34.2%) | -21.64 |
| £4.99 | 4.16 | 0.33 | 2.50 | 2.27 | 1.56 (37.4%) | -22.60 |
| £9.99 | 8.33 | 0.47 | 5.00 | 4.54 | 3.31 (39.8%) | -25.01 |

**Global caps** (WS2 D-4):
- The £25 absolute daily cap applies only up to about 25 households; above that, use max(25, 0.60 × N).
- Worst-case cap max(£40, £0.50 × N); live calls max(20, ⌈N/5⌉).
- The breaker latches, so a day is bounded by the daily cap and a month by Σ pools.
- If every server dies, Twilio's `timeLimit` still bounds each household. On the seed profile that is about £0.85 (TWILIO-DURATION-EVIDENCE).

### R9. Global caps per stage (Fortress, WS2 D-4 scaling) vs sum of household pools (arch A, £5.99)
| N | Daily absolute cap max(25, 0.60N) | Global worst-case cap max(40, 0.50N) | Active calls max(20, ⌈N/5⌉) | Σ household pools, billed ceiling/month | Expected A billed usage/day |
|---|---|---|---|---|---|
| 10 | £25 | £40 | 20 | £32 | £0.58 |
| 25 | £25 | £40 | 20 | £80 | £1.46 |
| 50 | £30 | £40 | 20 | £159 | £2.91 |
| 100 | £60 | £50 | 20 | £318 | £5.82 |
| 250 | £150 | £125 | 50 | £795 | £14.56 |
| 500 | £300 | £250 | 100 | £1,590 | £29.11 |
| 1000 | £600 | £500 | 200 | £3,180 | £58.22 |

**Hard limit for each variable-cost path** (the enforcer is HCG unless stated):

| Path | Limit | Enforced by |
|---|---|---|
| Twilio inbound + SDK leg, BYOC | Fortress reservation; `<Dial timeLimit>`; £2/24 h hold; 7,200 s max call; global breaker | HCG. **Twilio has no spend cap** |
| Media Streams | 30-min monitoring cap; renewal refused stops the stream | HCG |
| Whisper | Monitoring lease | HCG, plus **OpenAI project hard limit** |
| SMS / Polly | Per-household caps; geo permissions | HCG; Twilio geo only |
| Number purchases | `global_number_purchase_cap`, provisioning guard | HCG |
| Magrathea | Free inbound; 10 channels/number; outbound barred or prepaid | **Magrathea** (channels, prepay). Its limits do not end live calls |
| Self-hosted SIP (B2) | Session timers, concurrency caps; fixed cost | HCG |
| Telnyx channels | Overflow returns busy | Telnyx (capacity, not spend) |
| Top-ups | ≤ 0.60 × net, settled payments only | HCG (DB 077) |
| Chargebacks | Not cappable; count × £20 | Stripe Radar |

## 5. Number pooling

Pooling cuts rental but never adds capacity:
- **Twilio:** about 20 numbers carry 1,000 households for £17/month instead of £869.
- **A single shared number:** £0.87, but no redundancy.
- **Magrathea:** a single number has 10 channels, so it **blocks 18% of busy-hour calls at 500 households and 51% at 1,000**. The £100 minimum dominates until about 200 numbers.
- **Telnyx channel billing:** about £36–£321/month for the same channels.

### R13. Number pooling — per-customer vs small pool vs one shared number (traffic via HCG under A/C = 280 min/hh/month, busy hour 12% of daily)
Pooling removes rental only; it adds no capacity. Busy-hour channels needed (Erlang B 1%) are the same in every column.
| N | Busy-hour Erl / channels needed | Twilio per-customer £/mo | Twilio pool ⌈N/50⌉ (min 2) £/mo | Twilio single number £/mo | Magrathea per-customer £/mo (≥£100 min) | Magrathea pool numbers (≥2, ⌈ch/10⌉) / £/mo | Magrathea single number: blocking at 10 ch | Telnyx channel billing £/mo (list $15→$10/ch) |
|---|---|---|---|---|---|---|---|---|
| 10 | 0.19 / 3 | 8.69 | 1.74 | 0.87 | 100.00 | 2 / 100.00 | 0.0% | 35.55 |
| 50 | 0.93 / 5 | 43.46 | 1.74 | 0.87 | 100.00 | 2 / 100.00 | 0.0% | 59.25 |
| 100 | 1.87 / 6 | 86.92 | 1.74 | 0.87 | 100.00 | 2 / 100.00 | 0.0% | 71.10 |
| 500 | 9.33 / 17 | 434.59 | 8.69 | 0.87 | 250.00 | 2 / 100.00 | 18.4% | 188.02 |
| 1000 | 18.67 / 29 | 869.17 | 17.38 | 0.87 | 500.00 | 3 / 100.00 | 50.9% | 320.74 |

## 6. Sensitivity and viability

### R7c. Sensitivity — contribution % at N=1,000, £5.99 / £7.99
| Scenario | A | B1 | B2 | C | D | E |
|---|---|---|---|---|---|---|
| Base | 30.1% / 40.7% | 49.8% / 56.9% | 66.2% / 71.7% | 44.9% / 51.7% | 82.0% / 83.5% | 37.9% / 48.7% |
| Usage ×2 | 23.5% / 28.6% | 38.4% / 46.8% | 62.3% / 68.7% | 32.1% / 35.1% | 82.0% / 83.5% | 27.5% / 38.8% |
| SDK leg billed at list | 18.1% / 30.3% | 34.8% / 44.0% | 66.2% / 71.7% | 31.6% / 40.4% | 82.0% / 83.5% | 34.4% / 45.7% |
| Apple 30% | 33.3% / 40.5% | 49.1% / 55.5% | 63.2% / 68.7% | 44.7% / 51.6% | 79.0% / 80.5% | 36.3% / 47.0% |
| WS2 mix 40/45/10/5 | 33.1% / 44.5% | 53.1% / 60.4% | 67.6% / 72.7% | 49.1% / 56.5% | 82.0% / 83.5% | 41.0% / 51.9% |
| All three adverse | 16.7% / 21.7% | 23.6% / 28.1% | 59.3% / 65.7% | 22.1% / 25.8% | 79.0% / 80.5% | 23.0% / 34.0% |

### R12. E: maximum per-subscriber network fee that still gives 40% contribution (N=1,000)
| Price | Max network fee £/sub/month |
|---|---|
| £5.99 | 0.38 |
| £7.99 | 1.13 |
| £8.99 | 1.50 |
| £9.99 | 1.87 |

Usage ×2 leaves the worst case unchanged, because the pool is fixed. Under Apple 30% the pool shrinks so that the worst channel stays break-even.

**Is £5.99 viable for each architecture?**

| Arch | Verdict |
|---|---|
| A | **No** for 40% (30%; 18% if the SDK leg is billed); bounded loss only |
| B1 | Marginal: 50%, but 35% if the SDK leg is billed; fully loaded positive from 272 customers |
| B2 | **Yes** on contribution (66%; 59% with all sensitivities adverse); fully loaded needs about 200 customers plus the build |
| C | Conditional: 45%, but 32% if the SDK leg is billed or usage doubles; attribution unproven |
| D | **Yes** (82%), but it is a different product |
| E | No / borderline (38%); fee ≤ £0.38; delay |

## 7. Unknowns

1. **Real usage.** M1 trusted minutes decide A and C.
2. **SDK-leg billing:** −12 points on A.
3. **Channel mix:** Apple SBP enrolment unknown; Play Billing not built.
4. **AQL rate card (missing)** and any partner fee.
5. **Magrathea:** whether rentals count toward the minimum; production contract.
6. **Twilio BYOC price.**
7. **Forwarded-call attribution by carrier.**
8. **Support minutes per customer.**
9. **Infrastructure invoices and HA cost.**
10. **Refund, chargeback, fraud and payment-failure rates.**
11. **Willingness to pay** at £7.99+, and for D.
12. **Revenue lost while delaying.**
