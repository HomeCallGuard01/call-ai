# Magrathea, number hosting, Ofcom allocation, 07 porting and pre-answer redirect: desk research

Date: 2026-10-03. Public web documents only. Nobody was contacted.
Labels: **PUBLISHED** means I saw it on the cited page or PDF. **INFERRED** means it is my reasoning from published material. **UNKNOWN** means no public source was found.
Source numbers such as [S3] refer to the "Sources opened" list at the end.

---

## TL;DR for HCG

1. **Inbound to a Magrathea UK geographic number delivered over SIP has no per-minute charge.** The price is £0.50 per number per month, with a £100/month minimum. Each number carries 10 concurrent calls. **PUBLISHED** [S3, S2]
   - This removes HCG's £0.00756/min inbound cost for every call delivered to HCG's own SIP endpoint. **INFERRED**
   - Caveat: for accounts with "significant volume of ported numbers ... high volume traffic", Magrathea may switch to capacity charging on 30 days' notice. **PUBLISHED** [S3]
2. **Magrathea passes the diverting line identity to the client.** "Network Mode" is now the *default* for inbound delivery [S2]. In Network Mode Magrathea may pass the P-Asserted-Identity network number and the **"last diverted line identity (Diversion number)"** in SIP headers. **PUBLISHED** [S4, S5]
   - Its CDRs also have an `LDLI` field: "the last Diversion header where more than one is present". **PUBLISHED** [S6]
   - This is the field HCG's Twilio ingress never exposes.
   - Whether UK MNOs actually populate it on a CFU/CFB to a Magrathea number is **UNKNOWN**, so it needs a live test.
3. **Routing is static, not decided per call.** Routing is set per number through the NTSAPI or REST `SET` command. It can hold up to 3 targets with time-of-day order and a 20-second sequential failover. Changes take effect "in real time". **PUBLISHED** [S7, S8]
   - No pre-answer webhook or HTTP routing decision is documented. **PUBLISHED**: absent in [S7, S8, S9]
   - Pointing a number at a PSTN target needs a "Chargeable Number Translation" account. Setup is from £100 + VAT, and the forwarding minutes are deducted from prepay. **PUBLISHED** [S2]
4. **No UK wholesale provider was found that documents both a pre-answer HTTP routing decision and a SIP 3xx exit that takes the provider out of the media path.** Where a host forwards to the PSTN, the onward leg is billed to the number holder. **PUBLISHED** for Magrathea [S2], A&A [S22] and Simwood [S19]
5. **Magrathea is launching a mobile product.** "...launching of our mobile product which is currently undergoing testing" (newsletter, 5 Aug 2026). **PUBLISHED** [S12]
   - Its scope (SIMs? MVNO? 07 numbers? porting?) is **UNKNOWN**.
   - It could be an opportunity or a competitive risk, so it is the top question to ask.
   - No call-screening or anti-scam product was found. Magrathea's scam material is regulatory commentary. **PUBLISHED** [S13, S12]
6. **Porting a customer's 07 to a VoIP host is possible in the UK.** A&A does it with a PAC, normally in one working day, for £12 setup and £1.80/month. **PUBLISHED** [S20]
   - Porting **removes the number from the SIM**. **PUBLISHED** [S20]
   - Magrathea's porting documents list geographic and non-geographic ports only. 07 is not mentioned. **PUBLISHED** [S10, S11]
   - Ofcom designates 07 numbers for "Mobile Services", where *every* signal goes over wireless. This is a regulatory obstacle to HCG getting its own 07 allocation and a grey area for 07 numbers on pure SIP. **PUBLISHED** [S16]; the conclusion is **INFERRED**

---

## 1. Magrathea: public service inventory

