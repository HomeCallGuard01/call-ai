"""E-SIP: answer-only SIP capture endpoint for the Magrathea trial (plan §6.1, SIP plan §3).

LOCAL CONFIG ONLY. Running it where Magrathea can reach it, and pointing the DDI at it
(number/set), are approvals A4/A5. Nothing in this repo does either.

It only ever RESPONDS. It never sends INVITE, REFER, REGISTER or any 3xx; the one request
it may send is BYE inside a dialog it answered. Packets (SIP or RTP) from addresses
outside the allowlist are dropped without a reply.

Modes (one per test case):
  busy         100, 486                         loop / reject tests (T5a, T5b)
  noanswer     100, 180, waits for CANCEL       unanswered call (T9)
  unavailable  100, 480                         unreachable destination (T12)
  answer_hold  100, 180, 200; waits for BYE     first live call (T1), caller clears (T6a)
  answer_bye   100, 180, 200; BYE after N s     billing cessation, we clear (T6b)
Every answered call is also cut by E-SIP after max_call_s (hard per-call cap), counted
from our 200 OK, so it also covers a call whose ACK never arrives.

Clearing (SAFETY-1/-3, 2026-10-09): our BYE is a proper non-INVITE client transaction. It
is retransmitted (RFC 3261 Timer E: T1, doubling to T2) until a final response or Timer F
(64*T1). A 2xx or 481 marks the call "cleared". A timeout logs bye_unconfirmed (ALERT) and
starts a fresh BYE (CSeq+1), up to bye_attempts; the max_call_s backstop and shutdown
(SIGTERM) also start one if the call is not yet confirmed cleared. Our 200 OK is
retransmitted until ACK (Timer G); with no ACK by 64*T1 we clear with BYE (§13.3.1.4).
An in-dialog re-INVITE (session refresh, SAFETY-2) gets 200 OK with our unchanged SDP.
None of this proves the carrier clears its leg: only Magrathea's CDR shows that.

Privacy (PRIV-1): every SIP line written to the timeline goes through mask_line(), so
numbers in Request-URIs (e.g. a BYE to the caller's Contact) are masked like the rest.

Two-way audio proof, per answered call:
  E-SIP -> caller: a 1 kHz beep (0.4 s every 2 s) the caller should hear;
  caller -> E-SIP: received RTP is decoded into <evidence>/audio/<call>.wav, and the
  timeline records packets sent/received, first-packet time and RTP source.

Evidence: raw INVITEs go to <evidence>/raw/ (private, never committed); the timeline
<evidence>/timeline.jsonl records UTC timestamps for every message plus the
sip_identity classification with numbers masked.

  python3 -I esip_capture.py --config esip.conf.json [--mode answer_hold]
"""
import argparse
import ipaddress
import json
import math
import os
import random
import re
import signal
import socket
import sys
import threading
import time
import wave

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import sip_identity  # noqa: E402

FORBIDDEN_REQUESTS = {"INVITE", "REFER", "REGISTER", "SUBSCRIBE", "NOTIFY", "MESSAGE"}
PCMU, PCMA = 0, 8


# ---- G.711 (ITU-T reference algorithm) ----------------------------------------------
def lin2alaw(v):
    v >>= 3
    mask = 0xD5 if v >= 0 else 0x55
    if v < 0:
        v = -v - 1
    for seg, end in enumerate((0x1F, 0x3F, 0x7F, 0xFF, 0x1FF, 0x3FF, 0x7FF, 0xFFF)):
        if v <= end:
            a = (seg << 4) | ((v >> 1) & 0xF if seg < 2 else (v >> seg) & 0xF)
            return a ^ mask
    return 0x7F ^ mask


def lin2ulaw(v):
    v >>= 2
    mask = 0xFF
    if v < 0:
        v, mask = -v, 0x7F
    v = min(v, 8159) + (0x84 >> 2)
    for seg, end in enumerate((0x3F, 0x7F, 0xFF, 0x1FF, 0x3FF, 0x7FF, 0xFFF, 0x1FFF)):
        if v <= end:
            return ((seg << 4) | ((v >> (seg + 1)) & 0xF)) ^ mask
    return 0x7F ^ mask


def alaw2lin(a):
    a ^= 0x55
    t = (a & 0x0F) << 4
    seg = (a & 0x70) >> 4
    t = t + 8 if seg == 0 else (t + 0x108) << (seg - 1)
    return t if a & 0x80 else -t


