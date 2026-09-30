# Four-architecture model output

## Price book (every leg, labelled)

| Item | £ | Label | Source |
|---|---|---|---|
| twNumberBilled | 0.869170 | CONFIRMED HCG INVOICE | Twilio billed number-months (45) |
| twNumberList | 2.765000 | CURRENT OFFICIAL PUBLISHED PRICE | twilio.com/en-us/voice/pricing/gb: local number $3.50/mo |
| twInboundBilled | 0.007558 | CONFIRMED HCG INVOICE | Twilio billed, per started minute |
| twInboundList | 0.007900 | CURRENT OFFICIAL PUBLISHED PRICE | twilio.com/…/pricing/gb: inbound local $0.0100/min |
| twSdkBilled | 0.000000 | CONFIRMED HCG INVOICE | £0 billed on every client leg to date |
| twSdkList | 0.003160 | CURRENT OFFICIAL PUBLISHED PRICE | twilio.com/…/pricing/gb: Voice SDK $0.0040/min |
| twByoc | 0.003160 | CURRENT OFFICIAL PUBLISHED PRICE | twilio.com/…/pricing/gb + changelog: BYOC trunking $0.0040/min each direction |
| twSipIface | 0.003160 | CURRENT OFFICIAL PUBLISHED PRICE | twilio.com/…/pricing/gb: SIP interface $0.0040/min — whether it ALSO applies to BYOC-originated calls: QUOTE |
| twStreamBilled | 0.003329 | CONFIRMED HCG INVOICE | Twilio billed Media Streams |
| twStreamList | 0.003476 | CURRENT OFFICIAL PUBLISHED PRICE | twilio.com/…/pricing/gb: Media Streams $0.0044/min |
| twPolly | 0.000600 | CONFIRMED HCG INVOICE | Twilio billed Polly greeting |
| twSms | 0.042325 | CONFIRMED HCG INVOICE | Twilio Pricing API SMS segment |
| sipNumber | 2.000000 | CURRENT OFFICIAL PUBLISHED PRICE | sipflex.co.uk £2/number/month (retail; wholesale QUOTE) |
| sipInbound | 0.000000 | CURRENT OFFICIAL PUBLISHED PRICE | sipflex.co.uk / sipgatetrunking.co.uk: inbound free (at-volume terms QUOTE) |
| sipChannel | 1.000000 | CURRENT OFFICIAL PUBLISHED PRICE | sipflex.co.uk £1 per extra concurrent channel/month |
| transcription | 0.004740 | CURRENT OFFICIAL PUBLISHED PRICE | OpenAI whisper-1 $0.006/min |
| selfInfraPer1k | 600.000000 | ASSUMPTION | HCG-owned delivery: 2+ regions SBC/SIP proxy/media/TURN/monitoring, £/month per 1,000 subs (excl. staff) |
| selfBandwidth | 0.000070 | ASSUMPTION | ~64 kbit/s each way ≈ 1 MB/min at ~£0.07/GB egress |
| selfOpsStaff | 4000.000000 | ASSUMPTION | On-call/ops share for a self-run telecom platform £/month (fixed, independent of subs) |
| networkFee | — | PROVIDER QUOTE REQUIRED | MNO/MVNE selective-routing fee: not published |
| fraudReserve | 0.100000 | ASSUMPTION | H: fraud/abuse contingency £/sub/month (within hard containment only) |
| storeFee | 0.150000 | CURRENT OFFICIAL PUBLISHED PRICE | Apple SBP / Google Play 15% of net (Apple SBP enrolment UNCONFIRMED) |
| stripePct | 0.027000 | CURRENT OFFICIAL PUBLISHED PRICE | Stripe UK 1.5% + Billing 0.7% + Tax 0.5% |
| stripeFixed | 0.200000 | CURRENT OFFICIAL PUBLISHED PRICE | Stripe UK 20p |
| storeShare | 0.700000 | ASSUMPTION | Share paying via stores |
| vat | 0.200000 | CURRENT OFFICIAL PUBLISHED PRICE | UK VAT |

## Option B leg by leg (per connected minute, GBP)

