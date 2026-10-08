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
           "bye_after_s": 0.5, "max_call_s": 5, "max_runtime_s": 60, "evidence_dir": ev}
    e = esip_capture.Esip(cfg, mode)
    threading.Thread(target=e.run, daemon=True).start()
    return e, port


def uac():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.bind(("127.0.0.1", 0))
    s.settimeout(0.4)
    return s


def invite(s, port, rtp_port=None, pts="8"):
    global N
    N += 1
    me = s.getsockname()
    sdp = (f"v=0\r\no=t 1 1 IN IP4 127.0.0.1\r\ns=t\r\nc=IN IP4 127.0.0.1\r\nt=0 0\r\n"
           f"m=audio {rtp_port or me[1]} RTP/AVP {pts}\r\n")
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
    cond = bool(cond)
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

    # ---- G.711 against the stdlib reference (audioop exists on Python <= 3.12) ------
    try:
        import warnings
        warnings.simplefilter("ignore", DeprecationWarning)
        import audioop
        samples = list(range(-32768, 32768, 37))
        pcm = b"".join(v.to_bytes(2, "little", signed=True) for v in samples)
        ok_a = bytes(esip_capture.lin2alaw(v) for v in samples) == audioop.lin2alaw(pcm, 2)
        ok_u = bytes(esip_capture.lin2ulaw(v) for v in samples) == audioop.lin2ulaw(pcm, 2)
        dec_a = all(esip_capture.alaw2lin(i) == int.from_bytes(audioop.alaw2lin(bytes([i]), 2), "little", signed=True) for i in range(256))
        dec_u = all(esip_capture.ulaw2lin(i) == int.from_bytes(audioop.ulaw2lin(bytes([i]), 2), "little", signed=True) for i in range(256))
        check("G.711 A-law/u-law encode+decode match audioop reference", ok_a and ok_u and dec_a and dec_u,
              (ok_a, ok_u, dec_a, dec_u))
    except ImportError:
        check("G.711 reference check skipped (no audioop)", True)

    # ---- two-way audio, PCMA and PCMU ----------------------------------------------
    for pts, want in (("8 0 101", 8), ("0 101", 0)):
        e.mode = "answer_hold"
        rtp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        rtp.bind(("127.0.0.1", 0))
        rtp.settimeout(0.05)
        s2 = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s2.bind(("127.0.0.1", 0))
        s2.settimeout(0.4)
        cid = invite(s2, port, rtp.getsockname()[1], pts)
        answer = ""
        end = time.time() + 1.5
        while time.time() < end and "200 OK" not in answer.split("\r\n", 1)[0]:
            try:
                answer = s2.recv(65535).decode(errors="replace")
            except socket.timeout:
                pass
        import re as _re
        m = _re.search(r"m=audio (\d+) RTP/AVP (\d+)", answer)
        req(s2, port, "ACK", cid, 1)
        tone = bytes(esip_capture.ENC[want](v) for v in esip_capture._TONE)
        rx, rx_tone, seq = 0, 0, 0
        t_end = time.time() + 2.2
        while time.time() < t_end:
            if m:
                hdr = bytes([0x80, want]) + seq.to_bytes(2, "big") + (seq * 160).to_bytes(4, "big") + b"\x00\x00\x00\x01"
                rtp.sendto(hdr + tone, ("127.0.0.1", int(m.group(1))))
                seq += 1
            try:
                pkt = rtp.recv(2048)
                rx += 1
                if (pkt[1] & 0x7F) == want and pkt[12:] == esip_capture.TONE_FRAME[want]:
                    rx_tone += 1
            except socket.timeout:
                pass
            time.sleep(0.02)
        req(s2, port, "BYE", cid, 2)
        time.sleep(0.4)
        summ = [json.loads(l) for l in open(os.path.join(ev, "timeline.jsonl")) if '"media_summary"' in l
                and json.loads(l).get("call_id") == cid]
        sm = summ[0] if summ else {}
        wavs = [f for f in os.listdir(os.path.join(ev, "audio"))]
        check(f"two-way audio offer [{pts}]: answers PT {want}, caller hears beep, E-SIP records caller",
              m is not None and int(m.group(2)) == want and rx_tone > 0 and rx > 50
              and sm.get("two_way_audio") is True and sm.get("rtp_received", 0) > 50
              and sm.get("recorded_seconds", 0) > 1.0 and wavs,
              {"answer_pt": m and m.group(2), "rx": rx, "rx_tone": rx_tone, "summary": sm})
        rtp.close()
        s2.close()

    e.mode = "answer_hold"
    s3 = uac()
    invite(s3, port, None, "18")
    got = collect(s3, 0.8)
    check("offer without G.711 (G.729 only) -> 488", got[-1:] == ["SIP/2.0 488 Not Acceptable Here"], got)

    ev3 = tempfile.mkdtemp(prefix="esip-test-")
    cfg3 = {"listen_ip": "127.0.0.1", "listen_port": free_port(), "public_ip": "127.0.0.1",
            "rtp_port": free_port(), "allow_ips": [], "allow_cidrs": ["127.0.0.0/8"], "mode": "busy",
            "evidence_dir": ev3, "max_runtime_s": 60}
    e3 = esip_capture.Esip(cfg3, "busy")
    threading.Thread(target=e3.run, daemon=True).start()
    invite(s3, cfg3["listen_port"])
    got = collect(s3, 0.8)
    check("CIDR allowlist entry admits a source inside the subnet", got[-1:] == ["SIP/2.0 486 Busy Here"], got)

    # SDP pointing media at a non-allowlisted host: answered, but no RTP is sent there.
    ev4 = tempfile.mkdtemp(prefix="esip-test-")
    cfg4 = {"listen_ip": "127.0.0.1", "listen_port": free_port(), "public_ip": "127.0.0.1",
            "rtp_port": free_port(), "allow_ips": ["127.0.0.1"], "mode": "answer_hold", "ring_s": 0.1,
            "max_call_s": 1, "evidence_dir": ev4, "max_runtime_s": 60}
    e4 = esip_capture.Esip(cfg4, "answer_hold")
    threading.Thread(target=e4.run, daemon=True).start()
    s4 = uac()
    m4 = "\r\n".join([
        "INVITE sip:443300884327@127.0.0.1 SIP/2.0",
        f"Via: SIP/2.0/UDP 127.0.0.1:{s4.getsockname()[1]};branch=z9hG4bKx",
        "From: <sip:+447700900789@127.0.0.1>;tag=a", "To: <sip:443300884327@127.0.0.1>",
        "Call-ID: sdp-elsewhere@test", "CSeq: 1 INVITE", f"Contact: <sip:uac@127.0.0.1:{s4.getsockname()[1]}>",
        "Content-Type: application/sdp", "", "v=0\r\nc=IN IP4 127.0.0.2\r\nm=audio 4000 RTP/AVP 8\r\n"])
    s4.sendto(m4.encode(), ("127.0.0.1", cfg4["listen_port"]))
    collect(s4, 0.5)
    req(s4, cfg4["listen_port"], "ACK", "sdp-elsewhere@test", 1)
    time.sleep(1.6)                                   # max_call_s=1 ends it
    tl4 = [json.loads(l) for l in open(os.path.join(ev4, "timeline.jsonl"))]
    sm4 = next((r for r in tl4 if r.get("event") == "media_summary"), {})
    check("SDP media address outside allowlist: no RTP sent there; max_call_s BYE fires",
          any(r.get("event") == "sdp_media_ip_not_allowlisted_no_rtp_sent" for r in tl4)
          and sm4.get("rtp_sent") == 0
          and any(r.get("event") == "bye" and r.get("reason") == "max_call_s" for r in tl4), sm4)

    ok = all(RESULTS)
    print(f"{sum(RESULTS)}/{len(RESULTS)} passed (evidence in temp dir {ev}, removed)")
    import shutil
    shutil.rmtree(ev, ignore_errors=True)
    shutil.rmtree(ev2, ignore_errors=True)
    shutil.rmtree(ev3, ignore_errors=True)
    shutil.rmtree(ev4, ignore_errors=True)
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
