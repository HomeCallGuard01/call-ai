# Home Call Guard: commercial and network viability decision paper

Research only, 2026-09-30. No production, code, forwarding or account changes were made.

- Model: `research/viability/portfolio-model.js`; output in `MODEL_OUTPUT.md`.
- Carrier specification: `CARRIER_TECHNICAL_SPEC.md`.

Input labels:

| Label | Meaning |
|---|---|
| **CONFIRMED** | From HCG's own Twilio data/invoices |
| **PUBLISHED** | Current published provider price |
| **ASSUMPTION** | HCG modelling assumption |
| **QUOTE** | Provider quote required; the price is not invented |

## Summary

1. **Retail price is not what decides viability. The shape of HCG's telecom cost is.** On today's architecture (Twilio carries every forwarded call for its whole duration), cost scales with how much the customer's family and friends talk:
   - central mix: HCG makes **28% at £6.99** and **46% at £9.99**;
   - heavier or adverse-selection mix: HCG **loses money at every price up to £7.99**.
2. **A usage-independent architecture exists without any carrier cooperation.** It needs UK geographic numbers from a carrier that charges nothing for inbound calls (PUBLISHED: Sipflex, sipgate trunking), with calls delivered to the HCG app by HCG's own SIP/WebRTC + VoIP-push stack (A4).
   - Cost becomes ~£2.7–£3.0 per subscriber **whatever the usage**: central mix **40% at £6.99**, stress mix 35%.
   - With a wholesale number price of **≤ £1.00/month** (QUOTE), it reaches **~45–57% at £4.99–£6.99**.
3. **Network-side routing of trusted callers (the carrier target) is the best economics.** HCG's own cost falls to ~£0.74 per subscriber, but it depends entirely on a carrier/MVNE fee and capability. **Nothing is published.** HCG can afford at most **£1.22 (£4.99) / £1.62 (£5.99) / £2.03 (£6.99)** per subscriber per month at a 40% margin.
4. **Competitive reality: three of the five parties contacted already sell a scam-call product to their own customers.**
   - EE Scam Guard, £2/month, Norton-powered, launched 2024 and upgraded April 2026.
   - Vodafone Scam Call Protection, powered by Hiya, in Secure Net at £2/month, April 2026.
   - VMO2 Call Defence, free, "70m calls flagged a month" (not contacted, but a relevant route).
   - All are **pre-answer labelling/blocking**. None found analyses the live conversation. Google's on-device Scam Detection *does* (Pixel 9+, Galaxy S26, UK, off by default).
   - HCG's defensible gap is **live in-call protection on every handset, including iPhone and older Androids**, plus the family/warning layer.
5. **Hard requirement conflict found in HCG's own unmerged code.** Branch `feature/financial-safety-hard-limits` refuses calls at household £10/day and £40/period (and refuses unknown callers at £20/period or at a company HARD level) while forwarding still points at HCG. That breaks the requirement. §3 gives the correction; no code was changed tonight.
6. **The single biggest unknown is measurable and cheap to measure.** It's the real distribution of forwarded incoming minutes per subscriber. HCG has 0 genuine paying customers, so the model uses Ofcom's 146 outgoing min/month average as its anchor (ASSUMPTION: incoming ≈ outgoing).

## 1. Economic model

### Structure

A subscription with portfolio economics. There is **no per-customer incoming-minute bundle anywhere**, and a customer being targeted by scammers never loses protection.

| Cat. | What | Twilio today | A4 (free-inbound SIP + HCG-hosted delivery) |
|---|---|---|---|
| A | Trusted / unmonitored transport | £0.007558 per started min, CONFIRMED | £0 per min (PUBLISHED free inbound) |
| B | Unknown/monitored call transport, greeting, SMS | Same per-min rate + £0.0006 greeting + £0.0423/SMS | £0 per min + SMS |
| C | Fixed per subscriber | Number £0.869, CONFIRMED | Number £2.00 (PUBLISHED retail; wholesale QUOTE) + SIP channels £1 each (PUBLISHED; 22 channels per 1,000 subs by Erlang B) + infra £0.40 (ASSUMPTION) |
| D | AI + streaming | Stream £0.003329 CONFIRMED + transcription $0.006 PUBLISHED | Transcription only (own media) |
| E | VAT + payment | VAT 20%; store 15% of net (Apple SBP enrolment unconfirmed: 30% if not); Stripe 2.7% + 20p | Same |
| F | Abnormal | Reserve £0.10/sub/month (ASSUMPTION), bounded by the financial-safety controls | Same |

