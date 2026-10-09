# Magrathea: screened-call transfer readiness (Fri 2026-10-09)

**Goal:** prove whether Magrathea can support a **financially viable** transfer of a screened call to a customer's existing mobile.
**Status:**
- Phase 1 safety fixes are done and tested. They are **not deployed** to the VM.
- Phase 2 questions are ready (not sent).
- Phase 3 plans are **proposed, not approved**.
- Phase 4 teardown is prepared (not run).

**Nothing in this document originated a call, enabled forwarding or transfer, or changed routing.**

Evidence: [`MAGRATHEA-LIVE-CALL-EVIDENCE.md`](MAGRATHEA-LIVE-CALL-EVIDENCE.md). Plans: [`MAGRATHEA-SIP-TRIAL-PLAN.md`](MAGRATHEA-SIP-TRIAL-PLAN.md), [`MAGRATHEA-TRIAL-PLAN.md`](MAGRATHEA-TRIAL-PLAN.md).

---

## 1. Phase 1: safety fixes (`scripts/carriers/sip-lab/`)

| ID | Problem (found 2026-10-08) | Fix |
|---|---|---|
| **SAFETY-1** | The BYE was sent once. A lost BYE, or a lost 200 OK, left the carrier leg up. The 120 s cap was a no-op after any BYE | The BYE is a real UDP client transaction: retransmitted at T1 (0.5 s), doubling to T2 (4 s), until a final response or Timer F (32 s). **2xx/481 → `cleared` + `bye_confirmed`**. Timeout → `bye_unconfirmed` ALERT, then a fresh BYE (CSeq+1), up to 3 attempts, then a `clear_failed_manual_action` ALERT. The **`max_call_s` backstop starts another BYE whenever the call is not confirmed cleared**. A far-end BYE that races ours stops our retransmissions |
| **SAFETY-3** (new) | A lost ACK meant the call never reached `up`: no media, **no cap timer**, and the leg possibly billed until the caller hangs up | 200 OK is retransmitted until ACK (Timer G). With no ACK by 32 s → `ack_timeout` ALERT + BYE (RFC 3261 §13.3.1.4). **The 120 s cap now runs from our 200 OK, not from the ACK.** A retransmitted INVITE gets the same 200 again |
| **SAFETY-2** | *Correction to yesterday's note:* an in-dialog re-INVITE was **silently ignored**, not answered 405. Magrathea's `Session-Expires: 1900;refresher=uac` means a refresh re-INVITE at about 950 s, so a long call could fail its refresh | The re-INVITE (higher CSeq, call up) gets 200 OK with our **unchanged SDP**, and `Session-Expires` is echoed. A re-INVITE on a cleared call gets 481; during our BYE it gets 491. Under the 120 s cap this path is never reached, but it is now correct |
| **SHUTDOWN** (new) | The 12:00 UTC stop (SIGTERM) killed the process mid-call, leaving any held call to the caller | SIGTERM → stop accepting calls (a late INVITE gets 480) → BYE every held call → wait up to 5 s for 200s → log `shutdown {cleared, unconfirmed}` |
| **PRIV-1** | The BYE Request-URI (the caller's Contact) was logged unmasked | Every logged SIP line goes through `mask_line()` (any 7+ digit run → `****…NNN`, the DDI kept). Outbound lines now carry the Call-ID. **New `esip_report.py`** is the routine way to inspect a call: identity headers masked, other headers by name only, an optional in-memory "does any header hold the reference number" check, and never raw INVITEs, WAVs or pcap payloads |

The output guard is unchanged: E-SIP can send no INVITE, REFER, REGISTER or 3xx; BYE is the only request it can send.

**Tests** (loopback 127.0.0.1 only):
- new `test_esip_safety.py` **26/26**, run three times in parallel: 26/26 each time. This includes S15 (a real process, SIGTERM mid-call: BYE confirmed, exit in under 1 s despite a pending 120 s timer) and S16 (handler exception → ALERT, endpoint keeps serving);
- existing `test_esip_loopback.py` **16/16**, with T1 pinned to 2 s for its exact-sequence checks;
- `test_sip_identity.py` **14/14**.

**The same three suites passed on the VM** (Python 3.12.3), from a temporary directory that was deleted afterwards. The live service and `/opt/sip-lab` were untouched (hash `eed2f409…`, the code from 2026-10-08).

Scenarios covered:
- S1 BYE lost once;
- S2 200 OK lost (×3; doubling intervals checked);
- S3 no response at all (3 × Timer F, alerts, CSeq 1→2→3; **then the cap backstop's CSeq 4 BYE, confirmed**; only BYE is ever sent);
- S4 cap BYE lost in `answer_hold`;
- S5 ACK lost (200 retransmits, `ack_timeout`, BYE; no RTP);
- S6 INVITE retransmission;
- S7 far-end BYE race;
- S8 481;
- S9 session-refresh re-INVITE (same port, `Session-Expires` echoed, media continues);
- S10 SIGTERM shutdown clears the call;
- S11 re-INVITE after clearing → 481;
- S12 stray late 200;
- S13 output guard;
- S14 no unmasked number in any timeline, DDI still readable.

### 1.1 Remaining limitations (do not over-read the tests)

1. **A loopback simulation does not prove that Magrathea clears a real call.** Only Test 2 (one real BYE, 200 OK in 5 ms) is live evidence. The retransmit, ACK-timeout and re-INVITE paths have **never** met Magrathea's proxy. Even a 200 OK to our BYE proves only that Magrathea's proxy accepted it; **only Magrathea's CDR proves its leg (and billing) stopped** (M-Q2).
2. **We cannot force-clear a leg that Magrathea won't clear.** After `clear_failed_manual_action`, the only remedies are the caller hanging up, the customer's MNO, or Magrathea support. Alerts are written to the timeline only; nothing pages anyone. Hence: every test is attended.
3. **The fixes are not deployed.** The VM still runs the 2026-10-08 code, which has SAFETY-1/-3 and no graceful shutdown. That is acceptable only because **no call is planned before 12:00 UTC**. Deploying needs a service restart (§5, decision D2).
4. Media is not re-targeted on re-INVITE: we keep sending to the original SDP address. There is no handling of `UPDATE` (Magrathea's INVITE did not offer it) or of hold SDP.
5. Retransmit timers run in threads in one Python process. A per-message exception is now caught and logged as a `handler_error` ALERT (S16). A process crash would still lose them. *Corrected 2026-10-09:* the unit has `Restart=no`, so a crashed endpoint **stays down**: new calls then fail at Magrathea, and any held call is left to the caller.
6. `esip_report.py` masks digit runs; it does not recognise numbers written with separators. Raw INVITEs, WAVs and pcaps remain unmasked by design: they are the private evidence (mode 600/700, outside git).

---

## 2. Phase 2: remaining questions for Jay (supersedes the open items in the evidence doc §9)

Background to send with them:
- Three successful calls on 2026-10-08 (CDR refs below), each answered and recorded;
- our endpoint clearing the call itself worked (Test 2);
- withheld CLI arrives as `From: anonymous` with no RPID, PAI or Privacy;
- **no call carried P-Asserted-Identity.**

**Our docs already say** (and these questions ask Magrathea to confirm or correct):
- inbound to an 03 number delivered to SIP carries no Magrathea call charge (Annex 3 v6.0);
- a PSTN target needs a **Chargeable Number Translation** account (setup from £100 + VAT; minutes from prepay);
- the prepaid balance is **not** documented as a hard stop;
- some charges are post-paid;
- there is no spend-cap API.

1. **Transfer method.**
   - Once our SIP endpoint has answered and screened a call to `0330 088 4327`, can you transfer it to a UK mobile (the customer's own number) by any of:
     - (a) SIP **REFER** from us: blind, and/or attended?
     - (b) a **302** with `Contact: tel:+447…`, returned *before* we answer?
     - (c) any API or provider-assisted method, for example a target change or a "connect to" instruction mid-call?
   - Which works on the **trial** account, and what must be enabled (Chargeable Number Translation, the outbound account 112168, anything else)?
2. **Can HCG leave the call?**
   - After the transfer, is our SIP leg released completely, with no media or signalling through our server?
   - Or does your platform hairpin, keeping the inbound leg and bridging a new outbound leg?
3. **Is the onward mobile leg billed after we leave?**
   - Who is billed for the onward leg, and from when to when: does it run until either party hangs up, even with our server gone?
   - Is the original inbound leg still billed during the transferred conversation?
   - Can we set a **maximum duration** for onward legs?
4. **Exact rates** for the trial and production accounts:
   - inbound 03 → SIP (confirm £0, including mobile-originated and diverted calls);
   - onward call to a UK mobile, per network: per-minute rate, **connection charge**, **billing increment** (per second? minimum charge?);
   - Chargeable Number Translation setup and monthly fees;
   - number rental; channel limits; any minimum monthly spend.
5. **CLI on the onward leg:** which CLI would the customer's mobile see, the original caller's or our 03 number? Is presenting the original caller's CLI on a transferred call permitted for us?
6. **Loop protection:** if the customer's mobile diverts the transferred call again (busy, no answer, or unconditional forwarding), what stops a loop back to our number? Is there a diversion counter, or a way to mark the onward leg "do not divert"?
7. **Caller identity and forwarded-call verification:**
   - Under Network Mode, will **P-Asserted-Identity** be sent? We saw none.
   - Is `Remote-Party-ID … screen=yes` set by you after network verification, or passed through from upstream?
   - Can a VoIP-originated caller set RPID, PAI or Diversion values that reach us unchanged?
   - When a customer's mobile diverts to us (CFB, CFNRy, CFU), will we receive `Diversion` / LDLI identifying their mobile, on EE, Vodafone, O2 and Three?
   - How do withheld and unavailable callers differ?
8. **Genuine hard spending limit:**
   - Is the prepaid balance a hard cutoff, including for **in-progress** calls? Can it go negative? Which items are post-paid?
   - Is there a per-day or per-month cap, a per-call duration cap or a low-balance alert?
   - Can outbound 112168 be barred, or restricted to UK mobiles and limited to 2 channels, until needed?
9. **Yesterday's actual charges:** the CDRs (result, duration, debit, inbound/outbound charge) and any account charges for:
   - `cdr=6AC7C417GF374B24` (16:25 UTC, 5 s; was this your test call?);
   - `cdr=6AC7DA6BAF3B522D` (18:01);
   - `cdr=6AC7DE025F3BB2F9` (18:16, cleared by our BYE: did your CDR stop at 18:16:47?);
   - `cdr=6AC7DF255F3BD120` (18:21, withheld).
10. **Routing back:** our endpoint stops at 13:00 BST today.
    - Please restore or remove the trial number's target and confirm **in writing** when it no longer points at `159.65.27.229`, before we delete the server.
    - What does a caller hear while the number has no reachable target?

**Do not assume a transfer is free because our server has left.** Until Q1–Q4 are answered, a transfer is modelled as **a paid outbound leg to a UK mobile, billed to HCG for the full conversation, possibly plus the inbound leg (hairpin)**.

---

## 3. Phase 3: next live test plan (PROPOSED; nothing approved)

Two separate phones:
- **P-A**, the "caller": a second handset with its own SIM. The tariff must be known.
- **P-B**, the "customer mobile": Andrew's iPhone.

E-SIP runs the **fixed** code (D2). The tests are attended and one call at a time. The parent stop rules apply, plus: *no 200 OK to our BYE within 1 s, or any ALERT event → stop*.

Splitting this into two tests is deliberate.
- **Test 4 needs nothing from Magrathea** and has no HCG-billed onward leg.
- **Test 5 (the actual transfer) is blocked** on Magrathea's answers (Q1–Q6, Q8) and on an E-SIP code change: the output guard forbids REFER and 3xx today.

### 3.1 Test 4: forwarded call reaches HCG; HCG clears it. Ready on approval (D3)

**Route:**
1. P-A dials P-B.
2. Andrew declines on P-B (**CFB**, set with `**67*03300884327#`), or lets it ring (CFNRy `**61*…#`). CFU is **never** used.
3. P-B's network diverts the call to `0330 088 4327`.
4. Magrathea delivers it to E-SIP (`answer_bye`, 20 s).
5. E-SIP sends the BYE.

There is no onward leg and no transfer.

| Leg | Originated by | Billed to | Rate (verify; do not assume) |
|---|---|---|---|
| P-A → P-B | P-A's network | P-A's account | P-A's normal mobile-to-mobile rate |
| P-B → 03300884327 (forwarded leg) | P-B's network | **P-B's account** | P-B's rate for a diverted call to 03. 03 numbers are normally priced like 01/02 and inside allowances, but diverted legs can be priced separately, so read the bill |
| 03 → SIP (inbound to HCG) | Magrathea | HCG (Magrathea account) | £0 per Annex 3; **verify by CDR (Q9)** |
| Onward / transfer | **none** | — | — |

**It establishes:**
- `Diversion` / LDLI presence and form for P-B's network (N1);
- PAI on a forwarded call (N2);
- whether our BYE ends **both** the P-A and the forwarded leg;
- P-B's forwarded-leg charge.

**Maximum cost:** 2 calls × ≤ 2 min (E-SIP's 120 s cap; the planned BYE is at 20 s).
- P-A: 2 × 2 min at P-A's rate.
- P-B: 2 × 2 min at P-B's diverted-call rate.
- Magrathea: £0 by documentation, with no outbound possible: E-SIP cannot originate, there is no PSTN target, and only 2 trial channels.

Enforcement:
- **Ours:** the E-SIP BYE (now retransmitted, with the cap backstop).
- **Theirs:** manual hang-up. Nothing we control caps P-A's or P-B's bill beyond that.

Andrew fills in both tariff figures before approval. If either phone is pay-as-you-go out of bundle, use its per-minute rate × 8 min as the ceiling.

**Duration:** about 20 minutes in total:
1. set CFB;
2. **check it with `*#67#`**;
3. make 2 calls;
4. **cancel with `##67#`** (or `##002#` to clear every divert);
5. re-check with `*#67#`.

**Manual abort:**
- P-A hangs up. If the call persists, P-B's diverted leg ends with it.
- Then run `##002#` on P-B.
- Stop E-SIP (`systemctl stop esip.service`, which now sends a BYE on SIGTERM).

**Verifying HCG left:**
- the timeline shows `bye` → `bye_confirmed` (200 OK);
- the pcap shows zero SIP/RTP packets for the call after the 200;
- P-A's screen shows the call ended at the same second;
- Magrathea's CDR stop time is within ±2 s of `bye_confirmed` (Q9).

**Billing evidence:**
- Magrathea CDRs for the session's `X-CALLINFO` refs (Q9);
- MAGIC balance before and after (Andrew);
- P-A's and P-B's itemised usage (app or bill) with time and duration;
- DigitalOcean unchanged.

**Window:** the test must finish before **12:00 UTC (13:00 BST) today**, or the window is re-approved (D4).

### 3.2 Test 5: screened-call transfer to the customer mobile. BLOCKED

**Proposed route** (only once Magrathea confirms a method in writing):
1. P-A → P-B (CFB/CFNRy) → divert to `0330 088 4327`.
2. Magrathea → E-SIP answers and screens (about 5 s of tone or announcement), then decides "trusted".
3. E-SIP issues the **Magrathea-confirmed** mechanism:
   - REFER (`Refer-To: <P-B>`); or
   - for 302, a *pre-answer* redirect. That means **header-based screening only**, with no audio screening, because a 302 is sent instead of answering.
4. **Magrathea originates an onward leg to P-B's mobile.**
5. Andrew answers on P-B.

| Leg | Originated by | Billed to | Rate |
|---|---|---|---|
| P-A → P-B | P-A's network | P-A | as Test 4 |
| P-B → 03 (diverted) | P-B's network | P-B (the customer) | as Test 4 |
| 03 → SIP inbound | Magrathea | HCG | £0 by doc; **does it continue after the transfer (hairpin)? Q2** |
| **Onward 03-platform → P-B mobile** | **Magrathea** | **HCG** | **Unknown: Q4** (per-minute rate, connection charge, increment; Chargeable Translation fees) |

**Loop hazard:** the onward leg rings the same P-B that diverted the original call. If Andrew declines it, or CFNRy fires again, P-B diverts it back to our number. Required before the test:
- E-SIP **rejects a second arrival** for the same (caller, diverter) within 60 s with 486, with no second transfer. The duplicate rule already exists in `sip_identity.decide()` and needs wiring and tests.
- Magrathea answers Q6.
- **CFU must never be set on P-B** (every transferred call would loop).

**Maximum cost** (can only be stated after Q4 and Q8):
- (onward rate × ≤ 2 min + connection) × ≤ 2 calls;
- plus the hairpin inbound leg if Q2 says it stays;
- plus P-A and P-B as in Test 4.

**Enforcement gap:** once HCG has left the call, **E-SIP's 120 s cap no longer applies.** The only controls on the onward leg are then:
- a Magrathea per-call duration cap, if one exists (Q3/Q8);
- the prepaid balance, **if** Magrathea confirms it is a hard cutoff for in-progress calls (Q8);
- manual hang-up by Andrew.

Without either Magrathea control, the onward leg's cost is bounded **only by the people on the call**. That fails HCG's provable-maximum-loss rule for production, so it must be recorded as such even if the test passes.

**Verifying HCG left:**
- REFER: we get `202 Accepted`, then `NOTIFY` with `SIP/2.0 200` sipfrag; then BYE in either direction with 200. A 302 creates no dialog at all.
- The pcap: **no SIP or RTP for that Call-ID after the BYE, while A and B keep talking for 30 s** (Andrew notes the times).
- Magrathea's CDRs: the inbound leg stops at the transfer (released) or runs to the end of the conversation (hairpin).

**PASS** (SIP plan §5) needs:
- (a) P-B rings with the original CLI;
- (b) HCG's dialog ends at the transfer;
- (c) the onward leg's charge and payer are known from the CDRs plus Magrathea's written tariff.

A hairpin is recorded as **FAIL for cost**.

**Also needs:**
- an E-SIP code change: a REFER or 302 path behind an explicit `transfer_mode` config, with the guard relaxed only for that, and loopback tests;
- possibly enabling Chargeable Number Translation (£100+ setup per our docs). That is a paid provider change and **a separate approval**.

---

## 4. Phase 4: trial lifecycle

**Stop at 13:00 BST today** (verified 07:42 UTC):
- `esip-stop.timer` → Fri 12:00:00 UTC (it then had 4 h 17 min left), enabled;
- the `ExecStartPre` guard (epoch `1791547200`) refuses any start afterwards;
- all three units are active.

The VM and evidence are not deleted. The deadline is **not** extended, and no paid resources were created.

**Evidence:**
- Yesterday's sealed copies (Call 1, Test 2, Test 3) are in `~/hcg-magrathea-trial/evidence-live-20261008/` (mode 700).
- At 07:4x UTC today the VM's 10 evidence files were checked: **identical to the Test 3 sealed copy**. There have been no calls since.

**Teardown** (prepared, not run): `~/hcg-magrathea-trial/teardown-do.sh` was hardened today; the old version is kept as `.bak-20261008`.
1. **Refuses to run** without `--magrathea-confirmed "<date/ref>"`, which is Magrathea's written confirmation that the number no longer targets `159.65.27.229`. We cannot check it ourselves (REST `/number/*` → 401), and deleting first would let DigitalOcean's next holder of that IP receive our number's calls.
2. Checks that the droplet still holds `159.65.27.229`.
3. Stops the services, and SHA-256s every evidence file on the VM.
4. Copies the files to `final-<UTC>/` and **aborts with nothing deleted if any checksum mismatches**.
5. Deletes the droplet, firewall, key and tag, then **verifies each returns `not_found`**. If any still exists, it exits non-zero and keeps the local SSH files.
6. Then tells Andrew to revoke the DO token and delete the Keychain item.

The script was syntax-checked, and its refusal path was tested (exit 2).

**Optional extra check before teardown** (needs approval; costs one call): after Magrathea confirms, Andrew dials the DDI. The expected result is Magrathea's unavailable treatment. Our VM shows nothing, because the services have stopped and the firewall drops the call.

---

## 5. Decisions needed from Andrew

| ID | Decision | Notes |
|---|---|---|
| **D1** | Send the §2 questions to Jay (with the 4 CDR refs and the routing-back request) | Blocks Test 5, the cost model and teardown. No cost |
| **D2** | Deploy the fixed E-SIP to the VM (copy `sip-lab`, restart `esip.service`, verify the `start` event; rollback = the previous files, kept) | Only needed if any call happens before 12:00 UTC. No new resources |
| **D3** | Approve Test 4, with P-A's and P-B's tariffs filled in and the cost ceiling accepted | Forwarding on P-B is enabled and removed by Andrew. Needs D2. Must finish by 12:00 UTC unless D4 |
| **D4** | Leave the 13:00 BST stop as is (recommended), or approve a new window for Test 4 later | Extending keeps the VM about $0.14 per day; the £5 ceiling holds |
| **D5** | Test 5: only after Magrathea's written answers to Q1–Q6 and Q8, plus a stated maximum cost; needs a code change and possibly the paid Chargeable Translation | Not requested yet |
| **D6** | Teardown after Magrathea's written un-routing confirmation | `teardown-do.sh --magrathea-confirmed "…"` |
