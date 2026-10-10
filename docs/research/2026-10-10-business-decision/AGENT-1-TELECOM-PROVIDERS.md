# Agent 1: telecom providers and wholesale partnerships (2026-10-10)

**Scope:** research only. No provider was contacted, nothing was bought or signed up for, and no HCG or Twilio API was called. All web pages were read on 2026-10-10 unless another date is given.
**Labels:** **CONFIRMED** = an official document or HCG's own test. **INDICATIVE** = third-party, forum, search snippet, or an older document. **NEEDS PROVIDER CONFIRMATION (NPC).**
**FX:** $1 = £0.756. This is the rate implied by HCG's invoice (Twilio $0.0100 billed as £0.00756).
**Reference household:** T = 150 trusted minutes and U = 40 monitored unknown minutes a month (the "typical" household in `docs/finance/HCG_UNIT_ECONOMICS_V1.md`). N = number of customers.

## 1. Summary for the founder

1. **HCG's biggest cost is paying for inbound minutes, and it is the easiest cost to fix.**
   - Twilio charges £0.00756 for every minute, family calls included.
   - Magrathea (proven), Sipflex, sipgate and Gamma deliver calls to a SIP server at £0 per minute.
2. **Magrathea is proven for HCG:**
   - 5 live calls, including a mobile-forwarded call carrying the forwarding phone's number in `Diversion` (9 Oct).
   - Free inbound and £0.50 per number.
   - **£100/month minimum**.
   - **No REFER** and **no P-Asserted-Identity on any call**.
3. **Lowest-change win (R1): Magrathea → Twilio BYOC ($0.004/min) → today's Voice SDK.** The typical household falls from **£2.63 to £1.39 a month**, or **£1.97** if Twilio bills the SDK leg at list price.
4. **Largest saving (R2): Magrathea plus HCG's own SIP/media server delivering to the app.**
   - About **£0.72 variable per customer**, with trusted minutes at £0.
   - Plus £250–£500/month fixed and on-call operations.
   - With honest ops costs, it loses money below about 2,500 customers.
5. **No CPaaS (Twilio, Telnyx, Plivo, Vonage, Sinch) offers a hard £ cap on inbound voice.**
   - Telnyx refuses inbound only when an account is "billing blocked", which stops delivery.
   - Free-inbound carriers with outbound barred bound the exposure **structurally**. That is the strongest limit available.
6. **Telnyx (about £0.0068/min) and Plivo (about £0.0067/min plus streaming) are not materially cheaper.** They are a hedge only.
7. **No provider can release a forwarded PSTN leg.** The trusted-call cost goes away only with free inbound plus app delivery, or with routing in a network core (MNO, MVNO or FMC).
8. **EE (£2), Vodafone (£2) and O2 (free) already sell pre-answer scam labelling** (Hiya at EE and Vodafone). None hears the conversation. An MNO partnership is a 12–24-month business-development track.
9. **AQL rate card missing — AQL comparison incomplete.**
   - Searched: all `call-ai-*` worktrees (docs, handovers, research, response-packs), `~/hcg-*`, and file names under `~`.
   - The only record is "Call held, rate card received". No AQL price is used here.
10. **Next:** send the §5 questions to Magrathea and Twilio, then run the §3a tests (each £0–£19). R1 vs R2 can be decided in about 2 weeks.

## 2. Provider matrix

Inbound prices are for calls to UK geographic or 03 numbers delivered to SIP or an API.

