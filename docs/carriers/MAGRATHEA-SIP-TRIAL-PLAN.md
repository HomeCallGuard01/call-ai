# Magrathea controlled SIP trial: test plan (PREPARE ONLY)

**Date:** 2026-10-08. **Branch:** `research/magrathea-trial-poc`. **Parent plan:** [`MAGRATHEA-TRIAL-PLAN.md`](MAGRATHEA-TRIAL-PLAN.md). The call matrix T1–T8, stop rules and reset there still apply; this document adds to them.

**Status:** plan and local-only tooling. No API request, SIP registration, call, number or routing change, paid infrastructure, deployment or production change has been made for it. No secrets are involved: Magrathea delivers to an IP-addressed SIP URI without authentication.

**Labels:** **DOC** = Magrathea document. **PENDING-M** = pending Magrathea confirmation; not to be relied on or tested until confirmed. **LIVE** = only a controlled call can settle it. **INFERRED** = reasoning from DOC.

---

## 1. Ground rules this plan is built on

1. **On documented features alone, a trusted call stays off HCG's bill only if it never reaches Magrathea.**
   - The only *documented* way back to the customer's mobile is a PSTN target. That is a paid leg, it needs a Chargeable Translation account, and it loops back under CFU (parent plan §4.5, DOC + INFERRED).
   - **Network transfer is not ruled out.** REFER, redirect or a provider-assisted transfer that releases Magrathea's leg is undocumented, not disproven, and stays **PENDING-M** (§5). If Magrathea confirms one, it is tested for both technical and billing proof, and this rule is revised.
2. So **trusted routing is decided on the handset.** The customer uses conditional forwarding (CFB `**67*` / CFNRy `**61*`), and only unknown or declined callers reach Magrathea.
3. **The trial tests whether the carrier side behaves**: identity, loops, charges and cessation. It does not try to build carrier-side trusted forwarding.
4. **No header is trusted by default.** Every identity is recorded together with the header it came from and an evidence grade (§3).
5. **Trial scope (Magrathea, 2026-10-08):** REST access covers number management only. No account endpoints, and no FTP CDRs. Money evidence is therefore manual (§6).

## 2. Local-only configuration (prepared, tested on loopback, not deployed)

| File | What it is |
|---|---|
| `scripts/carriers/sip-lab/sip_identity.py` | Parses an INVITE and grades each identity: caller, network number, diverting line, privacy. Returns a routing decision for a call that has reached Magrathea |
| `scripts/carriers/sip-lab/esip_capture.py` | **E-SIP**, the answer-only capture endpoint. Modes: `busy` (486), `noanswer` (180, then waits for CANCEL), `unavailable` (480), `answer_hold`, `answer_bye`. Sends PCMA silence while a call is up. Raw INVITEs are written mode 600 outside the repo; the timeline is JSONL with numbers masked |
| `scripts/carriers/sip-lab/esip.conf.example.json` | Template config. Allowlist = the six documented Magrathea signalling IPs. `public_ip` and the evidence dir are filled in at A4 |
| `test_sip_identity.py` | 13 offline cases: spoofed CLI, PAI mismatch, withheld, missing CLI, loops, duplicates, wrong source, wrong DDI, History-Info. **13/13 pass** |
| `test_esip_loopback.py` | 10 cases on 127.0.0.1 with synthetic INVITEs. Covers every mode, the output guard, allowlist drop, file modes and masking. **10/10 pass** |

**Hard guards in E-SIP:**
- It **cannot** send INVITE, REFER, REGISTER or any 3xx. A code-level guard raises an error, and a test proves it.
- The only request it ever sends is BYE inside a dialog it answered.
- Packets from non-allowlisted IPs get no reply.
- It stops automatically after 4 h.

**Known limits:**
- UDP only. No TLS/SRTP. Magrathea documents an `E:` TLS/SRTP target (NTSAPI guide), which is not used in the trial.
- The ring delay blocks the receive loop for `ring_s`, which is 2 s by default.
- A retransmitted INVITE is logged but not re-answered.
- Untested against a real carrier until A5.

