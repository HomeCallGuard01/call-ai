# Agent 2: number pooling and concurrent calls

**Research only, 2026-10-10.** No calls, no provider contact, no production or API access.

**Evidence classes used throughout:**
- **PROVEN**: HCG's own captured evidence.
- **DEMONSTRATED FAILURE**: measured, and it did not work.
- **NEEDS CARRIER TESTING**: no evidence either way. This is never treated as failure.
- **DOC**: a primary document read today.
- **INDICATIVE**: a secondary source or an inference.

## 0. Andrew's four questions: definitive answers

### Q1. Can ONE HCG number reliably serve multiple customers?

**Not yet decidable. It is possible in principle and unproven for reliability.**

- **PROVEN (mechanism):** a mobile-diverted call reaching a Magrathea SIP number carried the diverting mobile in `Diversion`. One call, Lebara, 9 Oct (§1).
- **DEMONSTRATED FAILURE (one path only):** **Twilio PSTN numbers**. `ForwardedFrom` was the Twilio number on 184/184 production calls, so a shared Twilio number cannot identify the customer. This is not evidence against SIP carriers.
- **NEEDS CARRIER TESTING:** EE, O2, Vodafone retail and Three, the MVNOs on them, each divert type, and repeatability.

"Reliably" needs every network a pooled customer uses to deliver the diverting identity on 100% of calls. A miss under unconditional forwarding (CFU) means the call reaches nobody.

### Q2. How is the diverting (originally called) number identified, per provider and network?

