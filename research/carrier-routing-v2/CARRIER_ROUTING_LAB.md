# HCG Carrier & Routing Lab — v2

Research only, 2026-10-03. Nothing was contacted, tested, bought, changed or deployed. POC 1 and POC 2 are **not authorised** and were not run.

**Source of truth:** the decision report *HCG Next-Generation Telephony Architecture — Decision Report* (Claude Doc `758eb0cc-f638-4269-b3ce-327cddba8934`, final revision 2026-10-02). This lab deepens it; it does not replace it. Architecture IDs (A1–A12, C1–C3, G1–G8, R0–R6) are the report's.

Evidence labels: **PROVEN** (HCG production data or AOSP source), **PUBLISHED** (provider/standards page opened), **INFERRED** (reasoned from published facts), **UNKNOWN** (needs a provider answer or a physical test), **QUOTE** (only a supplier can price it).

---

## 1. Answer to the primary question

**Yes, but only if the trusted/unknown decision is taken before the call reaches any platform HCG pays for.** There are exactly three places that can do that, and none is proven yet:

| Decision point | Architectures | Trusted call on HCG's bill? | Customer keeps SIM? | Status |
|---|---|---|---|---|
| The customer's **handset**, with the network forwarding only declined/silenced calls (conditional forwarding) | A3 Android, A4 iPhone, A12 | No | Yes | UNKNOWN: needs POC 1 per network/handset |
| The **mobile core that hosts the number** (full MVNO, FMC SIM, Telnyx Mobile Voice) | A6, A7, A9 | No, if the core decides in signalling and does not anchor media | **No: new SIM + port** | UNKNOWN: needs provider answers, then POC 2 |
| The customer's **own MNO** applying caller-based diversion (3GPP CDIV `cp:identity`, or an IMS terminating AS) | A10 | No | Yes | Not offered by any UK MNO (PUBLISHED absence); partnership ask only |

Every other design (Telnyx, BYOC, SIP edge, own number range, REFER, number hosting) changes **who** carries the trusted leg or **what it costs per minute**. None removes it.

### Why: the one-line rule

> Once a trusted call terminates on a platform HCG pays for, getting it back to the customer's handset needs a **new leg**, because the handset is reachable only through (a) the same number, which forwards back to HCG (loop, PROVEN 15 Aug 2026 and 21 Sep 2026), or (b) another identity (the app's VoIP client, or a second number), which is a leg on HCG's account.

### Why SIP REFER (or a 3xx redirect) is never the lever here

| Forwarding mode | What a trusted call does at HCG | What REFER/302 to the customer's mobile would do |
|---|---|---|
| **Unconditional (**21*)** — today | Arrives at HCG for every caller | Re-enters the customer's number → forwards to HCG again → **loop**. Even if a provider honoured the REFER and left the path (no CPaaS documents this for PSTN-originated calls), there is nowhere to send the call. |
| **Conditional (CFB / CFNRy)** — A3/A4 | Trusted calls normally never arrive. They arrive only when the customer is genuinely busy or doesn't answer | The handset is still busy / still not answering → network forwards to HCG again → **loop**. The right handling is `<Reject>` (unbilled) or a message, not a transfer. |
| **Ported/hosted number** — N1 below | HCG's host is the number's home | The customer's SIM no longer holds that number; REFER needs a different destination identity → a new paid leg or a second number. |

So REFER only matters for **where the unknown-call media lives**, never for trusted-call cost. This matches the 2026-09-30 doc-verified finding that Twilio REFER keeps Twilio as pivot (both legs billed), Telnyx transfer keeps both PSTN legs, and SignalWire/Bandwidth release only SIP-originated calls.

---

## 2. Area findings

### 2.1 AQL

AQL said HCG's use case aligns with "programmable diversion, number-level routing, routing within the mobile core, SIP ingress/egress". All four are things a host network does **to numbers and SIMs it hosts** (INFERRED from aql's published products: number hosting on its own switch, a licensed MNO via BlueWave, Three Wholesale MVNO partner). A call to an EE number is routed by EE's core; nobody else sees it before EE's forwarding rules run.