### Usage distribution

All usage figures are ASSUMPTION, per subscriber per month:

| Segment | Trusted min | Unknown min | Unknown calls |
|---|---|---|---|
| Low | 40 | 8 | 4 |
| Normal | 150 | 25 | 10 |
| High | 450 | 60 | 20 |
| Extreme | 1,200 | 300 | 100 |
| Targeted by scammers | 150 | 120 | 80 |

Four portfolio mixes of 1,000 subscribers:

| Mix | Low | Normal | High | Extreme | Targeted | Avg min/sub |
|---|---|---|---|---|---|---|
| Light | 50% | 38% | 8% | 2% | 2% | 167 |
| Central | 33% | 44% | 15% | 4% | 4% | 240 |
| Heavy | 20% | 40% | 25% | 8% | 7% | 346 |
| Stress | 10% | 35% | 30% | 15% | 10% | 471 |

### Maximum average telecom + AI cost per subscriber (A+B+C+D+F)

Blended fees assume 70% app store (ASSUMPTION) and 30% Stripe.

| Price | 30% margin | 40% | 50% | 60% |
|---|---|---|---|---|
| £4.99 | £2.37 | £1.96 | £1.54 | £1.13 |
| £5.99 | £2.86 | £2.36 | £1.86 | £1.36 |
| £6.99 | £3.35 | £2.77 | £2.18 | £1.60 |
| £7.99 | £3.84 | £3.17 | £2.51 | £1.84 |
| £9.99 | £4.81 | £3.98 | £3.15 | £2.31 |

### Actual portfolio cost per subscriber and margin

Each cell shows cost per subscriber, then the margin at £4.99 / £6.99 / £9.99.

| Architecture | Light | Central | Heavy | Stress |
|---|---|---|---|---|
| A1 Twilio today (CONFIRMED) | £2.70 · 22/41/55% | £3.46 · 4/28/46% | £4.57 · −23/9/33% | £5.89 · −54/−14/17% |
| A1b Twilio if the app leg is billed at list | £3.32 | £4.35 · −17/13/36% | £5.84 | £7.61 · −96/−43/−4% |
| A2 Plivo (PUBLISHED) | £2.29 · 32/48/60% | £2.96 · 16/37/52% | £3.93 | £5.08 · −35/0/27% |
| A3 Free-inbound SIP → Twilio BYOC → existing SDK | £2.99 | £3.38 · 6/29/47% | £3.96 | £4.65 · −25/8/32% |
| **A4 Free-inbound SIP → HCG-hosted delivery** | £2.68 · 23/42/56% | **£2.76 · 21/40/55%** | £2.88 · 18/38/53% | **£3.04 · 14/35/51%** |

1,000-subscriber monthly contribution, central mix:

| Architecture | £4.99 | £6.99 | £9.99 |
|---|---|---|---|
| A1 (Twilio today) | £160 | £1,635 | £3,849 |
| A4 | £861 | £2,336 | £4,550 |

In the stress mix, A1 at £6.99 **loses £789 a month**; A4 still makes **£2,061**.

### A4 sensitivity (central mix)

Each cell shows the margin at £4.99 / £5.99 / £6.99.

| Number rental | Infra £200 per 1k subs | Infra £400 | Infra £800 |
|---|---|---|---|
| £0.50 | 62/66/69% | 57/62/66% | 47/54/59% |
| £1.00 | 50/56/61% | 45/52/57% | 35/44/50% |
| £2.00 | 26/36/44% | 21/32/40% | 11/24/33% |

Maximum number rental A4 can pay at a 40% margin: **£1.20 at £4.99, £1.60 at £5.99, £2.01 at £6.99**.

### Maximum average trusted minutes per subscriber at 40% margin (central unknown usage)

| Architecture | £4.99 | £5.99 | £6.99 | £7.99 | £9.99 |
|---|---|---|---|---|---|
| A1 Twilio today | 28 | 74 | 119 | 165 | 257 |
| A2 Plivo | 74 | 124 | 174 | 224 | 324 |
| A4 | unbounded | unbounded | unbounded | unbounded | unbounded |

Ofcom's average is ~146 outgoing min/month. **On Twilio today, the average UK mobile user's trusted calls alone exhaust a 40% margin at any price below ~£6.99.**

### A4's own risks

