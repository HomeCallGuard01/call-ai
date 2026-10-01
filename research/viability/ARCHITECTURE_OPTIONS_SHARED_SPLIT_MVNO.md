# Shared numbers, split routing and MVNO/MVNE: investigation and model re-run

Research only, 2026-10-01. No production changes, no testing against production, no handset tests. The provisional price is **unchanged and not decided**.

| Item | Location |
|---|---|
| Model | `number-sharing-rerun.js` (uses `subscription-design.js`) |
| Output | `NUMBER_SHARING_OUTPUT.md` |

Evidence labels: **PROVEN**, **STRONG**, **LIKELY**, **UNCONF** (unconfirmed), **ASM** (assumption).

## Summary

1. **Shared numbers cannot work on HCG's current Twilio PSTN ingress. PROVEN from HCG's own production data.** All 184 genuine forwarded calls (2026-09-08 read-only check, `APP_DECISION_008`) carried `ForwardedFrom` = the Twilio number itself, never the customer's diverting line. No other Twilio Call field carries it.
2. **The UK standard says the information should exist. PUBLISHED: NICC ND1016 v6.1.1, RULE CLI TERM 5.**
   - A diverting network "shall provide the original caller's CLI Information without modification. In addition, a line identity that represents the identity of the line from which the call was diverted shall be provided; this shall have the characteristics of a Network Number."
   - In UK SIP interconnect the Network Number is normally carried in `P-Asserted-Identity`, with History-Info/Diversion possibly also present.
   - **Whether EE, Vodafone, O2 and Three actually supply it on mobile call-forwarding, and whether it survives to a SIP ingress HCG controls, is UNCONF.** Twilio evidently doesn't surface it.
3. **Shared numbers would need an HCG-controlled SIP edge proxy** in front of Twilio:
   - it reads the network-asserted diverting identity;
   - it maps the identity to a household and **fails closed** if absent;
   - it passes a signed `X-` header to Twilio BYOC (Twilio exposes custom `X-` SIP headers to the webhook; header pass-through on BYOC is QUOTE).
4. **There's a better route to the same cost: HCG's own Ofcom number range.**
   - Ofcom charges **10p per number per year, and only in ~30 scarce area codes** (PUBLISHED); otherwise allocation is free.
   - Magrathea offers **number hosting for operator-owned ranges, managed by API** (PUBLISHED; price QUOTE).
   - Per-household numbers at pennies, with **no identification risk**, keeping the per-number channel cap as an external per-household bound.
   - Requires HCG to obtain an allocation as a communications provider (block of 1,000) and a hosting contract (UNCONF feasibility and lead time).
5. **Split routing (classify before Twilio) cannot deliver trusted calls back over the PSTN. PROVEN by the forwarding loop**: the customer's own number forwards unconditionally. Trusted calls still need app (VoIP) delivery.
   - Classification itself is nearly free: carrier inbound £0, signalling-only proxy.
   - It only *saves* money if trusted calls then avoid Twilio's app leg, which means HCG-owned media (Option C), with the complexity and dual-SDK risk already documented.
   - **Its practical value is as the SIP edge for shared numbers and for edge-level containment, not as a cost saver.**
6. **MVNO/MVNE is the only route that classifies inside the network.** Customers **can keep their numbers by porting** (Ofcom switching rules; text-to-switch), but they **must change network/SIM**, which makes HCG a mobile provider.
   - iPhone VoLTE/Wi-Fi calling depends on Apple carrier settings for the MVNO's network (UNCONF per partner). With 3G switched off that's material.
   - Possible upside (LIKELY, UNCONF): a full MVNO with its own ranges **receives** mobile termination revenue (capped 0.504p/min from June 2026) on incoming calls, so trusted calls could earn rather than cost.
   - Minimum commitments: QUOTE.
7. **Re-run result:** with numbers at ~£0.10/household (own range) **and** Twilio billing the SDK leg at £0 on BYOC calls, **£5.99 meets all three conditions** (41% normal / 29% heavy / 15% stress). If Twilio bills the SDK leg at list, nothing below £9.99 does (£7.99 reaches 39%). **The Twilio SDK-on-BYOC answer is now the single most price-determining unknown.**

## 1. Shared HCG forwarding numbers

### 1.1 What survives the path

