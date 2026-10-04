# HCG unit economics — generated tables (register v1.0.0, 2026-10-04), price £5.99 incl VAT

### A. Revenue waterfall

| Channel | Gross | VAT | Net | Fee | Leakage 2% | After fees |
| --- | --- | --- | --- | --- | --- | --- |
| Stripe (web/Android today) | £5.99 | £1.00 | £4.99 | £0.36 | £0.10 | £4.53 |
| Apple, Small Business Program 15% | £5.99 | £1.00 | £4.99 | £0.75 | £0.10 | £4.14 |
| Apple, standard 30% | £5.99 | £1.00 | £4.99 | £1.50 | £0.10 | £3.39 |
| Google Play Billing 15% (not live) | £5.99 | £1.00 | £4.99 | £0.75 | £0.10 | £4.14 |

### B. Per-minute cost (including per-call rounding, stream rounding and greeting spread over a 4-minute call)

| Basis | Trusted minute | Monitored minute | Marginal cost of monitoring | SMS segment |
| --- | --- | --- | --- | --- |
| Expected (billed today) | £0.0086 | £0.0172 | £0.0086 | £0.0423 |
| Fortress enforcement (app leg at list, ×1.10) | £0.0134 | £0.0229 | £0.0095 | £0.0466 |
| Ratio enforcement ÷ expected | 1.56× | 1.33× | 1.10× | 1.10× |

### C1. Safe variable budget — base case (infra £0.25/customer allocation, RevenueCat £0)

| Channel | Cost-of-service budget @40% | Fixed/customer | Variable | Reserve 15% | Overrun | Safe variable (expected £) | Trusted-only min | Monitored-only min | Min @75% trusted | Fortress £ for same minutes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Stripe (web/Android today) | £2.53 | £1.16 | £1.37 | £0.21 | £0.10 | **£1.07** | 123 | 61 | 99 | £1.54 |
| Apple, Small Business Program 15% | £2.15 | £1.16 | £0.98 | £0.15 | £0.10 | **£0.74** | 85 | 42 | 68 | £1.06 |
| Apple, standard 30% | £1.40 | £1.16 | £0.24 | £0.04 | £0.10 | **£0.10** | 11 | 5 | 9 | £0.14 |
| Google Play Billing 15% (not live) | £2.15 | £1.16 | £0.98 | £0.15 | £0.10 | **£0.74** | 85 | 42 | 68 | £1.06 |

### C2. Safe variable budget — 1,000 subscribers (infra £40/1,000), RevenueCat 1% on store channels

| Channel | Cost-of-service budget @40% | Fixed/customer | Variable | Reserve 15% | Overrun | Safe variable (expected £) | Trusted-only min | Monitored-only min | Min @75% trusted | Fortress £ for same minutes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Stripe (web/Android today) | £2.53 | £0.95 | £1.58 | £0.24 | £0.10 | **£1.24** | 144 | 72 | 115 | £1.80 |
| Apple, Small Business Program 15% | £2.15 | £1.01 | £1.13 | £0.17 | £0.10 | **£0.86** | 100 | 50 | 80 | £1.25 |
| Apple, standard 30% | £1.40 | £1.01 | £0.39 | £0.06 | £0.10 | **£0.23** | 26 | 13 | 21 | £0.33 |
| Google Play Billing 15% (not live) | £2.15 | £1.01 | £1.13 | £0.17 | £0.10 | **£0.86** | 100 | 50 | 80 | £1.25 |

### C3. Safe variable budget — no leakage, no reserve, no overrun (the most optimistic reading of the same facts)

| Channel | Cost-of-service budget @40% | Fixed/customer | Variable | Reserve 15% | Overrun | Safe variable (expected £) | Trusted-only min | Monitored-only min | Min @75% trusted | Fortress £ for same minutes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Stripe (web/Android today) | £2.63 | £1.16 | £1.47 | £0.00 | £0.00 | **£1.47** | 171 | 85 | 136 | £2.12 |
| Apple, Small Business Program 15% | £2.25 | £1.16 | £1.08 | £0.00 | £0.00 | **£1.08** | 126 | 62 | 100 | £1.57 |
| Apple, standard 30% | £1.50 | £1.16 | £0.33 | £0.00 | £0.00 | **£0.33** | 38 | 19 | 31 | £0.48 |
| Google Play Billing 15% (not live) | £2.25 | £1.16 | £1.08 | £0.00 | £0.00 | **£1.08** | 126 | 62 | 100 | £1.57 |

### C4. Fixed cost per customer (base)

| Number rental | Churned-number overhang | Infrastructure allocation | RevenueCat | Total |
| --- | --- | --- | --- | --- |
| £0.8692 | £0.0435 | £0.2500 | £0.0000 | £1.1626 |