So aql can be one of three things:

| Model | What aql does | Effect on trusted cost | Customer change |
|---|---|---|---|
| **C1** aql/BlueWave SIM, number ported in | Core decides per call; trusted delivered natively | **£0 if signalling-only (AQL-2/3)** | New SIM + port |
| **C2** aql as HCG's SIP ingress under **21* | Cheaper unknown-path ingress | None (trusted still delivered by HCG over VoIP) | None |
| **C3** aql as ingress for A3/A4 (conditional forwarding) | Cheaper unknown-path ingress | £0 trusted, but because of the handset, not aql | None |

The answer-evaluation matrix is the `AQL` block of the response pack (`response-pack/rules.mjs`): eight questions, each answer mapped to capability, architectures and POC 1 effect. **Only AQL-1 = YES removes POC 1**; the research expects NO. Do not send aql another email; the pack exists so the reply can be classified the day it arrives, and follow-ups are drafts for Andrew.

### 2.2 Magrathea

Magrathea is a UK range holder and wholesale carrier. Its value to HCG is on the **unknown path and number cost**, not the trusted path. Public documentation (2026-10-03, `sources/magrathea_number_hosting.md`):

| Finding | Status | HCG relevance |
|---|---|---|
| Inbound to Magrathea UK geographic numbers is free; £0.50/number/month; 10 concurrent channels per number; £100/month minimum; may move heavy-traffic ported numbers to capacity charging | PUBLISHED (Annex 3 v6.0, undated, linked from live client page) | Free-inbound ingress for forwarded unknown calls into HCG's own SIP edge → removes Twilio's £0.00756/min **on the unknown path only**; per-number channel limit is an external bound |
| "Network Mode" (default since 2025 handbook) can deliver P-Asserted-Identity and the last diverted line identity (Diversion number); CDRs carry an LDLI field | PUBLISHED | The diverting-line identity Twilio never exposes (PROVEN 184/184). Would enable shared numbers (G3). Whether UK MNOs populate it on forwarded calls: UNKNOWN until a live capture |
| Routing is static per number (API-managed, real-time, up to 3 timed failover targets); no pre-answer per-call webhook documented; forwarding to a phone number = £100+ setup plus prepaid minutes | PUBLISHED | No per-call decision point upstream of HCG; an onward PSTN leg is billed to the number holder |
| Hosting an HCG-owned Ofcom range: ≥ £500 setup, ≥ £100/month, 1-year term | PUBLISHED | **No per-minute saving** over Magrathea's own sub-allocated numbers; value is provider-independent identity only |
| No mobile-number porting documented; a mobile product is in testing (Aug 2026 newsletter), scope unknown | PUBLISHED / UNKNOWN | Possible future SIM-route partner or competitor; ask (MAG-5) |
| No anti-scam consumer product found | PUBLISHED absence | Competitive risk low–medium (unchanged) |

Remaining questions are the `MAGRATHEA` block of the response pack (MAG-1…MAG-6). None affects POC 1. MAG-4 (pre-answer redirect + release) would only help where the onward destination does not forward back to HCG — never under **21*.

### 2.3 Telnyx

**There are no written notes of what Telnyx said at the 30 Sep 2026 meeting anywhere in the repository or local notes.** The only recorded outcomes are Andrew's statements in later briefs: "Telnyx documentation has confirmed that Call Control transfer keeps both PSTN legs active" and "do not rely on what the Telnyx salesperson told us". The reconciliation below is therefore against documentation; the `TELNYX` block of the response pack is where the meeting's answers should be recorded and then confirmed in writing.

