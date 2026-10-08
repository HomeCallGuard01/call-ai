# Magrathea: first live direct-dial call, evidence record

**Result: Call 1 PASS; Test 2 (our BYE) PASS (§10); Test 3 withheld PASS (§12).** Billing proof is still pending (M-Q2). **SAFETY-1 open (§11).**
**Date:** Thursday 2026-10-08. **Call:** 18:01:16–18:01:39 UTC (**19:01 BST**), attended by Andrew.
**Runbook:** [`MAGRATHEA-FIRST-LIVE-CALL.md`](MAGRATHEA-FIRST-LIVE-CALL.md) §5. **Plan:** [`MAGRATHEA-SIP-TRIAL-PLAN.md`](MAGRATHEA-SIP-TRIAL-PLAN.md).

Andrew dialled the trial DDI `0330 088 4327` directly from his personal iPhone. There was no forwarding. The call reached the isolated E-SIP test server (`159.65.27.229`, DigitalOcean `lon1`), which answered it and held it with a beep. He spoke, then hung up.

**Privacy:** phone numbers, the raw INVITE, the WAV and the pcap are **not** in git. This record holds only masked summaries. Custody is described in §6.

---

## 1. PASS checklist (runbook §5)

| # | Check | Result | Evidence |
|---|---|---|---|
| 1 | INVITE from a Magrathea address, Request-URI user `443300884327` | **PASS** | Source `87.238.73.129:5060` (handbook SIP IP). R-URI `sip:443300884327@159.65.27.229`. Classifier `problems: []` |
| 2 | Caller CLI present; PAI recorded present/absent | **PASS (CLI)**; **PAI absent** | `From` and `Remote-Party-ID` carried Andrew's mobile, in **national** form (`07…`, not `+44`). RPID `party=calling;screen=yes;privacy=off`. **No `P-Asserted-Identity`**, so the grade is `presentation_only`, which is not trust-grade (§4) |
| 3 | Headers recorded | **PASS** | Present: `From`, `RPID`, `X-CALLINFO`, `Record-Route`, `Session-Expires`. Absent: `PAI`, `Privacy`, `Diversion` (expected on a direct dial), `History-Info` |
| 4 | Andrew heard the beep | **PASS** | Andrew's report, plus 1,044 RTP packets sent (§3). Timing observation in §3.1 |
| 5 | E-SIP received his voice | **PASS** | 1,026 RTP packets received, `two_way_audio: true`. A 20.52 s WAV was recorded with speech-level activity at about 2–3 s, 6–11 s and 12–17 s. *Andrew to confirm by listening that the WAV contains his phrase* |
| 6 | Clean teardown | **PASS** | BYE from the caller side, then 200 OK within 1 ms. No retransmissions in the pcap. Exactly one INVITE |
| 7 | Billing evidence | **PENDING** | No trial CDR access. CDR references to quote to Magrathea are in §2. MAGIC balance before/after not yet read (Andrew) |

Stop rules: none tripped. There was one INVITE per call, no non-Magrathea source, no non-allowlisted RTP (`rtp_dropped_non_allowlisted: 0`), and nothing touched Twilio, staging or production.

## 2. SIP signalling (from the timeline and the independent pcap; they agree)

Call-ID `18f0bf46-3de5-1240-1f98-005056a5faca`, **`X-CALLINFO: cdr=6AC7DA6BAF3B522D`**

| UTC | Direction | Message |
|---|---|---|
| 18:01:16.013 | Magrathea `87.238.73.129` → E-SIP | `INVITE sip:443300884327@159.65.27.229` |
| 18:01:16.014 | E-SIP → Magrathea | `100 Trying`, `180 Ringing` |
| 18:01:18.015 | E-SIP → Magrathea | `200 OK` (SDP: PCMA, RTP port 40002) |
| 18:01:18.133 | Magrathea → E-SIP | `ACK` (118 ms after the 200) |
| 18:01:39.007 | Magrathea → E-SIP | `BYE` (caller hung up) |
| 18:01:39.008 | E-SIP → Magrathea | `200 OK` |