**Hosting at A4 (not provisioned):** a small UK VM with a public IP. The firewall allows SIP/RTP from the Magrathea ranges only (parent plan §6.1). It is not connected to Twilio, Supabase, staging or production, and is destroyed after the session.

## 3. Identity: what each header can tell us, and how far to trust it

| Signal | Header (DOC: Schedule 3 §5, CDR spec) | Can a caller set it? | Grade in `sip_identity` | Use |
|---|---|---|---|---|
| Presentation number | `From`, `Remote-Party-ID` | **Yes**: VoIP callers choose it | `presentation_only` | Display to the customer if not withheld. **Never** enough to treat a caller as trusted |
| Network number | `P-Asserted-Identity` "may not always be present" (DOC) | Network-set (DOC). Whether it is ever passed through from VoIP originators is **PENDING-M** (M-Q7b) | `network_asserted` only when PAI is present and equals the presentation number | The only identity eligible for trusted-list matching |
| PAI differs from presentation | PAI ≠ From | — | `presentation_differs` | **Confidential**: never shown to an end user, never matched (§5.4) |
| Withheld | `privacy=full/yes` on RPID/Diversion, `Privacy:` for PAI (DOC) | Caller's choice | `withheld = true` | Monitoring path; no number displayed (§5.3) |
| Diverting line (the customer's mobile) | `Diversion` (last one = CDR `LDLI`) (DOC). `History-Info` is a fallback whose use is PENDING-M | Network-set is presumed but **PENDING-M** (M-Q7b) | always `unverified` | Recorded only. Becomes LF-2 evidence only after M-Q7 plus T8 pass per MNO |
| Dialled number | Request-URI user = `443300884327` (target encodes it, DOC) | No | — | Wrong DDI → 403 |
| CDR correlation | `X-CALLINFO: cdr=…` (DOC) | No | — | Joins the E-SIP timeline to Magrathea's CDR |

**Identifying the customer's forwarded mobile without trusting the header** (LIVE, per MNO):
- Call H-T from H-C while H-T has CFB set.
- Confirm that the `Diversion` identity equals H-T **and** that the call arrived on the DDI at the expected moment (timeline).
- Then repeat with a VoIP-originated call presenting a fake `Diversion`, **only if** Magrathea confirms such calls can reach us (M-Q7b). Without that, we cannot show the header is unspoofable, so it stays `unverified`.

## 4. Routing: trusted to the mobile, unknown to HCG

| Caller | Where the decision is made | Path | HCG paid leg? |
|---|---|---|---|
| Trusted | **Handset** (the customer answers; CFB/CFNRy never fires) | Stays on the customer's MNO. Magrathea never sees it (T3a proves this) | No (DOC + LIVE T3a) |
| Unknown / declined | MNO diverts → Magrathea DDI → E-SIP (trial) / HCG monitoring (Phase 6) | `number/set` target = HCG SIP endpoint | Magrathea inbound £0 (DOC, verify LIVE). The forwarding leg is billed to the **customer** by their MNO |
| Trusted, but it reached Magrathea anyway (e.g. CFU set, or the handset was off) | `sip_identity.decide()` → `monitor_flag_trusted` | Delivered to monitoring and flagged as an anomaly | No. There is no "forward to mobile" action **yet**. The only documented way is a paid PSTN leg with loop risk. A transfer action is added only if §5 is confirmed and proven |
| Loop suspected (more than one `Diversion`, or our own DDI as caller/diverter) | `decide()` → `reject_486` | Rejected | No |
| Withheld / no CLI | `decide()` → `monitor`, reason `no_usable_cli` | Monitoring | No |

**Phase 6 (out of scope here):** connecting E-SIP's role to the *existing* HCG monitoring path is still a separate design. Today that path is Twilio, and routing the DDI there touches the shared production account.

## 5. REFER, redirect and provider-assisted transfer: all PENDING-M

Magrathea's guide, handbook, NTSAPI guide and resource docs contain **no** mention of SIP REFER, 3xx redirect handling or call transfer (searched 2026-10-08). The only "transfer" in the REST API moves funds. So:
- **Nothing in this group is tested unless Magrathea confirms support in writing.** E-SIP's guard blocks REFER and 3xx today.
- If Magrathea confirms one, the gated test is:
  - **TX1:** E-SIP answers, then issues the confirmed mechanism towards a second handset (H-2).
  - PASS needs **all** of:
    - (a) H-2 rings with the original caller's CLI;
    - (b) the E-SIP dialog ends and **Magrathea's CDR for the original leg ends** at the transfer moment;
    - (c) any new leg's charge and payer are known from Magrathea's written tariff and the next CDR.
  - If the Magrathea leg stays up (hairpin), it is a paid relay, not a release. Record it as FAIL for cost.
- Requires a new approval (A5-TX) and a code change to E-SIP, made only after confirmation.
- **A PASS with billing proof establishes a carrier-side trusted route.** That means Magrathea's leg ends at the transfer, and Magrathea's written tariff plus the session CDRs show who pays for any new leg and at what rate. Rule 1 and §8 are then revised. Neither outcome is assumed in advance.

## 6. Measuring chargeable legs and when billing stops

There are no API CDRs and no FTP CSV on the trial, so every money fact comes from one of these:

| Source | What it proves | How |
|---|---|---|
| E-SIP timeline (UTC ms) | When **we** saw INVITE / 200 / ACK / BYE / CANCEL | `timeline.jsonl` |
| Magrathea CDRs for the session | The carrier's start/stop, `debit`, `result`, `inbound`/`outbound` charges | **PENDING-M (M-Q2):** ask Magrathea to export the session's CDRs (portal, or email). Match on `X-CALLINFO` |
| MAGIC portal (`CPORTAL = 1`) | Balance before and after | Andrew reads it manually, before and after the session |
| H-T itemised bill | The customer's forwarding leg: is it charged, and for how long | MNO bill / app usage |
| H-C itemised bill | The original call only | MNO bill |

**"Billing stops" is PASS when** the Magrathea CDR stop time is within ±2 s of the E-SIP BYE (T6b) or the caller's BYE (T6a). The H-T forwarding leg must end at the same moment (bill duration ≈ E-SIP talk time, rounded to that MNO's billing unit). The balance must be unchanged.

