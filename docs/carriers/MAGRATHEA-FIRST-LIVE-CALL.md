# Magrathea: first live inbound SIP call (runbook, PREPARED, NOT EXECUTED)

**Date:** 2026-10-08. **Goal:** one direct-dial call to `0330 088 4327` reaches an isolated HCG test endpoint, with full INVITE headers captured and two-way audio proven. Billing evidence is collected for the same call.

**Out of scope for this call:** forwarding changes (T3–T8), transfer (TX1), production, Twilio and HCG monitoring.

**Status:** nothing below has been done. Each step marked **[APPROVAL]** needs Andrew's explicit yes. No live API call, SIP registration, server, routing change or real call happens without it.

Parent documents: [`MAGRATHEA-SIP-TRIAL-PLAN.md`](MAGRATHEA-SIP-TRIAL-PLAN.md), [`MAGRATHEA-TRIAL-PLAN.md`](MAGRATHEA-TRIAL-PLAN.md).

---

## 1. Fastest isolated SIP server

**Recommendation:** one small Linux VM in a UK region, on a cloud account Andrew **already has**. Account sign-up and card verification are usually the slowest part.

| Option | Region | Why | Note |
|---|---|---|---|
| **DigitalOcean droplet** (preferred if an account exists) | London (LON1) | Public IPv4 sits directly on the interface (no NAT), plus a cloud firewall by source IP. Minutes to create | Billed hourly up to a monthly cap. **A powered-off droplet still bills; destroy it** |
| AWS Lightsail / EC2 | London (eu-west-2) | Same. 1:1 NAT is fine because E-SIP advertises `public_ip` in its SDP | Security group = firewall |
| Hetzner Cloud | Germany/Finland (no UK) | Cheapest | Non-UK; fine technically |
| Andrew's Mac plus router port-forward | Home | £0 | **Not recommended.** It exposes the home network, may be behind CGNAT, and has an extra NAT/SDP risk |

**Server requirements:**
- 1 vCPU, 512 MB–1 GB RAM, about 10 GB disk;
- Ubuntu 24.04 LTS (Python 3 preinstalled; E-SIP uses only the standard library);
- a static public IPv4;
- no domain name and no TLS certificate.

E-SIP runs as an unprivileged user (port 5060 needs no root).

**Firewall** (cloud firewall or security group; inbound default **deny**):

| Inbound | Protocol / ports | Sources |
|---|---|---|
| SIP | UDP 5060 | `87.238.72.129`, `.130`; `87.238.73.129`, `.130`; `213.166.3.129`, `.130` **and** `87.238.72.128/26`, `87.238.73.128/26`, `87.238.77.128/26`, `213.166.2.128/26`, `213.166.3.128/26`, `213.166.4.128/26` |
| RTP | UDP 40000–40019 | the same 6 IPs plus 6 subnets |
| SSH | TCP 22 | Andrew's current public IP only |

Source: Magrathea Client Handbook 2025.1, "Firewalls and whitelisting IP traffic". It says traffic "may originate from any of the IP addresses contained in the following subnets on any port > 1024". E-SIP enforces the same list itself.