| Hop | Identifier of the forwarding customer | Status |
|---|---|---|
| Customer's MNO performs forwarding (CFU) | ND1016 requires the diverting line identity as a **Network Number**. ISUP equivalents are Redirecting Number / Original Called Number; SIP equivalents are PAI and History-Info/Diversion | PUBLISHED requirement. **Per-MNO compliance UNCONF** (EE, Vodafone, O2, Three) |
| UK interconnect → HCG's terminating carrier | Should be preserved (all CPs must maintain CLI authenticity end to end; Ofcom CLI guidance) | LIKELY, UNCONF |
| Twilio PSTN number (today) | `ForwardedFrom` = the Twilio number on 184/184 calls; no other field | **PROVEN: not usable** |
| UK SIP carrier → HCG SIP proxy | PAI / History-Info / Diversion visible in raw SIP | UNCONF: needs a test capture per MNO |
| HCG proxy → Twilio BYOC | Proxy adds a signed `X-HCG-Household`; Twilio passes `X-` headers to webhooks | LIKELY; BYOC pass-through QUOTE |
| `P-Asserted-Identity` straight into Twilio | Not exposed as a parameter | STRONG (not documented) |

**Caller ID alone cannot identify the household.** `From` is the original caller, by rule.

### 1.2 Security: household identification must be trustworthy