| Topic | Finding | Label / source |
|---|---|---|
| **Wholesale numbering** | UK and Irish geographic, 03, 05 (LIECS), 070, 080, 084/087, 09 and "Gold" numbers. Allocated in real time through the API. | PUBLISHED [S1, S2] |
| **UK geographic price** | £0.50/number/month, £100/month minimum commitment. Product trial: up to 25 numbers for £100/yr, 2 channels each, no resale, no porting. Low Start package: up to 100 geographic numbers for £180/quarter. | PUBLISHED: Annex 3 v6.0 (undated) [S3]; Handbook v1.5, 7 Oct 2025 [S2] |
| **Inbound call charge (geo → SIP)** | "Magrathea will not charge the Customer for inbound calls to the Service Numbers." Schedule 3 cl. 7.7: no charge for calls "except where expressly agreed in writing". Cl. 7.8: the customer pays any third-party charges, e.g. reverse-charge calls, plus a 25% handling charge. | PUBLISHED [S3, S5] |
| **Channels per DID** | Schedule 3 cl. 7.9: "A maximum of ten concurrent calls will be allowed on each number". The limit can be raised on a traffic forecast, and extra charges may apply. | PUBLISHED [S5, S2] |
| **Ported-in numbers** | Cl. 7.11: Magrathea "reserve[s] the right to move clients to a capacity-based charge structure for the Ported numbers". | PUBLISHED [S5] |
| **Delivery destinations** | UK PSTN, international PSTN, voicemail-to-email, fax-to-email, SIP (`S:` RFC2833 / `s:` inband), IAX2, and TLS/SRTP (`E:`). Up to 3 indexed targets with `ORDE` time-of-day ordering and 20-second sequential failover. No simultaneous ring. | PUBLISHED [S7, S8] |
| **PSTN forwarding cost** | Basic translation to SIP/IAX/email is free. PSTN targets need a Chargeable NTS account: setup "starts at £100 plus VAT" (2018 handbook: £250), with forwarding minutes "deducted in real-time from a prepaid account". The API notes that a geographic number set to divert to a mobile "will not work because the mobile call is chargeable" unless the account is enabled for chargeable diversion. | PUBLISHED [S2, S7, S8] |
| **API** | NTSAPI: raw TCP on port 777 to api.magrathea-telecom.co.uk. Commands: ALLO, ACTI, DEAC, REAC, STAT, SET, ORDE, FEAT, INFO, BLK*. REST API at restapi.magrathea.net:8443/v1 offers the same functions plus 999 data. New features will go into the REST API only. Ported numbers are controlled with a `P` prefix (SET, ORDE and STAT only). | PUBLISHED [S7, S8, S9] |
| **Per-call features** | `FEAT D` presents the called number as the CLI. `FEAT J` turns on Anonymous Call Rejection. `FEAT U` adds a UK ringtone on international diverts. There is no screening or webhook feature. | PUBLISHED [S8] |
| **SIP headers delivered** | Network Mode is the default (2025 handbook). It may deliver the network number in P-Asserted-Identity, the presentation number in From and Remote-Party-ID, and the "last diverted line identity (Diversion number)". Privacy is flagged through privacy=full/yes in RPID or Diversion, or a Privacy header. Numbers are in +E.164 form. An `X-CALLINFO: cdr=…` header carries the call reference. Network numbers "must not be passed to any end-user" and must not be used for marketing. | PUBLISHED [S2, S4, S5, S6] |
| **History-Info header** | Not mentioned anywhere. | UNKNOWN |
| **Does Magrathea follow a SIP 3xx from the client's endpoint?** | Not documented. | UNKNOWN |
| **Own-range hosting** | "Interconnect Number Hosting" for CPs with their own Ofcom allocations: Magrathea leases a BT interconnect partition, does the data build and notifies other operators, routes BT traffic to the client's server, and passes on the full interconnect revenue. Product sheet: "Traffic is onward routed at a network level to allow you full control of your number ranges". | PUBLISHED [S14, S15] |
| **Hosting price (Annex 7 v4.0, undated)** | Initial setup: minimum £500. Subsequent setup: minimum £150. Decommissioning: minimum £500. **Option 1:** £100/month per 300,000 min (one notional E1) to 01/02/03/05, no revenue on geographic numbers, 20% admin fee on non-geographic revenue, and a £0.0009/min capacity charge on non-geographic only. **Option 2:** £500/month per E1, all termination revenue passed through, and £0.0002/min on geographic. Minimum term is 1 year per Unit of Capacity. The early termination charge is £500 per remaining month. | PUBLISHED [S15, S14] |
| **Porting** | Geographic and non-geographic ports, ordered through the MAGIC portal. Price: £10 per number, capped at £50 for a multi-line port. Lead times: single line 4 working days; multi-line 7, 10, 17 or 22 working days; non-geographic 7 working days. **No mention of 07 or mobile porting** in the porting guide or product page. Their switching guide covers fixed One Touch Switch only. | PUBLISHED [S10, S11, S2, S1b] |
| **Mobile / MVNO / SIM** | Not listed as a current product. Aug 2026 newsletter: mobile product "currently undergoing testing". | PUBLISHED [S12] |
| **Anti-scam / CLI products** | None found. Magrathea comments on Ofcom CLI rules, including the requirement to change unverified UK mobile CLIs on international calls to "withheld" by 15 Jul 2027. It also supports a traceback idea and warns that 07 spoofing is "the next loophole". | PUBLISHED [S12, S13] |
| **Emergency services (999/112)** | A wholesale product with data submission through the API. Prices (Annex 5 v7.0, 1 Oct 2025): £100 setup; £100/month management fee, waived if other spend is at least £100/month; £25 or £50/month fixed below 30 calls, then £2.05 per call plus 0.006p/min with a £50 minimum; £20 per bad-data incident. Magrathea's page says a telephony provider is "likely" obliged under the General Conditions to provide 999 access. | PUBLISHED [S17, S2, S1c] |
| **Does 999 apply to HCG?** | HCG's service only receives forwarded calls and never originates calls from the number. It is plausibly outside the 999-origination duty. | INFERRED. Needs legal confirmation |
| **Outbound barring / fraud** | Outbound is prepaid only, with a £250 minimum top-up. There are restricted tariffs (≤3p/min or ≤15p/min destinations). The default is 150 notional outbound channels. | PUBLISHED [S2, S1d] |
| **MagSIPConnect** | Authenticates *outbound* calls from cloud platforms "e.g. Twilio, Vonage" by IP range plus a unique SIP header, with sub-accounts. No setup charge on the master account. | PUBLISHED [S18] |
| **Interop notes** | Recommends PAI plus From with +E.164, G.711 a-law (G.722 first if offered), RFC2833 DTMF and ptime 20. RTP silence of 90–180 s may drop a call. Session timers of 1200–1800 s are recommended. | PUBLISHED [S19b] |
| **Onboarding** | KYC/due diligence, Trust ID, DocuSign contracts, direct debit for geographic numbers, Network Status Declaration. | PUBLISHED [S2] |

