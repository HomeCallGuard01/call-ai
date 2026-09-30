# Subscription design model output

## Inputs

| Input | Value | Label | Note |
|---|---|---|---|
| vat | 0.20 | PUBLISHED | UK VAT on the VAT-inclusive price |
| shareIos | 0.45 | ASSUMPTION | Payment mix: Apple IAP |
| shareAndroid | 0.35 | ASSUMPTION | Payment mix: Google Play Billing (required for Android in-app) |
| shareWeb | 0.20 | ASSUMPTION | Payment mix: Stripe (web) |
| appleFee | 0.15 | PUBLISHED (not re-verified in this session) | Apple Small Business Program 15% of net — HCG enrolment UNCONFIRMED (30% otherwise) |
| googleFee | 0.15 | PUBLISHED (not re-verified in this session) | Google Play subscriptions 15% of net |
| stripePct | 0.02700 | PUBLISHED (not re-verified in this session) | Stripe UK 1.5% + Billing 0.7% + Tax 0.5% |
| stripeFixed | 0.20 | PUBLISHED (not re-verified in this session) | Stripe UK 20p per charge |
| refundRate | 0.02000 | ASSUMPTION | Share of gross revenue refunded (store + Stripe) |
| chargebackRate | 0.00300 | ASSUMPTION | Stripe subscriptions disputed per month |
| disputeFee | 20.00 | ASSUMPTION | Stripe UK dispute fee £ (believed £20; verify) |
| sipNumber | 2.00 | PUBLISHED | sipflex.co.uk £2/number/month retail (wholesale range-holder price QUOTE) |
| numberOverhead | 0.05000 | ASSUMPTION | Extra numbers held in quarantine/lifecycle per active household |
| sipInbound | 0.00000 | PUBLISHED | Free inbound at retail (sipflex, sipgate) — at-volume terms QUOTE |
| sipChannel | 1.00 | PUBLISHED | sipflex.co.uk £1/concurrent channel/month |
| channelHeadroom | 1.30 | ASSUMPTION | Channels = Erlang-B(1% blocking) × 1.3 |
| twByoc | 0.00316 | PUBLISHED | Twilio BYOC $0.0040/min (twilio.com/…/pricing/gb); HCG not yet billed; increment QUOTE |
| twSdk | 0.00316 | PUBLISHED | Twilio Voice SDK $0.0040/min list — HCG billed £0 to date (INVOICE); for BYOC calls QUOTE → design uses LIST |
| twStream | 0.00348 | PUBLISHED | Twilio Media Streams $0.0044/min list (HCG billed £0.00333) |
| twPolly | 0.00060 | CONFIRMED HCG INVOICE | Greeting per unknown call |
| twSms | 0.04233 | CONFIRMED HCG INVOICE | SMS segment (warning SMS) |
| roundUp | 0.55 | ASSUMPTION | Extra started minute per call on per-minute Twilio legs |
| transcription | 0.00474 | PUBLISHED | OpenAI whisper-1 $0.006/min |
| railway | 50.00 | ASSUMPTION | Railway compute ≤1k subs; +£20 per extra 1k |
| supabase | 29.75 | PUBLISHED (not re-verified in this session) | Supabase Pro $25 + compute add-on (ASM £10) |
| email | 16.00 | ASSUMPTION | Transactional email (Resend or similar) |
| appleDev | 6.52 | PUBLISHED (not re-verified in this session) | Apple Developer Program $99/yr |
| monitoring | 30.00 | ASSUMPTION | Error monitoring, uptime, logs, domain/DNS |
| tokenService | 10.00 | ASSUMPTION | Isolated Voice-token minting service (credential isolation) |
| insurance | 100.00 | ASSUMPTION | Cyber + tech PI premium (broker quote required before scale) |
| supportPerSub | 0.30 | ASSUMPTION | Ongoing: ~6% of subs contact per month × £5 handling |
| onboardingPerSub | 0.13 | ASSUMPTION | Forwarding set-up help: 30% of new subs × 15 min × £20/h, over a 12-month life |
| fraudReserve | 0.10 | ASSUMPTION | Expected abuse cost within the hard bounds |

## Revenue waterfall per subscriber per month

