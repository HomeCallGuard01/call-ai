# HCG portfolio economics — model output

Generated 2026-09-30 by `research/viability/portfolio-model.js`. Research only; no price chosen.

## Inputs and labels

| Input | Value | Label | Source |
|---|---|---|---|
| fxUsdToGbp | 0.79 | ASSUMPTION | Conservative USD→GBP (a weaker £ raises USD-priced costs) |
| vatRate | 0.2 | PUBLISHED | UK standard VAT |
| storeFeeOfNet | 0.15 | PUBLISHED | Apple Small Business Program / Google Play subscriptions 15% (Apple SBP enrolment UNCONFIRMED — 30% if not) |
| stripePct | 0.027 | PUBLISHED | Stripe UK 1.5% + Billing 0.7% + Tax 0.5% (from 2026-09 research; not re-verified tonight) |
| stripeFixed | 0.2 | PUBLISHED | Stripe UK 20p per charge |
| storeShare | 0.7 | ASSUMPTION | Share of subscribers paying via App Store / Google Play (Play Billing needed on Android) |
| twNumber | 0.86917 | CONFIRMED | Twilio Pricing API + 45 billed number-months |
| twInbound | 0.007558 | CONFIRMED | Twilio Pricing API; per started minute; billable for the whole connected call incl. <Dial><Client> (Twilio Support) |
| twAppLeg | 0 | CONFIRMED | £0 billed on HCG account to date (list $0.004/min — risk) |
| twStream | 0.003329 | CONFIRMED | Twilio billed usage: Media Streams |
| twGreeting | 0.0006 | CONFIRMED | Twilio billed usage: Polly |
| twSms | 0.042325 | CONFIRMED | Twilio Pricing API: SMS segment |
| twByocUsd | 0.004 | PUBLISHED | https://www.twilio.com/en-us/changelog/bring-your-own-carrier-trunking-origination-price-reduced |
| transcriptionUsd | 0.006 | PUBLISHED | OpenAI whisper-1 list $0.006/min (HCG cannot read its own OpenAI costs) |
| plNumberUsd | 0.85 | PUBLISHED | https://www.plivo.com/voice/pricing/gb/ |
| plInboundUsd | 0.0055 | PUBLISHED | https://www.plivo.com/voice/pricing/gb/ |
| plSdkUsd | 0.0033 | PUBLISHED | https://www.plivo.com/voice/pricing/gb/ (SDK leg charged in addition) |
| sipNumber | 2 | PUBLISHED | https://www.sipflex.co.uk/ (£2/number/month; wholesale range holders likely lower — QUOTE) |
| sipInbound | 0 | PUBLISHED | sipflex / sipgate trunking: inbound calls free (range holder receives the 0.0377p FTR) |
| sipChannel | 1 | PUBLISHED | https://www.sipflex.co.uk/ £1 per additional concurrent channel/month |
| selfHostInfraPer1k | 400 | ASSUMPTION | Self-hosted SBC/media/TURN/push infra £/month per 1,000 subs (servers+bandwidth, excl. staff) |
| roundUpPerCall | 0.55 | ASSUMPTION | Extra started minute per call under 60/60 billing (observed call lengths) |
| busyHourShare | 0.1 | ASSUMPTION | Share of a day's traffic in the busy hour (for channel sizing) |
| abnormalReserve | 0.1 | ASSUMPTION | Expected abnormal-event cost per subscriber per month (floods/loops, bounded by Layer B) |
| networkBypassFee | — | QUOTE | MNO/MVNE per-subscriber fee for network-side trusted routing — NOT PUBLISHED; model solves for the maximum payable |

## Usage segments (per subscriber per month, ASSUMPTION)

Anchor: Ofcom CMR 2026 says average outgoing mobile minutes were 146/month in 2025 (164 post-pay). Incoming is assumed ≈ outgoing at portfolio level. **HCG has no measured distribution yet**: 0 genuine paying customers as of 2026-09-27.

| Segment | Trusted min | Unknown min | Trusted calls | Unknown calls | Warning SMS |
|---|---|---|---|---|---|
| Low | 40 | 8 | 15 | 4 | 0 |
| Normal | 150 | 25 | 45 | 10 | 1 |
| High | 450 | 60 | 120 | 20 | 2 |
| Extreme | 1200 | 300 | 300 | 100 | 4 |
| Targeted by scammers | 150 | 120 | 45 | 80 | 6 |