| Provider / path | Field | Status |
|---|---|---|
| Twilio PSTN number | `ForwardedFrom` | **DEMONSTRATED FAILURE** (184/184 = Twilio's own number). DOC: "depends on the caller's carrier… Not all carriers support passing this information". No documented `CalledVia` |
| Twilio via an HCG SIP edge (BYOC) | Raw `Diversion`/`History-Info` at HCG's proxy, then a signed `X-` header to Twilio | NEEDS CARRIER TESTING (viability doc §1) |
| **Magrathea SIP (Network Mode)** | **`Diversion`** (last entry; CDR field `LDLI`). Also `History-Info` if present | **PROVEN for Lebara→Magrathea, 1 call.** All other networks: NEEDS CARRIER TESTING |
| Magrathea `P-Asserted-Identity` | The caller's network number, not the diverter | Absent on all trial calls. Network Mode PAI needs an agreement (CONFIRMED by Magrathea; content unstated) |
| Telnyx | Webhook `custom_headers` (X- only, per DOC) | NEEDS CARRIER TESTING. A third-party report says Diversion is stripped from webhooks |
| UK interconnect (ISUP) | Redirecting Number / Original Called Number, mapped to Diversion or History-Info by gateways (RFC 6044) | INDICATIVE |
| Rule | NICC ND1016 v6.1.1 RULE CLI TERM 5: the diverting network "shall provide" the diverting line identity as a Network Number | A requirement, not proof of compliance |

| Network (host) | Status |
|---|---|
| Lebara (Vodafone) | **PROVEN, 1 call.** Divert type unclear (CFU or CFB; `reason=unknown`) |
| Vodafone retail, VOXI, Asda, Talkmobile | NEEDS CARRIER TESTING (same host core as Lebara, so likely; INDICATIVE) |
| EE, BT Mobile, 1pMobile | NEEDS CARRIER TESTING |
| O2, giffgaff, Tesco, Sky, Virgin Mobile | NEEDS CARRIER TESTING. giffgaff, Sky and Tesco may run their own supplementary-service platforms |
| Three, iD, Smarty | NEEDS CARRIER TESTING |

### Q3. What happens with simultaneous calls on one number?

**Capacity is per channel, trunk or account, not per number** (Twilio and Telnyx: DOC). Magrathea's trial cap is **2 channels per number**. Whether a live account's cap is per number or per account is **NEEDS CONFIRMATION**.
- **Pooling adds no capacity.** Total channels needed depend only on total traffic: about 26–43 at 1,000 subscribers (§3).
- On a shared number, households compete for that number's channels.
- When channels are exhausted the call is rejected. The caller likely hears busy or congestion and the call is not re-diverted (INDICATIVE).

### Q4. Does pooling materially reduce cost?

Number cost per month. Magrathea's £100/month account minimum applies to every Magrathea row; whether rentals count towards it is NEEDS CONFIRMATION.

| Design | 10 subs | 100 | 1,000 |
|---|---|---|---|
| Twilio dedicated (£0.869 measured) | £8.69 | £86.90 | £869 |
| Twilio pooled | not possible on PSTN numbers | — | — |
| Magrathea dedicated (£0.50 list, unverified) | £5.00 | £50 | £500 |
| **Magrathea pool, 10/number** | **£0.50** | **£5** | **£50** |
| Own Ofcom range, dedicated (≤10p/number/yr, 1,000-block, hosting fee QUOTE) | ~£8.33 + hosting | ~£8.33 + hosting | ~£8.33 + hosting |

**Pooling's saving over Magrathea dedicated numbers is £4.50, £45 and £450 a month (£0.45/sub).** Over an own range it is about £0.
- That is material against a £1.07/sub safe variable budget (£5.99, Stripe).
- It is smaller than the gain from leaving Twilio in the first place: £0.37–£0.86/sub on numbers, plus £1.81/sub of Twilio inbound minutes (240 min × £0.00756), against £0 inbound on Magrathea.
- It does not touch the AI or app-leg costs, which dominate.

**Verdict:**
- Pooling is a real but second-order saving. It only matters if HCG stays on rented £0.50 numbers.
- Do not rely on it until §1.1 passes.
- Use Diversion now as a **verification** signal on dedicated numbers (§6).

## 1. Smallest safe tests

### 1.1 Per-network identity test

**Setup:**
- The existing Magrathea trial DDI and E-SIP VM, with a **reject-only** mode: log the INVITE headers (masked), reply `486`/`603` and never answer.
- No answer means no connected leg. Magrathea inbound is £0 anyway (DOC), and an unanswered forwarding leg is normally not billed to the forwarding SIM (INDICATIVE).

**Per network:**
- One PAYG SIM (about £10). Set `**21*03300884327#` and place **one** call from Andrew's phone (≤10 s ring).
- Check `*#21#`, then deactivate with `##21#`.
- **Cost bound: about £10 SIM plus £0 call.** Covering 8 networks (EE, O2, Vodafone, Three, giffgaff, Sky, iD, Lebara) costs **about £80**.

**PASS:** the last `Diversion` entry (or the `History-Info` entry before the target) equals the SIM's MSISDN after E.164 normalisation.

**Classify each result:**
- **FAIL:** the header is present but wrong, or absent while the call clearly arrived.
- **INCONCLUSIVE:** the call did not arrive.

**Extension, before enrolling any customer on a network.** The signalling path can differ even on one SIM: an IMS divert (VoLTE/Wi-Fi Calling) is History-Info-native, while an MSC divert (CS/2G, handset off) uses ISUP Redirecting Number (INDICATIVE). So add:
- CFU with VoLTE off;
- CFU over Wi-Fi Calling;
- CFNRc with the handset off;
- one ported-in number;
- a repeat after 7 days.

That is 6 calls per network, all reject-only. Then add one attended `answer_hold` call (120 s cap) to confirm that media and delivery behave the same.

### 1.2 Other minimum tests

1. **Spoofing:** from a second SIP provider on HCG's own account, send one call to the trial DDI with a forged `Diversion` (= Andrew's own spare mobile). Record whether Magrathea passes it, strips it or alters `screen=`.
2. **Exhaustion:** make three simultaneous calls to the 2-channel trial DDI (reject-only on calls 1–2 is not enough; hold them in `answer_hold`, 60 s cap). Record what caller 3 hears, per host network. Cost: pennies.
3. **Magrathea written answers:**
   - Who sets Diversion and `screen=yes`?
   - Is the channel cap per number or per account?
   - Are channels billed?
   - Is routing on LDLI permitted under Schedule 3 §5?
   - Do rentals count towards the £100 minimum?
4. **Ofcom:** a numbering-condition check for a shared forwarding target, and the 03 charge position.

## 2. Identity signals: trust properties

- **Diversion (RFC 5806):** **Historic**, Independent Submission, "no formal standing". It assumes "the diverting UAS trusts the diverted-to UAS" and has no integrity protection (DOC).
- **History-Info (RFC 7044, Proposed Standard, Feb 2014):** intermediaries are "trusted implicitly". Tampering is neither prevented nor detected (DOC).
- **`screen=yes`** on the 9 Oct Diversion is **not authentication**. Whether Magrathea or an upstream gateway set it is open (M-Q3/M-Q7). ISUP Redirecting Number has no CLI-style screening indicator (INDICATIVE).
- **`reason=unknown`**: the divert type cannot be read from the header.
- Twilio's 184/184 failure does **not** locate the hop that dropped the identity (MNO, transit or Twilio). It says nothing about SIP carriers.

## 3. Concurrency sizing (Erlang B)