| Leg | Provider | Direction | £/min | Fixed | Label |
|---|---|---|---|---|---|
| Caller → customer mobile → forwarded to HCG DDI | Customer's MNO | customer outbound (forward) | customer tariff | — | ASSUMPTION: in bundle for most post-pay; PAYG may pay |
| Forwarded call arrives on UK SIP DDI | Sipflex / sipgate / aql / Magrathea | inbound | £0.00 | £2.00/number + £1.00/channel | CURRENT OFFICIAL PUBLISHED PRICE (volume terms PROVIDER QUOTE REQUIRED) |
| SIP carrier → Twilio BYOC trunk | Twilio | BYOC origination into Twilio | £0.00316 | — | CURRENT OFFICIAL PUBLISHED PRICE |
| Twilio SIP interface (if also charged on BYOC calls) | Twilio | inbound SIP | £0.00316 | — | CURRENT OFFICIAL PUBLISHED PRICE price; applicability PROVIDER QUOTE REQUIRED |
| Twilio → HCG app (<Dial><Client>) | Twilio Voice SDK | outbound to client | £0.00 billed / £0.00316 list | — | CONFIRMED HCG INVOICE (billed) / CURRENT OFFICIAL PUBLISHED PRICE (list) — continuation for BYOC calls PROVIDER QUOTE REQUIRED |
| Media Stream (monitored only) | Twilio | fork | £0.00333 billed / £0.00348 list | — | CONFIRMED HCG INVOICE / CURRENT OFFICIAL PUBLISHED PRICE |
| Transcription (monitored only) | OpenAI | API | £0.00474 | — | CURRENT OFFICIAL PUBLISHED PRICE |
| Greeting (unknown calls) | Twilio Polly | per call | £0.00060 | — | CONFIRMED HCG INVOICE |
| VAT on supplier charges | HMRC | — | reclaimable if VAT-registered | — | ASSUMPTION |

| Trusted minute | Twilio billed basis | Twilio list basis |
|---|---|---|
| A current Twilio | £0.00756 | £0.01106 |
| B SIP + BYOC + SDK | £0.00316 | £0.00632 |
| B if Twilio also charges SIP interface | £0.00632 | £0.00948 |

## Portfolio economics per subscriber (1,000 subs), Twilio billed basis

A trusted · B unknown transport · C AI/streaming · D fixed subscriber (number/channels) · G infrastructure/ops · H fraud contingency · I extreme users (their A+B+C). E (payment fees) and F (VAT) are deducted from revenue.

### central mix

| Architecture | A | B | C | D | G | H | I | Total | margin £4.99 | margin £5.99 | margin £6.99 | margin £7.99 | margin £9.99 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A Current Twilio | £1.34 | £0.31 | £0.22 | £0.87 | £0.00 | £0.10 | £0.63 | **£3.46** | 4% | 18% | 28% | 36% | 46% |
| B Free-inbound UK SIP → Twilio BYOC → existing Voice SDK | £0.56 | £0.16 | £0.22 | £2.02 | £0.00 | £0.10 | £0.32 | **£3.38** | 6% | 20% | 29% | 37% | 47% |
| C UK SIP carrier → HCG-owned SIP/WebRTC/VoIP-push delivery | £0.01069 | £0.04578 | £0.13 | £2.02 | £4.60 | £0.10 | £0.06949 | **£6.98** | -81% | -53% | -32% | -17% | 4% |

### stress mix

| Architecture | A | B | C | D | G | H | I | Total | margin £4.99 | margin £5.99 | margin £6.99 | margin £7.99 | margin £9.99 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A Current Twilio | £1.80 | £0.45 | £0.32 | £0.87 | £0.00 | £0.10 | £2.35 | **£5.89** | -54% | -31% | -14% | -1% | 17% |
| B Free-inbound UK SIP → Twilio BYOC → existing Voice SDK | £0.75 | £0.23 | £0.32 | £2.02 | £0.00 | £0.10 | £1.21 | **£4.64** | -24% | -6% | 8% | 18% | 32% |
| C UK SIP carrier → HCG-owned SIP/WebRTC/VoIP-push delivery | £0.01446 | £0.07195 | £0.19 | £2.02 | £4.60 | £0.10 | £0.26 | **£7.26** | -87% | -58% | -37% | -21% | 1% |

## Portfolio economics per subscriber (1,000 subs), Twilio list basis

A trusted · B unknown transport · C AI/streaming · D fixed subscriber (number/channels) · G infrastructure/ops · H fraud contingency · I extreme users (their A+B+C). E (payment fees) and F (VAT) are deducted from revenue.

### central mix

| Architecture | A | B | C | D | G | H | I | Total | margin £4.99 | margin £5.99 | margin £6.99 | margin £7.99 | margin £9.99 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A Current Twilio | £1.96 | £0.42 | £0.23 | £2.77 | £0.00 | £0.10 | £0.87 | **£6.34** | -65% | -40% | -21% | -8% | 12% |
| B Free-inbound UK SIP → Twilio BYOC → existing Voice SDK | £1.12 | £0.26 | £0.23 | £2.02 | £0.00 | £0.10 | £0.54 | **£4.27** | -16% | 2% | 14% | 23% | 36% |
| C UK SIP carrier → HCG-owned SIP/WebRTC/VoIP-push delivery | £0.01069 | £0.04578 | £0.13 | £2.02 | £4.60 | £0.10 | £0.06949 | **£6.98** | -81% | -53% | -32% | -17% | 4% |