| Mix (1,000 subs) | Low | Normal | High | Extreme | Targeted | Avg min/sub |
|---|---|---|---|---|---|---|
| Light-use base | 50% | 38% | 8% | 2% | 2% | 167 |
| Central | 33% | 44% | 15% | 4% | 4% | 240 |
| Heavy / older, chatty base | 20% | 40% | 25% | 8% | 7% | 346 |
| Stress (adverse selection) | 10% | 35% | 30% | 15% | 10% | 471 |

## 1. Tolerable average telecom + AI cost per subscriber (A+B+C+D+F)

Revenue after VAT and the blended payment fee (70% store at 15%, rest Stripe). A portfolio is viable at a margin if its average cost per subscriber is at or below the figure.

| Price | Net ex-VAT | Blended fee | After fees | 30% margin | 40% margin | 50% margin | 60% margin |
|---|---|---|---|---|---|---|---|
| £4.99 | £4.16 | £0.54 | £3.62 | £2.37 | £1.96 | £1.54 | £1.13 |
| £5.99 | £4.99 | £0.63 | £4.36 | £2.86 | £2.36 | £1.86 | £1.36 |
| £6.99 | £5.83 | £0.73 | £5.10 | £3.35 | £2.77 | £2.18 | £1.60 |
| £7.99 | £6.66 | £0.82 | £5.83 | £3.84 | £3.17 | £2.51 | £1.84 |
| £9.99 | £8.33 | £1.02 | £7.31 | £4.81 | £3.98 | £3.15 | £2.31 |

## 2. Average cost per subscriber by architecture and mix (1,000 subscribers)

A = trusted transport, B = unknown-call transport (+ greeting, SMS), C = fixed per subscriber (number, channels, infra), D = AI + streaming, F = abnormal reserve. E (VAT/fees) is in §1.

### Light-use base

| Architecture | A trusted | B unknown | C fixed | D AI/stream | F abnormal | Total | margin @ £4.99 | margin @ £5.99 | margin @ £6.99 | margin @ £7.99 | margin @ £9.99 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| A1 Twilio today (all legs on Twilio) | £1.23 | £0.29 | £0.87 | £0.22 | £0.10 | **£2.70** | 22% | 33% | 41% | 47% | 55% |
| A1b Twilio if the app leg is billed at list | £1.74 | £0.39 | £0.87 | £0.22 | £0.10 | **£3.32** | 7% | 21% | 31% | 38% | 48% |
| A2 Plivo (published) | £1.13 | £0.27 | £0.67 | £0.13 | £0.10 | **£2.29** | 32% | 41% | 48% | 53% | 60% |
| A3 UK free-inbound SIP numbers → Twilio BYOC → existing Voice SDK | £0.51 | £0.14 | £2.02 | £0.22 | £0.10 | **£2.99** | 15% | 27% | 36% | 43% | 52% |
| A4 UK free-inbound SIP numbers → HCG-hosted SIP/WebRTC + VoIP push (iOS PushKit/CallKit, Android FCM) | £0.00 | £0.03 | £2.42 | £0.13 | £0.10 | **£2.68** | 23% | 34% | 42% | 47% | 56% |

### Central

| Architecture | A trusted | B unknown | C fixed | D AI/stream | F abnormal | Total | margin @ £4.99 | margin @ £5.99 | margin @ £6.99 | margin @ £7.99 | margin @ £9.99 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| A1 Twilio today (all legs on Twilio) | £1.75 | £0.42 | £0.87 | £0.32 | £0.10 | **£3.46** | 4% | 18% | 28% | 36% | 46% |
| A1b Twilio if the app leg is billed at list | £2.48 | £0.57 | £0.87 | £0.32 | £0.10 | **£4.35** | -17% | 0% | 13% | 22% | 36% |
| A2 Plivo (published) | £1.61 | £0.39 | £0.67 | £0.19 | £0.10 | **£2.96** | 16% | 28% | 37% | 43% | 52% |
| A3 UK free-inbound SIP numbers → Twilio BYOC → existing Voice SDK | £0.73 | £0.21 | £2.02 | £0.32 | £0.10 | **£3.38** | 6% | 20% | 29% | 37% | 47% |
| A4 UK free-inbound SIP numbers → HCG-hosted SIP/WebRTC + VoIP push (iOS PushKit/CallKit, Android FCM) | £0.00 | £0.05 | £2.42 | £0.19 | £0.10 | **£2.76** | 21% | 32% | 40% | 46% | 55% |