Talk time is about 20.9 s from 200 OK to BYE. Ringing lasted 2.0 s (`ring_s`).

**INVITE facts that matter for later tests:**
- Two `Via` hops: `87.238.73.129` (edge proxy) ← `87.238.73.147` (the originating Magrathea element; `User-Agent: mss-sc V1.0 1015`).
- `To: <sip:+443300884327@sip.e.e164.org.uk>`.
- `Record-Route: <sip:87.238.73.129;lr;…>`. Any BYE that **E-SIP** sends (test T6b) must route back through this proxy. That path is not yet exercised live.
- `Session-Expires: 1900;refresher=uac`, `Min-SE: 120`. The caller side refreshes, so it is irrelevant under the 120 s cap but would matter for long calls.
- `Allow: INVITE, BYE, CANCEL, ACK`. **No `REFER`, `UPDATE` or `OPTIONS` advertised on this dialog.** This is an observation only; it does not decide M-Q5.
- SDP offer: PCMA, G.729, telephone-event/101, PCMU, GSM; `ptime 20`. The media address is `213.166.4.133`.

## 3. Media (pcap analysis)

| Direction | Codec | Packets | Span | Rate | Inter-packet (min / median / max) |
|---|---|---|---|---|---|
| E-SIP `:40002` → Magrathea `213.166.4.133:43448` | PCMA (PT 8) | 1,044 | 20.86 s | 50.0/s | 18.6 / 20.0 / 21.4 ms |
| Magrathea → E-SIP | PCMA (PT 8) | 1,027 | 20.52 s | 50.0/s | 16.8 / 20.0 / 23.1 ms |

- The first inbound RTP arrived at 18:01:18.494, 0.48 s after the 200 OK. The source matched the SDP (`rx_source == sdp_remote`).
- **Media came from `213.166.4.133`, inside `213.166.4.128/26`, not from one of the six handbook SIP IPs.** The subnet allowlist was therefore necessary; an IP-only allowlist would have dropped all inbound audio.

### 3.1 Beep timing: configured vs observed

- **Configured:** a 1 kHz tone for 0.4 s every 2 s (`esip_capture.py`: `frame_i % 100 < 20`). The deployed file's SHA-256 matches the committed one.
- **Sent on the wire:** 11 beeps, each **0.40 s**, with onsets **exactly 2.00 s apart** (min = max = 2.00 s).
- **Heard by Andrew:** "approximately every second".

The server output matches the configuration exactly. The difference arose after the audio left `159.65.27.229`: in the Magrathea or mobile network path, in the handset's processing, or in perception (0.4 s on, 1.6 s off). It cannot be resolved from server-side evidence. It does not affect the PASS. If it matters, a future approved call can be recorded on a second device.

## 4. Caller identity finding

The direct-dial INVITE carried the calling number only in `From` and `Remote-Party-ID`, which are **presentation** fields that a VoIP caller can set. There was no `P-Asserted-Identity`. Under Schedule 3 §5, PAI carries the network number. Without PAI (or written confirmation from Magrathea that RPID `screen=yes` means network-verified), HCG **cannot** use this CLI to decide that a caller is trusted. The classifier correctly set `match_identity: null`.

Open with Magrathea (M-Q3, M-Q7): is PAI added under Network Mode, and is the RPID `screen=yes` flag set by Magrathea or passed through from upstream?

## 5. Earlier call at 16:25:59 UTC (not placed from this session)

| Item | Value |
|---|---|
| Call-ID | `c9a7533f-3dd7-1240-1c8b-005056a53274` |
| X-CALLINFO | `cdr=6AC7C417GF374B24` |
| Source | `87.238.73.129` (same proxy); media from `213.166.4.132` |
| Caller | A **different** UK number from Andrew's mobile (masked; `presentation_only`, no PAI) |
| Outcome | Answered 16:26:01.527; BYE from the caller side at 16:26:06.431 (about 4.9 s talk); two-way audio (240 sent / 239 received); 4.78 s WAV recorded |