---

## 2. Getting your own Ofcom allocation (UK)

| Question | Finding | Label / source |
|---|---|---|
| **Who may apply** | "CPs that provide, or intend to provide within six months, a [PECN] and/or a [PECS], may apply to Ofcom for the allocation of numbers." "providers of PECS are CPs, and as such, are eligible". There is no licence. You operate under the General Authorisation and must meet the General Conditions. | PUBLISHED [S23] (statement, 1 Dec 2014); GA framing INFERRED |
| **How** | GC B1.10: apply through Ofcom's online number management system. | PUBLISHED [S21, S24] |
| **Decision time** | GC B1.11: Ofcom determines an application within **3 weeks** of a complete form, or 3 weeks after any extra information it requests. | PUBLISHED [S24] (GC version of 8 Apr 2026) |
| **Use-it-or-lose-it** | GC B1.18: Ofcom may withdraw numbers not Adopted within **6 months** of allocation. GC B1.6: numbers must be used effectively and efficiently. | PUBLISHED [S24] |
| **Cost** | GC B1.15: **£0.10 per number per year** for "Specified Geographic Numbers" only (the scarce codes), with reductions for ported, WLR and payphone numbers. Other geographic allocations are free. | PUBLISHED [S24]; "free otherwise" consistent with prior research |
| **Block size** | 1,000 numbers in conservation areas and 10,000 in standard areas. | Search snippet of Ofcom geographic consultation, **not opened**, so UNVERIFIED |
| **Consumer protection test** | Ofcom can refuse numbers to providers with prior consumer-protection breaches. | Search snippet only, so UNVERIFIED |
| **Mobile 07 for a non-MNO** | 071–075 and 077–079 are designated "Mobile Services". A "Mobile Service" is one "where every Signal ... has been, or is to be, conveyed through the agency of Wireless Telegraphy to or from Apparatus designed or adapted to be capable of being used while in motion". The plan explicitly defines MVNOs, so MVNOs can be 07 range holders. | PUBLISHED [S16] (Numbering Plan of 22 Apr 2025) |
| **Could HCG get 07 numbers?** | Not as a pure SIP or forwarding service. A&A reported in 2011 that Ofcom rejected its 07 application because "a call can be answered on a non mobile device". HCG would need to be an MVNO or offer a real mobile service. | PUBLISHED secondary [S25]; conclusion INFERRED |
| **Number portability (B3)** | GC B3 applies to any provider of a network or service with Plan numbers (a "Regulated Provider"). B3.2: provide portability "as soon as is reasonably practicable and on reasonable terms", with cost-oriented charges. For mobile numbers the donor may make no ongoing registration charge. A range holder therefore has to *export* numbers on request and may *import* them. Magrathea's Schedule 7 cl. 7.2 says Magrathea will "facilitate the Customer's compliance with General Condition B3". | PUBLISHED [S24, S14] |
| **Does a range holder control routing?** | Yes, for its own range. BT and other networks route that range to the holder's or host's interconnect, and the host routes onward "to the Customer's server" (Schedule 7 cl. 5.3.3; "full control of your number ranges"). But owning a range gives **no** control over the *customer's existing* 07 or landline. Those numbers stay routed by their current range holder or recipient provider unless they are ported to you. | PUBLISHED [S14, S15]; scope INFERRED |
| **Is own-range hosting worth it vs Magrathea sub-allocation?** | Sub-allocated geographic numbers already give free inbound at £0.50/number/month. Own-range hosting adds at least £500 setup, a 1-year term and at least £100/month per E1. Its benefits are independence from a sub-allocator and portability control. It does not reduce per-minute cost. | INFERRED from [S3, S15] |

