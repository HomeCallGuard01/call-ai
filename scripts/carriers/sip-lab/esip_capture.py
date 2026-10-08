"""E-SIP: answer-only SIP capture endpoint for the Magrathea trial (plan §6.1, SIP plan §3).

LOCAL CONFIG ONLY. Running it where Magrathea can reach it, and pointing the DDI at it
(number/set), are approvals A4/A5. Nothing in this repo does either.

It only ever RESPONDS. It never sends INVITE, REFER, REGISTER or any 3xx; the one request
it may send is BYE inside a dialog it answered (mode answer_bye). Packets from addresses
outside the allowlist are dropped without a reply.

Modes (one per test case):
  busy         100, 486                         loop / reject tests (T5a, T5b)
  noanswer     100, 180, waits for CANCEL       unanswered call (T9)
  unavailable  100, 480                         unreachable destination (T12)
  answer_hold  100, 180, 200; waits for BYE     billing cessation, caller clears (T6a)
  answer_bye   100, 180, 200; BYE after N s     billing cessation, we clear (T6b, T1)

Evidence: raw INVITEs go to <evidence>/raw/ (private, never committed); a timeline
<evidence>/timeline.jsonl records UTC timestamps for every message plus the
sip_identity classification with numbers masked.

  python3 -I esip_capture.py --config esip.conf.json [--mode busy]
"""
import argparse
import json
import os
import random
import re
import socket
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import sip_identity  # noqa: E402

FORBIDDEN_REQUESTS = {"INVITE", "REFER", "REGISTER", "SUBSCRIBE", "NOTIFY", "MESSAGE"}


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
        self.allow = set(cfg["allow_ips"])
        self.ev = cfg["evidence_dir"]
        os.makedirs(os.path.join(self.ev, "raw"), mode=0o700, exist_ok=True)
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.bind((cfg["listen_ip"], cfg["listen_port"]))
        self.dialogs = {}          # call-id -> state
        self.lock = threading.Lock()
        self.deadline = time.time() + cfg.get("max_runtime_s", 4 * 3600)

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

    def sdp(self):
        ip, port = self.cfg["public_ip"], self.cfg["rtp_port"]
        return (f"v=0\r\no=esip 1 1 IN IP4 {ip}\r\ns=esip\r\nc=IN IP4 {ip}\r\nt=0 0\r\n"
                f"m=audio {port} RTP/AVP 8 101\r\na=rtpmap:8 PCMA/8000\r\n"
                f"a=rtpmap:101 telephone-event/8000\r\na=sendrecv\r\n")

    def rtp_silence(self, cid, remote):
        """Send PCMA silence so carriers don't drop the call for missing media."""
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        seq, ts, ssrc = random.randint(0, 65535), 0, random.getrandbits(32)
        while cid in self.dialogs and self.dialogs[cid]["state"] == "up":
            hdr = bytes([0x80, 8]) + seq.to_bytes(2, "big") + ts.to_bytes(4, "big") + ssrc.to_bytes(4, "big")
            s.sendto(hdr + b"\xd5" * 160, remote)
            seq, ts = (seq + 1) & 0xFFFF, (ts + 160) & 0xFFFFFFFF
            time.sleep(0.02)

    def send_bye(self, cid):
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
        self.send(bye, d["addr"])

    # ---- main loop -----------------------------------------------------------------
    def handle(self, msg, addr):
        first = msg.split("\r\n", 1)[0]
        h = self.hdrs(msg)
        cid = (h.get("call-id") or [""])[0]
        self.log({"dir": "in", "line": first, "from": addr[0], "call_id": cid})
        method = first.split(" ", 1)[0]

        if method == "INVITE" and cid not in self.dialogs:
            fname = os.path.join(self.ev, "raw", f"{utc().replace(':', '')}-{abs(hash(cid))}.sip")
            with open(os.open(fname, os.O_WRONLY | os.O_CREAT, 0o600), "w") as f:
                f.write(msg)
            info = sip_identity.classify(msg, addr[0])
            self.log({"event": "classified", "info": masked_info(info)})
            tag = f"{random.getrandbits(40):x}"
            self.dialogs[cid] = {"state": "early", "tag": tag, "invite": msg, "addr": addr}
            self.send(self.response(msg, 100, "Trying"), addr)
            if self.mode == "busy":
                self.send(self.response(msg, 486, "Busy Here", tag), addr)
                self.dialogs[cid]["state"] = "done"
            elif self.mode == "unavailable":
                self.send(self.response(msg, 480, "Temporarily Unavailable", tag), addr)
                self.dialogs[cid]["state"] = "done"
            else:
                self.send(self.response(msg, 180, "Ringing", tag), addr)
                if self.mode in ("answer_hold", "answer_bye"):
                    time.sleep(self.cfg.get("ring_s", 2))
                    contact = (f"Contact: <sip:esip@{self.cfg['public_ip']}:"
                               f"{self.cfg['listen_port']}>")
                    self.send(self.response(msg, 200, "OK", tag, self.sdp(), [contact]), addr)
                    self.dialogs[cid]["state"] = "answered"
        elif method == "INVITE":
            self.log({"event": "retransmission_or_reinvite_ignored", "call_id": cid})
        elif method == "ACK" and self.dialogs.get(cid, {}).get("state") == "answered":
            d = self.dialogs[cid]
            d["state"] = "up"
            m = re.search(r"c=IN IP4 (\S+)[\s\S]*m=audio (\d+)", d["invite"])
            if m:
                threading.Thread(target=self.rtp_silence, args=(cid, (m.group(1), int(m.group(2)))),
                                 daemon=True).start()
            if self.mode == "answer_bye":
                threading.Timer(self.cfg.get("bye_after_s", 10), self.send_bye, [cid]).start()
        elif method == "CANCEL" and cid in self.dialogs:
            self.send(self.response(msg, 200, "OK"), addr)
            inv = self.dialogs[cid]["invite"]
            self.send(self.response(inv, 487, "Request Terminated", self.dialogs[cid]["tag"]), addr)
            self.dialogs[cid]["state"] = "done"
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
        self.log({"event": "start", "mode": self.mode, "allow": sorted(self.allow)})
        while time.time() < self.deadline:
            try:
                data, addr = self.sock.recvfrom(65535)
            except socket.timeout:
                continue
            if addr[0] not in self.allow:
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