### D. Usage profiles: contribution and gross margin per customer-month (all unknown minutes monitored, no cap)

| Profile | Trusted/unknown min | Usage cost | Stripe (web/Android today) | Apple, Small Business Program 15% | Apple, standard 30% | Google Play Billing 15% (not live) |
| --- | --- | --- | --- | --- | --- | --- |
| Light | 60/15 | £0.81 | £2.56 (51%) | £2.17 (43%) | £1.42 (28%) ✗ | £2.17 (43%) |
| Typical | 150/40 | £2.08 | £1.28 (26%) ✗ | £0.90 (18%) ✗ | £0.15 (3%) ✗ | £0.90 (18%) ✗ |
| Heavy family | 400/80 | £4.97 | −£1.60 (-32%) ✗ | −£1.99 (-40%) ✗ | −£2.73 (-55%) ✗ | −£1.99 (-40%) ✗ |
| Very heavy | 800/200 | £10.52 | −£7.15 (-143%) ✗ | −£7.53 (-151%) ✗ | −£8.28 (-166%) ✗ | −£7.53 (-151%) ✗ |

### E. Trusted vs monitored: largest monitored allowance (fully used) that keeps 40%, given trusted minutes

| Trusted min/month | Stripe (web/Android today) | Apple, Small Business Program 15% | Apple, standard 30% | Google Play Billing 15% (not live) |
| --- | --- | --- | --- | --- |
| 0 | 61 | 42 | 5 | 42 |
| 60 | 31 | 12 | — (trusted alone exceeds) | 12 |
| 150 | — (trusted alone exceeds) | — (trusted alone exceeds) | — (trusted alone exceeds) | — (trusted alone exceeds) |
| 300 | — (trusted alone exceeds) | — (trusted alone exceeds) | — (trusted alone exceeds) | — (trusted alone exceeds) |
| 500 | — (trusted alone exceeds) | — (trusted alone exceeds) | — (trusted alone exceeds) | — (trusted alone exceeds) |

### F. Warning levels — household £ consumed (expected basis) and the WATCH/LOSS lines

| Channel | Safe budget | 50% | 75% | 90% | 100% | WATCH: total cost > (margin < 40%) | LOSS: total cost > | LOSS ≈ trusted-only minutes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Stripe (web/Android today) | £1.07 | £0.53 | £0.80 | £0.96 | £1.07 | £2.53 | £4.53 | 391 |
| Apple, Small Business Program 15% | £0.74 | £0.37 | £0.55 | £0.66 | £0.74 | £2.15 | £4.14 | 346 |
| Apple, standard 30% | £0.10 | £0.05 | £0.07 | £0.09 | £0.10 | £1.40 | £3.39 | 259 |
| Google Play Billing 15% (not live) | £0.74 | £0.37 | £0.55 | £0.66 | £0.74 | £2.15 | £4.14 | 346 |

### G. Top-ups (monitored minutes; full cost incl. the connected leg) — minimum price per channel at 40% + 10% reserve

| Pack | Delivery cost | Marginal-only cost | Stripe (web/Android today) min → retail | Apple, Small Business Program 15% min → retail | Apple, standard 30% min → retail | Google Play Billing 15% (not live) min → retail |
| --- | --- | --- | --- | --- | --- | --- |
| 30 monitored min | £0.52 | £0.26 | £1.42 → £1.49 | £1.34 → £1.49 | £1.62 → £1.99 | £1.34 → £1.49 |
| 60 monitored min | £1.03 | £0.52 | £2.60 → £2.99 | £2.68 → £2.99 | £3.25 → £3.49 | £2.68 → £2.99 |
| 120 monitored min | £2.07 | £1.04 | £4.95 → £4.99 | £5.35 → £5.49 | £6.50 → £6.99 | £5.35 → £5.49 |
| 250 monitored min | £4.31 | £2.16 | £10.04 → £10.49 | £11.15 → £11.49 | £13.54 → £13.99 | £11.15 → £11.49 |

| Trusted/unmonitored pack | Delivery cost | Stripe (web/Android today) min → retail | Apple, Small Business Program 15% min → retail | Apple, standard 30% min → retail | Google Play Billing 15% (not live) min → retail |
| --- | --- | --- | --- | --- | --- |
| 100 min | £0.86 | £2.20 → £2.49 | £2.23 → £2.49 | £2.70 → £2.99 | £2.23 → £2.49 |
| 250 min | £2.15 | £5.13 → £5.49 | £5.56 → £5.99 | £6.75 → £6.99 | £5.56 → £5.99 |
| 500 min | £4.30 | £10.02 → £10.49 | £11.13 → £11.49 | £13.51 → £13.99 | £11.13 → £11.49 |