| Provider | Limit scope | Values | When exceeded |
|---|---|---|---|
| Twilio Voice / SIP trunking | Account, inbound + outbound | Unlimited with a Business PCP. **2–3** for accounts upgraded on or after 3 Feb 2026 without one (earlier accounts "unaffected at this time") | Error 64109: rejected |
| Telnyx | Account (global) | 2 initially, 10 after Level 2, more on request | `403 User channel limit exceeded D1` |
| Magrathea | Per number on the trial (2). Live account: NEEDS CONFIRMATION | 10 standard (brief) | Failure returned to the diverting MNO. What the caller hears: test §1.2(2) |

Assumptions:
- 240 forwarded min/sub/month (viability model). Under CFU **all** inbound is forwarded.
- 10% of daily traffic falls in the busy hour, giving **0.0133 Erl/sub**.
- Heavy = 2×. Stress = 6× (a scam wave or stuck legs).

| Households on the group | Erlangs (n/h/s) | Channels for 1% blocking (n/h/s) | for 0.1% (n/h/s) | Blocking on 10 channels (n/h/s) | Blocking on 2 channels (n) |
|---|---|---|---|---|---|
| 1 | 0.013 | 1 | 2 | ≈0 | 0.009% |
| 10 | 0.13/0.27/0.8 | 2/3/4 | 3/4/6 | ≈0 | **0.8%** |
| 100 | 1.3/2.7/8 | 5/8/15 | 7/10/18 | ≈0/0.04%/**12%** | 27% |
| 1,000 | 13/27/80 | 22/38/96 | 26/43/106 | **35%/65%/88%** | — |

What this means:
- **≤10 households per 10-channel number is safe.**
- A 2-channel number is unsafe even at 10 households.
- 100 per number fails under stress.
- If the live cap is per number, dedicated numbers give each household its own channels at no extra cost. If it is per account, pooling changes nothing.
- On a pool, one household's flood or stuck leg blocks its neighbours. The per-number cap stops being an external per-household cost bound and becomes a per-group one.
- Channel pricing: Magrathea NEEDS CONFIRMATION; Twilio does not charge per channel. Capacity is a reliability question more than a cost question.

## 4. Spoofing, privacy and verification

| Threat | Feasibility | Impact | Control |
|---|---|---|---|
| **Forged Diversion.** An attacker calls the shared number directly with Diversion = the victim's mobile | **Likely feasible** (INDICATIVE). Ofcom's invalid-CLI blocking covers CLI, not redirecting identity. Test §1.2(1) | The call rings the victim's app. That is little new reach, because calling the victim's mobile already forwards to HCG. HCG pays for one monitored call, the same as a direct call to any DDI | Pair match (dialled pool number + Diversion), per-household and per-pool rate limits, Fortress reservations |
| **Membership oracle.** The attacker cycles Diversion values and watches answer vs reject | Feasible, silent, scalable | **A list of protected, likely vulnerable, people. HIGH** | Uniform neutral answer for unknown pairs; rate limits; the pair match forces the attacker to guess the pool number too |
| **Missing Diversion** | Possible on any untested network or mode | **Under CFU, the customer receives no calls** | Fail closed and never guess. Enrol tested networks only. Alert on the first absent header and move the household to a dedicated number |
| **Wrong household** | Format mismatch (`0…` vs `+44…`), using the first rather than the last Diversion entry, a recycled MSISDN | **Privacy breach**: another household's audio, transcripts and alerts | Strict E.164. Use the last entry (as `sip_identity.py` does). Exact match to a verified MSISDN. Re-verify on any change of number or network |
| **Multi-hop chains** (landline → mobile → HCG) | Legitimate | `sip_identity.py` treats Diversion count > 1 as `loop_suspected` → 486 | Separate "the HCG DDI appears in the chain" (a loop) from customer-side hops |

**Trust boundary:**
- Accept Diversion only from Magrathea's documented SIP IPs (`is_magrathea()`), and only as **attribution data, never authentication**.
- Magrathea Schedule 3 §5: LDLI is for "the sole purpose of facilitating your service operation" and must not be disclosed to end users (DOC). The app must never display it.

**If pooled, verify each household this way:**
1. Verify the protected mobile P (an in-app SMS OTP proves possession).
2. Assign the pair (pool number N, P).
3. The first forwarded call must carry Diversion = P before the household shows "protected". This is **passive LF-2 proof at £0**, with no outbound verification call.
4. Any call on N with no matching pair gets a neutral answer and hang-up, an alert, and no routing.
5. Fallback is a dedicated number, which requires the customer to re-dial `**21*`.

## 5. Dynamic assignment, numbering, loops

**Assignment and migration:**
- "Dedicated numbers only when needed" works **only at enrolment**, when the customer's network is known.
- Any later change needs the **customer to re-dial `**21*`**. HCG cannot re-point a divert remotely. Triggers:
  - a network starts stripping Diversion;
  - the customer ports to another network;
  - a pool fills up or a pool number is spam-flagged.

  The household loses calls until the customer acts. **This is pooling's decisive operational weakness.**
- Migrating customers off Twilio needs a re-dial whichever design is chosen, so pooling does not change that effort.

**Recycling:**
- With dedicated numbers, a recycled number can receive a former customer's still-active CFU calls. Today quarantine never auto-releases.
- **A Diversion-match check closes this on dedicated numbers too.** Pool slots recycle cleanly, because removing a pair hands nothing to anyone.

**Ofcom:**
- Geographic numbers cost 10p/number/year in about 30 pilot codes and are otherwise free (Ofcom guidance; still charged per ISPreview 2023, GC B1.12; INDICATIVE for the current rate).
- Any 03 charge: NEEDS CONFIRMATION.
- No prohibition on shared forwarding targets was found; this NEEDS CONFIRMATION.
- An own range means HCG becoming a CP with a 1,000-block, hosted by Magrathea (QUOTE; lead time unknown).

**Loops and failure:**
- HCG never dials the PSTN today, and pooling adds no loop.
- **If an onward PSTN leg to the customer is ever added**, CFU loops it straight back, and on a pool it consumes **shared** channels.
  - Controls: the HCG DDI in From/PAI/Diversion means a loop; a duplicate (caller, diverter) key; never dial a number that has CFU active.
  - Magrathea confirmed that limits do not end live calls; only HCG's BYE does.
- Carrier divert-chain caps (configurable, often around 5; INDICATIVE) stop a loop only after several billed legs.
- When HCG is down or full, under CFU there is no handset fallback: the caller hears busy or an announcement (test §1.2(2)).
- An outage or spam flag on a pool number hits **every** household on it.

## 6. Recommendation

1. **Move off Twilio numbers to cheap dedicated SIP numbers** (Magrathea, then an own range). This is the large, risk-free saving.
2. **Run test §1.1 now** (8 networks, reject-only, about £80). Even on dedicated numbers the result buys:
   - passive LF-2 forwarding proof;
   - recycled-number misrouting protection;
   - a loop signal.
3. **Pool only as an opt-in, capped tier**, and only if HCG stays on rented numbers:
   - ≤10 households per 10-channel number;
   - networks that pass the §1.1 extension only;
   - pair match, fail closed, uniform response, alerting on first absence.
4. **Never pool on Twilio PSTN numbers** (demonstrated failure).

**Confidence:**
- The Twilio failure and the cost arithmetic: high.
- The spoofing feasibility and caller-heard behaviour: medium.
- Network coverage: low. One data point, which is missing evidence, not failure.

## Sources (accessed 2026-10-10)
- HCG:
  - `/Users/ad/call-ai-viability/research/viability/ARCHITECTURE_OPTIONS_SHARED_SPLIT_MVNO.md` (184/184, ND1016 quote);
  - `/Users/ad/call-ai-magrathea-trial/docs/carriers/MAGRATHEA-LIVE-CALL-EVIDENCE.md` §13, `MAGRATHEA-SIP-TRIAL-PLAN.md`, `MAGRATHEA-TRIAL-PLAN.md`, `MAGRATHEA-TRANSFER-READINESS.md`;
  - `scripts/carriers/sip-lab/sip_identity.py` (f664aaf);
  - `docs/launch/2026-10-06-LF2-VERIFICATION-CALL-DESIGN.md`.
- Twilio:
  - ForwardedFrom: https://www.twilio.com/docs/voice/twiml
  - Concurrency: https://support.twilio.com/hc/en-us/articles/223180028 (search snippet; direct fetch 403) and https://www.twilio.com/docs/sip-trunking/scale-and-limits
- RFCs: https://datatracker.ietf.org/doc/html/rfc5806 · https://www.rfc-editor.org/rfc/rfc7044 · https://www.rfc-editor.org/rfc/rfc6044
- NICC ND1016 v6.1.1: https://niccstandards.org.uk/wp-content/uploads/2025/09/ND1016-V6.1.1.pdf (quoted via the viability doc; PDF not text-extractable today)
- Telnyx:
  - https://developers.telnyx.com/docs/voice/sip-trunking/configuration/concurrent-limits
  - https://community.retellai.com/t/diversion-sip-header-stripped-missing-from-custom-sip-headers-webhook-payload/3295 (third party)
- Ofcom: https://www.ofcom.org.uk/__data/assets/pdf_file/0030/58458/geo-telephone-numbers.pdf · https://www.ispreview.co.uk/index.php/2023/05/ofcom-probe-three-providers-over-failure-to-pay-uk-number-charges.html
- Lebara on Vodafone: https://www.ispreview.co.uk/?p=27281