| Provider | UK inbound cost | Number cost | Capacity and minimum | Identity on forwarded calls | App delivery | AI media access | Hard spend controls | Fit for HCG | Evidence |
|---|---|---|---|---|---|---|---|---|---|
| **Twilio PV (today)** | $0.0100/min = £0.00756, whole call | Invoiced about £0.87/mo. **List page now shows local $3.50/mo, mobile $2.50** | Pay as you go, no minimum | `ForwardedFrom` only, depends on the carrier. Diversion and History-Info are not exposed on PSTN calls | Voice SDK (in production). SDK leg list $0.004/min, billed £0 to HCG so far | Media Streams $0.0044/min | **None** ("no maximum spend limit setting"). Suspension lets live calls finish | Incumbent; most expensive per minute | CONFIRMED (pricing page 2026-10-10; HCG invoice; containment audit 2026-10-04). Number list price vs invoice: NPC |
| **Twilio BYOC** | $0.0040/min receive | The carrier's number | Pay as you go | SIP INVITE from the carrier; which headers reach the webhook is NPC | Same Voice SDK | Same | None | **Best low-change route (R1)** | CONFIRMED price. SDK-leg billing on BYOC: NPC |
| **Magrathea** | **£0 to SIP** | **£0.50/mo**, 10 channels per number | **£100/mo contractual minimum** (written); 1-year terms on hosting | **Diversion = forwarding mobile (proven, Lebara)**. From/RPID `screen=yes`. **No PAI in 5/5 calls**. Network Mode "subject to agreement". No History-Info | None; needs HCG's own SIP stack or BYOC | Raw RTP at HCG's own server | Prepaid stops *new* chargeable calls, **not in-progress** ones. Inbound exposure about £0. No cap API | **Primary ingress (R1/R2)** | CONFIRMED (live trial; written answers in ticket LKV-51353-279; Annex 3 / Schedule 3) |
| **Sipflex (Cloud2Tel)** | **Free** | £2/mo | First channel free, then £1 per channel (period not stated); 30-day trial; no minimum stated | NPC | None (SIP) | Own server | "Spend and destination controls" listed, no detail | Backup ingress; 4× Magrathea's number price | CONFIRMED (sipflex.co.uk) |
| **sipgate trunking** | "No … charges for inbound calls" | 1 included on the developer plan; others NPC | Per trunk: £4.95 for 1 inbound concurrent call up to £149.95 for 50 | NPC | None | Own server | Not stated | Weak: priced per concurrent call | CONFIRMED (sipgatetrunking.co.uk) |
| **Simwood** | Wholesale; inbound charge not clearly published | £1.00–£1.50/DDI (hosted plans) | Channel pricing conflicts across documents | NPC | None | Own server | Prepaid; `maxcpm` per-call cap on PSTN forwards | Credible fraud-aware wholesaler; quote needed | INDICATIVE (simwood.com PDFs) |
| **Gamma** | 01/02/03 to Gamma SIP "inclusive" (G-Cloud rate card) | Partner price NPC | Via channel partners; MVNO on Three with its own Ericsson core | NPC | None | Own server | NPC | Ingress alternative; **MVNO/FMC route** | INDICATIVE (G-Cloud; trade press) |
| **AQL / BlueWave** | **AQL rate card missing** (no public list price either) | — | — | NPC | None | Own server | NPC | Hosts about 80M numbers; MNO status via BlueWave; Three MVNO partner; "routing within the mobile core" only for its own SIMs | **Incomplete**; INDICATIVE (aql.com) |
| **Telnyx** | Local or national $0.005; UK-mobile-range number $0.0032; + Voice API $0.002 + WebRTC $0.002 | $1/mo + $1 setup (local); $2 (mobile) | Pay as you go, or **channel billing Zone A $15→$10 per channel**: unlimited inbound, **busy on overflow** | `call.initiated` exposes the `Diversion` header; UK population NPC | WebRTC SDK, React Native, APNs/FCM push | Streaming $0.0035/min, RTP fork $0.0025 | International $700/day limit; billing-blocked account rejects inbound (D19). No general voice cap | Hedge (R3). Medium competitive risk (sells deepfake detection) | CONFIRMED (telnyx.com/pricing.md fetched 2026-10-10; support SIP codes) |
| **Plivo** | Local $0.0055, mobile $0.0075 | $0.85/mo local | Pay as you go; $10 credit | NPC | iOS/Android SDK with PushKit/FCM, $0.0033/min; React Native NPC | Streaming $0.003/min (the page also says "Included": conflict) | Prepaid credits; caps NPC | No better than Twilio as billed | CONFIRMED price page (May 2026 figures); streaming INDICATIVE |
| **Vonage** | UK rate not retrieved (page returned 403). Billed per second; inbound leg only when forwarding to SIP | NPC | Pay as you go | NPC | Client SDK | WebSocket | NPC | Unassessed | INDICATIVE (Vonage support articles) |
| **Sinch** | Generic page lists "receive $0.00/min"; UK not stated | NPC | Pay as you go; Elastic SIP | NPC | In-app SDK | NPC | NPC | **Worth one quote**: "$0 receive" if true for the UK | INDICATIVE |
| **Bandwidth / Voxbone, Colt, IDT, Daisy/Wavenet** | Rate card from an account team only | NPC | Enterprise commitments typical | NPC | Bandwidth has WebRTC; others SIP only | Own server | NPC | Low for a tiny start-up (high friction) | INDICATIVE |
| **Pure-IP** | Geographic inbound included | £0.15/mo per DDI | £16.95 per channel per month | NPC | None | Own server | NPC | Cheap-number comparable | INDICATIVE (G-Cloud snippet) |
| **BT IPX Type A / own Ofcom range** | FTR revenue 0.0377p/min only | Ofcom: free for most geographic codes; Magrathea hosting £500 setup + £100/mo per E1, 1-year minimum | 3-week Ofcom decision | As the host | — | — | — | Later, for independence; not a saving | CONFIRMED (Ofcom GCs; Magrathea Annex 7). FTR INDICATIVE |
| **Self-hosted (Kamailio/FreeSWITCH)** | £0 telecom | — | Own servers | Whatever the carrier sends | Own client plus VoIP push | Full | Inherent | R2 | CONFIRMED (E-SIP VM) |

