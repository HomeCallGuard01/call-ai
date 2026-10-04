# HCG unit economics, pricing scenarios and carrier comparison requirements

> **Superseded for decisions by [`HCG_UNIT_ECONOMICS_V1.md`](HCG_UNIT_ECONOMICS_V1.md) (2026-10-04)**, which uses one authoritative assumption register (`services/finance/assumptions/hcg-unit-economics.v1.json`) and reconciles the £0.50 / £0.86 / £1.25 / £2.07 figures. Kept as the historical record.

Prepared 2026-09-27. Internal analysis only: **no public price, allowance, customer term or provider change is implied or made.**

**Labels used throughout:**
- **CONFIRMED:** Twilio Pricing API for this account, or Twilio billing records.
- **ESTIMATED:** a published list price or a stated assumption.
- **UNKNOWN:** no evidence either way.
- **HYPOTHETICAL:** an unquoted alternative-carrier rate.

## 1. Unit costs today (Twilio, GBP, ex-VAT)

| Item | Cost | Status | Evidence |
|---|---|---|---|
| UK local number | £0.86917 / month | CONFIRMED | Pricing API; 45 number-months billed at exactly this rate |
| Inbound (forwarded) call | £0.007558 / started minute | CONFIRMED | Pricing API; a 239 s call billed 4 min = £0.03023. Twilio Support (2026-09): the inbound PSTN leg stays billable for the whole connected call, including when bridged to the app, so this applies to **trusted calls too** |
| App / Voice SDK (`<Dial><Client>`) leg | £0 billed so far | CONFIRMED observation | 100 legs with no price; `calls-client` has never appeared. Twilio's public list price is $0.004/min, so future billing is **UNKNOWN** (a risk). |
| Media Streams | £0.003329 / minute | CONFIRMED | Billing: 41 min = £0.13647; billed per started minute per stream (inferred) |
| Polly greeting (unknown callers) | £0.0006 each | CONFIRMED | Billing: 38 uses = £0.02282 |
| SMS | £0.042325 / segment | CONFIRMED | Pricing API. Warning = 1 segment; red-line / post-call / monitoring-limit messages = 2 segments (£0.08465), counted from the message text on `main` |
| Outbound UK mobile call | £0.023052 / min | CONFIRMED | Only the pre-23-Aug dial-back design used this; not current architecture |
| Transcription (whisper-1, audio sent once) | ≈ £0.00474 / monitored min | ESTIMATED | $0.006/min list × 0.79 FX; the OpenAI project key can't read costs |
| Live risk scoring | £0 | CONFIRMED (code) | Rule-based; no LLM on the live call path |
| Twilio platform / account fees | None observed | CONFIRMED | Only a £0.00152 failed-message processing fee in all history |
| VAT on Twilio | Usage prices are ex-VAT | UNKNOWN treatment | Presumed recoverable for VAT-registered AFMD (confirm with accountant) |
| FX | Twilio billed in GBP | CONFIRMED | OpenAI in USD, so FX exposure applies only to transcription |
| Store / payment fees | Stripe 1.5% + 20p + Billing 0.7% + Tax 0.5%; Google Play 15%; Apple 15% (Small Business Program) or 30% | ESTIMATED | Apple SBP enrolment UNKNOWN |

**Derived rates:**

| Measure | Cost |
|---|---|
| Trusted minute | **£0.007558** |
| Monitored minute | **£0.015627**, plus £0.0006 greeting per call |
| 10-minute trusted call (11 started minutes including ring) | **£0.083** |
| 10-minute monitored call | **£0.169** |

## 2. £4.99 contribution per customer per month

This is after VAT, fees and all telephony. Assumptions: 4-minute average call (ASSUMPTION), about 0.55 extra started minutes per call (ASSUMPTION), one warning SMS a month (ASSUMPTION).

| Minutes/mo | Monitored | Telephony + AI cost | Stripe | Store 15% | Apple 30% |
|---|---|---|---|---|---|
| 0 | — | £0.91 | £2.91 | £2.62 | £2.00 |
| 100 | 10–20% | £1.86–1.95 | £1.87–1.96 | £1.59–1.67 | £0.96–1.05 |
| 250 | 10–20% | £3.28–3.50 | £0.32–0.54 | £0.03–0.25 | **−£0.37 to −£0.59** |
| 500 | 10–20% | £5.65–6.10 | **−£1.83 to −£2.27** | **−£2.12 to −£2.56** | **−£2.74 to −£3.19** |
| 1,000 | 10–20% | £10.40–11.28 | **−£6.57 to −£7.46** | **−£6.86 to −£7.75** | **−£7.49 to −£8.37** |