---

## 3. Porting a customer's 07 mobile number to a VoIP host

| Question | Finding | Label / source |
|---|---|---|
| **Can a non-MNO VoIP provider receive a ported 07 and keep it on SIP?** | Yes. A&A: "Porting a mobile number to our service will remove the number from your existing SIM / mobile provider" and lets it be used on SIP or SIP2SIM. They need a PAC, it "normally takes one working day", and it costs £12 setup plus £1.80/month. | PUBLISHED [S20] |
| **Does Magrathea port 07?** | Not documented. Its guides cover geographic and non-geographic numbers only. The new mobile product may change this. | PUBLISHED absence [S10, S11, S1b]; UNKNOWN for the future |
| **Process** | Mobile switching is under GC C7. The customer requests a **PAC** (keep number) or **STAC** (cancel) free of charge, including by **SMS** (C7.33, "text-to-switch"). A PAC is valid 30 days (C7.42). The switch completes **within one Working Day** of submitting the PAC (C7.3). **One Touch Switch** is for *fixed* residential voice and broadband switching ("A customer changing their provider at a fixed location"), not mobile. | PUBLISHED [S24, S11] |
| **Effect on the customer's SIM** | The SIM loses the number, so it can no longer receive calls to that 07 or present it as CLI. The customer would need a new number on the SIM, or a SIP2SIM-type product from the recipient. HCG would then have to deliver **all** calls (trusted and screened) to the handset by app/VoIP, or by an onward PSTN leg to the SIM's new number, which is billed. Outbound calls would need HCG to originate with the ported CLI. | PUBLISHED (SIM loses number) [S20]; consequences INFERRED |
| **Regulatory fit** | An 07 must be "Adopted or otherwise used as part of a Mobile Service" [S16]. Hosting a ported 07 on pure SIP with no radio leg is a grey area; A&A's SIP2SIM option suggests providers keep a mobile element. | PUBLISHED definition; grey-area assessment INFERRED |
| **Bottom line for HCG** | Porting the customer's 07 to HCG would give routing control, so trusted calls could cost ~£0 on free inbound. But it makes HCG the customer's mobile number provider, kills native SIM calling, and runs into the 07 "Mobile Service" requirement. It is high friction for an elderly target market. | INFERRED |