**Number-pooling facts.** Pooling means serving many customers from one HCG number, identified per call by the forwarding line in `Diversion`.

| Provider | Diversion on forwarded calls | Capacity model | Pooling verdict |
|---|---|---|---|
| Magrathea | **Demonstrated** on 1 call (Lebara, `reason=unknown`, grade unverified); EE/VF/O2/Three untested | 10 concurrent calls **per number**; can be raised on a forecast (charges may apply) | Possible. Needs per-MNO proof, spoofing confirmation (Q3), and a raised channel cap, or a pool of numbers |
| Twilio PV | **Not exposed** (`ForwardedFrom` only, carrier-dependent) | Unmetered concurrency | **Not possible today**; keep one number per customer |
| Twilio BYOC | NPC (§5 Twilio Q2) | Carrier-side | Depends on the answer |
| Telnyx | Documented field in `call.initiated`; UK population NPC | Channel billing pooled per zone across numbers; overflow = busy | Possible on paper |
| Sipflex | NPC | Account channels (numbers add none) | NPC |
| sipgate | NPC | Concurrent calls per trunk | NPC |
| Plivo, Vonage, Sinch, Gamma, Simwood, AQL | NPC | NPC | NPC |

Magrathea Schedule 3 §5 bars disclosing the diverting identity to end users. Internal mapping is the stated purpose (CONFIRMED wording), but written confirmation is still required (Q3).

**Termination revenue:** not material.
- The geographic fixed termination rate is **0.0377p/min** from 1 June 2026, so 190,000 minutes a month (1,000 customers) is worth about **£72/month gross**.
- Magrathea passes it through only on hosting Option 2, at £500/month per E1, so the net is negative.
- Free-inbound sub-allocation passes none. Termination revenue is not a business model.

## 3. The three most promising routes, with cost formulas

HCG costs per month, excluding payment-processing fees and VAT. AI = Whisper £0.0047/min. "Media" = Twilio Media Streams £0.0033/min.

**Baseline (today, Twilio PV):**
`cost = N × [£0.87 + (T+U) × £0.00756 + U × (£0.0033 + £0.0047) + SMS × £0.042]`
Typical household: 0.87 + 1.44 + 0.32 = **£2.63** (excluding SMS). Exposure is unbounded per minute.

### R1. Magrathea free inbound → Twilio BYOC → existing Voice SDK (lowest change; about 2–4 weeks)

`cost = max(£100, £0.50N)* + N × [(T+U) × (£0.00302 + s) + U × (£0.00333 + £0.0047)]`

- `s` = the SDK leg: £0 as billed today, or £0.00302 at list.
- `*` if rentals don't count towards the minimum, the fixed term is £100 + £0.50N (NPC).

**Typical household:**

| | s = £0 | s = list |
|---|---|---|
| Per customer at N ≥ 200 | **£1.39** | £1.97 |
| Per customer at N = 50 | £2.89 | — |