def ulaw2lin(u):
    u = ~u & 0xFF
    t = (((u & 0x0F) << 3) + 0x84) << ((u & 0x70) >> 4)
    return 0x84 - t if u & 0x80 else t - 0x84


ENC = {PCMA: lin2alaw, PCMU: lin2ulaw}
DEC = {PCMA: [alaw2lin(i) for i in range(256)], PCMU: [ulaw2lin(i) for i in range(256)]}
# 1 kHz at 8 kHz is exactly 8 samples per cycle, so one 20 ms frame repeats seamlessly.
_TONE = [int(8000 * math.sin(2 * math.pi * 1000 * n / 8000)) for n in range(160)]
TONE_FRAME = {pt: bytes(f(s) for s in _TONE) for pt, f in ENC.items()}
SILENCE_FRAME = {PCMA: bytes([0xD5]) * 160, PCMU: bytes([0xFF]) * 160}


def utc():
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + ".%03dZ" % (time.time() % 1 * 1000)


def mask(n):
    return None if not n else ("*" * (len(n) - 3) + n[-3:] if n != sip_identity.DDI_E164 else n)


_DDI_DIGITS = {u.lstrip("+") for u in sip_identity.DDI_RURI_USERS}


def mask_line(line):
    """Mask any run of 7+ digits (a phone number) except the trial DDI itself."""
    def m(x):
        d = x.group(0)
        return d if d in _DDI_DIGITS else "*" * (len(d) - 3) + d[-3:]
    return re.sub(r"\d{7,}", m, line)


def masked_info(info):
    c, d = dict(info["caller"]), dict(info["diversion"])
    for k in ("presented", "network", "match_identity"):
        c[k] = mask(c[k])
    d["identity"] = mask(d["identity"])
    return {**info, "caller": c, "diversion": d}