### stress mix

| Architecture | A | B | C | D | G | H | I | Total | margin £4.99 | margin £5.99 | margin £6.99 | margin £7.99 | margin £9.99 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A Current Twilio | £2.64 | £0.62 | £0.32 | £2.77 | £0.00 | £0.10 | £3.26 | **£9.71** | -146% | -107% | -79% | -58% | -29% |
| B Free-inbound UK SIP → Twilio BYOC → existing Voice SDK | £1.51 | £0.39 | £0.32 | £2.02 | £0.00 | £0.10 | £2.03 | **£6.38** | -66% | -40% | -22% | -8% | 11% |
| C UK SIP carrier → HCG-owned SIP/WebRTC/VoIP-push delivery | £0.01446 | £0.07195 | £0.19 | £2.02 | £4.60 | £0.10 | £0.26 | **£7.26** | -87% | -58% | -37% | -21% | 1% |

### Option C scale sensitivity (central mix, billed basis n/a): fixed ops/infra spread over subscribers

| Subscribers | C total £/sub | margin £4.99 | margin £5.99 | margin £6.99 | margin £7.99 | margin £9.99 |
|---|---|---|---|---|---|---|
| 500 | £10.98 | -177% | -133% | -101% | -77% | -44% |
| 1000 | £6.98 | -81% | -53% | -32% | -17% | 4% |
| 2500 | £4.58 | -23% | -4% | 9% | 19% | 33% |
| 10000 | £3.38 | 6% | 20% | 29% | 37% | 47% |

Option D HCG-side cost at 2,500 subs (central): £2.25/sub **plus the network fee (PROVIDER QUOTE REQUIRED)**. Max affordable fee at 40%: £4.99 → −£0.29 · £5.99 → £0.11 · £6.99 → £0.52 · £7.99 → £0.92 · £9.99 → £1.73.

## Catastrophic exposure (attacker maximising HCG's bill)

Parameters are ASSUMPTIONS chosen as a realistic motivated attacker, not a ceiling of what is possible. "Stopped by" names the first control **outside the attacker's reach**.

| Arch | Scenario | Stopped by (outside attacker control) | Exposure £ | Basis |
|---|---|---|---|---|
| A | L0 external: inbound flood to HCG numbers, 500 concurrent unknown calls (botnet / hacked PBXs) | Nothing provider-side: Twilio has no inbound concurrency or spend cap. HCG app caps (unmerged) are app-controlled. | £468.81 | per hour, unbounded in time |
| A | L3 backend/env compromise (master Twilio auth token): outbound calls to high-cost international numbers, 1 CPS for 1 h, $1.50/min, 60 min each | Twilio geo-permissions are changeable with the same token → NOT independent. Only: prepaid balance without auto-recharge (CONSOLE setting; API-changeability UNCONFIRMED), Twilio fraud desk (UNCONFIRMED). | £255960.00 | first hour of calls |
| A | L3: buy numbers en masse (5,000 numbers) | None provider-side found | £13825.00 | per month, recurring |
| A | L3: OpenAI key misuse (LLM-jacking) | OpenAI prepaid credit with auto-recharge OFF (budgets are notification-only) | balance | bounded by prepaid balance only if auto-recharge is off |
| B | L0 inbound flood | SIP carrier channel count (provider-enforced; portal-only change) | £14.82 | per hour at 22 channels — BOUNDED (but channel exhaustion is shared-fate DoS for all customers) |
| B | L3 backend compromise: Twilio outbound fraud (same Twilio account still exists) | Same as A unless Twilio account is separate, number-less, geo-locked and the auth token is not held by the app backend | £255960.00 | same as A — BLOCKER unless isolated |
| C | L0 inbound flood | Carrier channel count + fixed-size HCG infra (no per-minute billing) | £6.44 | per hour — BOUNDED (transcription is the only variable; prepaid) |
| C | L3 backend compromise: outbound via SIP trunk | Carrier: trunk provisioned inbound-only / outbound barred at carrier (portal-only, MFA) → £0 | £0.00 | if carrier config confirmed (QUOTE) |
| D | L0 inbound flood of unknown calls | Network diverts only unknown callers to HCG's DDI → same channel bound as C | £2.89 | per hour — BOUNDED |