- Breaks even with today at about 70–90 customers.
- **Gains:**
  - about 47% lower cost;
  - Diversion gives a passive "forwarding proven" signal (LF-2);
  - 10 calls per number bound each household's concurrency.
- **Unchanged:** Twilio is still unbounded per minute, and the master-token risk remains.

### R2. Magrathea (Sipflex standby) → HCG self-hosted SIP/media → own app client plus VoIP push (largest saving; 2–4 months of build)

`cost = £100 + F_infra (~£150–£400, INDICATIVE) + F_ops (on-call) + N × [£0.50 + U × £0.0047 + ~£0.03 push/bandwidth]`

- Typical variable cost is **£0.72 per customer**, with **trusted minutes at £0**.
- All-in, with F = £500: about **£1.22 per customer at N = 1,000**, and £3.22 at N = 200.
- The 2026-10-01 review found that, with honest ops costs, this loses money below about 2,500 customers.
- **Strongest hard limit:** inbound is £0, outbound is barred, and AI is capped by an OpenAI project hard limit (CONFIRMED available).
- **Risks:** HCG owns delivery reliability (PushKit, CallKit, ConnectionService) and 24/7 operations.

### R3. Telnyx full stack with channel billing (vendor hedge; 1–2 months)

`cost = C × £11.3→£7.6 + N × [£0.76 + (T+U) × £0.00302 + U × (£0.00265 + £0.0047)]`

- `C` is the peak channel count, about 0.015N (average concurrency is 0.0044N).
- At N = 1,000: about **£1.83 per customer**. Pay-per-minute instead: about £2.35.
- **Risks:**
  - overflow is **busy** (a failed trusted call);
  - whether channel billing covers Call Control/WebRTC is unknown;
  - there is no TeXML `<Client>`, and push would need a dual-SDK migration;
  - Telnyx sells deepfake detection, so it would learn HCG's design.
- Use R3 only if Twilio refuses BYOC SDK terms.

**Not shortlisted:**
- Plivo: no cheaper than Twilio.
- sipgate: priced per concurrent call.
- Vonage and Sinch: unpriced (get a quote; Sinch lists "$0 receive").
- MVNO SIMs: these change the customer's provider.

### 3a. Demonstrated failure vs missing evidence, and the smallest safe test per route

**Demonstrated (tested or written; do not re-test):**
- Magrathea **REFER unsupported** (written answer; `Allow` header on 5/5 calls).
- **PAI absent** on 5/5 trial calls. This is a trial-account fact; Network Mode under the agreement is untested.
- Prepaid limits **do not end live calls** (Magrathea, written).
- Twilio has **no hard spend cap** (Twilio documentation).
- Twilio PV **exposes no Diversion**.
- No provider releases a forwarded PSTN leg (documentation, 2026-09-30).
- Lebara: forwarding unsupported (written), and on the handset the registration was lost after one use.

**Missing evidence (not failures):**
- Diversion on EE/VF/O2/Three.
- Twilio BYOC SDK-leg billing and header exposure.
- Magrathea CDR debits, volume terms, Network Mode PAI.
- Telnyx channel-billing scope.
- Sipflex/Simwood headers.
- **All AQL figures.**