| Risk | Analysis | Control |
|---|---|---|
| Spoofed diverting identity (attacker sends a call to the shared number with PAI = a victim's mobile) | Network Numbers are asserted by the originating/diverting UK network and must be valid (ND1016 ORIG 2). Rogue or lax CPs and international gateways are the known spoofing vector; Ofcom now requires blocking invalid CLIs. **Impact if spoofed:** the attacker's call rings the victim's app, which is equivalent to calling the victim directly. A spoofed *trusted* caller CLI already bypasses monitoring today. | Accept only when the identity matches a registered household **and** the dialled shared number is the one assigned to that household. Reject international-origin calls claiming UK diverting identities (where the carrier marks origin). |
| **Missing or wrong identity** (an MNO doesn't send it, or sends a different format/number) | **The main risk.** The call can't be attributed: deliver to nobody (customer misses the call) or the wrong household (privacy breach) | **Fail closed** (never guess). Only enrol a household on a shared number after its MNO is *measured* to supply the identity. Customers on non-compliant MNOs get a dedicated number. |
| Customer has more than one forwarded line / number changes | Identity must match the protected number on file | Re-verify on number change |
| Privacy | Callers see nothing new; the diverting identity is already personal data HCG holds | DPIA update |

### 1.3 How many households per number?

- **Technically:** unlimited, if identification works (the identifier is the PAI, not the dialled number).
- **Concurrency:** the carrier's per-DID channel cap now applies to the **group**. One household's flood can block others' calls on the same number (blast radius), and the *external* per-household cost bound becomes a per-group bound. A per-household limit at the proxy is HCG-controlled only. The financial bound per number stays the same; reliability isolation is lost.
- **Failure blast radius:** if a number is flagged as spam, blocked or mis-routed, or its carrier route fails, every household on it is affected.
- **Recommendation if ever used:** ≤ 10 households per number, enrolled only from MNOs measured to pass the identity, with per-household concurrency at the proxy.

**Regulatory:** UNCONF. Using a CP-allocated geographic number as a shared forwarding target is not obviously prohibited (comparable to shared voicemail/access numbers), but needs a numbering-condition check.

### 1.4 Does it fit the current architecture?
- **No** on Twilio PSTN numbers (PROVEN).
- **Yes**, with a free-inbound SIP carrier + HCG SIP edge proxy + Twilio BYOC (Option B + proxy).
- An own Ofcom range gives similar cost without any of the above.

## 2. Split carrier / split routing

| Step | Where | Cost incurred |
|---|---|---|
| Forwarded call arrives at UK SIP DDI | Wholesale carrier | £0/min (PUBLISHED retail; volume QUOTE) |
| Classification (trusted list lookup on `From`; household from DDI or PAI) | **HCG SIP edge proxy** (Kamailio/OpenSIPS + HCG lookup API). Signalling only, no media, HA pair | Fixed, ~£300/month (ASM) |
| TRUSTED → delivery | **Cannot go back over the PSTN** (unconditional forwarding loops, PROVEN). Must be VoIP to the app: Twilio (BYOC $0.004 + SDK £0 or list) **or** HCG-owned media (Option C) | Twilio: £0.00316–£0.00632/min; own media: bandwidth only, plus C's platform costs |
| UNKNOWN → monitored path | Twilio BYOC → `/voice` → Media Stream + AI | As Option B |

**Conclusion (STRONG):**
- Split routing gives the cheapest *classification*, not the cheapest *delivery*.
- The trusted-call cost after classification is the app-delivery leg, which only HCG-owned media removes. Using it for trusted calls but Twilio for unknown calls needs **two VoIP stacks in the app** (dual-SDK push conflict risk).
- The proxy is worth having for shared numbers, edge rate-limiting and SIP-level containment.

## 3. MVNO / MVNE / carrier piggyback

| Question | Finding |
|---|---|
| Can routing happen inside the network? | Yes, with a **full MVNO core**, or a host MNO that exposes an IMS terminating hook / conditional CDIV (`CARRIER_TECHNICAL_SPEC.md`). Light MVNOs depend on the host. |
| Keep existing numbers? | **Yes, by porting** (Ofcom switching; port in about 1 working day). PUBLISHED regime. **But the customer must change network and SIM.** |
| iPhone / Android | Native dialler, no app needed for trusted calls. **iPhone VoLTE / Wi-Fi calling require Apple carrier settings for that network.** Big MVNOs (giffgaff, iD, VOXI, Smarty) have them; a new or small MVNO may not (UNCONF per partner). Without VoLTE, post-3G calls fall back to 2G. |
| Commercials | Minimum commitments, set-up fees and per-subscriber fees: QUOTE. HCG would sell a **mobile plan** (airtime + protection), a different product and price point. |
| Termination revenue | A full MVNO with its own ranges receives mobile termination (cap 0.504p/min from June 2026, PUBLISHED). Trusted calls could be net revenue (LIKELY; split with host UNCONF). |
| Realistic UK partners | **Cloud9 / Wireless Logic** (full MVNO, MNC 234/18, own core; contacted). **aql** (UK operator; Three Wholesale MVNO partner; contacted). **Gamma** (Three MVNO; LOW competitive risk). **eSIM Go** (UK MVNE on Vodafone, "low barrier", May 2026; no scam product found). **Silux** (Three MVNE behind amaysim UK; not checked). Simwood/Transatel excluded per instruction. |
| Competitive risk | Host MNOs (EE, Vodafone, VMO2, Three) sell pre-answer scam products (HIGH). MVNEs above: LOW (none found). |

## 4. Architecture comparison (additions)

| Option | Trusted £/min | Number £/hh | Identification | External per-household bound | Build | Main unknowns |
|---|---|---|---|---|---|---|
| A Twilio today | £0.00756 (billed) | £0.87 billed / £2.77 list | DDI | **None** | — | Rejected (unbounded) |
| B SIP + BYOC + SDK, 1 number each | £0.00316–£0.00632 | £2.00 retail / QUOTE | DDI (PROVEN pattern) | Per-DID channel cap | Weeks | SDK-on-BYOC billing; wholesale price |
| **B + own Ofcom range** | same | **~£0.01–£0.10** (QUOTE hosting) | DDI | Per-DID channel cap | + Ofcom allocation and hosting contract | Allocation feasibility; hosting fee |
| B + shared numbers + SIP proxy | same | £2.00 / N | **PAI per ND1016** (UNCONF per MNO) | Per-*group* only | + HA SIP proxy | MNO identity compliance; fail-closed misses |
| Split routing (proxy classifies) | Twilio leg, or own media (C) | as B | DDI or PAI | as B | Proxy (+ C for savings) | Dual VoIP stack if trusted ≠ Twilio |
| C HCG-owned delivery | ~£0 | as B | DDI | Channel cap + fixed infra | Platform build | ≥ ~10k subs to pay back |
| D / MVNO | £0 to HCG (possibly revenue) | n/a (ported numbers) | Network | Network fail-open | Partner integration; mobile-plan product | Everything; iPhone carrier settings |

## 5. Model re-run (fully loaded, 1,000 subs, Apple 15%)

Each cell shows normal / heavy / stress margin. ✔ = normal ≥ 40% and heavy and stress ≥ 0%.

**SDK leg £0 on BYOC calls (as invoiced today; QUOTE for BYOC):**

| Numbers | £5.99 | £6.99 | £7.99 | £9.99 | Lowest |
|---|---|---|---|---|---|
| 1:1 retail £2.00 | 1 / −11 / −25 | 13 / 3 / −9 | 22 / 13 / 3 | 35 / 28 / 19 | none |
| 1:1 wholesale £1.00 | 22 / 10 / −4 | 31 / 21 / 9 | 38 / 29 / 19 | 47 / 40 / 32 ✔ | £9.99 |
| 1:1 wholesale £0.50 | 32 / 21 / 7 | 40 / 30 / 18 ✔ | 46 ✔ | 54 ✔ | £6.99 |
| **1:1 own range ~£0.10** | **41 / 29 / 15 ✔** | 47 ✔ | 52 ✔ | 59 ✔ | **£5.99** |
| Shared 1:2 + proxy | 16 / 4 / −10 | 26 / 16 / 4 | 33 / 25 / 14 | 44 ✔ | £9.99 |
| Shared 1:3 + proxy | 23 / 11 / −3 | 32 / 22 / 10 | 39 / 30 / 19 | 48 ✔ | £9.99 |
| Shared 1:10 + proxy | 33 / 21 / 7 | 40 ✔ | 46 ✔ | 54 ✔ | £6.99 |
| Shared ~negligible + proxy | 37 / 25 / 11 | 44 ✔ | 49 ✔ | 56 ✔ | £6.99 |

**SDK leg at list ($0.004/min):** nothing below £9.99 passes in any number architecture. £9.99 passes at ≤ £0.50 wholesale, own range, or sharing ≥ 1:10. Own range at £7.99: 39 / 24 / 7.

**Own range ~£0.10, SDK £0, per price:**

| Price | Contribution £/sub | Normal | Heavy | Stress | Break-even avg min | Falls below 40% above avg min |
|---|---|---|---|---|---|---|
| £5.99 | £2.04 | 41% | 29% | 15% | 636 | **249** (normal mix is 240) |
| £6.99 | £2.75 | 47% | 37% | 25% | 774 | 322 |
| £7.99 | £3.46 | 52% | 43% | 33% | 912 | 395 |
| £9.99 | £4.89 | 59% | 52% | 43% | 1,188 | 542 |

£5.99 passes **with only 9 minutes of headroom** above the assumed normal mix. £6.99 has 82 minutes of headroom.

## 6. Containment implications (the absolute requirement still applies)

| Option | Effect on the hard, external maximum loss |
|---|---|
| Own range | Unchanged and good: per-DID channel caps remain external per household (hosting carrier must support them; QUOTE) |
| Shared numbers | Per-household external bound becomes per-group; the financial bound per number is unchanged |
| Split-routing proxy | Adds HCG-controlled edge limits (rate, concurrency), useful but **not external**. External bounds still come from carrier caps and prepaid balances. |
| MVNO | Trusted cost leaves HCG entirely; containment shifts to the partner contract (QUOTE) |
| All Twilio-based options | Still require Twilio to confirm outbound / international-SMS lock against API change. Otherwise **unbounded** (`CATASTROPHIC_RISK_REVIEW.md`). |

## 7. Evidence needed before choosing the price

1. **Twilio, in writing:**
   - Is the Voice SDK `<Client>` leg billed on BYOC-originated calls, and at what rate?
   - BYOC-only, or BYOC + SIP interface?
   - Are `X-` headers passed through on BYOC?
   - Can outbound / international SMS be locked against API change?

   The first question alone moves the lowest compliant price between £5.99 and £9.99.
2. **Own Ofcom range:**
   - eligibility and lead time for an allocation of 1,000 geographic numbers (non-scarce area code);
   - Magrathea (or another range host) hosting fee, free inbound, per-DID channel caps, outbound bar.
3. **Wholesale per-number quotes** (Sipflex, sipgate, Magrathea, aql) as a fallback.
4. **Per-MNO forwarding identity capture**, only if sharing is pursued. Record raw SIP (PAI / History-Info / Diversion) for a forwarded call from one SIM on each of EE, Vodafone, O2 and Three to a test DID on a non-production SIP account. Needs handsets and SIMs; a separate, non-destructive session, not tonight.
5. **MVNO partner answers** (Cloud9/Wireless Logic, aql, eSIM Go, Gamma): in-network routing hook, iPhone carrier-settings status, minimum commitments, MTR share.
6. **Measured usage** from a capped pilot. £5.99's margin depends on average forwarded minutes staying ≤ ~249/month.

## Sources
- NICC ND1016 v6.1.1 (2025-09), RULE CLI TERM 5: https://niccstandards.org.uk/wp-content/uploads/2025/09/ND1016-V6.1.1.pdf
- Ofcom CLI guidance: https://www.ofcom.org.uk/cymru/phones-telecoms-and-internet/information-for-industry/telecoms-industry-guidance/calling-line-identification
- RFC 5806 Diversion / RFC 7544 History-Info mapping: https://datatracker.ietf.org/doc/html/rfc5806 · https://www.rfc-editor.org/rfc/rfc7544
- Twilio Call resource / ForwardedFrom: https://www.twilio.com/docs/voice/api/call-resource
- Twilio Diversion header validation: https://www.twilio.com/en-us/changelog/diversion-header-validation-for-termination-calls
- HCG production evidence: `docs/mobile-app/APP_DECISION_008_call_delivery_architecture.md` (184/184 calls)
- Ofcom geographic number charging (10p/number/year, scarce codes): https://www.ofcom.org.uk/siteassets/resources/documents/phones-telecoms-and-internet/information-for-industry/numbering/geographic-numbering/geo-telephone-numbers.pdf
- Magrathea number hosting: https://www.magrathea-telecom.co.uk/service/numbering/number-hosting/ and https://www.magrathea-telecom.co.uk/business-solutions/requiring-own-number-ranges/
- Apple carrier features (Europe): https://support.apple.com/en-gb/108048
- Mobile termination cap 0.504p/min from 1 June 2026: Ofcom call-termination statement (see `CATASTROPHIC_RISK_REVIEW.md` sources)