## 7. Test matrix (adds to parent §6.3; attended, one call at a time)

| # | Test | E-SIP mode | Action | PASS | Pending |
|---|---|---|---|---|---|
| T1–T8 | As parent plan | as parent | as parent | as parent | — |
| T6a | Cessation, caller clears | `answer_hold` | H-C hangs up after 60 s | §6 criteria | M-Q2 |
| T6b | Cessation, HCG clears | `answer_bye` (60 s) | E-SIP sends BYE | §6 criteria | M-Q2 |
| T9 | Unanswered | `noanswer` | Leave it ringing | Caller hears ringing. Magrathea's own no-answer timeout (or the caller's hang-up) produces CANCEL; E-SIP replies 487; CDR `duration 0`, `debit 0` | M-Q8 (no-answer timer; is a single-target number failed over?) |
| T10a | Missing CLI, withheld | `busy` | H-C dials `141` + H-T (CFB) | `withheld = true`; nothing displayed; decision `monitor` | — |
| T10b | Missing CLI, unavailable | `busy` | Only if Andrew has an international or payphone-style source. **Otherwise skipped** | `grade = absent` | — |
| T11a | Duplicate, quick redial | `busy` | H-C calls twice within 10 s | Two distinct Call-IDs, both classified; the duplicate rule fires on the second only if (caller, diverter) matches within the window | — |
| T11b | Duplicate, retransmission | `noanswer` | (observed passively) | Repeated INVITEs with the same Call-ID are logged once and not double-answered | — |
| T12a | Unreachable, rejecting | `unavailable` | Call the DDI directly | 480 reaches the caller as failure/busy; one INVITE; CDR `result 480` | M-Q8 |
| T12b | Unreachable, E-SIP down | E-SIP **stopped** | Call the DDI directly | What the caller hears, and how long Magrathea retries | **PENDING-M** (M-Q8); run only after the answer, since behaviour is undocumented |
| T5c | Loop, CFU with E-SIP down | E-SIP stopped, H-T CFU | H-C calls H-T | Exactly one INVITE attempt series and no return to H-T; ends within Magrathea's timeout | M-Q4, M-Q8 |
| TX1 | Transfer | — | §5 | §5 | **Blocked until M-Q5 confirmed** |