By 16:25:59 UTC the trial number's target already pointed at the VM, about 18 minutes after the endpoint started (16:07 UTC). The routing change and this call were not made from this session. **To confirm with Magrathea:** was this their own post-change test call?

## 6. Evidence custody (outside git)

| Copy | Location | Protection |
|---|---|---|
| Originals (live) | VM: `/home/esip/evidence/{timeline.jsonl,raw/,audio/}`, `/var/lib/esip-pcap/session-20261008T161010Z.pcap` | Mode 700, owned by `esip`/root; SSH from Andrew's IP only |
| Sealed copy | Mac: `/Users/ad/hcg-magrathea-trial/evidence-live-20261008/vm-evidence-20261008T1801Z.tar.gz` + `vm-sha256.txt` | Folder mode 700, files 600. SHA-256 of all 6 files (timeline, 2 raw INVITEs, 2 WAVs, pcap) verified identical to the VM originals at 18:05 UTC |

`teardown-do.sh` takes a further copy before it deletes anything. Nothing in this table is committed, pasted into chat or sent to Magrathea. Only the call times, Call-IDs and CDR references in this record are to be shared.

## 7. Server budget and window (checked 2026-10-08 18:05 UTC, read-only)

- **Account:** exactly 1 droplet (`607324203`, `s-1vcpu-512mb-10gb`, created 16:07:33 UTC), 1 firewall, 1 SSH key. No volumes, no reserved IPs.
- **Cost:** $0.00595/h, capped at $4.00/month by DigitalOcean.
  - To 13:00 BST Friday (about 44 h): about **$0.26**.
  - Worst case if never torn down: $4.80 including VAT (≈ £3.60–3.85) per month. **Within the £5 ceiling.**
  - Billing continues after the SIP services stop until `teardown-do.sh` is run.
- **Window:** `esip-stop.timer` stops the endpoint and capture at **Fri 2026-10-09 12:00:00 UTC = 13:00 BST**. An `ExecStartPre` guard (epoch `1791547200`) refuses any start after then. The VM and evidence are kept.

## 8. Next isolated test: what it must establish (review only; nothing implemented or approved)

**The question:** can a call that the customer's own mobile diverts to an HCG Magrathea number be identified reliably, ended cleanly and costed? Can a trusted caller then be put through to the customer's existing mobile without HCG paying for a relay leg?

### 8.1 Technical

| # | Must establish | Test | Depends on |
|---|---|---|---|
| N1 | A **forwarded** call arrives with a usable diverting identity (`Diversion`/LDLI), per MNO and per forward type (CFB, CFNRy, CFU) | T3–T5 (parent plan): Andrew's mobile forwards to the DDI; a second phone calls it | A5b approval; **M-Q7** |
| N2 | Caller identity is network-asserted (PAI) or reliably screened | Same calls; compare `From`/RPID/PAI | **M-Q3, M-Q7** |
| N3 | E-SIP can end a call itself and Magrathea honours it (BYE via `Record-Route`) | T6b (`answer_bye`) | None technical |
| N4 | Failure paths are safe: no-answer, busy, unavailable, endpoint down; no loop under CFU | T9, T12a, T12b, T5c | **M-Q8, M-Q11** |
| N5 | Withheld callers are handled correctly | T2w / T10a (`141`) | None |
| N6 | Network-assisted transfer of a trusted, screened call to the customer's mobile: Magrathea's leg leaves the path | TX1 (code change to E-SIP + A5-TX) | **M-Q5**: blocked until Magrathea answers in writing |

### 8.2 Commercial (each needs a written source; none is assumed)