| Price | VAT | Net | Store fees | Stripe fees | Refunds | Disputes | Net after payment |
|---|---|---|---|---|---|---|---|
| £5.99 | £1.00 | £4.99 | £0.60 | £0.07 | £0.10 | £0.01 | **£4.21** |
| £6.99 | £1.17 | £5.83 | £0.70 | £0.08 | £0.12 | £0.01 | **£4.92** |
| £7.99 | £1.33 | £6.66 | £0.80 | £0.08 | £0.13 | £0.01 | **£5.63** |
| £9.99 | £1.66 | £8.33 | £1.00 | £0.09 | £0.17 | £0.01 | **£7.05** |

## Cost stack per subscriber (1000 subscribers)

| Mix | Avg min | Trusted | Unknown transport | AI + streams | SMS | Numbers | Channels | Platform | Support | Fraud | Total | Channels needed |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Normal (central) | 240 | £1.46 | £0.31 | £0.32 | £0.05 | £2.10 | £0.03 | £0.24 | £0.42 | £0.10 | **£5.05** | 29 |
| High legitimate (heavy) | 346 | £2.09 | £0.47 | £0.48 | £0.07 | £2.10 | £0.04 | £0.24 | £0.42 | £0.10 | **£6.01** | 38 |
| High legitimate (stress) | 471 | £2.80 | £0.67 | £0.69 | £0.09 | £2.10 | £0.05 | £0.24 | £0.42 | £0.10 | **£7.17** | 49 |

## Contribution margin by price, usage mix and scale

### 500 subscribers

| Mix | £5.99 | £6.99 | £7.99 | £9.99 |
|---|---|---|---|---|
| Normal (central) | -22% (−£1.09) | -7% (−£0.38) | 5% (£0.33) | 21% (£1.75) |
| High legitimate (heavy) | -41% (−£2.05) | -23% (−£1.34) | -9% (−£0.63) | 9% (£0.79) |
| High legitimate (stress) | -64% (−£3.21) | -43% (−£2.50) | -27% (−£1.79) | -4% (−£0.37) |

### 1000 subscribers

| Mix | £5.99 | £6.99 | £7.99 | £9.99 |
|---|---|---|---|---|
| Normal (central) | -17% (−£0.84) | -2% (−£0.13) | 9% (£0.58) | 24% (£2.01) |
| High legitimate (heavy) | -36% (−£1.80) | -19% (−£1.09) | -6% (−£0.38) | 12% (£1.04) |
| High legitimate (stress) | -59% (−£2.96) | -39% (−£2.25) | -23% (−£1.54) | -1% (−£0.12) |

### 2500 subscribers

| Mix | £5.99 | £6.99 | £7.99 | £9.99 |
|---|---|---|---|---|
| Normal (central) | -14% (−£0.70) | 0% (£0.01) | 11% (£0.72) | 26% (£2.14) |
| High legitimate (heavy) | -33% (−£1.67) | -16% (−£0.95) | -4% (−£0.24) | 14% (£1.18) |
| High legitimate (stress) | -57% (−£2.82) | -36% (−£2.11) | -21% (−£1.40) | 0% (£0.02) |

### 5000 subscribers

| Mix | £5.99 | £6.99 | £7.99 | £9.99 |
|---|---|---|---|---|
| Normal (central) | -13% (−£0.65) | 1% (£0.06) | 12% (£0.77) | 26% (£2.19) |
| High legitimate (heavy) | -32% (−£1.62) | -16% (−£0.91) | -3% (−£0.20) | 15% (£1.23) |
| High legitimate (stress) | -56% (−£2.77) | -35% (−£2.06) | -20% (−£1.35) | 1% (£0.07) |

## Break-even usage (1,000 subscribers; the normal mix scaled up or down)

Average forwarded minutes per subscriber per month at which the margin falls to 40% and to 0%. Monitored share and call lengths are held at the normal mix.

| Price | Avg min @ 40% margin | Avg min @ break-even (0%) | Normal mix today |
|---|---|---|---|
| £5.99 | never reaches 40% | 145 min | 240 min |
| £6.99 | never reaches 40% | 226 min | 240 min |
| £7.99 | 5 min | 306 min | 240 min |
| £9.99 | 91 min | 467 min | 240 min |

## Exactly where each price crosses 40% (normal mix, 1,000 subs, conservative base; one driver moved at a time)

