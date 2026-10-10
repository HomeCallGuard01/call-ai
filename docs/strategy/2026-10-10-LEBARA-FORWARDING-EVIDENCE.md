# Lebara external forwarding: historical evidence vs Lebara's statement (2026-10-10)

**Status:** read-only investigation. No production, Twilio, compatibility-policy, billing or forwarding change.

**Sources:**
- `docs/launch/INCIDENT_2026-09-28_INCOMING_CALLS.md`: read-only production Twilio and Supabase triage on 28 Sep.
- `docs/launch/ANDROID_CALL_CHAIN_AUDIT_2026-09-30.md`: `scripts/triage-incoming-calls.js` run on 30 Sep.
- Private production snapshots `~/hcg-staging-handset-test/prod-snapshot-9cb62adb-2026-10-0{2,3}.json`.
- `research/magrathea-trial-poc`: `docs/carriers/MAGRATHEA-LIVE-CALL-EVIDENCE.md` §13.
- Test A evidence `~/hcg-ws5-evidence/testA-20261010/`.
- Live production and Twilio reads were **not** made: blocked by this session's permission rules.

## 1. Historical evidence

### Household `9cb62adb`: Andrew's production household on the Motorola, HCG number `+44 1559 606063`

| Item | Value | Status |
|---|---|---|
| Carrier recorded at sign-up | `carrier_provider_key = lebara` (captured 2026-09-25 20:11 UTC); `app_platform = android` | **Confirmed** (snapshot) |
| A real inbound call reached `…6063` on **27 Sep 11:22:55 UTC** | `activation_verified_at = 2026-09-27T11:22:55Z`. Production `eb43368` sets this only from an inbound Twilio call to the household's HCG number | **Confirmed**. The "monitored about 6 s" detail is not in the local evidence; the Twilio/production record would show it |
| Calls **delivered to the app** on 26 and 27 Sep | Incident report: "delivered on 26 Sep and 27 Sep (latest 11:36, 58 s connected)". Call-chain audit: 27 Sep 11:34 and 11:36 parent and app leg completed. `delivery_verified_at = 2026-09-27T11:37:55Z` | **Confirmed** |
| The **4-second completed call on 26 Sep** | The incident report confirms delivery on 26 Sep. Duration and time are **not in local evidence** | Needs the Twilio record |
| Later call | 30 Sep 12:42: reached HCG, the app didn't answer | Confirmed (audit) |
| **Were these calls forwarded by Lebara?** | Twilio can't tell a forwarded call from a direct dial (`ForwardedFrom` = the Twilio number on 184/184 production calls; LF-2). **No document records which number the caller dialled** (the Motorola's mobile, or `…6063` directly) | **Not proven.** It is consistent with forwarding: the household was set up to forward; the 28 Sep incident assumed an active `**21*` divert on Andrew's phones; the 30 Sep runbook warned that the Motorola's always-forward pointed at its production HCG number |
| **Which forwarding mode** | The set-up flow uses unconditional forwarding (`**21*`). No `*#21#` reading was recorded on 26–27 Sep. On 10 Oct `*#21#` read **not forwarded** (when and how it was cleared is unrecorded) | **Assumption: unconditional**, not confirmed |

### Magrathea Test 4, 9 Oct 09:58:31 UTC: **network diversion by Lebara to an external number, PROVEN**

- **The call:** iPhone (Lebara) → Motorola (Lebara monthly SIM) → **Lebara network diverted it** → Magrathea DDI `0330 088 4327` → HCG's trial endpoint.
- **Proof:**
  - SIP **`Diversion: <sip:…030@…>;reason=unknown`** names the Motorola as the diverting line;
  - Magrathea CDR `6AC8BAC7JF4CE809`;
  - Magrathea confirmed it in writing (ticket LKV-51353-279);
  - two-way audio for about 6.8 s.
- **The divert type was not proven:** `reason=unknown`. Busy forwarding had been set; unconditional forwarding to the same number had been used on this phone before.
- **Afterwards:** `*#67#` read inactive, and **both re-registrations by code were refused**.

### Test A, 10 Oct

- Registering no-answer forwarding **by code** to Lebara's own voicemail was refused ("invalid MMI").
- Lebara's 1211 service then set it, to voicemail 121 after 15 s, and it worked.

## 2. Reconciliation with Lebara support ("external forwarding unsupported network-wide, including by support")

- **Confirmed contradiction:** Lebara's network **did** divert a call to an external number on **9 Oct**, and evidently delivered forwarded traffic to HCG's Twilio number on 26–27 Sep (very likely, not proven).
- So "unsupported" cannot mean "technically impossible on Lebara's network". The consistent explanations, none yet proven:
  1. **A policy or support position, not a network block:** Lebara doesn't *support* or guarantee external forwarding (its help page says "isn't available at the moment"), but its core still executes diversions that are already registered.
  2. **A recent change:** new diversion **registrations** are now refused, either across the network or **on this SIM**. Evidence: re-registrations failed after 9 Oct; `**61*` failed on 10 Oct; existing or earlier registrations had worked. This could follow the unusual 03 diversion, an anti-fraud flag, or a platform change.
  3. **Route-dependent:** codes refused, Lebara-side provisioning allowed (as with 1211).
- **What Lebara needs to answer, with evidence:** *"Your network diverted calls from my SIM to external UK numbers on 26–27 Sep and on 9 Oct (CDR `6AC8BAC7JF4CE809`, SIP Diversion header). Is diversion now barred on my SIM, or was there a network-wide change on or after 9 Oct? Will existing customers' external diversions keep working?"*

