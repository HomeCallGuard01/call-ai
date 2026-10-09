# Magrathea: screened-call transfer readiness (Fri 2026-10-09)

**Goal:** prove whether Magrathea can support a **financially viable** transfer of a screened call to a customer's existing mobile.
**Status:**
- Phase 1 safety fixes are done and tested, and **deployed to the VM 2026-10-09 08:05 UTC (D2, commit `827c6bb`)**; see §1.2.
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
3. *(Resolved by D2, §1.2: the fixes are deployed.)* No live call has yet exercised the new code.
4. Media is not re-targeted on re-INVITE: we keep sending to the original SDP address. There is no handling of `UPDATE` (Magrathea's INVITE did not offer it) or of hold SDP.
5. Retransmit timers run in threads in one Python process. A per-message exception is now caught and logged as a `handler_error` ALERT (S16). A process crash would still lose them. *Corrected 2026-10-09:* the unit has `Restart=no`, so a crashed endpoint **stays down**: new calls then fail at Magrathea, and any held call is left to the caller.
6. `esip_report.py` masks digit runs; it does not recognise numbers written with separators. Raw INVITEs, WAVs and pcaps remain unmasked by design: they are the private evidence (mode 600/700, outside git).

### 1.2 Deployment to the trial VM (D2, approved 2026-10-09)

**Pre-deploy review** found and fixed two more issues (commit `827c6bb`):
- the cap timers were non-daemon threads, so a stop just after a call could hang past systemd's 90 s stop timeout;
- one exception in the message handler would have terminated the endpoint.

New tests S15 (a real process, SIGTERM mid-call: BYE confirmed, exit < 1 s) and S16 (handler exception → ALERT, still serving) pass.

**Deployment, 08:04–08:06 UTC:**
1. **Pre-checks:**
   - no active call (no RTP sockets; last event 2026-10-08 18:21);
   - config SHA-256 recorded (`763a9cc4…`).
2. **Rollback copy:** `/opt/sip-lab.rollback-416051e` (`esip_capture.py` `eed2f409…`).
   - Rollback = `mv /opt/sip-lab.rollback-416051e /opt/sip-lab` (after moving the new one aside), then `systemctl restart esip.service`.
3. **Staged** `git archive 827c6bb scripts/carriers/sip-lab` into `/opt/sip-lab.new-827c6bb` (root:root, 644). All 7 file hashes matched the commit.
4. **Tests on the VM against the staged files:** safety **26/26**, loopback **16/16**, identity **14/14**.
5. **Swapped** directories; `systemctl restart esip.service`.

**Verified running version:**
- PID started 08:05:36 UTC as user `esip`;
- unchanged command line (`--config /home/esip/esip.conf.json --mode answer_hold`);
- deployed `esip_capture.py` = `834b10f3c94ccd40` = commit `827c6bb`;
- **config file unchanged** (hash identical);
- `start` event: `answer_hold`, `max_call_s` 120, 12 ranges.

**Post-deployment health check (no telephone call):**

| # | Check | Result |
|---|---|---|
| 1 | Graceful stop under the systemd sandbox | A second restart logged `shutdown {cleared: 0, unconfirmed: 0}`, `auto_stop`, then a new `start` (the SIGTERM handler works under `ProtectSystem=strict`, `NoNewPrivileges`, `AF_INET` only) |
| 2 | Liveness + allowlist | SIP OPTIONS from the VM's own public IP (not allowlisted): **no reply**, logged `dropped_non_allowlisted` |
| 3 | Shutdown unchanged | `esip-stop.timer` `OnCalendar=2026-10-09 12:00:00 UTC`, `Persistent=true`, next run in 3 h 53 min; both `ExecStartPre` guards (epoch `1791547200`) present; all units enabled; capture active |
| 4 | Firewalls | ufw active, 25 ALLOW rules. Cloud firewall `hcg-magrathea-esip-fw` (applied by tag): inbound SSH 1 source, UDP 5060 and UDP 40000–40019 from 12 Magrathea ranges; outbound UDP/ICMP to the 12 ranges + DNS + NTP. Unchanged |
| 5 | Listening | TCP 22, UDP 5060 only |
| 6 | Resources | 1 droplet (`s-1vcpu-512mb-10gb`), 1 firewall; endpoint memory about 9 MB of 200 MB |

**Not exercised:** any path that needs a real Magrathea message. The first live call on this code is Test 4.

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

**Revised 2026-10-09 at Andrew's request:** a **spare mobile** is the forwarding "customer" phone, so **no setting changes on Andrew's personal iPhone**.
- **P-A, caller:** Andrew's personal iPhone. Nothing changed on it, apart from making sure *Show My Caller ID* is **back ON** (it was turned off for Test 3).
- **P-B, customer:** the spare mobile, with its own SIM. Busy-forwarding to our number is set on it for the test only.

**Route:**
1. P-A dials P-B.
2. Andrew **declines** the call on P-B (CFB).
3. P-B's network diverts it to `0330 088 4327`.
4. Magrathea delivers it to E-SIP (`answer_bye`, 20 s, via the temporary drop-in as in Test 2).
5. E-SIP sends the BYE.

There is no onward leg and no transfer. CFNRy (no answer) is an optional second call. **CFU (forward everything) is never used.**

| Leg | Originated by | Billed to | Rate (from Andrew; do not assume) |
|---|---|---|---|
| P-A (iPhone) → P-B (spare) | iPhone's network | Andrew's iPhone account | Mobile-to-mobile rate |
| P-B → 03300884327 (diverted) | **Spare SIM's network** | **Spare SIM account** | Its rate for a *diverted* call to 03 |
| 03 → SIP | Magrathea | HCG | £0 per Annex 3; verify by CDR |

**Maximum cost:**
- 2 calls × ≤ 2 min (E-SIP cap; the planned BYE is at 20 s);
- each call charged on both SIMs (P-A's rate + P-B's diverted rate) × 4 min in total;
- Magrathea £0 by documentation.

A spare **PAYG SIM with a small credit balance (or a contract with an Ofcom spend cap) is a genuine hard limit on P-B's side.** That is better than anything we have on the carrier side.

**Procedure (attended, about 20 minutes):**
1. **Record P-B's current busy divert:** `*#67#`, and `*#61#` if CFNRy is also used. It is usually the network's voicemail number. Note it down privately, so it can be restored exactly.
2. Set: `**67*03300884327#`. Some networks need `**67*+443300884327#`. On some MVNOs it is only available in the app or settings.
3. Verify: `*#67#` shows the 0330 number.
4. I switch E-SIP to `answer_bye` 20 s (drop-in), verify, and confirm "ready".
5. Andrew calls P-B from the iPhone, declines it on P-B, and listens on the iPhone: beeps, then the call is cut after about 20 s.
6. I check the call, masked: Diversion/LDLI present and pointing at P-B (last 3 digits only), PAI, the BYE confirmed, nothing else sent.
7. Optional second call: a CFNRy variant, only if 1–6 pass.
8. **Restore P-B:** re-register the recorded original (for example `**67*<voicemail number>#`), or `##67#` if there was none. Verify with `*#67#`.
9. I restore `answer_hold` and record the result.

**Manual abort:** the iPhone hangs up. On P-B, run `##67#` (or `##002#` to clear every divert, then restore voicemail later). I can stop E-SIP at any time; it now sends BYE on stop.

**Verifying HCG left:** `bye` → `bye_confirmed` in the timeline; zero SIP/RTP for the call after the 200 in the pcap; the iPhone shows the call ended at the same second; the Magrathea CDR stop time ±2 s.

**Billing evidence:** Magrathea CDRs (refs from `X-CALLINFO`); MAGIC balance before and after; the iPhone's and the spare SIM's itemised usage, or the PAYG credit before and after.

**Window:** must finish before **12:00 UTC (13:00 BST) today**, or D4.

**Needed from Andrew before approval** (do **not** send phone numbers in chat; they are not needed):

| # | Item | Why |
|---|---|---|
| 1 | Spare phone: **network** (EE / Vodafone / O2 / Three, or the MVNO, e.g. giffgaff, Tesco, Lebara, Smarty, Voxi) | MMI support and divert behaviour vary. `Diversion` population is per network (M-Q7c) |
| 2 | Spare SIM: **PAYG or contract**; current credit or spend cap | Defines the hard limit on P-B's side |
| 3 | Spare SIM: **how a diverted call to an 03 number is charged**: inside the allowance? Out-of-bundle per-minute rate? Any divert surcharge? (From the tariff page or the app) | P-B leg cost ceiling |
| 4 | Spare phone: does it **allow busy forwarding by code** (`**67*`), or only in the app or settings? Is call forwarding enabled on that SIM at all? | Some PAYG SIMs bar diverts or need them enabled |
| 5 | Spare phone: what `*#67#` shows now (just "voicemail number" vs "not active"; you keep the number) | So it can be restored exactly |
| 6 | Spare phone: handset type; **Do Not Disturb / Silence Unknown Callers / call screening off**; Wi-Fi Calling on or off | These can stop the call ringing, or change how it is diverted |
| 7 | iPhone (P-A): **network and whether calls to mobiles are inclusive** (or the per-minute rate); confirm *Show My Caller ID* is back **ON** | P-A leg cost; the caller must present a CLI |
| 8 | Is the iPhone's number stored as a contact on the spare (irrelevant to the network, but it avoids confusion) | — |
| 9 | Confirmation that the spare SIM and iPhone are **not** HCG customer or production numbers, and have no HCG forwarding today | No production impact |

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
| **D2** | ~~Deploy the fixed E-SIP to the VM~~ **DONE 2026-10-09 08:05 UTC** (`827c6bb`, §1.2); rollback copy kept | — |
| **D3** | Approve Test 4 (spare mobile = P-B), with the §3.1 items answered and the cost ceiling accepted | Forwarding on the spare is enabled and removed by Andrew. Must finish by 12:00 UTC unless D4 |
| **D4** | Leave the 13:00 BST stop as is (recommended), or approve a new window for Test 4 later | Extending keeps the VM about $0.14 per day; the £5 ceiling holds |
| **D5** | Test 5: only after Magrathea's written answers to Q1–Q6 and Q8, plus a stated maximum cost; needs a code change and possibly the paid Chargeable Translation | Not requested yet |
| **D6** | Teardown after Magrathea's written un-routing confirmation | `teardown-do.sh --magrathea-confirmed "…"` |