**Stop rules:** the parent §6.5 rules apply, plus any INVITE that is not `classified`, or any `problems` entry other than those the test expects.

## 8. Providers against £5.99 and HCG's mandatory containment

The reference is £5.99, **£4.99 net of VAT**. The safe variable budget per subscriber at 40% margin is: **Stripe £1.07, Apple SBP/Play £0.74, Apple 30% £0.10** (`docs/finance/HCG_UNIT_ECONOMICS_V1_TABLES.md` §B). Price status: recorded as approved by Andrew on 2026-10-04 (`docs/launch/2026-10-05-PRICE-CUTOVER-CHECKLIST.md`). Live cutover is not done, and `HCG_UNIT_ECONOMICS_V1.md` still says "candidate".

| | **Twilio (today)** | **Magrathea (trial, docs)** | **AQL** |
|---|---|---|---|
| Trusted call cost to HCG | **£0.00756 per started minute for the whole conversation** (MEASURED) | £0 if handset-decided (never reaches Magrathea). LIVE T3a | Hypothetical £0 network-side (`TABLES` §I, modelled). No quote |
| Unknown/monitored leg | Inbound £0.00756/min + Media Streams £0.0033/min + AI (MEASURED/EST.) | Inbound £0 (DOC, LIVE T6) + HCG-hosted media + AI (not costed) | £0.0172/min modelled, no quote |
| Number | £0.869/month (MEASURED) | £0.50/month list; trial £100/yr for ≤25 numbers; £100/month minimum (LIST, unverified) | Unknown |
| Modelled typical margin at £5.99 (Stripe / stores) | Below the 40% target for a typical household: 26% on Stripe (`TABLES` §D) | 73% / 65%, **excluding HCG's own SIP/media infrastructure** (`TABLES` §I) | 56% / 49% (hypothetical) |
| **Hard provider spend ceiling** | **None.** "There is no maximum spend limit setting". LEVEL 4 **RED** (`PROVIDER_FINANCIAL_CONTAINMENT_FINAL.md` §0) | **None proven.** Prepaid is not a hard cap; some charges post-paid (DOC). Exposure is bounded by design only if PSTN targets are impossible (M-Q4) and 112168 is restricted (M-Q10) | Unknown. Questionnaire never sent |
| Reservation before expenditure / per-call cap / breaker (P0 §6, D3 = REJECT) | Enforced in HCG code via `<Dial timeLimit>` and the containment layer. The provider itself is unbounded | HCG endpoint can enforce a per-call cap (E-SIP sends BYE), concurrency (2 channels on the trial) and refusal (486). **But** refusing does not stop the customer's MNO forwarding leg, and D5 conflicts with "never stop delivery" | Unknown |
| CLI / forwarding evidence | `ForwardedFrom` = Twilio number on 184/184 calls checked (no LF-2 value) | `Diversion`/LDLI documented. Reliability **PENDING-M** + LIVE T8 per MNO | Possible carrier-side route, unconfirmed |
| Can a forwarded trusted PSTN leg be released? | No | **Not documented → PENDING-M** (§5) | Unknown |

**Reading the table:**
- Magrathea is the only option whose documented cost structure makes trusted *and* unknown carrier minutes £0 to HCG.
- **None** of the three currently meets HCG's mandatory "provable maximum loss" requirement:
  - Twilio is documented as unbounded;
  - Magrathea is unproven pending M-Q4/M-Q9/M-Q10;
  - AQL is unknown.
- Magrathea's 73%/65% figure omits HCG-hosted media and AI infrastructure, so it is an upper bound.
- Nothing here changes AL-2 or any launch decision.

## 9. Approval checklist (each a separate yes from Andrew; nothing is pre-approved)