### H. Higher tiers — safe variable budget and what it buys (75% trusted mix)

| Price | Stripe (web/Android today) | Apple, Small Business Program 15% | Apple, standard 30% | Google Play Billing 15% (not live) |
| --- | --- | --- | --- | --- |
| £5.99 | £1.07 ≈ 99 min (61 monitored-only) | £0.74 ≈ 68 min (42 monitored-only) | £0.10 ≈ 9 min (5 monitored-only) | £0.74 ≈ 68 min (42 monitored-only) |
| £6.99 | £1.45 ≈ 135 min (84 monitored-only) | £1.04 ≈ 96 min (60 monitored-only) | £0.30 ≈ 27 min (17 monitored-only) | £1.04 ≈ 96 min (60 monitored-only) |
| £7.99 | £1.84 ≈ 171 min (106 monitored-only) | £1.35 ≈ 125 min (78 monitored-only) | £0.50 ≈ 46 min (28 monitored-only) | £1.35 ≈ 125 min (78 monitored-only) |
| £9.99 | £2.62 ≈ 243 min (151 monitored-only) | £1.95 ≈ 181 min (113 monitored-only) | £0.89 ≈ 83 min (51 monitored-only) | £1.95 ≈ 181 min (113 monitored-only) |
| £12.99 | £3.78 ≈ 351 min (219 monitored-only) | £2.87 ≈ 266 min (166 monitored-only) | £1.49 ≈ 138 min (86 monitored-only) | £2.87 ≈ 266 min (166 monitored-only) |
| £14.99 | £4.56 ≈ 423 min (264 monitored-only) | £3.48 ≈ 323 min (201 monitored-only) | £1.88 ≈ 175 min (109 monitored-only) | £3.48 ≈ 323 min (201 monitored-only) |

### I. Telephony architecture sensitivity (HYPOTHETICAL rates; £5.99, 1,000 subscribers for carrier minimums)

| Architecture | Trusted min cost | Monitored min cost | Safe trusted-only min (Stripe / 15% store) | Typical margin Stripe / 15% | Heavy margin Stripe / 15% | Very heavy margin Stripe / 15% |
| --- | --- | --- | --- | --- | --- | --- |
| Twilio today (billed) | £0.0086 | £0.0172 | 123 / 85 | 30% / 22% | -28% / -36% | -139% / -147% |
| Twilio, app leg billed at list | £0.0122 | £0.0208 | 87 / 60 | 16% / 8% | -63% / -70% | -211% / -219% |
| Telnyx Call Control + WebRTC (list) | £0.0081 | £0.0161 | 131 / 91 | 32% / 25% | -22% / -30% | -126% / -134% |
| Magrathea free inbound + HCG-hosted SIP/WebRTC | £0.0000 | £0.0049 | unbounded by cost / unbounded by cost | 73% / 65% | 68% / 60% | 55% / 47% |
| AQL/MVNO/FMC network-side trusted routing | £0.0000 | £0.0172 | unbounded by cost / unbounded by cost | 56% / 49% | 41% / 33% | -1% / -9% |

### J. Sensitivity of single unknowns (typical profile, Stripe and Apple 30% channels, margin)

| Change | Stripe | Apple |
| --- | --- | --- |
| Base | 26% | 3% |
| Apple SBP confirmed (15%) | — | 18% |
| Leakage 0% | 28% | 5% |
| Leakage 5% | 23% | 0% |
| Infra at 100 subscribers (£0.40) | 23% | 0% |
| Infra at 10,000 subscribers (£0.004) | 31% | 8% |
| App leg billed at list | 12% | -11% |
| Transcription → gpt-4o-mini-transcribe ($0.003) | 28% | 5% |
| OpenAI retries 3× (worst day) | 18% | -5% |
| FX 0.85 £/$ (weaker £) | 25% | 3% |

### K. Legacy figures reproduced from their own formulas

| Figure | Reproduced | Formula |
| --- | --- | --- |
| £0.86 envelope | £0.8580 | economicPolicy.deriveVariableEnvelope() defaults |
| £0.50 budget | £0.49 formula / £0.50 seeded | 58% slice of the envelope (migration 067 seed) |
| £2.07 for 100 minutes | £1.8787 → £2.0666 | 100 × (Fortress connected + monitoring) × 1.10 |
| £1.25 candidate: storeFee_noInfra_reserve10 | £1.2394 | reconstruction (no source found) |
| £1.25 candidate: storeFee_noInfra_noReserve_overrun | £1.2771 | reconstruction (no source found) |
| £1.25 candidate: stripeFee_infra_reserve15 | £1.2870 | reconstruction (no source found) |
| £1.25 candidate: storeFee_noInfra_reserve15_overrun | £1.0705 | reconstruction (no source found) |