### Heavy / older, chatty base

| Architecture | A trusted | B unknown | C fixed | D AI/stream | F abnormal | Total | margin @ £4.99 | margin @ £5.99 | margin @ £6.99 | margin @ £7.99 | margin @ £9.99 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| A1 Twilio today (all legs on Twilio) | £2.49 | £0.63 | £0.87 | £0.48 | £0.10 | **£4.57** | -23% | -4% | 9% | 19% | 33% |
| A1b Twilio if the app leg is billed at list | £3.54 | £0.85 | £0.87 | £0.48 | £0.10 | **£5.84** | -53% | -30% | -13% | 0% | 18% |
| A2 Plivo (published) | £2.29 | £0.58 | £0.67 | £0.28 | £0.10 | **£3.93** | -7% | 9% | 20% | 29% | 41% |
| A3 UK free-inbound SIP numbers → Twilio BYOC → existing Voice SDK | £1.04 | £0.31 | £2.03 | £0.48 | £0.10 | **£3.96** | -8% | 8% | 20% | 28% | 40% |
| A4 UK free-inbound SIP numbers → HCG-hosted SIP/WebRTC + VoIP push (iOS PushKit/CallKit, Android FCM) | £0.00 | £0.07 | £2.43 | £0.28 | £0.10 | **£2.88** | 18% | 30% | 38% | 44% | 53% |

### Stress (adverse selection)

| Architecture | A trusted | B unknown | C fixed | D AI/stream | F abnormal | Total | margin @ £4.99 | margin @ £5.99 | margin @ £6.99 | margin @ £7.99 | margin @ £9.99 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| A1 Twilio today (all legs on Twilio) | £3.35 | £0.89 | £0.87 | £0.68 | £0.10 | **£5.89** | -54% | -31% | -14% | -1% | 17% |
| A1b Twilio if the app leg is billed at list | £4.75 | £1.21 | £0.87 | £0.68 | £0.10 | **£7.61** | -96% | -65% | -43% | -27% | -4% |
| A2 Plivo (published) | £3.08 | £0.82 | £0.67 | £0.40 | £0.10 | **£5.08** | -35% | -14% | 0% | 11% | 27% |
| A3 UK free-inbound SIP numbers → Twilio BYOC → existing Voice SDK | £1.40 | £0.44 | £2.04 | £0.68 | £0.10 | **£4.65** | -25% | -6% | 8% | 18% | 32% |
| A4 UK free-inbound SIP numbers → HCG-hosted SIP/WebRTC + VoIP push (iOS PushKit/CallKit, Android FCM) | £0.00 | £0.10 | £2.44 | £0.40 | £0.10 | **£3.04** | 14% | 27% | 35% | 42% | 51% |

## 3. Network-side trusted routing: the maximum per-subscriber fee HCG could pay a carrier/MVNE

A5 removes trusted transport (A) from HCG entirely; HCG carries only unknown calls. The carrier fee is **PROVIDER QUOTE REQUIRED**, so the model gives the most HCG could pay per subscriber per month and still hit each margin (central mix).

| Price | max fee @ 30% | max fee @ 40% | max fee @ 50% | max fee @ 60% |
|---|---|---|---|---|
| £4.99 | £1.64 | £1.22 | £0.80 | £0.39 |
| £5.99 | £2.12 | £1.62 | £1.12 | £0.63 |
| £6.99 | £2.61 | £2.03 | £1.45 | £0.86 |
| £7.99 | £3.10 | £2.43 | £1.77 | £1.10 |
| £9.99 | £4.07 | £3.24 | £2.41 | £1.58 |

HCG-side cost with A5 (central mix): £0.74 per subscriber (B £0.05, C £0.40, D £0.19, F £0.10).

## 4. Break-even: average TRUSTED minutes per subscriber a portfolio can carry at 40% margin

Holding the central mix's unknown/monitored usage and fixed costs constant and solving for average trusted minutes.