| Topic | What the documentation supports | Trusted-cost effect |
|---|---|---|
| UK origination | **Published** (correcting the 2026-09 "not published" finding): $0.005/min to a UK local/national number (HCG's forwarding-number type), $0.0032/min to a UK mobile number ([telnyx.com/pricing.md](https://telnyx.com/pricing.md), 2026-10-03) | Telnyx Call Control + WebRTC on a local number ≈ $0.009/min (£0.0067) vs Twilio £0.00756 billed: ~11% cheaper, same legs |
| Channel billing | UK is in Zone A: $15/channel/month (0–10) falling to $10 (250+). Channel-billed calls show $0 origination; Voice API $0.002 and WebRTC $0.002 per minute listed separately (INFERRED to remain). Above the channel count new calls get "User Busy" (PUBLISHED) | **Reduces** the rate of the trusted leg; does not remove it. Break-even ≈ 4,700 min/channel/month at mobile-number rates. Overflow = busy to a forwarded caller → conflicts with "never stop delivery while forwarding points at HCG" unless sized for peak with headroom. |
| WebRTC / SDK | App leg $0.002/min list; TeXML has no `<Client>`; RN push support to confirm | Moves the app leg from Twilio to Telnyx. Same leg count. |
| Call Control | `transfer`/`bridge` create a new outbound leg (A→C); both billed (INFERRED from docs) | Adds a leg if used for trusted calls |
| Refer | $0.10 per invocation; SIP-address targets only; PSTN-originated applicability UNKNOWN | None: see § 1 (REFER is never the lever) |
| Reject before answer | TeXML `<Reject>` "will incur no cost" (PUBLISHED) | Leakage under CFB/CFNRy can be free on Telnyx too |
| Forwarding signals | `call.initiated` exposes Diversion and User-to-User headers, not History-Info | Possible household identification (shared numbers) if UK MNOs send Diversion: UNKNOWN |
| Streaming | WebSocket $0.0035/min; raw RTP fork $0.0025/min | Unknown path only |
| Forwarded loop | Same as Twilio: a PSTN return to a CFU-forwarding number loops | — |
| Busy / no-answer | Under CFB/CFNRy trusted calls only leak in when busy; reject before answer | Leakage cost only |
| **Mobile Voice** (programmable VoLTE SIM/eSIM) | Native ringing; per-number conditional forwarding to SIP/Call Control; the OpenAPI `MobilePhoneNumber` schema has `inbound.interception_app_id` ("the app that will intercept inbound calls") — a pre-ring hook candidate, behaviour and billing undocumented; $5/SIM/month (US section); VoLTE beta; UK SIMs / 07 porting / iPhone UNKNOWN | **The only Telnyx product that could remove the trusted leg**, and only by becoming the customer's mobile service (A6) |

**What would actually reduce trusted cost on Telnyx:** only Mobile Voice with a pre-ring webhook (TEL-3/4/5 all YES). Everything else — origination rate, channel billing, WebRTC, refer — makes the same legs cheaper or moves them. Full documentation findings with sources: `sources/telnyx_twilio_docs.md`.

### 2.4 Twilio — the precise current limitation

| Item | Fact | Evidence |
|---|---|---|
| Trusted call legs today | Parent inbound PSTN leg + child `<Dial><Client>` leg | PROVEN (call CA43b447…, 2026-09-12) |
| Billing | Parent £0.00756 per **started** minute for the whole conversation (239 s → 4 × £0.00756 = £0.03024); child £0 on invoice (list $0.004/min, permanence UNKNOWN) | PROVEN |
| Why it can't end early | **21* sends every call to Twilio; the only PSTN route back to the handset is the forwarding number (loop). `<Refer>` is SIP-only; REFER from PSTN-originated calls keeps Twilio as pivot and bills both legs | PUBLISHED (Twilio docs, verified 2026-09-30). Elastic SIP Trunking: a 302 from HCG's SBC makes Twilio re-INVITE from its side, one redirect only, so Twilio stays in path (PUBLISHED/INFERRED, 2026-10-03) |
| Household identification | `ForwardedFrom` = HCG's own Twilio number on 184/184 calls → one number per household | PROVEN |
| Unbilled path | `<Reject>` as first verb is not billed | PUBLISHED (to confirm on forwarded calls: TWI-2) |

**Provider-side capability that could alter it:** none found inside Twilio. Twilio has no mobile-core product (Super SIM → KORE, data-only). "Decide upstream on the carrier/SIP side" can only mean the handset (U1), the number's host core (U2), or an HCG SIP edge before Twilio (U3), and only U1/U2 remove the trusted leg. TWI-1 asks Twilio to name the arrangement; a named carrier arrangement acting before the customer's MNO would remove POC 1, and none is known.

### 2.5 UK network operators

| Network | Hook HCG would need | Exists as a product? | Realistic route |
|---|---|---|---|
| BT/EE | Opt-in CDIV "divert unless caller ∈ list; always divert anonymous" managed by partner API, or a terminating IMS AS (redirecting, not B2BUA) with iFC DefaultHandling = SESSION_CONTINUED | No (PUBLISHED absence); EE sells Scam Guard (pre-answer labelling) | Partnership only; competitive risk HIGH |
| VodafoneThree | Same | No; Vodafone Scam Call Protection (Hiya). CAMARA Call Forwarding Signal in catalogue (status read only) | Same; Call Forwarding Signal useful for verification today |
| Virgin Media O2 | Same | No; O2 Call Defence | Same |

**Theoretical vs realistic:** 3GPP TS 24.604 §4.9.1.3 supports `cp:identity` and `anonymous` conditions, so caller-based diversion is standard IMS capability. GSMA IR.92 §2.3.8 leaves those conditions to the operator, and no UK MNO exposes them to consumers or partners. Wholesale integration (an AS on the MNO's IMS) is a carrier project with security certification and commercial terms (QUOTE), not an API sign-up. The full ask is already written: `research/viability/CARRIER_TECHNICAL_SPEC.md` (branch `research/commercial-network-viability`).

What an MNO **can** realistically tell HCG now, cheaply, is how its network treats a handset decline with CFB set (MNO-2). That narrows POC 1's network half without removing the handset/Apple halves.

### 2.6 Number hosting, ranges, porting, provider-independent identity

| Option | What HCG controls | Trusted-call effect | Main value |
|---|---|---|---|
| **G2 Own Ofcom geographic range, hosted by Magrathea or similar** | Routing of HCG's forwarding numbers; carrier choice behind them (numbers stay with the range, so HCG can move host without customers re-forwarding) | None (still a forwarding target) | **Provider-independent forwarding identity** → future carrier migration without customer action. Eligibility: any provider (or intending provider within 6 months) of a public network/service; Ofcom decides within 3 weeks; unused numbers withdrawable after 6 months (PUBLISHED). Magrathea hosting ≥ £500 setup + ≥ £100/month, 1-year term: no per-number saving vs wholesale DIDs at £0.50 |
| **Wholesale DIDs** (Magrathea £0.50/month published; Sipflex/sipgate £2.00 retail; aql QUOTE) | Routing to HCG SIP | None | Free inbound; cheaper unknown path; at £0.50 already below the earlier "own range ~£0.10–£1.20" thresholds that mattered for margin |
| **Own 07 mobile range** | — | — | Mobile ranges are reserved for wireless mobile services: HCG would effectively have to be a mobile operator (INFERRED from Ofcom numbering rules) |
| **Port HCG's existing Twilio numbers out** | Same as above | None | Avoids asking customers to re-forward during a provider move (portability of singly bought Twilio GB numbers: UNKNOWN) |
| **N1: customer ports their own 07 to an HCG-controlled VoIP host** (possible: e.g. A&A ports mobile numbers onto SIP by PAC, ~1 working day, £12 + £1.80/month; Magrathea documents no mobile port-in) | Routing of the customer's public number, before any MNO | **Moves the leg, doesn't remove it.** The customer's SIM loses that number, so trusted calls must be delivered onward by VoIP (app) or to a second number — a leg HCG pays, and calls no longer arrive natively on the SIM | Not recommended: breaks "trusted calls arrive in the native dialler" and makes HCG the customer's number provider |
| **Shared HCG numbers (G3)** | — | None | Only with diverting identity in signalling (MAG-3/TWI-3); fail-closed risk |

**Conclusion:** hosting, ranges and porting give HCG **identity and carrier independence** for the unknown path, and lower its fixed cost. They are worth doing for any architecture, but they are not a trusted-cost lever. The only "hosting" that puts trusted calls on £0 is hosting the **SIM**, not the number (§ 2.7).

### 2.7 FMC / MVNO / SIM routes: does HCG stop being a £5–£7 add-on?

**Yes.** Every SIM route that keeps trusted calls off HCG's bill (A6, A7, A9) makes HCG, or its partner, the customer's mobile provider. The product changes as follows:

| Dimension | Add-on today (A1, or A3/A4) | SIM route (A6/A7/A9) |
|---|---|---|
| What the customer buys | Protection on their existing line | A SIM-only mobile plan with protection built in |
| Customer steps | Install app, set one forwarding code | Order SIM/eSIM → install → text-to-switch/PAC port (Ofcom: port completes in about 1 working day) → leave current network's airtime deal (early termination charges may apply; handset finance stays with old network) → install app |
| Number | Unchanged | Kept by porting (07 port-in by the partner: UNKNOWN for aql, PUBLISHED "mobile" for iQ Mobile) |
| iPhone | App only | Needs Apple carrier settings for the host network (VoLTE/Wi-Fi Calling); eSIM activation flow depends on partner |
| Trusted route economics | £0.00756/min today (A1) or £0 if POC 1 passes | £0/min if signalling-only; per-SIM wholesale + airtime instead (QUOTE) |
| Monitoring route | Forwarding → HCG number | Core diverts unknown calls over SIP to HCG (egress QUOTE) |
| HCG revenue/cost lines | Subscription; telephony per minute | Subscription **plus airtime**; SIM fees, airtime wholesale, possibly mobile termination revenue (cap 0.504p/min from June 2026) |
| Regulation | Light (app + call handling) | Ofcom General Conditions for a consumer mobile provider: contract summaries, switching, billing accuracy, vulnerable customers, 999/112 access, number portability obligations (via partner or directly) |
| Operational burden | App support | SIM logistics/eSIM provisioning, porting failures, coverage complaints (host network), roaming, credit control and bad debt, premium-rate/international fraud, number port-out, lost/stolen SIMs |
| Price | £4.99–£6.99 add-on | Must cover airtime: priced as a SIM-only plan, not an add-on (market comparison not researched here) |

The SIM route is a **different business**, not a cheaper back-end for the same one. It is credible only as (a) HCG partnering with an MVNO that sells the SIM while HCG supplies protection via the per-call hook, or (b) a deliberate pivot to "scam-safe mobile plan for older customers". Either is a business decision POC 2 cannot make.

### 2.8 Android and 2.9 iPhone

See `POC1_SPEC.md` (POC 1 design, not run).

---

## 3. Economic model

`economics/legs-model.mjs` compares architectures by the **number of chargeable legs and how long each is billed**, not by customer behaviour. Rates live in one table with status and source; `null` means QUOTE and is reported as "≥ known part + QUOTE", never as zero. Quotes are inserted with `--rates quotes.json` (keys listed in `MODEL_OUTPUT.md`). Tests (`legs-model.test.mjs`, 7) check it reproduces the decision report's figures and the 239-s real call.

Headline (rates as of 2026-10-03; `MODEL_OUTPUT.md` has the full tables):

| Architecture | Trusted legs on HCG account | Trusted £/min | 100 / 200 / 400 trusted min/sub at 10k subs (illustration) |
|---|---|---|---|
| A1 today | 2 | £0.0076 | £7,560 / £15,120 / £30,240 |
| A1 if SDK leg billed at list | 2 | £0.0106 | £10,560 / £21,120 / £42,240 |
| A2 Telnyx per-minute (UK local number, list) | 3 | £0.0067 | £6,750 / £13,500 / £27,000 |
| A11 SIP + BYOC | 3 | £0.0030 | £3,000 / £6,000 / £12,000 |
| A11 + HCG-owned media | 3 | ~£0.0004 + fixed platform | £400 / £800 / £1,600 + platform |
| A3/A4, A12, A7/A9 signalling-only, A10 | 0 | £0 | £0 |
| A9 media anchored | 1 | QUOTE | QUOTE |

The minutes are the report's illustrations, **not** HCG usage forecasts. The shape is what matters: per-minute architectures scale linearly with trusted minutes, which HCG cannot cap without breaking delivery; zero-leg architectures move the cost to fixed lines (number, SIM, MNO fee) that HCG can bound.

---

## 4. Operations at 10,000 customers

Viable architectures only (A1 shown as the baseline). "External bound" = a limit enforced by a provider, not HCG code.

| Dimension | A1 / A11 (forward everything) | A3 Android + A4 iPhone (handset decides) | A7 / A9 / A6 (SIM route) | A10 (MNO hook) |
|---|---|---|---|---|
| Number provisioning | 1 HCG number per household (Twilio today; own range would cut cost) | Same, numbers receive unknown calls only | Partner provisions SIM; HCG needs SIP egress target per sub (or one target + header) | 1 HCG target per household |
| Porting | None (customer); HCG numbers portable only if bought portable | None | **Every customer ports**; port failures and port-outs are HCG's (or partner's) support | None |
| Support burden | Forwarding codes (MMI unreliable on Three/giffgaff) | Higher: two OS behaviours, conditional codes, screening role (Android), three iOS settings HCG can't read | Highest: mobile-provider support (coverage, SIM, billing, porting) | Lowest |
| Fraud controls | Inbound abuse floods; Twilio master-token risk | Same for unknown calls; trusted callers can't flood HCG | Plus customer airtime fraud (premium, international, roaming), SIM swap; needs wholesale bars and credit limits | Same as A3 for the unknown path |
| Resilience | HCG/Twilio outage = every call fails (no fail-open under **21*) | **Fail-open**: screening crash/timeout → phone rings normally; HCG outage only affects unknown calls | Core fail-open if iFC default = continue; HCG outage → calls ring natively | Fail-open per carrier spec R7 |
| Emergency failure mode | If forwarding target dead, callers can't reach customer at all | Customer can always receive trusted calls natively; unknown calls fail only if HCG target dead | Customer's 999 and inbound depend on the partner network (as any MVNO) | Network-native |
| Carrier lock-in | CPaaS lock-in (44 backend files + SDK); own range reduces it | Low: any ingress works for unknown calls | **High**: customers' numbers live on the partner core | Per-MNO contracts, four of them |
| Observability | Full CDRs on every call | Unknown calls only; trusted calls invisible to HCG (by design). Leakage visible as `<Reject>`s. Role/forwarding health must be reported by the app | Partner CDRs/events required (spec R10) | Per-MNO events (spec R10) |
| Reconciliation | Twilio usage vs call rows | Same, fewer rows | Partner per-SIM invoices + airtime + HCG usage | MNO per-sub fee + unknown-path usage |
| Unit economics | Linear in trusted minutes (uncapped) | Fixed number + unknown minutes only | Fixed per SIM + airtime margin (QUOTE) | Fixed per-sub fee (QUOTE) + unknown |
| Migration complexity from today | — | Customer changes **21* → **67*/**61* (+ iPhone settings); new Android screening service; app health reporting | Customer switches network; HCG integrates partner core; new product | Customer opts in; HCG integrates four MNO APIs |

---

## 5. Remaining unknowns (ranked by decision impact)

1. Does each UK network apply CFB to a handset decline (486/603 over VoLTE/VoWiFi, UDUB on 2G)? → POC 1 / MNO-2 / AQL-7.
2. Does iPhone Silence Unknown Callers produce a decline (CFB), a silent ring (CFNRy) or neither? → POC 1 (E2).
3. Does any provider offer a per-call pre-ring hook for consumer SIMs without anchoring media, with 07 port-in and iPhone carrier settings? → AQL-2…6, FMC-1…4, TEL-3…5.
4. Is the Twilio SDK leg billed on BYOC calls, and is today's £0 permanent? → TWI-4 (moves every app-delivery route).
5. Will any UK MNO expose caller-based diversion? → MNO-1 (expected no).
6. Whether UK MNOs populate the diverting identity on forwarded calls (Magrathea Network Mode can deliver it) → MAG-3 / live capture. Own-range hosting is now priced (≥ £500 + £100/month) and gives no per-number saving.
7. What Telnyx actually said on 30 Sep → record in the TELNYX block and confirm in writing.