---

## 4. Pre-answer HTTP routing with a SIP 3xx exit (provider leaves the media path)

| Provider | Pre-answer HTTP decision? | 3xx / redirect behaviour | Onward PSTN leg billed to | Label / source |
|---|---|---|---|---|
| **Magrathea** | No. Static `SET` targets with real-time updates. | Not documented. | The number holder: Chargeable NTS minutes from prepay. | PUBLISHED [S7, S8, S2]; 3xx UNKNOWN |
| **Simwood** | No. Number config is static JSON. Webhooks (2019) are notifications only. | No mention of 302. PSTN forwarding is a `pstn` endpoint with a `maxcpm` cap. | The account holder (`maxcpm` caps cost per minute). | PUBLISHED [S19, S26, S27, S28] |
| **A&A** | No HTTP routing found. | Number-level redirect to up to 10 numbers. | "You as the owner of the number pay for the redirection." | PUBLISHED [S22, S29, S30] |
| **Twilio / Telnyx / Plivo** | Yes (webhooks), but the platform stays in the path. | Already established in prior HCG research: no release of a forwarded PSTN leg; REFER works for SIP only. | The account holder. | Prior research (memory), not re-opened today |

**Conclusion:** I found no UK wholesale provider that publicly documents a per-call HTTP decision before answer followed by a SIP 3xx that hands a PSTN call back so the original network re-routes it and the host leaves the media and billing path. **UNKNOWN** if any provider does this privately.

Structurally, a host that receives a PSTN call and sends it to another PSTN number must originate a new leg. That leg is billed to the number holder (Magrathea, A&A and Simwood all say so). UK interconnects are not known to support bouncing a call back to the originating network with a 3xx. **INFERRED**

**Implication:** the lowest-cost trusted-call path with Magrathea is *not* a PSTN redirect. It is free SIP inbound to HCG's own SIP/media server plus app delivery (VoIP/push to the handset). The only variable cost is HCG's own compute and bandwidth. **INFERRED**. This matches the earlier "A4 free-inbound SIP + self-hosted delivery" finding.

---

## Questions for Magrathea (to ask when Andrew approves contact)

1. **Diversion data:** On UK mobile CFU/CFB/CFNRy into a Magrathea geographic number, do you receive the diverting party's number from Vodafone, EE, O2 and Three? Is it delivered in a `Diversion` header, in `History-Info`, or both? Please share a sample INVITE.
2. **Free inbound at scale:** Does the "no charge for inbound calls" in Annex 3 v6.0 still apply to calls originated on mobile networks? At what volume would you move us to capacity charging (for numbers you allocate, not ported ones)? Can a number get more than 10 channels, and at what price?
3. **3xx handling:** If our SIP endpoint answers an INVITE with 302 to a PSTN number, do you follow it? If so, is it billed as a Chargeable NTS PSTN leg, and do you stay in the media path? Can we reject with a specific code so the *originating* network applies the subscriber's CFB/CFNRy (for example 486 versus 480 versus 603)?
4. **Mobile product:** What is it (SIMs, MVNO, 07 sub-allocation, 07 port-in), when does it launch, and is there an API? Is call screening or anti-scam on your roadmap (competitive risk)?
5. **07 porting:** Can you port in 07 mobile numbers today or with the new product? Under which Ofcom designation would they be used?
6. **Hosting:** What are the current Annex 7 prices (v4.0 is undated)? What lead time is there for a BT data build of a new Ofcom allocation? Do you also host 07 ranges?
7. **Emergency:** For a receive-only service where customers never originate calls from these numbers, do you require Schedule 5 (999)?
8. **Prices:** Please confirm current per-number prices and minimums, and the price for a 25-number trial for commercial testing.
9. **Twilio hybrid:** Can a Magrathea number's SIP target be a Twilio SIP domain or Elastic SIP Trunk (inbound), with MagSIPConnect for outbound?

