"""Masked call report for E-SIP evidence (PRIV-1). The routine way to inspect a call.

Never prints a raw INVITE, a WAV or pcap payload. Every run of 7+ digits is masked to its
last three digits, except the trial DDI. Identity headers are shown masked; every other
header is shown by name only. With --ref-raw, each header is also checked against the
caller number in a reference INVITE (compared in memory; never printed).

  python3 -I esip_report.py --evidence /home/esip/evidence [--call CALL-ID-PREFIX] [--ref-raw FILE]
"""
import argparse
import glob
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from esip_capture import Esip, mask_line  # noqa: E402

IDENTITY = ("from", "to", "contact", "remote-party-id", "p-asserted-identity", "p-preferred-identity",
            "privacy", "diversion", "history-info", "x-callinfo", "user-agent", "via", "record-route")


def nsn(digits):
    return digits[-10:] if len(digits) >= 10 else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--evidence", required=True)
    ap.add_argument("--call", help="Call-ID prefix (default: latest INVITE)")
    ap.add_argument("--ref-raw", help="raw INVITE whose From number is the reference (never printed)")
    a = ap.parse_args()

    tl = [json.loads(l) for l in open(os.path.join(a.evidence, "timeline.jsonl"))]
    invites = [r for r in tl if r.get("line", "").startswith("INVITE ") and r.get("dir") == "in"]
    if a.call:
        invites = [r for r in invites if r.get("call_id", "").startswith(a.call)]
    if not invites:
        sys.exit("no matching INVITE")
    cid = invites[-1]["call_id"]
    print(f"call {cid[:8]}…  first INVITE {invites[0]['t']}")

    ref = None
    if a.ref_raw:
        m = re.search(r"^From:\s*<sip:\+?(\d+)@", open(a.ref_raw).read(), re.M)
        ref = m and nsn(m.group(1))

    for path in sorted(glob.glob(os.path.join(a.evidence, "raw", "*.sip"))):
        text = open(path).read()
        if re.search(r"^Call-ID:\s*" + re.escape(cid), text, re.M | re.I):
            head = text.replace("\r\n", "\n").split("\n\n", 1)[0]
            print("\nheaders (identity headers masked, others by name only):")
            hits = []
            for line in head.split("\n")[1:]:
                if ":" not in line:
                    continue
                k, v = line.split(":", 1)
                if ref and any(nsn(d) == ref for d in re.findall(r"\d{7,}", v)):
                    hits.append(k.strip())
                shown = mask_line(v.strip()) if k.strip().lower() in IDENTITY else "[not shown]"
                print(f"  {k.strip()}: {shown}")
            if ref:
                print("headers carrying the reference number:", hits or "NONE")
            break

    print("\ntimeline:")
    for r in tl:
        if r.get("call_id") == cid or (r.get("info") or {}).get("call_id") == cid:
            print("  " + mask_line(json.dumps(r)))
    alerts = [r for r in tl if r.get("alert") and r.get("call_id") == cid]
    print("\nALERTS:", [r["event"] for r in alerts] or "none")


if __name__ == "__main__":
    main()