| Route | Smallest safe test (each needs Andrew's approval; attended; 60 s cap; outbound barred) | Cost bound |
|---|---|---|
| R1 Magrathea → Twilio BYOC | After Magrathea Q5: point the **trial DDI** at a BYOC trunk on an **isolated Twilio subaccount** (not the shared prod/staging account), with a TwiML `<Dial timeLimit=60><Client>` to one test handset, geo permissions off. Make 3 calls (1 direct, 1 forwarded, 1 withheld). Read webhook params for Diversion; read the invoice after 48 h for the Client-leg charge | < $0.10 Twilio; £0 Magrathea; VM < £0.25 |
| R1/R2 per-MNO identity | One 20 s forwarded call from an EE, a Vodafone, an O2 and a Three SIM to the trial DDI → E-SIP VM (`answer_hold`, 120 s cap; rebuild if torn down at the 10 Oct 12:00 UTC deadline) | VM pennies; each SIM's forwarding leg at its own tariff (record from the bill) |
| R2 self-hosted delivery | On the same VM, bridge the E-SIP call to one registered test softphone (no push), 3 calls; then one PushKit/FCM wake test | VM only, < £1 |
| R3 Telnyx | Prepaid account, auto-recharge **off**, $25 top-up, 1 UK local number, 1 channel-billed channel; 4 forwarded calls; confirm $0 per-call lines and Diversion | ≤ $25 (≈ £19), hard-bounded by the balance |
| Sipflex standby | 30-day free trial, 1 number → E-SIP; 1 direct + 1 forwarded call; capture headers | £0 |
| AQL | **No test** until the rate card is in the repo and AQL-8 is answered | £0 |

## 4. Network-level screening and MNO partnership assessment

**What UK MNOs actually sell (CONFIRMED unless marked):**

| MNO | Product | Price | Mechanism |
|---|---|---|---|
| EE (BT) | Scam Guard | £2/mo (was £1, then £1.50) | **Network-level Hiya** call labelling before answer, plus Norton app tools (choose.co.uk, 1 May 2026). *Repo correction:* the call part is Hiya, not Norton |
| VodafoneThree | Scam Call Protection (Secure Net) | £2/mo | Hiya pre-answer warning (Apr 2026); CAMARA Call Forwarding Signal (read-only) |
| VMO2 | Call Defence | Free | AI on number behaviour; about 70M calls/month labelled; blocks known fraud (Mar 2026) |
| Three UK | Spam-text blocking | — | No consumer **call** product verified (INDICATIVE) |

In late 2025 the operators committed to anti-spoofing upgrades, with rollout within 12 months (INDICATIVE).

**What this means:**
- **Every MNO product is pre-answer number reputation (Hiya at EE and Vodafone; O2 described as Hiya by one trade article, INDICATIVE). None hears the conversation.** HCG's live in-call AI complements them. Hiya is a direct competitor: do not approach.
- Networks *could* send unknown callers to HCG without any forwarding code (an IMS application server or a CDIV rule). No MNO publishes a partner API for this (INDICATIVE absence).
- **Realistic path:**
  - **(a) Now:** MNOs as distribution and verification partners only (CAMARA forwarding status).
  - **(b) 6–12 months:** pitch one MNO (VMO2, not yet engaged; free Call Defence leaves room for a premium layer) an in-call add-on for vulnerable customers. HCG needs real outcome data first.
  - **(c) 12+ months:** MVNO/FMC cores route **only SIMs they host**: Gamma (its own core on Three), Wireless Logic/Cloud9 (MNC 234/18), AQL/BlueWave, iQ Mobile (INDICATIVE). That means a SIM change and a port, so it fits an opt-in "HCG SIM" for carers, not the universal product.
  - **(d)** Magrathea's mobile product was "undergoing testing" in Aug 2026; nothing newer is public.
- **Onboarding friction for a tiny start-up is high:** due diligence, security questionnaires, revenue share and minimum volumes. Expect a cycle of at least 12 months.

## 5. Questions that need direct provider confirmation (drafts for Andrew; AQL: next scheduled contact only, not email)

**Magrathea (ticket LKV-51353-279):**
> 1. Does the £100/month live minimum include number rentals (£0.50/number)? Minimum term?
> 2. Please confirm inbound remains free for mobile-originated calls at 1,000–10,000 numbers and about 3M minutes/month, and when capacity-based charging would apply to numbers you allocate.
> 3. Under the Network Mode agreement, will INVITEs carry P-Asserted-Identity? Is RPID `screen=yes` set by you after verification? Can a VoIP-originated caller set From, RPID or Diversion values that reach us unchanged? May we use Diversion internally (never displayed) to map calls to customers on shared numbers?
> 4. Is `Diversion` populated on diverts from EE, Vodafone, O2 and Three subscribers, and does `reason=` ever carry the divert type? Can the 10-call limit per number be raised for a shared number, and at what price?
> 5. Can a number's SIP target be a Twilio BYOC termination URI, with TLS/SRTP?
> 6. Do you follow a 302 from our endpoint? Is any provider-assisted transfer available?
> 7. Live account: is the prepaid balance a hard stop for new chargeable calls? Is there a near-real-time balance or CDR API?
> 8. Receive-only service: is Schedule 5 (999) required?
> 9. What is the mobile product you are testing (SIMs, 07 numbers, porting, per-call routing API)?
> 10. Please send CDRs (duration, debit, inbound) for `6AC7DA6BAF3B522D`, `6AC7DE025F3BB2F9`, `6AC7DF255F3BD120`, `6AC8BAC7JF4CE809`.

**Twilio:**
> 1. On a BYOC trunk, is the `<Dial><Client>` Voice SDK leg billed, and at what rate? Our PV invoices show £0 for it; will that continue?
> 2. Which inbound SIP headers (Diversion, PAI, History-Info) reach the voice webhook on BYOC calls?
> 3. Is there any hard voice spend limit, or a documented maximum overrun after suspension?
> 4. Your GB page lists local numbers at $3.50/month; we pay about £0.87. Is a change scheduled?

**Telnyx:**
> 1. Does channel billing apply to UK numbers on Call Control apps delivering to WebRTC, and which per-minute fees remain?
> 2. Is Diversion populated on UK PSTN calls forwarded from EE, Vodafone, O2 and Three?
> 3. Can a hard monthly voice cap refuse new calls without ending live ones?

**Sipflex / Simwood / Gamma / Sinch / Vonage:**
> We need 1,000–10,000 UK geographic numbers receiving forwarded calls from UK mobiles (about 190 min/number/month, outbound barred), delivered to our SIP servers (Sinch/Vonage: also via your Voice API and in-app SDK). Please quote number rental, inbound per-minute and channel charges, the concurrency model, minimum commitment and term. Please also confirm whether you deliver the diverting party (Diversion or History-Info) and P-Asserted-Identity.

**AQL (at the next call):**
> AQL-8 (free-inbound DIDs plus caps) and the AQL-1 to AQL-7 routing questions. **Andrew to commit the September rate card to the repo.**

**Gamma / Wireless Logic (MVNO):**
> Can your core apply a per-subscriber "divert to SIP URI X unless the caller is on list L" rule before alerting the handset? Via what API, at what minimum volume and per-SIM fee? Does it work on iPhone with VoLTE?

## 6. Sources

**HCG (read-only):**
- `/Users/ad/call-ai-magrathea-trial/docs/carriers/{MAGRATHEA-LIVE-CALL-EVIDENCE.md, MAGRATHEA-TRANSFER-READINESS.md §0, MAGRATHEA-TRIAL-PLAN.md}`
- `/Users/ad/call-ai-carrier-routing-v2/research/carrier-routing-v2/{CARRIER_ROUTING_LAB.md, sources/*.md, response-pack/}`
- `/Users/ad/call-ai-viability/research/viability/{DECISION_PAPER.md, ARCHITECTURE_OPTIONS_SHARED_SPLIT_MVNO.md, CATASTROPHIC_RISK_REVIEW.md}`
- `/Users/ad/call-ai-research-2026-10-10/docs/{strategy/2026-10-10-ARCHITECTURE-REASSESSMENT.md, finance/HCG_UNIT_ECONOMICS_V1.md, integration/2026-10-04-PROVIDER_FINANCIAL_CONTAINMENT_FINAL.md}`
- AQL search: all `call-ai-*` worktrees, `~/hcg-*`, and file names under `~`. **No rate card was found.**

**Web (read 2026-10-10):**
- twilio.com/en-us/voice/pricing/gb
- telnyx.com/pricing.md (GB rows, Zone A, WebRTC, Refer)
- support.telnyx.com articles 4409457 (SIP codes D19/D39) and 8228452
- plivo.com/voice/pricing/gb/ and plivo.com/blog/new-audio-streaming
- sipflex.co.uk
- sipgatetrunking.co.uk
- cdn.simwood.com/docs/hosted_pricing.pdf
- api.support.vonage.com/hc/en-us/articles/204015203
- sinch.com/voice/pricing/
- G-Cloud service 352234188238614 (Gamma)
- mobilenewscwp.co.uk (Gamma on Three)
- portal.aql.com/telecoms/developers/
- btwholesale.com IPX datasheet
- ispreview.co.uk 2026/03 Ofcom termination caps
- choose.co.uk/news/2026/ee-scam-guard-ai-fraud-protection-price-rise/
- news.virginmediao2.co.uk (1 billion flagged)
- Magrathea and Ofcom documents: as listed in `sources/magrathea_number_hosting.md` (opened 2026-10-03)