Because forwarding is unconditional, **trusted family minutes, not monitored minutes, drive the cost.**

## 3. Pricing sensitivity (internal scenarios, not decisions)

**Break-even total minutes a month** (15% monitored; Stripe / Store 15%):

| Price | Twilio (confirmed) | Twilio if app leg billed at list | HYPOTHETICAL carrier A (Plivo-list-like) | HYPOTHETICAL carrier B (channel billing, Telnyx-like) |
|---|---|---|---|---|
| £4.99 | 293 / 264 | 215 / 194 | 336 / 303 | 484 / 436 |
| £5.99 | 375 / 336 | 275 / 246 | 429 / 384 | 618 / 554 |
| £6.99 | 456 / 407 | 335 / 299 | 522 / 466 | 753 / 672 |
| £9.99 | 699 / 621 | 513 / 456 | 801 / 711 | 1,155 / 1,025 |

**Contribution at each plan's usage ceiling** (Store 15%, 15% monitored):

| Scenario | Cost | Contribution |
|---|---|---|
| £4.99 single plan, 300 min | £3.89 | −£0.36 |
| £4.99 with 500 min | £5.88 | −£2.34 |
| £7.99 higher-usage tier, 1,000 min | £10.84 | −£5.18 |
| £9.99 higher-usage tier, 1,500 min | £15.80 | −£8.73 |

**What this shows:**
- On Twilio, any included-usage level has to be priced at roughly **≥ £0.01 of net revenue per included minute** to break even at its cap.
- A monitored-minute allowance alone doesn't bound cost, because trusted minutes aren't capped by it.
- **The single most valuable commercial lever is the per-minute cost of the forwarded inbound leg,** and it matters more than the price point.
- **Twilio starting to bill the app leg would cut break-even by about 25%.** The ledger will detect that automatically.

## 4. What we need from alternative carriers

This lets any quote be dropped straight into the model above.

**HCG's usage shape:**
- One UK geographic number per household, bought and released programmatically, with UK address/regulatory compliance.
- All of the customer's calls arrive through **unconditional mobile forwarding** (`**21*`).
- Every call is bridged to an **iOS/Android app** (Voice SDK with push, CallKit/ConnectionService).
- Unknown callers get an en-GB TTS greeting and a **real-time audio stream** (8 kHz µ-law, bidirectional-capable) to HCG.
- Warning SMS are sent **from the same UK number**.
- Planning volumes: 1,000 / 5,000 / 10,000 households; about 100–500 conversation minutes per household per month, 10–20% monitored.

**Please quote in GBP where possible:**
1. UK local number: monthly rental, setup fee, regulatory bundle/address costs, and porting-in of existing individual Twilio UK numbers (lead time, cost, downtime, and whether customers' existing `**21*` forwarding keeps working).
2. **Inbound per-minute price for UK local numbers, and the billing increment** (per second vs 60/60), plus any programmable-voice/API per-minute fee on top.
3. **App / WebRTC leg price** when bridging an inbound call to a mobile SDK user, and whether it's charged in addition to the inbound leg.
4. **Channel / concurrency billing:** is it available for UK numbers? Is it compatible with programmable voice (webhooks, streaming, SDK bridging)? Price per channel, and which per-minute fees still apply per call.
5. Real-time media streaming price (per minute? increment?), audio format, and bidirectional support.
6. en-GB TTS voice and its price; SMS from a UK geographic number (price per segment, sender rules).
7. **Can a forwarded PSTN leg be released or handed off** once a call is identified as trusted (SIP REFER or similar), so the carrier stops carrying the conversation? Under unconditional forwarding we expect **no**; please confirm.
8. **Per-call cost data:** API or webhook with billed duration, price and currency per call leg and per message, plus daily usage by category. This feeds HCG's provider-neutral ledger.
9. Sub-accounts for staging vs production.
10. Volume or committed-use tiers at the three volumes above; invoice currency and VAT treatment for a UK VAT-registered company.
11. SLA, UK data residency, and number-porting-out terms.

**Comparison template** (per carrier):

| Field | Value |
|---|---|
| number £/mo | |
| inbound £/min | |
| increment | |
| app leg £/min | |
| API fee £/min | |
| stream £/min | |
| TTS £/use | |
| SMS £/segment | |
| channel £/mo (if any) | |
| per-call cost API | yes/no |
| porting | yes/no, lead time |

Substitute these values into `cost()` in the model to get break-even and contribution, directly comparable with the Twilio column.
