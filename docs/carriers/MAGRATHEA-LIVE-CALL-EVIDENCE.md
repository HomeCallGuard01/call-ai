# Magrathea: first live direct-dial call, evidence record

**Result: PASS** (technical). Billing proof is still pending (M-Q2).
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
> Could you help with:
>
> 1. **Earlier call.** We also received a 5-second call at 16:25:59 UTC (`cdr=6AC7C417GF374B24`) from a number other than our test phone. Was this your post-change test call?
> 2. **Caller identity verification.** Both calls carried the CLI in `From` and `Remote-Party-ID` (`screen=yes`) only, with no `P-Asserted-Identity`.
>    - Under Network Mode, would PAI be supplied?
>    - Is `screen=yes` set by Magrathea after network verification, or passed through from upstream?
>    - Can a VoIP-originated caller set `RPID`, `PAI` or `Diversion` values that reach us unchanged?
>    - When a customer's mobile diverts to the number (busy / no-answer / unconditional), which headers carry the diverting line (`Diversion` / LDLI), and does that vary by mobile network?
> 3. **Network-assisted transfer.** After our endpoint has screened a call, we want to pass a trusted caller through to the customer's existing mobile.
>    - Do you support SIP REFER, or follow a 302 redirect from our endpoint, on inbound calls?
>    - If so, does your leg leave the path or stay up, and what is charged for the new leg, to whom and at what rate?
>    - Is there any other provider-assisted way to do this?
> 4. **Billing evidence.** Could you send the CDRs for both calls (`result`, duration, `debit`, inbound charge), and confirm whether the prepaid balance is a hard stop?
>
> Our test endpoint is scheduled to stop at 13:00 BST on Fri 9 Oct. After that, calls to the number will fail until we arrange the next test window with you.
>
> Thanks,
> Andrew