| Driver (base) | £5.99 (base -17%) | £6.99 (base -2%) | £7.99 (base 9%) | £9.99 (base 24%) |
|---|---|---|---|---|
| Avg forwarded minutes / sub | cannot reach 40% (in range) | cannot reach 40% (in range) | cannot reach 40% (in range) | reaches 40% only if ≤ 91 min |
| Subscribers (fixed-cost dilution) | cannot reach 40% (in range) | cannot reach 40% (in range) | cannot reach 40% (in range) | cannot reach 40% (in range) |
| Number rental £/month | cannot reach 40% (in range) | cannot reach 40% (in range) | reaches 40% only if ≤ £0.02 | reaches 40% only if ≤ £0.74 |
| Twilio connected £/min (BYOC + SDK) | cannot reach 40% (in range) | cannot reach 40% (in range) | cannot reach 40% (in range) | reaches 40% only if ≤ £0.0016/min |
| Transcription price multiple | cannot reach 40% (in range) | cannot reach 40% (in range) | cannot reach 40% (in range) | cannot reach 40% (in range) |
| Apple commission | cannot reach 40% (in range) | cannot reach 40% (in range) | cannot reach 40% (in range) | cannot reach 40% (in range) |
| Refund rate | cannot reach 40% (in range) | cannot reach 40% (in range) | cannot reach 40% (in range) | cannot reach 40% (in range) |
| Support £/sub/month | cannot reach 40% (in range) | cannot reach 40% (in range) | cannot reach 40% (in range) | cannot reach 40% (in range) |
| Insurance £/month | cannot reach 40% (in range) | cannot reach 40% (in range) | cannot reach 40% (in range) | cannot reach 40% (in range) |

## Stress checks at the base scale (1,000 subs)

### Normal (central)

| Scenario | £5.99 | £6.99 | £7.99 | £9.99 |
|---|---|---|---|---|
| Base | -17% | -2% | 9% | 24% |
| Apple SBP not granted (30%) | -24% | -9% | 2% | 17% |
| Twilio bills the SDK leg AND SIP interface on BYOC calls | -35% | -17% | -5% | 13% |
| SDK leg stays £0 (as billed today) | 1% | 13% | 22% | 35% |
| Wholesale numbers at £1.00 (QUOTE) | 4% | 16% | 25% | 37% |
| Refunds 5% | -20% | -5% | 6% | 21% |
| Support 2× (£0.60) | -23% | -7% | 4% | 20% |

### High legitimate (heavy)

| Scenario | £5.99 | £6.99 | £7.99 | £9.99 |
|---|---|---|---|---|
| Base | -36% | -19% | -6% | 12% |
| Apple SBP not granted (30%) | -43% | -26% | -12% | 6% |
| Twilio bills the SDK leg AND SIP interface on BYOC calls | -62% | -41% | -25% | -3% |
| SDK leg stays £0 (as billed today) | -11% | 3% | 13% | 28% |
| Wholesale numbers at £1.00 (QUOTE) | -15% | -1% | 10% | 25% |
| Refunds 5% | -39% | -22% | -9% | 9% |
| Support 2× (£0.60) | -42% | -24% | -10% | 9% |

### High legitimate (stress)

| Scenario | £5.99 | £6.99 | £7.99 | £9.99 |
|---|---|---|---|---|
| Base | -59% | -39% | -23% | -1% |
| Apple SBP not granted (30%) | -66% | -45% | -30% | -8% |
| Twilio bills the SDK leg AND SIP interface on BYOC calls | -94% | -68% | -49% | -22% |
| SDK leg stays £0 (as billed today) | -25% | -9% | 3% | 19% |
| Wholesale numbers at £1.00 (QUOTE) | -38% | -21% | -7% | 11% |
| Refunds 5% | -62% | -42% | -26% | -4% |
| Support 2× (£0.60) | -65% | -44% | -28% | -5% |

## Scenario grid (1,000 subscribers): normal ≥40% · heavy ≥0% · stress ≥0%

Each cell shows normal / heavy / stress margin. ✔ = all three conditions met. Numbers £2.00 = published retail (Sipflex); £1.00 / £0.50 = wholesale sensitivity points, **not prices** (QUOTE).

