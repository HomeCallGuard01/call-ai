"""Loopback test for esip_capture: 127.0.0.1 only, synthetic INVITEs, temp evidence dir.
No traffic leaves the machine.

Run: python3 -I scripts/carriers/sip-lab/test_esip_loopback.py
"""
import json
import os
import socket
import stat
import sys
import tempfile
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import esip_capture  # noqa: E402

N = 0


def free_port():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def start(allow, mode, ev):
    port = free_port()
    cfg = {"listen_ip": "127.0.0.1", "listen_port": port, "public_ip": "127.0.0.1",
           "rtp_port": free_port(), "allow_ips": allow, "mode": mode, "ring_s": 0.2,
           "bye_after_s": 0.5, "max_runtime_s": 60, "evidence_dir": ev}
    e = esip_capture.Esip(cfg, mode)
    threading.Thread(target=e.run, daemon=True).start()
    return e, port


def uac():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.bind(("127.0.0.1", 0))
    s.settimeout(0.4)
    return s


def invite(s, port):
    global N
    N += 1
    me = s.getsockname()
    sdp = f"v=0\r\no=t 1 1 IN IP4 127.0.0.1\r\ns=t\r\nc=IN IP4 127.0.0.1\r\nt=0 0\r\nm=audio {me[1]} RTP/AVP 8\r\n"
    msg = "\r\n".join([
        "INVITE sip:443300884327@127.0.0.1 SIP/2.0",
        f"Via: SIP/2.0/UDP 127.0.0.1:{me[1]};branch=z9hG4bKt{N}",
        "From: <sip:+447700900789@127.0.0.1>;tag=a", "To: <sip:443300884327@127.0.0.1>",
        f"Call-ID: call{N}@test", "CSeq: 1 INVITE", f"Contact: <sip:uac@127.0.0.1:{me[1]}>",
        "P-Asserted-Identity: <sip:+447700900789@127.0.0.1>",
        "Diversion: <sip:+447700900123@127.0.0.1>;reason=user-busy",
        "Content-Type: application/sdp", f"Content-Length: {len(sdp)}", "", sdp])
    s.sendto(msg.encode(), ("127.0.0.1", port))
    return f"call{N}@test"


def req(s, port, method, cid, cseq):
    msg = "\r\n".join([f"{method} sip:esip@127.0.0.1 SIP/2.0",
                       f"Via: SIP/2.0/UDP 127.0.0.1:{s.getsockname()[1]};branch=z9hG4bKr{cid}{method}",
                       "From: <sip:+447700900789@127.0.0.1>;tag=a", "To: <sip:443300884327@127.0.0.1>",
                       f"Call-ID: {cid}", f"CSeq: {cseq} {method}", "Content-Length: 0", "", ""])
    s.sendto(msg.encode(), ("127.0.0.1", port))


def collect(s, wait=1.2):
    out, end = [], time.time() + wait
    while time.time() < end:
        try:
            out.append(s.recv(65535).decode(errors="replace").split("\r\n", 1)[0])  # RTP silence also lands here
        except socket.timeout:
            pass
    return [l for l in out if l.startswith("SIP/2.0") or l.split(" ")[0].isalpha() and "SIP/2.0" in l]


RESULTS = []


def check(name, cond, detail=""):
    RESULTS.append(cond)
    print(f"{len(RESULTS):2}. {'PASS' if cond else 'FAIL'}  {name}" + ("" if cond else f"  -> {detail}"))


def main():
    ev = tempfile.mkdtemp(prefix="esip-test-")
    e, port = start(["127.0.0.1"], "busy", ev)
    s = uac()

    invite(s, port)
    got = collect(s)
    check("busy: 100 then 486, nothing else", got == ["SIP/2.0 100 Trying", "SIP/2.0 486 Busy Here"], got)

    e.mode = "unavailable"
    invite(s, port)
    got = collect(s)
    check("unavailable: 480", got == ["SIP/2.0 100 Trying", "SIP/2.0 480 Temporarily Unavailable"], got)

    e.mode = "noanswer"
    cid = invite(s, port)
    got = collect(s, 0.8)
    req(s, port, "CANCEL", cid, 1)
    got += collect(s, 0.8)
    check("noanswer: 180, then CANCEL -> 200 + 487",
          got == ["SIP/2.0 100 Trying", "SIP/2.0 180 Ringing", "SIP/2.0 200 OK",
                  "SIP/2.0 487 Request Terminated"], got)

    e.mode = "answer_hold"
    cid = invite(s, port)
    got = collect(s, 0.8)
    req(s, port, "ACK", cid, 1)
    time.sleep(0.3)
    req(s, port, "BYE", cid, 2)
    got += collect(s, 0.6)
    check("answer_hold: 200 answered; caller BYE -> 200; E-SIP sends no BYE",
          got == ["SIP/2.0 100 Trying", "SIP/2.0 180 Ringing", "SIP/2.0 200 OK", "SIP/2.0 200 OK"], got)

    e.mode = "answer_bye"
    cid = invite(s, port)
    got = collect(s, 0.8)
    req(s, port, "ACK", cid, 1)
    got += collect(s, 1.0)
    check("answer_bye: E-SIP clears with BYE after the timer",
          got[:3] == ["SIP/2.0 100 Trying", "SIP/2.0 180 Ringing", "SIP/2.0 200 OK"]
          and any(l.startswith("BYE ") for l in got[3:]), got)

    sent_forbidden = []
    for bad in ("REFER sip:x SIP/2.0\r\n\r\n", "INVITE sip:x SIP/2.0\r\n\r\n",
                "REGISTER sip:x SIP/2.0\r\n\r\n", "SIP/2.0 302 Moved Temporarily\r\n\r\n"):
        try:
            e.send(bad, ("127.0.0.1", 9))
            sent_forbidden.append(bad.split("\r\n")[0])
        except RuntimeError:
            pass
    check("output guard refuses REFER / INVITE / REGISTER / 3xx", not sent_forbidden, sent_forbidden)

    ev2 = tempfile.mkdtemp(prefix="esip-test-")
    e2, port2 = start(["87.238.72.129"], "busy", ev2)
    invite(s, port2)
    got = collect(s, 0.8)
    dropped = "dropped_non_allowlisted" in open(os.path.join(ev2, "timeline.jsonl")).read()
    check("non-allowlisted source gets no reply and is logged", got == [] and dropped, got)

    raws = os.listdir(os.path.join(ev, "raw"))
    modes = {stat.S_IMODE(os.stat(os.path.join(ev, "raw", r)).st_mode) for r in raws}
    check("raw INVITEs written mode 600", raws and modes == {0o600}, modes)
    tl = open(os.path.join(ev, "timeline.jsonl")).read()
    check("timeline masks numbers (no full test number present)",
          "+447700900789" not in tl and "+447700900123" not in tl and "*******789" in tl)
    classified = [json.loads(l) for l in tl.splitlines() if '"classified"' in l]
    check("classification logged per INVITE with diversion identity masked",
          len(classified) == 5 and classified[0]["info"]["diversion"]["identity"].endswith("123"))

    ok = all(RESULTS)
    print(f"{sum(RESULTS)}/{len(RESULTS)} passed (evidence in temp dir {ev}, removed)")
    import shutil
    shutil.rmtree(ev, ignore_errors=True)
    shutil.rmtree(ev2, ignore_errors=True)
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
