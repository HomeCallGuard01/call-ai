"""Regression tests for SAFETY-1/-2/-3 and PRIV-1 (2026-10-09). 127.0.0.1 only.

A scripted fake "Magrathea proxy" loses or withholds messages on purpose, so each failure
path is exercised: lost BYE, lost 200 OK to BYE, no response at all, lost ACK, retransmitted
INVITE, far-end BYE racing ours, 481, session-refresh re-INVITE, shutdown, and log masking.

A pass here proves E-SIP's own behaviour only. It does NOT prove Magrathea clears its leg;
only Magrathea's CDR for a real call shows that.

Timers are scaled: T1 = 50 ms, T2 = 400 ms, so Timer F = 64*T1 = 3.2 s.

Run: python3 -I scripts/carriers/sip-lab/test_esip_safety.py
"""
import json
import os
import re
import shutil
import socket
import sys
import tempfile
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import esip_capture  # noqa: E402

T1, T2 = 0.05, 0.4
MOBILE = "07700900789"           # Ofcom drama-range test number; must never appear unmasked in logs
RESULTS, DIRS = [], []


def check(name, cond, detail=""):
    cond = bool(cond)
    RESULTS.append(cond)
    print(f"{len(RESULTS):2}. {'PASS' if cond else 'FAIL'}  {name}" + ("" if cond else f"  -> {detail}"))


_USED = set()


def free_port():
    """A free UDP port not handed out before in this run (the OS may re-issue a just-closed one)."""
    while True:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.bind(("127.0.0.1", 0))
        p = s.getsockname()[1]
        s.close()
        if p not in _USED:
            _USED.add(p)
            return p


class Proxy:
    """Plays Magrathea's edge proxy + caller UA. Records every message E-SIP sends it."""
    n = 0

    def __init__(self, mode="answer_hold", **cfg_over):
        self.ev = tempfile.mkdtemp(prefix="esip-safety-")
        DIRS.append(self.ev)
        cfg = {"listen_ip": "127.0.0.1", "listen_port": free_port(), "public_ip": "127.0.0.1",
               "rtp_port": free_port(), "rtp_slots": 1, "allow_ips": ["127.0.0.1"], "mode": mode,
               "ring_s": 0.05, "bye_after_s": 0.3, "max_call_s": 60, "max_runtime_s": 120,
               "evidence_dir": self.ev, "sip_t1": T1, "sip_t2": T2, "bye_attempts": 3}
        cfg.update(cfg_over)
        self.e = esip_capture.Esip(cfg, mode)
        threading.Thread(target=self.e.run, daemon=True).start()
        self.port = cfg["listen_port"]
        self.s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.s.bind(("127.0.0.1", 0))
        self.s.settimeout(0.02)
        self.rtp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.rtp.bind(("127.0.0.1", 0))
        self.rtp.setblocking(False)
        self.msgs = []           # (t, text) from E-SIP
        self.rtp_rx = []         # arrival times of RTP from E-SIP
        Proxy.n += 1
        self.cid = f"safety{Proxy.n}@test"
        self.to_tag = None
        self.cseq = 100

    def send(self, text):
        self.s.sendto(text.encode(), ("127.0.0.1", self.port))

    def hdr(self, method, cseq, extra=(), body=""):
        me = self.s.getsockname()[1]
        to = "To: <sip:+443300884327@sip.e.e164.org.uk>" + (f";tag={self.to_tag}" if self.to_tag else "")
        lines = [f"{method} sip:{'443300884327@127.0.0.1' if method == 'INVITE' and not self.to_tag else 'esip@127.0.0.1:5060'} SIP/2.0",
                 f"Record-Route: <sip:127.0.0.1:{me};lr;did=1.x>",
                 f"Via: SIP/2.0/UDP 127.0.0.1:{me};branch=z9hG4bK{method}{cseq}{Proxy.n}",
                 "Max-Forwards: 69", f"From: <sip:{MOBILE}@10.9.9.9>;tag=CALLER", to,
                 f"Call-ID: {self.cid}", f"CSeq: {cseq} {method}", f"Contact: <sip:{MOBILE}@10.9.9.9>",
                 f"Remote-Party-ID: <sip:{MOBILE}@10.9.9.9>;party=calling;screen=yes;privacy=off",
                 *extra]
        if body:
            lines += ["Content-Type: application/sdp"]
        return "\r\n".join(lines + [f"Content-Length: {len(body)}", "", body])

    def sdp(self):
        return (f"v=0\r\no=MTLSBC 1 1 IN IP4 127.0.0.1\r\ns=SIP Call\r\nc=IN IP4 127.0.0.1\r\nt=0 0\r\n"
                f"m=audio {self.rtp.getsockname()[1]} RTP/AVP 8 101\r\na=rtpmap:8 PCMA/8000\r\n")

    def invite(self):
        self.send(self.hdr("INVITE", self.cseq, body=self.sdp()))

    def ack(self):
        self.send(self.hdr("ACK", self.cseq))

    def reply(self, msg, code, reason="OK"):
        h = esip_capture.Esip.hdrs(msg)
        self.send("\r\n".join(["SIP/2.0 %d %s" % (code, reason), *[f"Via: {v}" for v in h["via"]],
                               f"From: {h['from'][0]}", f"To: {h['to'][0]}", f"Call-ID: {self.cid}",
                               f"CSeq: {h['cseq'][0]}", "Content-Length: 0", "", ""]))

    def pump(self, secs, on_msg=None):
        end = time.time() + secs
        while time.time() < end:
            try:
                m = self.s.recv(65535).decode(errors="replace")
                self.msgs.append((time.time(), m))
                if self.to_tag is None and m.startswith("SIP/2.0 200") and "INVITE" in m:
                    t = re.search(r"^To: .*;tag=(\w+)", m, re.M)
                    self.to_tag = t and t.group(1)
                if on_msg:
                    on_msg(m)
            except socket.timeout:
                pass
            try:
                while True:
                    self.rtp.recv(2048)
                    self.rtp_rx.append(time.time())
            except BlockingIOError:
                pass

    def byes(self):
        return [(t, m) for t, m in self.msgs if m.startswith("BYE ")]

    def oks_to_invite(self):
        return [m for t, m in self.msgs if m.startswith("SIP/2.0 200") and "INVITE" in m.split("CSeq:")[1][:30]]

    def timeline(self):
        return [json.loads(l) for l in open(os.path.join(self.ev, "timeline.jsonl"))]

    def events(self, name):
        return [r for r in self.timeline() if r.get("event") == name]

    def state(self):
        return self.e.dialogs[self.cid]["state"]

    def answer(self):
        """INVITE, wait for 200, ACK. Returns once the call is up."""
        self.invite()
        self.pump(0.3)
        self.ack()
        self.pump(0.05)