| Scenario | £5.99 | £6.99 | £7.99 | £9.99 | Lowest compliant price |
|---|---|---|---|---|---|
| SDK leg at list (conservative); numbers £2.00; Apple 15% | -17% / -36% / -59% | -2% / -19% / -39% | 9% / -6% / -23% | 24% / 12% / -1% | none ≤ £9.99 |
| SDK leg at list (conservative); numbers £2.00; Apple 30% | -24% / -43% / -66% | -9% / -26% / -45% | 2% / -12% / -30% | 17% / 6% / -8% | none ≤ £9.99 |
| SDK leg at list (conservative); numbers £1.00; Apple 15% | 4% / -15% / -38% | 16% / -1% / -21% | 25% / 10% / -7% | 37% / 25% / 11% | none ≤ £9.99 |
| SDK leg at list (conservative); numbers £1.00; Apple 30% | -3% / -22% / -45% | 9% / -7% / -27% | 18% / 3% / -14% | 30% / 18% / 4% | none ≤ £9.99 |
| SDK leg at list (conservative); numbers £0.50; Apple 15% | 15% / -5% / -28% | 25% / 8% / -12% | 32% / 18% / 1% | 43% / 31% / 18% ✔ | £9.99 |
| SDK leg at list (conservative); numbers £0.50; Apple 30% | 8% / -11% / -35% | 18% / 2% / -18% | 26% / 11% / -6% | 36% / 25% / 11% | none ≤ £9.99 |
| SDK leg £0 (as invoiced today); numbers £2.00; Apple 15% | 1% / -11% / -25% | 13% / 3% / -9% | 22% / 13% / 3% | 35% / 28% / 19% | none ≤ £9.99 |
| SDK leg £0 (as invoiced today); numbers £2.00; Apple 30% | -6% / -17% / -32% | 6% / -4% / -16% | 15% / 7% / -4% | 28% / 21% / 13% | none ≤ £9.99 |
| SDK leg £0 (as invoiced today); numbers £1.00; Apple 15% | 22% / 10% / -4% | 31% / 21% / 9% | 38% / 29% / 19% | 47% / 40% / 32% ✔ | £9.99 |
| SDK leg £0 (as invoiced today); numbers £1.00; Apple 30% | 15% / 4% / -11% | 24% / 14% / 2% | 31% / 22% / 12% | 41% / 34% / 25% ✔ | £9.99 |
| SDK leg £0 (as invoiced today); numbers £0.50; Apple 15% | 32% / 21% / 7% | 40% / 30% / 18% ✔ | 46% / 37% / 26% ✔ | 54% / 47% / 38% ✔ | £6.99 |
| SDK leg £0 (as invoiced today); numbers £0.50; Apple 30% | 26% / 14% / 0% | 33% / 23% / 11% | 39% / 30% / 20% | 47% / 40% / 31% ✔ | £9.99 |

## Per-price detail under the best-evidenced plausible case (SDK £0 as invoiced; numbers £1.00 wholesale — QUOTE; Apple 15%)

| Price | Contribution £/sub (normal) | Margin normal | Margin heavy | Margin stress | Break-even avg min | Margin < 40% above avg min |
|---|---|---|---|---|---|---|
| £5.99 | £1.10 | 22% | 10% | -4% | 453 | 66 |
| £6.99 | £1.81 | 31% | 21% | 9% | 590 | 139 |
| £7.99 | £2.52 | 38% | 29% | 19% | 729 | 212 |
| £9.99 | £3.94 | 47% | 40% | 32% | 1005 | 359 |

Normal mix today: 240 avg forwarded min/sub/month (ASSUMPTION; Ofcom 146 outgoing min anchor).

## Individual households: loss per household and its hard bound (no averaging)

| Case | Household | Minutes | Cost/month | contribution @ £5.99 | contribution @ £6.99 | contribution @ £7.99 | contribution @ £9.99 |
|---|---|---|---|---|---|---|---|
| Conservative (SDK list, £2 numbers) | normal | 175 min | £4.44 | −£0.23 | £0.48 | £1.19 | £2.61 |
| Conservative (SDK list, £2 numbers) | high | 510 min | £7.22 | −£3.01 | −£2.30 | −£1.59 | −£0.17 |
| Conservative (SDK list, £2 numbers) | extreme | 1500 min | £16.56 | −£12.35 | −£11.64 | −£10.93 | −£9.51 |
| Conservative (SDK list, £2 numbers) | targeted | 270 min | £6.33 | −£2.12 | −£1.41 | −£0.70 | £0.73 |
| Best-evidenced (SDK £0, £1 numbers) | normal | 175 min | £2.74 | £1.46 | £2.18 | £2.89 | £4.31 |
| Best-evidenced (SDK £0, £1 numbers) | high | 510 min | £4.31 | −£0.11 | £0.61 | £1.32 | £2.74 |
| Best-evidenced (SDK £0, £1 numbers) | extreme | 1500 min | £10.08 | −£5.87 | −£5.16 | −£4.45 | −£3.02 |
| Best-evidenced (SDK £0, £1 numbers) | targeted | 270 min | £4.21 | £0.00 | £0.71 | £1.42 | £2.85 |