| # | Must establish | Source |
|---|---|---|
| C1 | Inbound cost to HCG of an 03 call delivered to SIP, per minute and per call | Magrathea tariff, then the session CDRs (M-Q2) for `cdr=6AC7DA6BAF3B522D` / `6AC7C417GF374B24` |
| C2 | That **billing stops** at BYE (CDR stop within ±2 s of the E-SIP timeline) | Session CDRs (M-Q2) |
| C3 | What the **customer** pays for their mobile's forwarding leg to an 03 number, per MNO | Itemised MNO bill of the forwarding handset |
| C4 | Cost and payer of any transfer leg, and whether Magrathea's original leg stops | Magrathea's written answer to M-Q5, then CDRs |
| C5 | Whether the prepaid balance is a hard spend stop | M-Q9 |
| C6 | Production pricing: DDI rental, channels, minimum commitment; fit against the £5.99 safe variable budget (Stripe £1.07, stores £0.74, Apple 30% £0.10) | Magrathea commercial quote |

### 8.3 Recommended order

1. Send Jay the questions in §9. Ask for the CDRs of both calls.
2. On Andrew's approval, run **N3 + N5** in the current window. No forwarding is needed, so the risk is low.
3. Run **N1/N2** only after M-Q7 is answered, as a separate A5b approval. The window would need a new extension approval, or a fresh VM.
4. Run **N6** only after a written M-Q5 answer, as A5-TX.

## 9. Technical summary for Jay (draft; not sent; Andrew to send)

> **Subject:** HCG trial 0330 088 4327 — first inbound SIP call successful; three questions
>
> Hi Jay,
>
> Thanks for routing the trial number to our test endpoint. The first direct-dial test passed:
>
> - **Call:** Thu 8 Oct 18:01:16 UTC (19:01 BST), `X-CALLINFO cdr=6AC7DA6BAF3B522D`, Call-ID `18f0bf46-3de5-1240-1f98-005056a5faca`.
> - **Signalling:** INVITE from 87.238.73.129 to `S:443300884327@159.65.27.229`; we sent 180 then 200 OK after 2 s; your ACK arrived 118 ms later; the caller cleared with BYE at 18:01:39 and we replied 200 OK. One INVITE, no retransmissions.
> - **Media:** G.711 A-law both ways at 50 packets/s, RTP from 213.166.4.133. About 1,040 packets each way, with a clean recording on our side.
>
> We also ran two follow-up calls: at 18:16 UTC our endpoint cleared the call with BYE (`cdr=6AC7DE025F3BB2F9`; your 200 OK came back in 5 ms), and at 18:21 UTC a withheld-CLI call (`cdr=6AC7DF255F3BD120`) arrived with `From: anonymous`, no RPID, PAI or Privacy header.
>
> Could you help with:
>
> 1. **Earlier call.** We also received a 5-second call at 16:25:59 UTC (`cdr=6AC7C417GF374B24`) from a number other than our test phone. Was this your post-change test call?
> 2. **Caller identity verification.** Both calls carried the CLI in `From` and `Remote-Party-ID` (`screen=yes`) only, with no `P-Asserted-Identity`.
>    - Under Network Mode, would PAI be supplied?
>    - Is `screen=yes` set by Magrathea after network verification, or passed through from upstream?
>    - For withheld and unavailable callers (international, payphone), do you ever send a `Privacy` header or a reason, so we can tell them apart?
>    - Can a VoIP-originated caller set `RPID`, `PAI` or `Diversion` values that reach us unchanged?
>    - When a customer's mobile diverts to the number (busy / no-answer / unconditional), which headers carry the diverting line (`Diversion` / LDLI), and does that vary by mobile network?
> 3. **Network-assisted transfer.** After our endpoint has screened a call, we want to pass a trusted caller through to the customer's existing mobile.
>    - Do you support SIP REFER, or follow a 302 redirect from our endpoint, on inbound calls?
>    - If so, does your leg leave the path or stay up, and what is charged for the new leg, to whom and at what rate?
>    - Is there any other provider-assisted way to do this?
> 4. **Billing evidence.** Could you send the CDRs for these calls (also `cdr=6AC7DE025F3BB2F9`, 18:16 UTC, where our endpoint cleared with BYE) (`result`, duration, `debit`, inbound charge), and confirm whether the prepaid balance is a hard stop?
>
> Our test endpoint is scheduled to stop at 13:00 BST on Fri 9 Oct. After that, calls to the number will fail until we arrange the next test window with you.
>
> Thanks,
> Andrew