class Esip:
    def __init__(self, cfg, mode):
        self.cfg, self.mode = cfg, mode
        self.nets = [ipaddress.ip_network(x) for x in cfg["allow_ips"] + cfg.get("allow_cidrs", [])]
        self.ev = cfg["evidence_dir"]
        for sub in ("raw", "audio"):
            os.makedirs(os.path.join(self.ev, sub), mode=0o700, exist_ok=True)
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.bind((cfg["listen_ip"], cfg["listen_port"]))
        self.dialogs = {}          # call-id -> state
        self.lock = threading.Lock()
        self.dlock = threading.RLock()    # dialog state transitions (main loop + timers)
        self.next_rtp = 0
        self.deadline = time.time() + cfg.get("max_runtime_s", 4 * 3600)
        self.t1 = cfg.get("sip_t1", 0.5)
        self.t2 = cfg.get("sip_t2", 4.0)
        self.bye_attempts = cfg.get("bye_attempts", 3)
        self.stopping = False

    def allowed(self, ip):
        try:
            a = ipaddress.ip_address(ip)
        except ValueError:
            return False
        return any(a in n for n in self.nets)

    # ---- output guards -------------------------------------------------------------
    def send(self, data, addr):
        first = data.split("\r\n", 1)[0]
        if not first.startswith("SIP/2.0"):
            method = first.split(" ", 1)[0]
            if method in FORBIDDEN_REQUESTS or method != "BYE":
                raise RuntimeError(f"refusing to send request {method}")
        elif re.match(r"SIP/2\.0 3\d\d", first):
            raise RuntimeError("refusing to send a 3xx redirect")
        self.sock.sendto(data.encode(), addr)
        cid = re.search(r"^Call-ID:\s*(\S+)", data, re.M | re.I)
        self.log({"dir": "out", "line": mask_line(first), "to": addr[0], "call_id": cid and cid.group(1)})

    def log(self, rec):
        rec = {"t": utc(), **rec}
        with self.lock, open(os.path.join(self.ev, "timeline.jsonl"), "a") as f:
            f.write(json.dumps(rec) + "\n")

    # ---- SIP helpers ---------------------------------------------------------------
    @staticmethod
    def hdrs(msg):
        out = {}
        for line in msg.split("\r\n\r\n", 1)[0].split("\r\n")[1:]:
            if ":" in line:
                k, v = line.split(":", 1)
                out.setdefault(k.strip().lower(), []).append(v.strip())
        return out

    def response(self, req, code, reason, to_tag=None, body="", extra=()):
        h = self.hdrs(req)
        to = h["to"][0] + (f";tag={to_tag}" if to_tag and "tag=" not in h["to"][0] else "")
        lines = [f"SIP/2.0 {code} {reason}"] + [f"Via: {v}" for v in h.get("via", [])]
        lines += [f"Record-Route: {r}" for r in h.get("record-route", [])]
        lines += [f"From: {h['from'][0]}", f"To: {to}", f"Call-ID: {h['call-id'][0]}",
                  f"CSeq: {h['cseq'][0]}", *extra]
        if body:
            lines += ["Content-Type: application/sdp"]
        lines += [f"Content-Length: {len(body.encode())}", "", body]
        return "\r\n".join(lines)

    def sdp(self, pt, port):
        ip = self.cfg["public_ip"]
        name = "PCMA" if pt == PCMA else "PCMU"
        return (f"v=0\r\no=esip 1 1 IN IP4 {ip}\r\ns=esip\r\nc=IN IP4 {ip}\r\nt=0 0\r\n"
                f"m=audio {port} RTP/AVP {pt} 101\r\na=rtpmap:{pt} {name}/8000\r\n"
                f"a=rtpmap:101 telephone-event/8000\r\na=fmtp:101 0-16\r\na=ptime:20\r\n"
                f"a=sendrecv\r\n")

    @staticmethod
    def offer(invite):
        """(remote_ip, remote_port, [payload types]) from the INVITE's SDP, or None."""
        body = invite.split("\r\n\r\n", 1)[1] if "\r\n\r\n" in invite else ""
        c = re.search(r"^c=IN IP4 (\S+)", body, re.M)
        m = re.search(r"^m=audio (\d+) RTP/\w+ ([\d ]+)", body, re.M)
        if not (c and m):
            return None
        return c.group(1), int(m.group(1)), [int(x) for x in m.group(2).split()]

    # ---- media: beep out, record in --------------------------------------------------
    def media(self, cid):
        d = self.dialogs[cid]
        pt, remote, rsock = d["pt"], d["remote"], d["rtp_sock"]
        rsock.setblocking(False)
        seq, ts, ssrc = random.randint(0, 65535), 0, random.getrandbits(32)
        sent = recv = dropped = 0
        first_rx, rx_src, pcm = None, None, bytearray()
        # Media only ever goes to an allowlisted (Magrathea) address, whatever the SDP says.
        send_ok = self.allowed(remote[0])
        if not send_ok:
            self.log({"event": "sdp_media_ip_not_allowlisted_no_rtp_sent", "call_id": cid,
                      "sdp_remote": remote[0]})
        frame_i, t0 = 0, time.time()
        while d["state"] == "up":
            on = (frame_i % 100) < 20                       # 0.4 s beep every 2 s
            payload = (TONE_FRAME if on else SILENCE_FRAME)[pt]
            hdr = bytes([0x80, pt]) + seq.to_bytes(2, "big") + ts.to_bytes(4, "big") + ssrc.to_bytes(4, "big")
            if send_ok:
                rsock.sendto(hdr + payload, remote)
                sent += 1
            seq, ts, frame_i = (seq + 1) & 0xFFFF, (ts + 160) & 0xFFFFFFFF, frame_i + 1
            while True:
                try:
                    pkt, src = rsock.recvfrom(2048)
                except BlockingIOError:
                    break
                if not self.allowed(src[0]):
                    dropped += 1
                    continue
                if len(pkt) > 12 and (pkt[1] & 0x7F) == pt:
                    cc = (pkt[0] & 0x0F) * 4
                    for b in pkt[12 + cc:]:
                        v = DEC[pt][b]
                        pcm += v.to_bytes(2, "little", signed=True)
                    recv += 1
                    if first_rx is None:
                        first_rx, rx_src = utc(), f"{src[0]}:{src[1]}"
            time.sleep(max(0, t0 + frame_i * 0.02 - time.time()))
        rsock.close()
        wav = os.path.join(self.ev, "audio", f"{d['file_id']}.wav")
        with wave.open(wav, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(8000)
            w.writeframes(bytes(pcm))
        os.chmod(wav, 0o600)
        self.log({"event": "media_summary", "call_id": cid, "codec": "PCMA" if pt == PCMA else "PCMU",
                  "rtp_sent": sent, "rtp_received": recv, "rtp_dropped_non_allowlisted": dropped,
                  "first_rx": first_rx, "rx_source": rx_src, "sdp_remote": f"{remote[0]}:{remote[1]}",
                  "recorded_seconds": round(len(pcm) / 16000, 2),
                  "two_way_audio": sent > 0 and recv > 0})

    def send_bye(self, cid, why):
        """Start a BYE client transaction unless the call is already cleared or one is in flight."""
        with self.dlock:
            d = self.dialogs.get(cid)
            if not d or d["state"] not in ("answered", "up", "bye_sent"):
                return
            if d.get("bye_txn") and not d["bye_txn"]["done"]:
                return                                  # a transaction is already retrying
            d["cseq_out"] = d.get("cseq_out", 0) + 1
            h = self.hdrs(d["invite"])
            target = re.search(r"<([^>]+)>", h["contact"][0]).group(1)
            routes = [f"Route: {r}" for r in reversed(h.get("record-route", []))]
            branch = f"z9hG4bK{random.getrandbits(40):x}"
            bye = "\r\n".join([
                f"BYE {target} SIP/2.0",
                f"Via: SIP/2.0/UDP {self.cfg['public_ip']}:{self.cfg['listen_port']};branch={branch}",
                "Max-Forwards: 70", *routes,
                f"From: {h['to'][0]};tag={d['tag']}", f"To: {h['from'][0]}",
                f"Call-ID: {cid}", f"CSeq: {d['cseq_out']} BYE", "Content-Length: 0", "", ""])
            txn = d["bye_txn"] = {"cseq": d["cseq_out"], "done": False, "t0": time.time()}
            d["bye_count"] = d.get("bye_count", 0) + 1
            d["state"] = "bye_sent"
            self.log({"event": "bye", "call_id": cid, "reason": why, "cseq": txn["cseq"],
                      "attempt": d["bye_count"]})
        threading.Thread(target=self._bye_txn, args=(cid, d, txn, bye), daemon=True).start()

    def _bye_txn(self, cid, d, txn, bye):
        """RFC 3261 §17.1.2 over UDP: send, retransmit at T1 doubling to T2, give up at 64*T1."""
        interval, give_up = self.t1, txn["t0"] + 64 * self.t1
        while True:
            with self.dlock:
                if txn["done"] or d["state"] != "bye_sent":
                    return
                self.send(bye, d["addr"])
            wake = min(time.time() + interval, give_up)
            while time.time() < wake:
                if txn["done"] or d["state"] != "bye_sent":
                    return
                time.sleep(min(0.01, self.t1 / 10))
            if time.time() >= give_up:
                break
            interval = min(interval * 2, self.t2)
        with self.dlock:
            if txn["done"] or d["state"] != "bye_sent":
                return
            txn["done"] = True
            self.log({"event": "bye_unconfirmed", "alert": True, "call_id": cid, "cseq": txn["cseq"],
                      "attempt": d["bye_count"], "after_s": round(time.time() - txn["t0"], 2)})
            retry = d["bye_count"] < self.bye_attempts
            if not retry:
                self.log({"event": "clear_failed_manual_action", "alert": True, "call_id": cid,
                          "attempts": d["bye_count"],
                          "action": "caller must hang up; ask Magrathea to clear the call; stop testing"})
        if retry:
            self.send_bye(cid, "retry_after_timeout")

    def bye_response(self, cid, cseq_n, code):
        with self.dlock:
            d = self.dialogs.get(cid)
            txn = d and d.get("bye_txn")
            if not txn or txn["cseq"] != cseq_n or txn["done"]:
                self.log({"event": "stray_bye_response", "call_id": cid, "code": code})
                return
            if code < 200:
                return                                  # provisional: keep retransmitting (Timer E)
            txn["done"] = True
            if 200 <= code < 300 or code == 481:
                d["state"] = "cleared"
                self.log({"event": "bye_confirmed", "call_id": cid, "code": code, "cseq": cseq_n,
                          "after_s": round(time.time() - txn["t0"], 3)})
                self._close_rtp(d)
                return
            self.log({"event": "bye_rejected", "alert": True, "call_id": cid, "code": code})
            retry = d["bye_count"] < self.bye_attempts
        if retry:
            self.send_bye(cid, f"retry_after_{code}")

    def _timer(self, secs, cid, why):
        # Daemon, so a pending cap timer cannot hold the process open past systemd's stop
        # timeout; shutdown() has already sent BYE for any held call by then.
        t = threading.Timer(secs, self.send_bye, [cid, why])
        t.daemon = True
        t.start()

    def _close_rtp(self, d):
        if d.get("rtp_sock") and not d.get("media_started"):
            d["rtp_sock"].close()

    def _ok_retransmit(self, cid, d, ok):
        """RFC 3261 §13.3.1.4: resend our 200 OK until ACK; no ACK by 64*T1 -> clear with BYE."""
        interval, give_up = self.t1, time.time() + 64 * self.t1
        while time.time() < give_up:
            wake = min(time.time() + interval, give_up)
            while time.time() < wake:
                if d["state"] != "answered":
                    return
                time.sleep(min(0.01, self.t1 / 10))
            with self.dlock:
                if d["state"] != "answered":
                    return
                if time.time() < give_up:
                    self.send(ok, d["addr"])
            interval = min(interval * 2, self.t2)
        with self.dlock:
            if d["state"] != "answered":
                return
            self.log({"event": "ack_timeout", "alert": True, "call_id": cid})
        self.send_bye(cid, "ack_timeout")

    def shutdown(self, grace_s=5.0):
        """Clear every call we may still hold, then wait briefly for confirmations."""
        with self.dlock:
            live = [c for c, d in self.dialogs.items() if d["state"] in ("answered", "up", "bye_sent")]
        for c in live:
            self.send_bye(c, "shutdown")
        end = time.time() + grace_s
        while time.time() < end and any(self.dialogs[c]["state"] == "bye_sent" for c in live):
            try:
                data, addr = self.sock.recvfrom(65535)
            except (socket.timeout, BlockingIOError):
                continue
            if self.allowed(addr[0]):
                self.handle(data.decode(errors="replace"), addr)
        left = [c for c in live if self.dialogs[c]["state"] == "bye_sent"]
        self.log({"event": "shutdown", "cleared": len(live) - len(left), "unconfirmed": len(left),
                  "alert": bool(left)})

    # ---- main loop -----------------------------------------------------------------
    def handle(self, msg, addr):
        first = msg.split("\r\n", 1)[0]
        h = self.hdrs(msg)
        cid = (h.get("call-id") or [""])[0]
        self.log({"dir": "in", "line": mask_line(first), "from": f"{addr[0]}:{addr[1]}", "call_id": cid})
        method = first.split(" ", 1)[0]
        cseq = (h.get("cseq") or ["0 ?"])[0].split()
        cseq_n = int(cseq[0]) if cseq[0].isdigit() else 0

        if method == "INVITE" and cid not in self.dialogs:
            file_id = f"{utc().replace(':', '')}-{abs(hash(cid)) % 10**8}"
            with open(os.open(os.path.join(self.ev, "raw", f"{file_id}.sip"),
                              os.O_WRONLY | os.O_CREAT, 0o600), "w") as f:
                f.write(msg)
            info = sip_identity.classify(msg, addr[0])
            self.log({"event": "classified", "info": masked_info(info)})
            tag = f"{random.getrandbits(40):x}"
            d = self.dialogs[cid] = {"state": "early", "tag": tag, "invite": msg, "addr": addr,
                                     "file_id": file_id, "invite_cseq": cseq_n}
            self.send(self.response(msg, 100, "Trying"), addr)
            if self.mode == "busy":
                self.send(self.response(msg, 486, "Busy Here", tag), addr)
                d["state"] = "done"
                return
            if self.mode == "unavailable":
                self.send(self.response(msg, 480, "Temporarily Unavailable", tag), addr)
                d["state"] = "done"
                return
            self.send(self.response(msg, 180, "Ringing", tag), addr)
            if self.mode not in ("answer_hold", "answer_bye"):
                return
            off = self.offer(msg)
            pt = next((p for p in (PCMA, PCMU) if off and p in off[2]), None)
            if pt is None:
                self.log({"event": "no_g711_in_offer", "offer": off and off[2]})
                self.send(self.response(msg, 488, "Not Acceptable Here", tag), addr)
                d["state"] = "done"
                return
            port = self.cfg["rtp_port"] + 2 * (self.next_rtp % self.cfg.get("rtp_slots", 10))
            self.next_rtp += 1
            rs = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            rs.bind((self.cfg["listen_ip"], port))
            d.update(pt=pt, remote=(off[0], off[1]), rtp_sock=rs, rtp_port=port)
            time.sleep(self.cfg.get("ring_s", 2))
            if self.stopping:
                self.send(self.response(msg, 480, "Temporarily Unavailable", tag), addr)
                d["state"] = "done"
                rs.close()
                return
            contact = f"Contact: <sip:esip@{self.cfg['public_ip']}:{self.cfg['listen_port']}>"
            ok = self.response(msg, 200, "OK", tag, self.sdp(pt, port), [contact])
            d["ok"] = ok
            with self.dlock:
                self.send(ok, addr)
                d["state"] = "answered"
            # The cap runs from our 200 OK, so it also covers a call whose ACK is lost.
            self._timer(self.cfg.get("max_call_s", 120), cid, "max_call_s")
            threading.Thread(target=self._ok_retransmit, args=(cid, d, ok), daemon=True).start()
        elif method == "INVITE":
            d = self.dialogs[cid]
            if cseq_n == d["invite_cseq"]:
                # Retransmission of the original INVITE: repeat our last answer (§17.2.1).
                if d["state"] == "answered" and d.get("ok"):
                    self.send(d["ok"], addr)
                self.log({"event": "invite_retransmission", "call_id": cid, "state": d["state"]})
            elif d["state"] == "up" and d.get("ok"):
                # SAFETY-2: in-dialog re-INVITE (e.g. RFC 4028 session refresh). Answer 200 OK
                # with our unchanged SDP so the refresh succeeds; media is not re-targeted.
                contact = f"Contact: <sip:esip@{self.cfg['public_ip']}:{self.cfg['listen_port']}>"
                se = [f"Session-Expires: {v}" for v in h.get("session-expires", [])][:1]
                self.send(self.response(msg, 200, "OK", d["tag"], self.sdp(d["pt"], d["rtp_port"]),
                                        [contact, *se]), addr)
                self.log({"event": "reinvite_answered", "call_id": cid, "cseq": cseq_n})
            else:
                self.send(self.response(msg, 491 if d["state"] == "bye_sent" else 481,
                                        "Request Pending" if d["state"] == "bye_sent"
                                        else "Call/Transaction Does Not Exist"), addr)
        elif method == "ACK" and self.dialogs.get(cid, {}).get("state") == "answered":
            with self.dlock:
                d = self.dialogs[cid]
                d["state"] = "up"
                d["media_started"] = True
            threading.Thread(target=self.media, args=(cid,), daemon=True).start()
            if self.mode == "answer_bye":
                self._timer(min(self.cfg.get("bye_after_s", 10), self.cfg.get("max_call_s", 120)),
                            cid, "bye_after_s")
        elif method == "CANCEL" and cid in self.dialogs:
            self.send(self.response(msg, 200, "OK"), addr)
            d = self.dialogs[cid]
            self.send(self.response(d["invite"], 487, "Request Terminated", d["tag"]), addr)
            d["state"] = "done"
            if d.get("rtp_sock"):
                d["rtp_sock"].close()
        elif method == "BYE":
            self.send(self.response(msg, 200, "OK"), addr)
            with self.dlock:
                d = self.dialogs.get(cid)
                if d:
                    if d.get("bye_txn"):
                        d["bye_txn"]["done"] = True     # the far end cleared first: stop our BYE
                    d["state"] = "done"
                    self._close_rtp(d)
        elif method == "OPTIONS":
            self.send(self.response(msg, 200, "OK"), addr)
        elif first.startswith("SIP/2.0"):
            code = int(first.split()[1]) if len(first.split()) > 1 and first.split()[1].isdigit() else 0
            if len(cseq) > 1 and cseq[1] == "BYE":
                self.bye_response(cid, cseq_n, code)
        elif method != "ACK":
            self.send(self.response(msg, 405, "Method Not Allowed"), addr)

    def run(self):
        self.sock.settimeout(1.0)
        self.log({"event": "start", "mode": self.mode, "allow": [str(n) for n in self.nets],
                  "max_call_s": self.cfg.get("max_call_s", 120)})
        while time.time() < self.deadline and not self.stopping:
            try:
                data, addr = self.sock.recvfrom(65535)
            except socket.timeout:
                continue
            if not self.allowed(addr[0]):
                self.log({"event": "dropped_non_allowlisted", "from": addr[0]})
                continue
            try:
                self.handle(data.decode(errors="replace"), addr)
            except Exception as exc:              # one bad message must not take the endpoint down
                self.log({"event": "handler_error", "alert": True, "error": mask_line(repr(exc))[:300]})
        self.stopping = True
        self.shutdown()
        self.log({"event": "auto_stop"})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", required=True)
    ap.add_argument("--mode", choices=["busy", "noanswer", "unavailable", "answer_hold", "answer_bye"])
    a = ap.parse_args()
    cfg = json.load(open(a.config))
    e = Esip(cfg, a.mode or cfg["mode"])
    # systemd stop / the 12:00 UTC timer: clear held calls with BYE before exiting.
    signal.signal(signal.SIGTERM, lambda *_: setattr(e, "stopping", True))
    e.run()


if __name__ == "__main__":
    main()