**Hard per-household bound (external):** the carrier's per-DID channel cap (QUOTE) × every minute of the month × the Twilio connected rate. At 1 channel: £273.02/month; at 2 channels: £546.05/month (conservative rates). This is the most any single household, loop or attacker on one number can cost HCG in transport, whatever HCG's code does. Tighter bounds (e.g. £10/day) exist only in HCG's own code, so they are not external.

## Hard, externally enforced maximum loss (Option B with containment)

Every term is a **provider-side** bound that HCG's own compromised code or credentials cannot raise. Each is **PROVIDER CONFIRMATION REQUIRED**.

### 1000 subscribers

| Bound | Mechanism (provider-enforced) | £ |
|---|---|---|
| Twilio (dedicated delivery account) | Prepaid float = 14 days of normal spend, **auto-recharge OFF**; account holds no numbers; outbound voice + international SMS disabled and **locked against API change** (Twilio must confirm) | £916.76 |
| Twilio in-flight overrun at suspension | Calls in progress complete: ≤ carrier channels (29) × 240 min (Twilio max call length) × worst leg rate | £123.16 |
| OpenAI | Prepaid credit = 14 days, auto-recharge OFF (budgets are soft) | £87.24 |
| SIP carrier | Inbound-only trunk (outbound barred at carrier), IP-auth, account channel cap, per-DID cap, prepaid/credit limit ≈ 1 week of rental + channels | £554.00 |
| Railway / Supabase | Railway hard limit; Supabase spend cap on | £190.00 |
| **Maximum loss per incident** | Sum; replenishment only by a human after review | **£1871.17** |

= 38% of one month's net revenue at £6.99. When a float is exhausted, service stops for all customers until a human tops it up (the forwarding deficiency). Floats must be sized against that outage risk, not only the loss.

### 5000 subscribers

| Bound | Mechanism (provider-enforced) | £ |
|---|---|---|
| Twilio (dedicated delivery account) | Prepaid float = 14 days of normal spend, **auto-recharge OFF**; account holds no numbers; outbound voice + international SMS disabled and **locked against API change** (Twilio must confirm) | £4583.80 |
| Twilio in-flight overrun at suspension | Calls in progress complete: ≤ carrier channels (107) × 240 min (Twilio max call length) × worst leg rate | £454.43 |
| OpenAI | Prepaid credit = 14 days, auto-recharge OFF (budgets are soft) | £436.21 |
| SIP carrier | Inbound-only trunk (outbound barred at carrier), IP-auth, account channel cap, per-DID cap, prepaid/credit limit ≈ 1 week of rental + channels | £2732.00 |
| Railway / Supabase | Railway hard limit; Supabase spend cap on | £350.00 |
| **Maximum loss per incident** | Sum; replenishment only by a human after review | **£8556.44** |

= 35% of one month's net revenue at £6.99. When a float is exhausted, service stops for all customers until a human tops it up (the forwarding deficiency). Floats must be sized against that outage risk, not only the loss.

## Cheapest price meeting all three conditions (1,000 subscribers)

| Price | Normal ≥ 40% | Heavy ≥ 0% | Stress ≥ 0% | Normal ≥ 40% if Apple 30% | Normal ≥ 40% if SDK + SIP charged | All pass (base) |
|---|---|---|---|---|---|---|
| £5.99 | ✗ -17% | ✗ -36% | ✗ -59% | ✗ -24% | ✗ -35% | no |
| £6.99 | ✗ -2% | ✗ -19% | ✗ -39% | ✗ -9% | ✗ -17% | no |
| £7.99 | ✗ 9% | ✗ -6% | ✗ -23% | ✗ 2% | ✗ -5% | no |
| £9.99 | ✗ 24% | ✓ 12% | ✗ -1% | ✗ 17% | ✗ 13% | no |