- **Engineering.** Replacing the Twilio Voice SDK with an HCG-run SIP/WebRTC stack means iOS PushKit + CallKit and Android FCM + ConnectionService (same platform model as today), a TURN/SBC and media server, and a monitoring audio fork.
- **HCG becomes responsible for carrier-grade call delivery.** The provider migration playbook already found: no forced app update, and a dual-SDK push-conflict risk.
- **Free inbound at scale is a retail promise.** It needs written confirmation for 1–10k numbers and ~0.2–3M min/month (QUOTE).
- **Customer-side cost.** The customer's own tariff pays for the forwarded leg. Unlimited plans are unaffected; PAYG customers may pay per minute (ASSUMPTION; disclose it).

## 2. Cheapest cross-platform telecom architecture: provider findings

| Provider | UK inbound | App / SDK leg | SIP | Can trusted leg be released after classification? | Network caller-ID routing | Keep customer's number | Android | iPhone | Failover | Competitive risk | Contact route |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **Twilio** (contacted) | £0.007558/started min CONFIRMED | £0 billed (list $0.004) | BYOC $0.004/min PUBLISHED | **No.** Twilio stays pivot; SIP REFER from PSTN bills both legs (doc-verified earlier) | No | Yes (forwarding) | Yes (SDK) | Yes (SDK) | Fallback URL; can serve a static `<Reject>` (unbilled) | Low | Already engaged |
| **Plivo** | $0.0055/min PUBLISHED | $0.0033/min, charged PUBLISHED | Included in SDK rate (QUOTE for BYOC) | No ("bridges the caller") | No | Yes (forwarding) | Native SDK | Native SDK (React Native support QUOTE) | Fallback URL | **None found** | [plivo.com/contact/sales](https://www.plivo.com/contact/sales/) (1 business day) |
| **Telnyx** | UK origination **not published** (QUOTE) | Voice API $0.002 + WebRTC (not itemised) | $0.0032 in (US list) | Claims REFER "out of path"; PSTN-leg applicability undocumented | No | Yes | SDK | SDK | — | **Medium:** sells live-audio **deepfake detection** ($0.01/call, Apr 2026). Supplier, not consumer rival, but it would learn HCG's design. | sales@telnyx.com, UK +44 3301 900175 |
| **Sipflex (Cloud2Tel)** | **£0 inbound** PUBLISHED | n/a (needs HCG stack or BYOC) | Channels £1/month; numbers £2 PUBLISHED; API | n/a: per-minute cost already £0 | No | Yes (forwarding) | Via HCG app | Via HCG app | Provider-side failover destination; **must never be the customer's own mobile (loop)** | **None found** | support@sipflex.co.uk, 0800 810 1057; high-volume enquiries welcome |
| **sipgate trunking** | **£0 inbound** PUBLISHED | n/a | From £4.95/trunk | n/a | No | Yes | Via app | Via app | Trunk failover | None found | [sipgatetrunking.co.uk](https://www.sipgatetrunking.co.uk/) |
| **Magrathea** (wholesale range holder) | QUOTE (2021 docs: numbers 50p/month, stale) | n/a | Wholesale SIP | n/a | No | Yes | Via app | Via app | — | **Low–medium:** carrier-level scam-prevention work (CLI blocking, "voice firewall" in blog posts); no consumer product listed | 0345 004 0040, info@magrathea-telecom.co.uk, [contact form](https://www.magrathea-telecom.co.uk/contact/) |
| **Gamma** (wholesale + MVNO on Three) | QUOTE | n/a | Wholesale SIP | n/a | Possibly, via MVNO (QUOTE) | Yes | — | — | — | Low: AI virtual agent for businesses; no scam product found | Not researched tonight |
| **BT/EE** (contacted) | — | — | — | Network can (IMS), if offered | **Yes, technically** (IMS AS / CDIV conditions) | Yes (native) | Yes | Yes | Network default handling | **High:** EE Scam Guard (£2/month) | Engaged |
| **Vodafone / VodafoneThree** (contacted) | — | — | — | Same | Same; CAMARA APIs | Yes | Yes | Yes | — | **High:** Scam Call Protection (Hiya, £2/month) | Engaged; Three Wholesale lists aql, Wireless Logic and Gamma as MVNO partners |
| **VMO2** (not contacted) | — | — | — | Same | Same | Yes | Yes | Yes | — | **High:** Call Defence (free) | VMO2 Business 0800 064 3790 (wholesale MVNO partner team exists) |
| **Wireless Logic / Cloud9** (contacted) | — | — | — | **Yes, inside its own core** | **Yes, inside its own core** (full MVNO, MCC/MNC 234/18, own HLR/GMSC); **VoLTE/IMS capability QUOTE** | **Only by porting to its SIM** | Yes | Yes | Core default | None found | Engaged |
| **aql** (contacted) | — | — | — | Possibly | Possibly (UK operator, Three MVNO partner) | Porting | Yes | Yes | — | Low–medium: AI monitoring of its own number estate for misuse (B2B) | Engaged |
| **eSIM Go** (MVNE on Vodafone, May 2026) | — | — | — | QUOTE | QUOTE | Porting | Yes | Yes | — | None found | docs.esim-go.com |
| **Hiya** | — | — | — | — | — | — | — | — | — | **Direct competitor** (powers Vodafone). **Do not approach.** | — |

Not researched tonight: Vonage (per-second billing; UK rate needs a quote), Sinch, Bandwidth UK, Colt, IDT.

**Conclusions.**
- No CPaaS releases a trusted PSTN leg under unconditional forwarding. Only a per-minute price change (A2/A3), a free-inbound carrier (A4) or carrier-side routing (A5) moves the economics.
- **Cheapest cross-platform route available today without any carrier's permission: A4.**
- **Cheapest overall, if a carrier or MVNE agrees: A5.**

## 3. Fair use and financial protection (no minute allowance cut-off)

### Principle
- Protection is sold per household; HCG manages cost at portfolio level.
- A customer targeted by scammers keeps full protection: the targeted segment is modelled explicitly, and at A4 it costs HCG almost nothing extra in transport.

### Mechanisms (in escalation order, none of which blocks ordinary calls)
1. **Portfolio monitoring.** Ledger + spend monitor already built: per-household projected cost, margin WATCH, loss ALERT, anomaly detection. **Stale data is never treated as £0.**
2. **Abnormal-usage and commercial-use detection.** Signals:
   - many *distinct* unknown callers;
   - business-hours concentration;
   - high inbound volume with short gaps;
   - repeat callers who become trusted contacts at a high rate;
   - SIM/number reused across households.
   These produce a *review*, never an automatic cut-off.
3. **Account cost thresholds.** Per household, relative to the plan's after-fee revenue: WATCH when under the target margin, ALERT when loss-making. At ALERT: fair-use contact and an offer of a higher-use / business plan.
4. **Warnings** to the customer (in-app first).
5. **Cost-bounding action that is always safe: "transport-only" mode.**
   - Stop paid monitoring (AI + streams, cost D) for that household.
   - **Keep delivering every call.**
   - The customer is told explicitly.
   - Under A4, transport is ~£0/min, so this bounds a household's cost at roughly its fixed cost.
6. **Abuse rejection** is limited to patterns that are not ordinary calls: forwarding loops (caller is an HCG number), call floods (burst), a single caller hammering the line, and more than N simultaneous calls. Even these can collide with a genuine call during an attack; that residual risk is stated, not hidden.
7. **Suspension or cancellation only after forwarding is verified removed.** See below.

### Hard requirement: never stop delivering while forwarding points at HCG

The safe mechanism needed before any automatic hard cap or suspension:

- **(a) Forwarding-state verification.**
  - HCG places a verification call to the customer's mobile. If it arrives back at the HCG number, forwarding is still active; if it rings the handset, forwarding is off.
  - HCG already has this mechanism: `services/forwardingVerification.js` on `integration/mobile-app-onboarding`.
  - Or use the operator **CAMARA Call Forwarding Signal** API. UK operators announced CAMARA collaboration; per-operator availability of this API is **unconfirmed (QUOTE)**.
- **(b) Hand-back flow.**
  - The customer is shown the exact cancel code (`##21#`) and a one-tap dial where the OS allows.
  - HCG keeps delivering in transport-only mode until (a) confirms removal.
  - Escalating reminders; a grace period (e.g. 30 days, DECISION); the number is then quarantined, not released, until verified or expired.
- **(c)** Only after (a) confirms "not forwarding" may HCG stop answering the number.
- **(d) An automatic hard £ cap may only ever switch a household to transport-only.** It may **never** refuse ordinary calls.

**Correction needed to HCG's unmerged `feature/financial-safety-hard-limits`.** Its admission rules `household_daily_hard`, `household_period_hard`, `household_period_unknown_block` and `company_hard_unknown_block` refuse ordinary calls while forwarding is live. They must become "switch to transport-only + alert". Keep refusals only for loop / burst / caller-flood / concurrency patterns. Not changed tonight (research only).

## 4. Carrier-side target architecture

```
TRUSTED CALLER → ordinary network → customer handset      (HCG not in the path, £0 to HCG)
UNKNOWN CALLER → network diverts → HCG → protection → customer
```

This needs **one** of:
- **N1: IMS terminating application server hook.** The operator's S-CSCF invokes an HCG-controlled (or operator-hosted, HCG-fed) application server for opted-in subscribers. It is in **redirect/proxy mode**, not a media B2BUA, so trusted calls continue natively and unknown calls are redirected to HCG. Default handling: *continue* (fail open to normal delivery).
- **N2: selective call diversion with identity conditions.** 3GPP TS 24.604 CDIV with `identity`/`anonymous` conditions: "divert all except these callers" to HCG. The operator exposes the rule to HCG through an API (Ut/XCAP is normally not exposed to third parties). GSMA IR.92 leaves conditions to operator choice, so this is an operator ask.
- **N3: MVNO/MVNE core** (Cloud9/Wireless Logic, aql, eSIM Go). N1 or N2 logic inside the MVNE's own core. The customer switches SIM but keeps their number by porting (PAC). Works on iPhone and Android with no app involvement for trusted calls, but changes the product into a mobile-plan proposition.

In all three, HCG's **return leg** must not re-trigger the divert (loop). It needs a bypass marker: a trunk/PAI identity the AS or iFC excludes, or a routing prefix. The original caller ID must also be presented to the handset.

The specification to send is `CARRIER_TECHNICAL_SPEC.md`. It is deliberately silent on *how* HCG detects scams, because three of the recipients sell competing products.

**Commercial ceiling for any carrier offer:** ≤ £1.22 (£4.99) / £1.62 (£5.99) / £2.03 (£6.99) / £2.43 (£7.99) per subscriber per month at a 40% margin (central mix).

## 5. Decision

### GO: viable with today's buildable architecture
All three must hold:
- **Price ≥ £6.99**, on **A4** (free-inbound UK SIP numbers + HCG-hosted delivery). It's usage-independent: ~40% margin at £6.99 even with £2 retail numbers, and 35% in the stress mix.
- A 1,000-subscriber **pilot measures** average HCG cost per subscriber **≤ £2.77 at £6.99** (≤ £2.36 at £5.99; ≤ £1.96 at £4.99) for 40%.
- The HCG-hosted delivery stack matches Twilio's delivery reliability on **both** iPhone and Android: measured approved-call ring success ≥ 99% (DECISION on the exact bar), and no loss of caller ID.

Staying on Twilio (A1) is a GO **only at £9.99** (central 46%, stress 17%), or at £6.99 only if measured usage looks like the light mix (≤ ~£2.77/sub; roughly average trusted ≤ 119 min/month).

### GO IF: viable only if specific pricing or capability is confirmed
- **Wholesale numbers ≤ £1.20/month at £4.99, ≤ £1.60 at £5.99, ≤ £2.01 at £6.99**, with free inbound confirmed in writing at 1–10k numbers and ≥ 3M min/month (Magrathea, Sipflex, sipgate, Gamma quotes). At ≤ £1.00, A4 reaches ≈ 45–57% at £4.99–£6.99.
- **Or a carrier/MVNE route (A5) at ≤ £1.22 / £1.62 / £2.03 per subscriber per month** (£4.99 / £5.99 / £6.99, 40%), with N1 or N2 behaviour, fail-open default handling, loop-safe return and caller-ID preservation.
- **Or Twilio commits in writing** to £0 app-leg billing plus committed-use inbound at ≤ ~£0.003/min. That's the price at which A1 roughly matches A4 at central usage (QUOTE).
- In every case: **Apple Small Business Program enrolment confirmed** (15%, not 30%). At 30%, every tolerable figure above falls by ~£0.6–£1.2.

### STOP / PIVOT triggers (measurable)
1. **Usage:** pilot-measured average forwarded minutes per subscriber put HCG's cost above the tolerable figure for the chosen price and architecture (e.g. > £2.77 at £6.99 / 40%), **and** neither A4 nor A5 can be delivered within 6 months (DECISION).
2. **Quotes:** no wholesale number ≤ £2.01/month (at £6.99) **and** no carrier/MVNE route ≤ £2.03/sub (at £6.99) **and** no Twilio committed pricing ≤ ~£0.003/min. Then the consumer model is not viable below ~£9.99 and HCG should pivot (see below).
3. **Delivery quality:** the forwarded-call model cannot reach the agreed ring-success bar (e.g. ≥ 99%) on both platforms. The existing launch gate on screened-call quality stands.
4. **Differentiation:**
   - UK MNOs add **in-call conversational** scam detection to their £0–£2 products; or
   - Google/Apple on-device in-call detection covers a majority of the UK smartphone base (today only Pixel 9+/S26, off by default; nothing equivalent found on iPhone).
   - Then a £5–£10 standalone consumer subscription loses its reason to exist.
5. **Store fees:** Apple SBP unavailable **and** price < £6.99.

**Pivot options** if STOP triggers: (a) premium/family positioning at ≥ £9.99; (b) B2B2C: license the in-call protection engine to an MNO, MVNE or bank, where the network carries trusted calls by design; (c) HCG-branded MVNO (N3) where HCG owns routing.

## Data gaps to close (in order of value)
1. Real forwarded-minute distribution per subscriber: pilot, via the ledger/spend monitor already built.
2. Written quotes:
   - wholesale UK geographic numbers + free inbound at volume;
   - Twilio committed-use + app-leg guarantee;
   - Telnyx UK origination;
   - Plivo BYOC.
3. Carrier/MVNE answers to `CARRIER_TECHNICAL_SPEC.md`: N1/N2 support, fee, VoLTE on MVNE cores.
4. CAMARA Call Forwarding Signal availability per UK operator.
5. Apple SBP status.
6. Willingness to pay against a £2/month MNO anchor for pre-answer labelling. Not modelled; no data.

## Sources
- Ofcom Communications Market Report 2026 (146 outgoing min/month, 2025): https://www.ofcom.org.uk/siteassets/resources/documents/research-and-data/multi-sector/cmr/cmr26/communications-market-report-2026.pdf
- Ofcom fixed termination rate cap 0.0377p/min from 1 June 2026: https://www.ofcom.org.uk/siteassets/resources/documents/consultations/category-1-10-weeks/reviews-of-call-termination-markets-and-end-to-end-connectivity-condition/statement-documents/statement-reviews-of-call-termination-markets-and-end-to-end-connectivity-condition.pdf
- Plivo UK pricing: https://www.plivo.com/voice/pricing/gb/
- Twilio BYOC $0.004: https://www.twilio.com/en-us/changelog/bring-your-own-carrier-trunking-origination-price-reduced
- Telnyx Voice API pricing: https://telnyx.com/pricing/voice-api
- Telnyx deepfake detection: https://telnyx.com/products/deepfake-detection
- Sipflex: https://www.sipflex.co.uk/ and https://www.sipflex.co.uk/contact
- sipgate trunking: https://www.sipgatetrunking.co.uk/
- Magrathea: https://www.magrathea-telecom.co.uk/ and scam-call posts https://www.magrathea-telecom.co.uk/closing-the-loopholes-on-scam-callers/
- EE Scam Guard (Apr 2026): https://www.ispreview.co.uk/index.php/2026/04/ee-uk-launch-upgraded-ai-scam-guard-service-to-protect-mobile-users.html
- Vodafone Scam Call Protection: https://www.vodafone.co.uk/newscentre/press-release/ai-powered-scam-call-protection-secure-net/ and Hiya: https://www.businesswire.com/news/home/20260422082375/en/Vodafone-Warns-Customers-About-Scam-Calls-Before-They-Answer-Powered-by-Hiya
- VMO2 Call Defence: https://news.virginmediao2.co.uk/ai-helps-virgin-media-o2-detect-and-flag-1-billion-suspected-scam-and-spam-calls-to-customers/
- Google Scam Detection (UK, Pixel 9+): https://support.google.com/phoneapp/answer/15654065?hl=en-GB and https://9to5google.com/2026/02/25/google-messages-scam-detection-gemini/
- Three Wholesale MVNO partners: https://www.three.co.uk/wholesale/mvno-partnerships
- Cloud9 (MCC/MNC 234/18): https://en.wikipedia.org/wiki/Cloud9_(service_provider)
- eSIM Go UK MVNE: https://esimgo.com/knowledge-hub/newsroom/esim-go-and-csg-empower-uk-mobile-brands-with-real-time-subscriber-intelligence/
- CAMARA API overview (Call Forwarding Signal): https://camaraproject.org/api-overview/
