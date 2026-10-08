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
Every answered call is also cut by E-SIP after max_call_s (hard per-call cap).

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
        self.next_rtp = 0
        self.deadline = time.time() + cfg.get("max_runtime_s", 4 * 3600)

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
        self.log({"dir": "out", "line": first, "to": addr[0]})

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
        d = self.dialogs.get(cid)
        if not d or d["state"] != "up":
            return
        h = self.hdrs(d["invite"])
        target = re.search(r"<([^>]+)>", h["contact"][0]).group(1)
        routes = [f"Route: {r}" for r in reversed(h.get("record-route", []))]
        bye = "\r\n".join([
            f"BYE {target} SIP/2.0",
            f"Via: SIP/2.0/UDP {self.cfg['public_ip']}:{self.cfg['listen_port']};branch=z9hG4bK{random.getrandbits(40):x}",
            "Max-Forwards: 70", *routes,
            f"From: {h['to'][0]};tag={d['tag']}", f"To: {h['from'][0]}",
            f"Call-ID: {cid}", "CSeq: 1 BYE", "Content-Length: 0", "", ""])
        d["state"] = "bye_sent"
        self.log({"event": "bye", "call_id": cid, "reason": why})
        self.send(bye, d["addr"])

    # ---- main loop -----------------------------------------------------------------
    def handle(self, msg, addr):
        first = msg.split("\r\n", 1)[0]
        h = self.hdrs(msg)
        cid = (h.get("call-id") or [""])[0]
        self.log({"dir": "in", "line": first, "from": f"{addr[0]}:{addr[1]}", "call_id": cid})
        method = first.split(" ", 1)[0]

        if method == "INVITE" and cid not in self.dialogs:
            file_id = f"{utc().replace(':', '')}-{abs(hash(cid)) % 10**8}"
            with open(os.open(os.path.join(self.ev, "raw", f"{file_id}.sip"),
                              os.O_WRONLY | os.O_CREAT, 0o600), "w") as f:
                f.write(msg)
            info = sip_identity.classify(msg, addr[0])
            self.log({"event": "classified", "info": masked_info(info)})
            tag = f"{random.getrandbits(40):x}"
            d = self.dialogs[cid] = {"state": "early", "tag": tag, "invite": msg, "addr": addr,
                                     "file_id": file_id}
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
            d.update(pt=pt, remote=(off[0], off[1]), rtp_sock=rs)
            time.sleep(self.cfg.get("ring_s", 2))
            contact = f"Contact: <sip:esip@{self.cfg['public_ip']}:{self.cfg['listen_port']}>"
            self.send(self.response(msg, 200, "OK", tag, self.sdp(pt, port), [contact]), addr)
            d["state"] = "answered"
        elif method == "INVITE":
            self.log({"event": "retransmission_or_reinvite_ignored", "call_id": cid})
        elif method == "ACK" and self.dialogs.get(cid, {}).get("state") == "answered":
            d = self.dialogs[cid]
            d["state"] = "up"
            threading.Thread(target=self.media, args=(cid,), daemon=True).start()
            cap = self.cfg.get("max_call_s", 120)
            if self.mode == "answer_bye":
                threading.Timer(min(self.cfg.get("bye_after_s", 10), cap), self.send_bye,
                                [cid, "bye_after_s"]).start()
            threading.Timer(cap, self.send_bye, [cid, "max_call_s"]).start()
        elif method == "CANCEL" and cid in self.dialogs:
            self.send(self.response(msg, 200, "OK"), addr)
            d = self.dialogs[cid]
            self.send(self.response(d["invite"], 487, "Request Terminated", d["tag"]), addr)
            d["state"] = "done"
            if d.get("rtp_sock"):
                d["rtp_sock"].close()
        elif method == "BYE":
            self.send(self.response(msg, 200, "OK"), addr)
            if cid in self.dialogs:
                self.dialogs[cid]["state"] = "done"
        elif method == "OPTIONS":
            self.send(self.response(msg, 200, "OK"), addr)
        elif first.startswith("SIP/2.0"):
            pass                                  # e.g. 200 OK to our BYE: logged above
        elif method != "ACK":
            self.send(self.response(msg, 405, "Method Not Allowed"), addr)

    def run(self):
        self.sock.settimeout(1.0)
        self.log({"event": "start", "mode": self.mode, "allow": [str(n) for n in self.nets],
                  "max_call_s": self.cfg.get("max_call_s", 120)})
        while time.time() < self.deadline:
            try:
                data, addr = self.sock.recvfrom(65535)
            except socket.timeout:
                continue
            if not self.allowed(addr[0]):
                self.log({"event": "dropped_non_allowlisted", "from": addr[0]})
                continue
            self.handle(data.decode(errors="replace"), addr)
        self.log({"event": "auto_stop"})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", required=True)
    ap.add_argument("--mode", choices=["busy", "noanswer", "unavailable", "answer_hold", "answer_bye"])
    a = ap.parse_args()
    cfg = json.load(open(a.config))
    Esip(cfg, a.mode or cfg["mode"]).run()


if __name__ == "__main__":
    main()