| Architecture | £4.99 | £5.99 | £6.99 | £7.99 | £9.99 |
|---|---|---|---|---|---|
| A1 Twilio today (all legs on Twilio) | 28 | 74 | 119 | 165 | 257 |
| A1b Twilio if the app leg is billed at list | 7 | 40 | 72 | 104 | 169 |
| A2 Plivo (published) | 74 | 124 | 174 | 224 | 324 |
| A3 UK free-inbound SIP numbers → Twilio BYOC → existing Voice SDK | — | — | 31 | 141 | 360 |
| A4 UK free-inbound SIP numbers → HCG-hosted SIP/WebRTC + VoIP push (iOS PushKit/CallKit, Android FCM) | unbounded | unbounded | unbounded | unbounded | unbounded |

Channel sizing (Erlang B, 1% blocking, central mix, 1,000 subscribers): 22 concurrent SIP channels.

## 5. 1,000-subscriber portfolio P&L (monthly contribution, £)

### A1 Twilio today (all legs on Twilio)

| Mix | £4.99 | £5.99 | £6.99 | £7.99 | £9.99 |
|---|---|---|---|---|---|
| Light-use base | £922.26 | £1660.00 | £2397.73 | £3135.46 | £4610.93 |
| Central | £159.85 | £897.58 | £1635.31 | £2373.05 | £3848.51 |
| Heavy / older, chatty base | −£944.61 | −£206.87 | £530.86 | £1268.59 | £2744.06 |
| Stress (adverse selection) | −£2264.93 | −£1527.20 | −£789.47 | −£51.73 | £1423.73 |

### A3 UK free-inbound SIP numbers → Twilio BYOC → existing Voice SDK

| Mix | £4.99 | £5.99 | £6.99 | £7.99 | £9.99 |
|---|---|---|---|---|---|
| Light-use base | £633.60 | £1371.34 | £2109.07 | £2846.80 | £4322.27 |
| Central | £238.45 | £976.18 | £1713.92 | £2451.65 | £3927.12 |
| Heavy / older, chatty base | −£337.09 | £400.64 | £1138.38 | £1876.11 | £3351.58 |
| Stress (adverse selection) | −£1032.96 | −£295.23 | £442.51 | £1180.24 | £2655.71 |

### A4 UK free-inbound SIP numbers → HCG-hosted SIP/WebRTC + VoIP push (iOS PushKit/CallKit, Android FCM)

| Mix | £4.99 | £5.99 | £6.99 | £7.99 | £9.99 |
|---|---|---|---|---|---|
| Light-use base | £944.21 | £1681.94 | £2419.68 | £3157.41 | £4632.88 |
| Central | £860.91 | £1598.64 | £2336.38 | £3074.11 | £4549.58 |
| Heavy / older, chatty base | £738.54 | £1476.27 | £2214.00 | £2951.74 | £4427.20 |
| Stress (adverse selection) | £585.94 | £1323.68 | £2061.41 | £2799.14 | £4274.61 |

## 6. Sensitivity: A4 (usage-independent architecture) vs number price and infrastructure

A4's cost is almost entirely fixed per subscriber, so its margin depends on **number rental** (Sipflex publishes £2/month retail; a wholesale range-holder price is **PROVIDER QUOTE REQUIRED**) and on self-hosted infrastructure (**ASSUMPTION**). The values below are **sensitivity points, not prices**. Central mix, 1,000 subscribers; each cell shows the margin at £4.99 / £5.99 / £6.99.

| Number £/month | infra £200/1k | infra £400/1k | infra £800/1k | infra £1,600/1k |
|---|---|---|---|---|
| number £0.50 | 62% / 66% / 69% | 57% / 62% / 66% | 47% / 54% / 59% | 28% / 38% / 45% |
| number £1.00 | 50% / 56% / 61% | 45% / 52% / 57% | 35% / 44% / 50% | 16% / 28% / 37% |
| number £1.50 | 38% / 46% / 52% | 33% / 42% / 49% | 23% / 34% / 42% | 4% / 18% / 28% |
| number £2.00 | 26% / 36% / 44% | 21% / 32% / 40% | 11% / 24% / 33% | -8% / 8% / 20% |

Maximum number rental A4 can afford at 40% margin (central mix, £400/1k infra):

| Price | Max £/number/month @ 40% | @ 50% |
|---|---|---|
| £4.99 | £1.20 | £0.78 |
| £5.99 | £1.60 | £1.10 |
| £6.99 | £2.01 | £1.42 |
| £7.99 | £2.41 | £1.74 |
| £9.99 | £3.22 | £2.39 |