def cseq_branch(m):
    return (re.search(r"^CSeq: (.*)$", m, re.M).group(1).strip(),
            re.search(r"branch=(\S+)", m).group(1))


def main():
    # 1. Lost BYE: first copy dropped, retransmission answered.
    p = Proxy("answer_bye")
    p.answer()
    seen = []

    def drop_first(m):
        if m.startswith("BYE "):
            seen.append(m)
            if len(seen) == 2:
                p.reply(m, 200)
    p.pump(1.5, drop_first)
    b = p.byes()
    check("S1 lost BYE: retransmitted with the same CSeq and branch (one transaction)",
          len(b) == 2 and cseq_branch(b[0][1]) == cseq_branch(b[1][1]), [cseq_branch(x[1]) for x in b])
    check("S1 retransmission interval = T1 (50 ms)", len(b) == 2 and 0.035 < b[1][0] - b[0][0] < 0.09,
          len(b) == 2 and b[1][0] - b[0][0])
    check("S1 200 OK confirms clearing: state cleared, bye_confirmed logged, no further BYEs",
          p.state() == "cleared" and p.events("bye_confirmed") and len(p.byes()) == 2)

    # 2. Lost 200 OK to BYE (we answer, the answer is lost): retransmissions double towards T2.
    p = Proxy("answer_bye")
    p.answer()
    got = []

    def answer_fourth(m):
        if m.startswith("BYE "):
            got.append(time.time())
            if len(got) == 4:
                p.reply(m, 200)
    p.pump(2.0, answer_fourth)
    gaps = [round(got[i + 1] - got[i], 3) for i in range(len(got) - 1)]
    check("S2 lost 200s: BYE retransmitted at ~T1, 2T1, 4T1 until answered, then stops",
          len(p.byes()) == 4 and len(gaps) == 3 and gaps[0] < gaps[1] < gaps[2] and 0.15 < gaps[2] < 0.3
          and p.state() == "cleared", gaps)

    # 3. No response at all: Timer F, alert, fresh BYE transactions, then manual-action alert;
    #    the max_call_s backstop still fires afterwards and its BYE is retransmitted and confirmed.
    p = Proxy("answer_bye", max_call_s=11.5)
    p.answer()
    p.pump(10.6)
    tl_unconf = p.events("bye_unconfirmed")
    cseqs = sorted({cseq_branch(m)[0] for t, m in p.byes()})
    check("S3 no answer: Timer F (64*T1 = 3.2 s) -> bye_unconfirmed ALERT per attempt",
          len(tl_unconf) == 3 and all(r.get("alert") for r in tl_unconf)
          and all(3.0 < r["after_s"] < 3.6 for r in tl_unconf), tl_unconf)
    check("S3 each new attempt is a new transaction (CSeq 1, 2, 3 BYE)", cseqs == ["1 BYE", "2 BYE", "3 BYE"], cseqs)
    check("S3 after 3 attempts: clear_failed_manual_action ALERT", p.events("clear_failed_manual_action"))
    n_before = len(p.byes())

    def answer_backstop(m):
        if m.startswith("BYE ") and "CSeq: 4 BYE" in m:
            p.reply(m, 200)
    p.pump(2.0, answer_backstop)
    bs = [r for r in p.events("bye") if r["reason"] == "max_call_s"]
    check("S3 120 s backstop still effective after unacknowledged BYEs: new BYE (CSeq 4), confirmed",
          bs and bs[0]["cseq"] == 4 and len(p.byes()) > n_before and p.state() == "cleared", (bs, p.state()))
    sent_requests = {m.split(" ")[0] for t, m in p.msgs if not m.startswith("SIP/2.0")}
    check("S3 the only request E-SIP ever sent is BYE", sent_requests == {"BYE"}, sent_requests)

    # 4. answer_hold: 120 s cap path, first cap BYE lost.
    p = Proxy("answer_hold", max_call_s=0.5)
    p.answer()
    first = []

    def drop_first_cap(m):
        if m.startswith("BYE "):
            first.append(m)
            if len(first) == 2:
                p.reply(m, 200)
    p.pump(1.2, drop_first_cap)
    ev = p.events("bye")
    check("S4 answer_hold cap BYE lost once: retransmitted, confirmed, media stopped",
          ev and ev[0]["reason"] == "max_call_s" and p.state() == "cleared"
          and (not p.rtp_rx or p.rtp_rx[-1] < time.time() - 0.5), (ev, p.state()))

    # 5. Lost ACK (SAFETY-3): 200 OK retransmitted; no ACK by 64*T1 -> ack_timeout -> BYE.
    p = Proxy("answer_hold")
    p.invite()

    def answer_bye(m):
        if m.startswith("BYE "):
            p.reply(m, 200)
    p.pump(4.0, answer_bye)
    oks = p.oks_to_invite()
    check("S5 lost ACK: 200 OK retransmitted (Timer G) several times", len(oks) >= 4, len(oks))
    check("S5 no ACK by 64*T1: ack_timeout ALERT, then BYE, confirmed cleared",
          p.events("ack_timeout") and [r["reason"] for r in p.events("bye")] == ["ack_timeout"]
          and p.state() == "cleared", (p.events("bye"), p.state()))
    check("S5 no RTP sent on a call that was never confirmed", not p.rtp_rx, len(p.rtp_rx))

    # 6. INVITE retransmitted while waiting for ACK: our 200 OK is repeated, then ACK -> up.
    p = Proxy("answer_hold", sip_t1=1.0)
    p.invite()
    p.pump(0.2)
    p.invite()
    p.pump(0.2)
    n_ok = len(p.oks_to_invite())
    p.ack()
    p.pump(0.3)
    check("S6 retransmitted INVITE -> same 200 OK repeated; ACK then brings the call up",
          n_ok == 2 and p.state() == "up" and p.events("invite_retransmission"), (n_ok, p.state()))

    # 7. Far end BYE races ours: we answer 200 and stop retransmitting.
    p = Proxy("answer_bye")
    p.answer()
    raced = []

    def race(m):
        if m.startswith("BYE ") and not raced:
            raced.append(1)
            p.cseq += 1
            p.send(p.hdr("BYE", p.cseq))
    p.pump(1.0, race)
    t_last = p.byes()[-1][0] if p.byes() else 0
    p.pump(0.6)
    check("S7 caller BYE while ours is pending: we reply 200, state done, our BYE stops",
          p.state() == "done" and any(m.startswith("SIP/2.0 200") and "BYE" in m for t, m in p.msgs)
          and p.byes()[-1][0] == t_last, p.state())

    # 8. 481 to our BYE: dialog already gone at the carrier -> treated as cleared.
    p = Proxy("answer_bye")
    p.answer()
    p.pump(1.0, lambda m: m.startswith("BYE ") and p.reply(m, 481, "Call/Transaction Does Not Exist"))
    check("S8 481 to BYE -> cleared, no retries", p.state() == "cleared" and len(p.byes()) == 1,
          (p.state(), len(p.byes())))

    # 9. SAFETY-2: session-refresh re-INVITE while up -> 200 OK with unchanged SDP; call continues.
    p = Proxy("answer_hold")
    p.answer()
    p.pump(0.3)
    first_sdp = re.search(r"m=audio (\d+)", p.oks_to_invite()[0]).group(1)
    p.cseq += 1
    p.send(p.hdr("INVITE", p.cseq, ["Session-Expires: 1900;refresher=uac", "Supported: timer"], p.sdp()))
    p.pump(0.3)
    oks = p.oks_to_invite()
    re_ok = oks[-1] if len(oks) >= 2 else ""
    p.send(p.hdr("ACK", p.cseq))
    n_rtp = len(p.rtp_rx)
    p.pump(0.4)
    check("S9 re-INVITE (refresh) -> 200 OK, same media port, Session-Expires echoed",
          f"CSeq: {p.cseq} INVITE" in re_ok and re.search(r"m=audio (\d+)", re_ok)
          and re.search(r"m=audio (\d+)", re_ok).group(1) == first_sdp
          and "Session-Expires: 1900;refresher=uac" in re_ok, re_ok[:200])
    check("S9 call stays up and media keeps flowing after the refresh",
          p.state() == "up" and len(p.rtp_rx) > n_rtp + 10, (p.state(), len(p.rtp_rx) - n_rtp))

    # 10. shutdown() (systemd stop / 12:00 UTC timer) clears the held call with BYE.
    threading.Thread(target=p.pump, args=(1.5, lambda m: m.startswith("BYE ") and p.reply(m, 200)),
                     daemon=True).start()
    time.sleep(0.05)
    p.e.stopping = True
    time.sleep(1.6)
    sd = p.events("shutdown")
    check("S10 shutdown sends BYE (reason shutdown) and reports cleared=1, unconfirmed=0",
          sd and sd[0]["cleared"] == 1 and sd[0]["unconfirmed"] == 0
          and [r["reason"] for r in p.events("bye")] == ["shutdown"], (sd, p.events("bye")))

    # 11. re-INVITE after the call is cleared -> 481, no answer.
    q = Proxy("answer_bye")
    q.answer()
    q.pump(1.0, lambda m: m.startswith("BYE ") and q.reply(m, 200))
    q.cseq += 1
    q.send(q.hdr("INVITE", q.cseq, body=q.sdp()))
    q.pump(0.3)
    check("S11 re-INVITE after the call is cleared -> 481, never a new 200",
          any(m.startswith("SIP/2.0 481") for t, m in q.msgs)
          and not any(f"CSeq: {q.cseq} INVITE" in m for m in q.oks_to_invite()))

    # 12. A late 200 OK for an already confirmed BYE is ignored (stray), state unchanged.
    q.send("\r\n".join(["SIP/2.0 200 OK", "Via: SIP/2.0/UDP 127.0.0.1:5060;branch=z9hG4bKold",
                        f"From: <sip:x>", "To: <sip:y>", f"Call-ID: {q.cid}", "CSeq: 1 BYE",
                        "Content-Length: 0", "", ""]))
    q.pump(0.2)
    check("S12 late 200 OK to BYE -> logged stray_bye_response, state still cleared",
          q.events("stray_bye_response") and q.state() == "cleared")

    # 13. Output guard is unchanged: no REFER / INVITE / REGISTER / 3xx can leave.
    leaked = []
    for bad in ("REFER sip:x SIP/2.0\r\n\r\n", "INVITE sip:x SIP/2.0\r\n\r\n",
                "REGISTER sip:x SIP/2.0\r\n\r\n", "SIP/2.0 302 Moved Temporarily\r\n\r\n"):
        try:
            q.e.send(bad, ("127.0.0.1", 9))
            leaked.append(bad.split("\r\n")[0])
        except RuntimeError:
            pass
    check("S13 output guard still refuses REFER / INVITE / REGISTER / 3xx", not leaked, leaked)

    # 14. PRIV-1: no timeline line from any scenario holds the caller's number unmasked.
    time.sleep(0.3)
    all_tl = "".join(open(os.path.join(d, "timeline.jsonl")).read() for d in DIRS)
    digits = MOBILE.lstrip("0")
    check("S14 PRIV-1: caller number never unmasked in any timeline (BYE R-URI masked)",
          digits not in all_tl and "BYE sip:********789@10.9.9.9" in all_tl,
          [l for l in all_tl.splitlines() if digits in l][:2])
    check("S14 the trial DDI stays readable in logs", "INVITE sip:443300884327@127.0.0.1" in all_tl)

    # 15. Real process + SIGTERM (what systemd and the 12:00 UTC timer send) during a held
    #     call with a pending 120 s cap timer: BYE, confirmation, prompt exit.
    import json as _j
    import signal
    import subprocess
    ev = tempfile.mkdtemp(prefix="esip-safety-")
    DIRS.append(ev)
    port = free_port()
    cf = os.path.join(ev, "c.json")
    _j.dump({"listen_ip": "127.0.0.1", "listen_port": port, "public_ip": "127.0.0.1", "rtp_port": free_port(),
             "rtp_slots": 1, "allow_ips": ["127.0.0.1"], "mode": "answer_hold", "ring_s": 0.05,
             "max_call_s": 120, "max_runtime_s": 300, "evidence_dir": ev}, open(cf, "w"))
    # 16. A handler exception is logged as an ALERT and the endpoint keeps serving.
    q2 = Proxy("busy")
    q2.send("\r\n".join(["INVITE sip:443300884327@127.0.0.1 SIP/2.0", "Call-ID: broken@test", "CSeq: 1 INVITE",
                          "Content-Length: 0", "", ""]))      # no Via/From/To: response() raises
    q2.pump(0.3)
    q2.invite()
    q2.pump(0.3)
    check("S16 malformed INVITE -> handler_error ALERT; next call still answered (486 in busy mode)",
          q2.events("handler_error") and any(m.startswith("SIP/2.0 486") for t, m in q2.msgs), q2.events("handler_error"))

    proc = subprocess.Popen([sys.executable, "-I", os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                                                  "esip_capture.py"), "--config", cf])
    time.sleep(0.6)
    u = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    u.bind(("127.0.0.1", 0))
    u.settimeout(0.05)
    me = u.getsockname()[1]
    base = [f"Via: SIP/2.0/UDP 127.0.0.1:{me};branch=z9hG4bKs15", f"From: <sip:{MOBILE}@10.9.9.9>;tag=C",
            "To: <sip:443300884327@127.0.0.1>", "Call-ID: s15@test"]
    u.sendto("\r\n".join(["INVITE sip:443300884327@127.0.0.1 SIP/2.0", *base, "CSeq: 1 INVITE",
                           f"Contact: <sip:{MOBILE}@10.9.9.9>", "Content-Type: application/sdp", "",
                           "v=0\r\nc=IN IP4 127.0.0.1\r\nm=audio 4000 RTP/AVP 8\r\n"]).encode(), ("127.0.0.1", port))
    time.sleep(0.4)
    u.sendto("\r\n".join(["ACK sip:esip@127.0.0.1 SIP/2.0", *base, "CSeq: 1 ACK", "Content-Length: 0", "", ""]).encode(),
             ("127.0.0.1", port))
    time.sleep(0.5)
    t0 = time.time()
    proc.send_signal(signal.SIGTERM)
    while time.time() - t0 < 8 and proc.poll() is None:
        try:
            m = u.recv(65535).decode(errors="replace")
            if m.startswith("BYE "):
                h = [l for l in m.split("\r\n") if l.split(":")[0] in ("Via", "From", "To", "Call-ID", "CSeq")]
                u.sendto(("SIP/2.0 200 OK\r\n" + "\r\n".join(h) + "\r\nContent-Length: 0\r\n\r\n").encode(),
                         ("127.0.0.1", port))
        except socket.timeout:
            pass
    rc = proc.wait(timeout=10)
    took = time.time() - t0
    tl15 = [_j.loads(l) for l in open(os.path.join(ev, "timeline.jsonl"))]
    sd = [r for r in tl15 if r.get("event") == "shutdown"]
    check("S15 real process, SIGTERM mid-call: BYE confirmed, shutdown cleared=1, exit < 6 s despite 120 s timer",
          rc == 0 and took < 6 and sd and sd[0]["cleared"] == 1 and sd[0]["unconfirmed"] == 0
          and any(r.get("event") == "bye_confirmed" for r in tl15), (rc, round(took, 1), sd))

    for d in DIRS:
        shutil.rmtree(d, ignore_errors=True)
    print(f"{sum(RESULTS)}/{len(RESULTS)} passed")
    sys.exit(0 if all(RESULTS) else 1)


if __name__ == "__main__":
    main()