---

## Sources opened (all 2026-10-03)

| # | URL | Notes |
|---|---|---|
| S1 | https://www.magrathea-telecom.co.uk/ | Services index |
| S1a | https://www.magrathea-telecom.co.uk/service/numbering/number-hosting/ | Hosting page |
| S1b | https://www.magrathea-telecom.co.uk/service/numbering/number-porting/ | Porting page: "geographic and non-geographic" |
| S1c | https://www.magrathea-telecom.co.uk/service/voice-connectivity/emergency-services/ | 999 page |
| S1d | https://www.magrathea-telecom.co.uk/service/voice-connectivity/managed-national-international-voice-connectivity/ | Prepay, £250 minimum |
| S1e | https://www.magrathea-telecom.co.uk/service/numbering/ | Numbering overview |
| S1f | https://www.magrathea-telecom.co.uk/service/numbering/chargeable-nts/ | Chargeable NTS |
| S1g | https://www.magrathea-telecom.co.uk/service/voice-connectivity/two-tiered-billing/ | |
| S1h | https://www.magrathea-telecom.co.uk/business-solutions/requiring-own-number-ranges/ | Own ranges |
| S1i | https://www.magrathea-telecom.co.uk/clientinfo/ | Current document index |
| S1j | https://www.magrathea-telecom.co.uk/service/voice-connectivity/magsipconnect/ | Returned 404 |
| S2 | https://www.magrathea-telecom.co.uk/wp-content/uploads/CLIENT-HANDBOOK_2025.1.pdf | v1.5, 7 Oct 2025 (current) |
| S2old | https://www.magrathea-telecom.co.uk/wp-content/uploads/2018/09/CLIENT-HANDBOOK.pdf | Older (~2019) handbook, used for comparison only |
| S3 | https://www.magrathea-telecom.co.uk/wp-content/uploads/Annex-Schedule-3-UK-Geo-price-list-v6.0.pdf | Free inbound, £0.50/number. Undated v6.0 |
| S4 | https://www.magrathea-telecom.co.uk/wp-content/uploads/2018/10/Network-Mode-CLI.pdf | Network Mode agreement (older copy; same text appears in S5) |
| S5 | https://www.magrathea-telecom.co.uk/wp-content/uploads/Schedule-3-Inbound-Geographic-Number-Service-v2026.6.pdf | Schedule 3 v2026.6: 10 channels, Network Mode, ported-number clause |
| S6 | https://www.magrathea-telecom.co.uk/wp-content/uploads/New-CDR-Information.pdf | CDR definition, 25 Aug 2021: LDLI, X-CALLINFO |
| S7 | https://www.magrathea-telecom.co.uk/wp-content/uploads/2018/11/Numbering-API-Instructions-2.pdf | NTSAPI (older) |
| S8 | https://www.magrathea-telecom.co.uk/wp-content/uploads/Numbering-API-Instructions-Aug-2024-1.pdf | NTSAPI (page footer 8 May 2025): FEAT U, E: SRTP |
| S9 | https://www.magrathea-telecom.co.uk/wp-content/uploads/RESTAPI-User-Guide.pdf | REST API |
| S10 | https://www.magrathea-telecom.co.uk/wp-content/uploads/Porting-guide-v7.5.pdf | Porting guide v7.5: lead times |
| S11 | https://www.magrathea-telecom.co.uk/wp-content/uploads/Magrathea-Switching-and-Porting-Guide-April-2024.pdf | OTS / GPL guide, Apr 2024 |
| S12 | https://www.magrathea-telecom.co.uk/august-2026-newsletter/ | 5 Aug 2026: mobile product in testing; Ofcom CLI measures |
| S13 | https://www.magrathea-telecom.co.uk/closing-the-loopholes-on-scam-callers/ | 15 Aug 2024 |
| S14 | https://www.magrathea-telecom.co.uk/wp-content/uploads/Schedule-7-Hosted-Numbering-Service-v4.0-2.pdf | Schedule 7 v4.0 |
| S15 | https://www.magrathea-telecom.co.uk/wp-content/uploads/Annex-Schedule-7-Hosted-Numbering-Price-List-v4.0-2.pdf | Hosting prices, undated v4.0. Also https://www.magrathea-telecom.co.uk/wp-content/uploads/Product-sheet-Number-hosting-1-1.pdf |
| S16 | https://www.ofcom.org.uk/siteassets/resources/documents/phones-telecoms-and-internet/information-for-industry/numbering/other/national-numbering-plan.pdf?v=401943 | Numbering Plan of 22 Apr 2025 |
| S17 | https://www.magrathea-telecom.co.uk/wp-content/uploads/Annex-Schedule-5-Emergency-Services-v7.0-011025.pdf | 999 prices, 1 Oct 2025 |
| S18 | https://www.magrathea-telecom.co.uk/wp-content/uploads/Product-sheet-MagSIPConnect.pdf | MagSIPConnect |
| S19b | https://www.magrathea-telecom.co.uk/wp-content/uploads/Interoperability-FAQ-and-best-practice-1.pdf | Interop FAQ |
| — | https://www.magrathea-telecom.co.uk/wp-content/uploads/2021/04/Product-sheet-Numbering.pdf | Numbering product sheet |
| — | https://mirrors.edge.kernel.org/CPAN/authors/id/C/CM/CMS/Magrathea-API-v1.6.0.readme | Third-party Perl API readme |
| S19 | https://cdn.simwood.com/docs/simwood_apiv3.pdf | Simwood Customer API v3.22 |
| S20 | https://aa.net.uk/voice-and-mobile/number-porting/mobile-porting/ | A&A 07 port-in |
| S21 | https://www.ofcom.org.uk/phones-and-broadband/phone-numbers/numbering | Ofcom NMS |
| S22 | https://support.aa.net.uk/VoIP_How_to:_Redirect_to_another_number | A&A redirect billing |
| S23 | https://www.ofcom.org.uk/siteassets/resources/documents/consultations/7983-amendments-numbering-applications/statement/number_application_form_statement.pdf?v=334710 | 1 Dec 2014 statement |
| S24 | https://www.ofcom.org.uk/siteassets/resources/documents/phones-telecoms-and-internet/information-for-industry/general-authorisation-regime/general-conditions-of-entitlement---unofficial-consolidate-version.pdf?v=390446 | GCs, version of 8 Apr 2026 (B1, B3, C7) |
| — | https://www.ofcom.org.uk/phones-and-broadband/phone-numbers/number-portability-info | Ofcom portability page |
| S25 | https://www.revk.uk/2011/03/ofcom-outlaw-mobile-call-diverts.html | 10 Mar 2011, secondary source |
| S26 | https://simwood.com/2019/10/realtime-call-webhooks/ | Simwood webhooks (notification only) |
| S27 | https://simwood.com/2014/05/advanced-inbound-routing-and-mobile/ | |
| S28 | https://simwood.com/2014/05/default-inbound-routing/ | |
| S29 | https://support.aa.net.uk/Incoming_VoIP_Features | |
| S30 | https://support.aa.net.uk/VoIP_-_Transferring_Calls | |

Not opened, so treat as unverified: the Ofcom geographic block-size and consumer-protection-test details (search snippets only). Magrathea's Annex 3 and Annex 7 price lists carry version numbers but no dates. Treat them as current as of 2026-10-03 because they are linked from the live /clientinfo/ page.