**Consequence:** the architectural conclusion "forwarding can't be relied on across all networks" still stands; Lebara's own statement is enough to make it unsafe to *promise*. But the claim "**Lebara cannot forward to HCG**" was **too strong**. It has forwarded. Treat Lebara as **"unreliable / unconfirmed"**, not "impossible", until Lebara answers.

## 3. Read-only checks that would settle it (Andrew; no cost)

1. **iPhone Recents** for 26 Sep (the 4 s call) and **27 Sep 12:22 BST** (= 11:22 UTC): which number was dialled? **The Motorola's own mobile** means Lebara forwarding is confirmed; `…6063` directly means a direct dial.
2. **Twilio Console** › Monitor › Calls › the calls to `+441559606063` on 26 Sep and 27 Sep 11:22–11:23 UTC: From, duration, child legs and stream (that's the about-6 s monitoring).
3. **Lebara account usage** for the Motorola SIM, 26–27 Sep and 9 Oct: itemised forwarded-call legs, if Lebara shows them.
4. Send Lebara the question in §2.

## 4. Operators and providers: what we have actually investigated

| Category | Provider | Investigated? | What we learned / what they could offer |
|---|---|---|---|
| UK MNO | **EE, O2, Vodafone, Three** | Desk research and HCG carrier policy (forwarding codes; Vodafone PAYG marked incompatible). **None contacted** | Unconditional forwarding generally available on pay-monthly. Retail scam products: EE Scam Guard (£2), Vodafone Scam Call Protection (Hiya), VMO2 Call Defence (free), all **pre-answer labelling only**. Network-side selective diversion (3GPP CDIV with caller conditions) is optional in GSMA IR.92 and not offered to consumers. **Partnership** (network-side routing of unknown calls to HCG) is plausible but needs business development |
| UK MVNO | **Lebara** | **Live-tested** (Test A, Magrathea Test 4); support contacted | See §1–2: diverts executed; support says unsupported; registrations now refused |
| UK MVNO | giffgaff, Sky, Smarty, iD, Talkmobile | HCG policy (`provider_specific`); not tested live | Expected to allow forwarding (codes or Settings); unverified on devices |
| UK MVNO | **Tesco Mobile, 1pMobile** | Policy `incompatible` (Tesco via a support statement) | Tesco runs on O2; worth re-checking with evidence |
| UK MVNO | Lyca, VOXI, ASDA | Policy `unverified` | Unexplored |
| UK MVNO | Virgin Mobile (O2) | Community statement only | "Don't currently support call forwarding" (unverified) |
| UK landline | BT, Virgin Media, Sky | Researched 2026-09 | No consumer selective forwarding (landline delivery on HOLD) |
| UK wholesale / CPaaS | **Magrathea** | **Live trial**, 4 calls passed, Diversion header proven | Free inbound; £0.50/number/month; 10 channels; **£100/month minimum**; no REFER; can host an own number range; "Network Mode" can deliver the diverting line's identity (LDLI). Credible usage-independent backend |
| UK wholesale | **AQL** | Call held, rate card received | Operator with MNO status via BlueWave (Isle of Man). Routing in the mobile core likely only for aql SIMs (SIM change); key question unanswered |
| UK wholesale / FMC | Gamma, iQ Mobile, Wireless Logic | Desk research only | FMC SIMs that route inbound mobile calls via SIP before ringing, but **need a SIM change** |
| UK SIP | Sipflex, sipgate | Desk research (viability report) | Free-inbound geographic SIP numbers; basis of the A4 usage-independent model (about £2.7–3.0 per subscriber) |
| International CPaaS | **Twilio** | Current provider | Per-minute inbound; no spend limit; SDK leg £0 so far |
| International CPaaS | **Telnyx** | Docs plus a 30 Sep meeting (**no notes recorded**) | Published UK inbound ($0.005/min local); channel billing; Mobile Voice eSIM (beta, UK unclear); TeXML lacks `<Client>` |
| International CPaaS | Plivo | Docs | UK number $0.85; inbound $0.0055; SDK leg charged |
| **Unexplored** | Vonage, Sinch, Bandwidth, Simwood (UK wholesale), Colt, BT Wholesale, Daisy/Wavenet, IDT; Ofcom number-range application (direct) | — | Possible alternatives for free or cheap inbound and number hosting. None changes the forwarding dependency |
| Platform | Google (Pixel / Samsung on-device Scam Detection, UK) | Desk research | Free **competitor** to on-device-only protection |

## 5. Revised recommendation (no decision taken)

1. **Withdraw "Lebara cannot forward to HCG".** Replace it with: *Lebara has executed external diversions (9 Oct proven; 26–27 Sep very likely), but now refuses new registrations by code and support says it's unsupported. Status: unconfirmed, pending Lebara's answer and the §3 checks.* **Don't change the compatibility policy yet** (as instructed). But note that today's `compatible` label promises more than the evidence supports.
2. **The platform finding stands:** live AI screening without forwarding is impossible for a third-party app (AOSP `@SystemApi`; iPhone has no APIs). The forwarding-based product remains the **only** way to deliver live screening. Its reach is **"most networks"**, not "all", and every network should be confirmed with evidence (like Test 4), not by support statements.
3. **Commercial path, revised:**
   - keep the **forwarding product as the core** where networks support it (Andrew has already ruled out an Android-only main architecture);
   - move it to a **usage-independent backend** (Magrathea or a free-inbound SIP carrier, plus self-hosted delivery) to reach margin at £5.99;
   - use **on-device protection only as a fallback** for networks that can't forward. It's not a standalone product: Google ships free on-device scam detection.
4. **Fastest evidence, at no cost:** §3 checks 1–2 (10 minutes for Andrew) settle the 26–27 Sep question. §2's question to Lebara settles whether registrations are blocked on the SIM or across the network.