**Estimated maximum cost:**
- At list prices as last known (≈ $4–6/month for the smallest UK VM, billed hourly; **check the provider's pricing page at creation**), a same-day session of up to 4 h costs **well under $1**.
- **Worst case if the VM is forgotten: one month's cap, about $6.**
- Magrathea: £0 for inbound to SIP on the trial (DOC, to be verified from the session CDR).
- Andrew's call to an 03 number: whatever his mobile plan charges (often inclusive; **not assumed**).
- No Twilio, OpenAI or HCG spend.

## 2. Server setup (exact steps, after approval L2)

On the provider console:
1. Create the VM: UK region, Ubuntu 24.04, smallest size, Andrew's SSH key, no backups or monitoring add-ons.
2. Attach the firewall above.
3. Note `VM_IP`.

From the Mac:
```bash
scp -r /Users/ad/call-ai-magrathea-trial/scripts/carriers/sip-lab root@VM_IP:/opt/sip-lab
```

On the VM:
```bash
useradd --system --create-home --home-dir /home/esip esip
install -d -o esip -g esip -m 700 /home/esip/evidence
cp /opt/sip-lab/esip.conf.example.json /home/esip/esip.conf.json
sed -i "s/REPLACE_AT_A4/VM_IP/" /home/esip/esip.conf.json        # public_ip
chown esip:esip /home/esip/esip.conf.json
# Self-test on the VM itself (loopback only), then start capture:
sudo -u esip env TMPDIR=/home/esip python3 -I /opt/sip-lab/test_sip_identity.py
sudo -u esip env TMPDIR=/home/esip python3 -I /opt/sip-lab/test_esip_loopback.py
tmux new -s esip
  sudo -u esip python3 -I /opt/sip-lab/esip_capture.py --config /home/esip/esip.conf.json --mode answer_hold
# second tmux window: independent packet capture
  tcpdump -i any -n -s0 -w /home/esip/evidence/session.pcap 'udp port 5060 or udp portrange 40000-40019'
ss -lunp | grep -E '5060|python'        # confirm listening
```

**Safety settings:**
- `max_call_s` 120 cuts any answered call after 2 minutes.
- `max_runtime_s` 14400 stops E-SIP after 4 h.

E-SIP cannot originate, redirect, transfer or register. That is enforced in code and tested.

It also sends RTP only to an allowlisted Magrathea address. If Magrathea's SDP names a media address outside the documented ranges, the call is still answered and logged, but no audio is sent: the event `sdp_media_ip_not_allowlisted_no_rtp_sent` appears. Treat that as a finding. Ask Magrathea for their media range before widening the list.

## 3. What to give Magrathea

| Item | Value |
|---|---|
| Number | `03300884327` (trial) |
| Target index 1 | **`S:443300884327@VM_IP`** (upper-case `S` = SIP with RFC2833 DTMF, per the NTSAPI guide; the user part carries the dialled number because SIP does not otherwise) |
| REST equivalent (for reference) | `POST /number/set/03300884327` body `{"destinationType":"SIP_RFC2833","index":1,"destinationIdentifier":"443300884327@VM_IP"}` (REST guide v1.2.9, example 2) |
| Transport / port | UDP 5060 (default; a non-default port syntax is not documented, so we don't use one) |
| Authentication | None; IP-addressed target. Nothing to register |
| Codecs we accept | G.711 A-law (PCMA) preferred, μ-law (PCMU); RFC2833 telephone-event 101 |
| RTP | UDP 40000–40019 on `VM_IP` |
| Our firewall admits | Your 6 SIP IPs plus 6 UDP subnets from Handbook 2025.1 |
| Headers we'd like | Network Mode as default: `From`, `Remote-Party-ID`, `P-Asserted-Identity`, `Privacy`, `Diversion`, `X-CALLINFO` (confirm) |

## 4. The routing change

**The only change:** the trial DDI's **target index 1** is set to `S:443300884327@VM_IP`. No `order`, `feature`, PIN, CLI or other change.

**Fastest route: ask Magrathea support to make it** (Jay / Hayley).
- Our REST login still gets a 401 on `/number/*` (plan §2.4), so we cannot do it ourselves today.
- In the same email, ask them to **tell us the current target** (needed for rollback) and to confirm once it is applied.

If they fix `/number/*` access instead, we would first run R6 to read the current target (approved separately), then `number/set`, then R6 to read it back. That is a live API write and needs its own approval.

## 5. The first call: capture headers and prove two-way audio

Andrew, attended, one call. Record the UTC time of each action in `timeline.txt`.

1. VM: E-SIP running in `answer_hold` mode and tcpdump running (§2).
2. Andrew dials **0330 088 4327 directly** from his own phone. There is no forwarding change.
3. Expected: about 2 s of ringing, then answer, then **a beep every 2 s** (proves audio E-SIP → caller).
4. Andrew says between beeps: *"Magrathea test one, Andrew, [time]"* (proves audio caller → E-SIP).
5. Andrew hangs up after about 30 s. If he doesn't, E-SIP cuts the call at 120 s.
6. Optional second call (T2w): the same, dialled with `141` (withheld). It checks privacy handling.

**PASS for the first live call:**

| # | Check | Evidence |
|---|---|---|
| 1 | INVITE arrived from a Magrathea address, Request-URI user `443300884327` | `raw/*.sip`, timeline `classified.problems == []` |
| 2 | Caller CLI = Andrew's number in `+44` form (`From`/RPID), and PAI present or absent recorded | raw INVITE (private); timeline grade |
| 3 | Headers recorded: `PAI`, `RPID`, `Privacy`, `Diversion` (expected absent on a direct dial), `X-CALLINFO` | raw INVITE |
| 4 | Andrew heard the beep | Andrew's note plus `media_summary.rtp_sent` |
| 5 | E-SIP received his voice | `media_summary.rtp_received > 0`, `two_way_audio: true`; `audio/*.wav` plays his phrase |
| 6 | Clean teardown: BYE from the caller, 200 OK, no retransmissions | timeline, pcap |
| 7 | Billing evidence requested | Magrathea CDR export for the session (M-Q2) matched on `X-CALLINFO`; MAGIC balance before/after; Andrew's bill line |

Raw INVITEs, the WAV and the pcap contain personal numbers and Network Numbers. They stay in `/home/esip/evidence` and then `/Users/ad/hcg-magrathea-trial/` (mode 700). They never go into git or chat; only masked summaries do.

**Stop immediately and roll back if:**
- any unexpected INVITE arrives, or one from a non-Magrathea source;
- more than one INVITE arrives per call;
- audio fails in both directions;
- anything touches Twilio, staging or production.

## 6. Rollback

1. **Ask Magrathea to restore target index 1** to the value they reported in §4, or to remove it, and to confirm by email. Where API access exists: `set` back, then R6 read-back (separate approval).
2. Verify: Andrew calls the DDI. The result must match the pre-test behaviour, and E-SIP must log **no** new INVITE.
3. Copy evidence off the VM: `scp -r root@VM_IP:/home/esip/evidence /Users/ad/hcg-magrathea-trial/live-YYYYMMDDTHHMMZ/`, then `chmod -R go-rwx` that folder.
4. Stop E-SIP and tcpdump. **Destroy the VM** (not just power off), and delete its firewall.
5. Confirm in the provider console that no VM or reserved IP remains billing.
6. Record the MAGIC balance after the session. Request the session CDR export.

**Emergency stop** (if something looks wrong mid-call): stop the E-SIP process. Calls to the DDI then fail at Magrathea and no further audio flows. Then continue with steps 1–6.

## 7. Minimum approvals for the first live call

| ID | Approval | What it allows | Cost / risk |
|---|---|---|---|
| **L1** | Send the email in §8 to Magrathea | Outward contact: routing request plus questions | None |
| **L2** | Create one UK VM, upload `sip-lab`, run E-SIP + tcpdump | Paid infrastructure, max ≈ $6 if forgotten; destroyed same day | Low; firewall-restricted |
| **L3** | Magrathea sets trial DDI target 1 → `S:443300884327@VM_IP` (at our request) | Number routing change on the **trial** number only | Low; trial number, no customers |
| **L4** | Andrew places one direct-dial call (plus optional `141` call) to `0330 088 4327` | Live calls | Andrew's own call charge |

Rollback (§6) is part of L2/L3; no separate approval is needed to undo.

**Not included, and needing approval later:**
- any forwarding change on a phone (A5b);
- transfer tests (A5-TX);
- REST writes;
- more MNOs (A5c).

## 8. Draft email to Magrathea (for L1; no credentials)

> Subject: Trial 0330 088 4327 – please route to our SIP test endpoint
>
> Hi Jay / Hayley,
>
> Thank you for the account clarification. To run our first inbound test today:
>
> 1. Please tell us the current target on 03300884327, then set **target index 1** to **S:443300884327@VM_IP** (UDP 5060, no registration). We accept G.711 A-law/μ-law and RFC2833. RTP is on UDP 40000–40019. Our firewall admits your SIP IPs and the six UDP subnets listed in the 2025.1 handbook.
> 2. Please confirm Network Mode is active on this number and which headers we should expect (P-Asserted-Identity, Remote-Party-ID, Privacy, Diversion, History-Info, X-CALLINFO).
> 3. Our REST login receives HTTP 401 on /number/status and /block/info for this number. Could you enable read access to those, and confirm the login is not locked?
> 4. As the trial has no FTP CDRs, could you export the CDRs for our test calls (including result, debit, inbound/outbound charge, start/stop and LDLI)? Or are they visible in MAGIC?
> 5. Please confirm the trial account cannot route this number to a PSTN destination (no chargeable translation).
> 6. Separately, for planning: do you support SIP REFER, following a 3xx from our endpoint, or any provider-assisted transfer on inbound calls? If so, does your leg leave the call path, and how is any new leg billed?
>
> We'll restore or remove the target after testing and let you know.
>
> Thanks, Andrew

Replace `VM_IP` once L2 has created the VM. Alternatively, send items 2–6 now and item 1 when the IP is known.