- [ ] **A3:** send the Magrathea questions (§10 plus parent §10) by email. Outward contact.
- [ ] **A4a:** create the E-SIP VM (paid infrastructure, a few £; auto-destroy within 4 h of the session).
- [ ] **A4b:** `POST /number/set/03300884327` index 1 → `S:443300884327@<E-SIP IP>`. Record the prior target first (R6), restore afterwards. **Needs `/number/*` access working**; R6 401 is still open.
- [ ] **A5a:** attended direct-dial calls: T1, T2, T2w, T12a, T9, T11b.
- [ ] **A5b:** H-T forwarding change (CFB, then CFU for T5b/T5c) plus T3a, T4, T8, T5a, T5b, T6a, T6b, T10a, T11a. Not the Build 17 iPhone; not the production Motorola.
- [ ] **A5c:** per-MNO repetition of T4, T8, T6.
- [ ] **A5d:** T12b / T5c (E-SIP down). Only after M-Q8 is answered.
- [ ] **A5-TX:** transfer test. Only after M-Q5 is confirmed in writing, plus a code change review.
- [ ] Session-end reset (parent §6.5) confirmed complete, then the VM destroyed.

## 10. Information required from Magrathea

Send together with parent §10 Q1–Q13 (which still stand). New or sharpened:

- **M-Q1 (access):**
  - Please enable or confirm REST `/number/status` and `/block/info` for our API login on `03300884327`. We received a Tomcat 401 at 14:12 UTC on 2026-10-08.
  - Is the login locked out?
  - What are the number's current target and expiry?
- **M-Q2 (CDRs on trial):** with no FTP CDRs on the trial, can you export the CDRs for a named test session, including `result`, `debit`, `inbound`, `outbound`, `cpacc`, `cpstop`, `LDLI`? Or are they visible in MAGIC?
- **M-Q3 (headers):** on the trial DDI, which headers will we receive? (`From`, `RPID`, `PAI`, `Privacy`, `Diversion`, `History-Info`, `X-CALLINFO`.) Is Network Mode active, and is the agreement needed?
- **M-Q4 (no PSTN):** confirm the trial account **cannot** route the DDI to a PSTN target (no Chargeable Translation), so a mis-set target cannot create a paid leg.
- **M-Q5 (transfer):** do you support SIP REFER, or follow a 3xx from our endpoint, on inbound calls? If so: does your leg leave the path or stay up, and who pays for the new leg at what rate? Any other provider-assisted transfer?
- **M-Q6 (UDP/TLS):** can a number target use UDP from your ranges to our IP with no authentication? Which RTP source ranges and codecs (PCMA/PCMU) should we allow?
- **M-Q7 (diversion trust):**
  - (a) Internal, never-displayed use of `Diversion`/LDLI to confirm that a customer's own phone forwarded: permitted under Schedule 3 §5.5?
  - (b) Can a VoIP-originated caller set `Diversion` or `PAI` that reaches us unchanged?
  - (c) Per-MNO population on CFU/CFB/CFNRy to an 03 number.
- **M-Q8 (failure behaviour):**
  - Your no-answer timer for a single-target number.
  - What the caller hears when our endpoint returns 480/486, or does not respond.
  - Retry/timeout timing.
- **M-Q9 (spend):** is the prepaid balance a hard stop? Can it go negative? Which charges can arise on inbound-only use?
- **M-Q10 (outbound 112168):** set restriction HIGH or bar outbound entirely, and reduce channels to 2, until needed.
- **M-Q11 (duplicates):** do you ever re-present the same call (new Call-ID) after a failure, e.g. alternate route retry?

## 11. Pending-Magrathea register (not relied on anywhere)

- REFER, 3xx and transfer support (M-Q5).
- Header population and PAI/Diversion trustworthiness (M-Q3, M-Q7).
- History-Info.
- Failure, timeout and retry behaviour (M-Q8, M-Q11).
- Trial CDR access (M-Q2).
- Hard spend stop (M-Q9).
- No-PSTN guarantee (M-Q4).
- UDP/RTP ranges and codecs (M-Q6).
- Registered-UA targets (parent Q6).
- `/number/*` access for our login (M-Q1).