---

## 10. Test 2: HCG-controlled termination (BYE from our side). **PASS**

**Approved by Andrew 2026-10-08 (Tests 2 and 3).** Call at **18:16:35 UTC (19:16 BST)**, direct dial from Andrew's iPhone. Call-ID `3cb313be-3de7-1240-5c97-005056a51fcb`, **`X-CALLINFO: cdr=6AC7DE025F3BB2F9`**.

**Set-up (temporary, now removed):** a systemd drop-in `esip.service.d/zz-test2.conf` ran E-SIP with `--mode answer_bye` and a copy of the config with `bye_after_s: 10`. Everything else was unchanged: `max_call_s` 120, the 12 allowlist ranges, firewalls, capture and the 13:00 BST stop/guard.

**Pre-flight (before asking Andrew to call):** a loopback check against a Magrathea-shaped INVITE (Record-Route, two Vias, Contact on another host, real values 10 s / 120 s). **13/13 PASS on the Mac and 13/13 on the VM** (127.0.0.1 only). Existing suites: 16/16 and 14/14.

| UTC | Direction | Message |
|---|---|---|
| 18:16:35.005 | Magrathea `87.238.72.129` → E-SIP | `INVITE` (a different edge proxy from Call 1's `.73.129`) |
| 18:16:35.007 | E-SIP → Magrathea | `100 Trying`, `180 Ringing` |
| 18:16:37.008 | E-SIP → Magrathea | `200 OK` (PCMA) |
| 18:16:37.126 | Magrathea → E-SIP | `ACK` |
| **18:16:47.129** | **E-SIP → Magrathea** | **`BYE`** (timeline event `bye`, reason `bye_after_s`), with `Route: <sip:87.238.72.129;lr;…>`; Request-URI = the caller UA Contact on `213.166.3.70` |
| **18:16:47.135** | **Magrathea → E-SIP** | **`200 OK`, `CSeq: 1 BYE`** (5 ms later) |

| Check | Result | Evidence |
|---|---|---|
| 1. Our server initiated the disconnection with BYE | **PASS** | Timeline `bye` / `bye_after_s`; the pcap shows the BYE leaving `159.65.27.229`. Andrew did not hang up; the call dropped on his iPhone |
| 2. Magrathea acknowledged it | **PASS** | `200 OK` with `CSeq: 1 BYE` from the same proxy, 5 ms later. Single BYE, no retransmission needed |
| 3. Duration; media stopped | **PASS** | Answer → BYE = **10.12 s** (ring 2.0 s; INVITE → BYE 12.12 s). RTP out: 501 packets, 18:16:37.128–18:16:47.128, ending at the BYE. RTP in: 493 packets, last at 18:16:47.158, which is in flight. **Zero packets from the VM after BYE + 50 ms, and zero packets to the VM after BYE + 1 s.** WAV 9.82 s, `two_way_audio: true` |
| 4. No further activity or charges initiated by us | **PASS (our side)** | Since 18:16:30 the VM sent packets **only** to Magrathea's proxy `87.238.72.129` and the call's media address `213.166.3.182`. No INVITE, REFER or 3xx was sent (the `send()` guard). Nothing arrived after the call. Magrathea's own charge for the inbound leg is **pending its CDR** (M-Q2) |

**Beep:** 5 complete beeps of 0.40 s at exactly 2.00 s intervals, plus a single 20 ms frame at 10.00 s as the BYE fired. Andrew reported hearing "approximately 10 beeps". That is the same 2:1 ratio as Call 1 ("about every second"). So the server sends one beep per 2 s, and the handset hears roughly two events per 2 s, consistently. This is **unexplained**. Hypotheses, not verified: the abrupt start and stop of each tone are heard as two clicks; or echo or processing in the mobile path. It doesn't affect any PASS. It is worth a ramped-tone check in a later approved call.

**Restored:** the drop-in and test config were removed at 18:18:23 UTC. The `start` event shows `answer_hold`, `max_call_s` 120 and 12 ranges. The deadline guard is present; the timer still fires at Fri 12:00 UTC; ufw still has 25 rules.

**Evidence:** sealed copy `evidence-live-20261008/vm-evidence-20261008T1817Z-test2.tar.gz` + `vm-sha256-test2.txt` (8 files, checksums match the VM). Outside git, mode 700.

## 11. SAFETY-1: the 120 s backstop does not cover an unacknowledged BYE (fix before wider testing)

**Found:** 2026-10-08 during Test 2 review (code reading; it did **not** occur in any call). **Status: OPEN.** Not fixed, to keep the VM's code unchanged during the approved window.

**Defect** (`scripts/carriers/sip-lab/esip_capture.py`, `send_bye`):
1. `send_bye` sends the BYE **once** over UDP and sets `state = "bye_sent"` immediately. There is no retransmission (RFC 3261 non-INVITE Timer E: 0.5 s, doubling to 4 s, until Timer F = 32 s).
2. The 120 s `max_call_s` timer calls the same `send_bye`, which returns early unless `state == "up"`. **After any BYE has been sent, the backstop is a no-op.**
3. **Failure scenario:** our BYE, or Magrathea's 200 OK, is lost. Our media stops (the RTP loop needs `state == "up"`), but **Magrathea's leg, the caller and any forwarding leg stay up** until the caller hangs up. That could be a paid leg on a forwarded call. Nothing on our side would ever retry, and the only record would be a `bye` event with no inbound `200 OK`.
4. The same applies when the 120 s cap BYE itself is lost in `answer_hold` mode.

**Related findings (same review):**
- **SAFETY-2:** an in-dialog re-INVITE (for example a session refresh; Magrathea sends `Session-Expires: 1900;refresher=uac`) is treated as an unknown method and gets **405**, not 200 OK with the same SDP. This is irrelevant under a 120 s cap, but it must be handled before any call can last near 1,900 s.
- **PRIV-1:** the timeline logs the BYE Request-URI unmasked, and that URI contains the caller's number (the INVITE Contact). The timeline is private (mode 600, outside git), but the design intent is that the timeline holds only masked numbers.

**Fix to make before wider testing (needs approval to deploy):**
- Retransmit the BYE on Timers E/F until a final response.
- On a 2xx/481, mark the call `done`. On a timeout, log `bye_unconfirmed` and raise it as a stop-rule event.
- Let the `max_call_s` timer re-send the BYE when the state is `bye_sent` and unconfirmed.
- Answer re-INVITEs with 200 OK and the same SDP.
- Mask the Request-URI user in logged lines.
- Add loopback tests that drop the first BYE and the first 200 OK.

**Until fixed:** every test call stays attended, and the stop rule applies. *If our BYE is not answered with 200 OK within about 1 s, the caller hangs up and testing stops.* No unattended or forwarded-call test (T3–T8, TX1) runs on this code.

## 12. Test 3: withheld caller ID. **PASS (call); CLI withheld**

**Call** at **18:21:25 UTC (19:21 BST)**. Andrew turned off *Settings → Phone → Show My Caller ID* on his iPhone (rather than dialling the `141` prefix) and dialled the DDI normally. Call-ID `e9aad32f-…`, **`X-CALLINFO: cdr=6AC7DF255F3BD120`**. The endpoint was in the normal `answer_hold` mode.

**Method (privacy):** the analysis ran on the VM. Every run of six or more digits was replaced by a tag, and the reference mobile number came from Call 1's raw INVITE in memory, so no number was displayed. Andrew's number is **not** in this record.

### 12.1 Identity headers received (masked)

| Header | Value |
|---|---|
| Request-URI | `INVITE sip:<DDI>@159.65.27.229` |
| `From` | `<sip:anonymous@213.166.3.70>;tag=…` |
| `Contact` | `<sip:anonymous@213.166.3.70>` |
| `To` | `<sip:+<DDI>@sip.e.e164.org.uk>` |
| `Remote-Party-ID` | **absent** (in Calls 1 and 2 it was present: `party=calling;screen=yes;privacy=off`) |
| `P-Asserted-Identity` | **absent** |
| `Privacy` | **absent** |
| Screening indicator | **none** (`screen=` only ever appeared inside RPID, which was removed) |
| `Diversion` / `History-Info` | absent (direct dial) |
| `X-CALLINFO` | `cdr=6AC7DF255F3BD120;` |
| Others | `Record-Route` (`87.238.73.130`, a third edge proxy), 2 × `Via` (`87.238.73.130` ← `213.166.3.70`), `User-Agent: mss-sc V1.0 1015`, `Session-Expires`, `Min-SE`, `Allow`, `Supported` |

**Andrew's mobile number appeared in no header and not in the SDP** (checked every header and the SDP body against the reference number).

Classifier: `presented: null`, `network: null`, **`withheld: true`**, `grade: absent`, `match_identity: null`, `problems: []`. The routing decision would be `monitor`, reason `no_usable_cli`.

### 12.2 Results

| # | Question | Result |
|---|---|---|
| 1 | Delivered successfully | **PASS.** INVITE from Magrathea `87.238.73.130` → 100/180 → 200 after 2 s → ACK. Two-way PCMA audio: 1,050 packets sent / 1,039 received. A 20.78 s WAV was recorded |
| 2 | CLI actually withheld | **YES.** `From` and `Contact` were `anonymous`. Magrathea removed RPID rather than sending it with `privacy=full` |
| 3 | Field contents | §12.1 |
| 4 | Any header exposing the mobile | **NONE**, in headers or SDP. No PAI carried the network number either; it is withheld end to end towards us |
| 5 | Can HCG reliably recognise "withheld" | **It can recognise "no caller ID delivered"** (`From: anonymous`, no RPID or PAI). That fails safe: the call is never trusted and the number is never displayed. **It cannot yet tell *withheld* from *unavailable*** (international, payphone, network-unavailable). Magrathea sent no `Privacy` header or reason code, and we have no unavailable-CLI sample (T10b). Also, a VoIP caller can set `From: anonymous` themselves; that is harmless, because it only ever lowers trust. **PENDING-M (M-Q3):** what does an "unavailable" CLI look like, and is a `Privacy` header or a cause code ever sent? |
| 6 | Correct termination, nothing unexpected | **PASS.** Caller BYE at 18:21:48.338 (CSeq `BYE`) → our 200 OK 1 ms later. 21.0 s connected. RTP ended at the BYE. **Zero packets from the VM after it.** The only destinations were Magrathea's proxy and the call's media address. No other INVITE arrived (4 on disk in total: 16:25, 18:01, 18:16, 18:21) |

**Evidence:** sealed copy `evidence-live-20261008/vm-evidence-20261008T1822Z-test3.tar.gz` + `vm-sha256-test3.txt` (10 files, checksums match the VM). Outside git, mode 700.

**Summary of identity across the three calls:** no call carried `P-Asserted-Identity`. With CLI shown, the number arrives only in caller-settable `From`/RPID (`screen=yes`). With it withheld, all identity is removed. On today's evidence, HCG has **no network-asserted caller identity** from Magrathea. Trust decisions must not rely on these headers until M-Q3/M-Q7 are answered.
