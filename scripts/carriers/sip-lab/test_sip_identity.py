"""Offline tests for sip_identity. Synthetic INVITEs only; numbers are Ofcom drama
ranges (07700 900xxx, 01632 960xxx), never real subscribers.

Run: python3 -I scripts/carriers/sip-lab/test_sip_identity.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import sip_identity as s  # noqa: E402

MAG = "87.238.72.129"
CUSTOMER = "+447700900123"     # the forwarding mobile (H-T)
TRUSTED = "+447700900456"
STRANGER = "+447700900789"
HOUSEHOLD = {"mobile": CUSTOMER, "trusted": {TRUSTED}}


def invite(ruri_user="443300884327", frm=STRANGER, pai=None, rpid=None,
           diversion=(), privacy=None, history=(), call_id="c1@test"):
    lines = [f"INVITE sip:{ruri_user}@esip.example SIP/2.0",
             f"From: <sip:{frm}@87.238.72.129>;tag=1" if frm else
             "From: \"Anonymous\" <sip:anonymous@anonymous.invalid>;tag=1",
             f"To: <sip:{ruri_user}@esip.example>", f"Call-ID: {call_id}"]
    if pai:
        lines.append(f"P-Asserted-Identity: <sip:{pai}@87.238.72.129>")
    if rpid:
        lines.append(f"Remote-Party-ID: {rpid}")
    for d in diversion:
        lines.append(f"Diversion: {d}")
    for hi in history:
        lines.append(f"History-Info: {hi}")
    if privacy:
        lines.append(f"Privacy: {privacy}")
    lines.append("X-CALLINFO: cdr=TESTREF;")
    return "\r\n".join(lines) + "\r\n\r\n"


CASES = []


def case(fn):
    CASES.append(fn)
    return fn


@case
def forwarded_unknown_caller_with_diversion():
    i = s.classify(invite(pai=STRANGER, diversion=[f"<sip:{CUSTOMER}@x>;reason=user-busy"]), MAG)
    assert i["caller"]["grade"] == "network_asserted", i
    assert i["diversion"]["identity"] == CUSTOMER and i["diversion"]["reason"] == "user-busy"
    assert i["diversion"]["grade"] == "unverified"          # never "proven" from header alone
    assert s.decide(i, HOUSEHOLD)[0] == "monitor"


@case
def trusted_needs_network_asserted_identity():
    spoof = s.classify(invite(frm=TRUSTED), MAG)              # presentation only, no PAI
    assert spoof["caller"]["grade"] == "presentation_only"
    assert spoof["caller"]["match_identity"] is None
    assert s.decide(spoof, HOUSEHOLD)[0] == "monitor"         # not treated as trusted
    real = s.classify(invite(frm=TRUSTED, pai=TRUSTED), MAG)
    assert s.decide(real, HOUSEHOLD)[0] == "monitor_flag_trusted"


@case
def pai_differs_is_confidential_and_not_matched():
    i = s.classify(invite(frm=TRUSTED, pai="+441632960001"), MAG)
    assert i["caller"]["grade"] == "presentation_differs"
    assert i["caller"]["match_identity"] is None


@case
def withheld_caller():
    i = s.classify(invite(frm=None, pai=STRANGER, privacy="id"), MAG)
    assert i["caller"]["withheld"] is True
    action, reasons = s.decide(i, HOUSEHOLD)
    assert action == "monitor" and "no_usable_cli" in reasons


@case
def missing_cli_entirely():
    i = s.classify(invite(frm=None), MAG)
    assert i["caller"]["grade"] == "absent"
    assert "no_usable_cli" in s.decide(i, HOUSEHOLD)[1]


@case
def loop_double_diversion_rejected():
    i = s.classify(invite(pai=STRANGER, diversion=[f"<sip:{CUSTOMER}@x>;reason=unconditional",
                                                     "<sip:+443300884327@x>;reason=unconditional"]), MAG)
    assert "loop_suspected" in i["problems"]
    assert s.decide(i, HOUSEHOLD)[0] == "reject_486"


@case
def loop_own_ddi_as_caller_rejected():
    i = s.classify(invite(frm="+443300884327", pai="+443300884327"), MAG)
    assert s.decide(i, HOUSEHOLD)[0] == "reject_486"


@case
def duplicate_call_id_rejected():
    i = s.classify(invite(pai=STRANGER, call_id="dup@test"), MAG)
    assert s.decide(i, HOUSEHOLD, recent_call_keys={"dup@test"}) == ("reject_486", ["duplicate"])


@case
def non_magrathea_source_rejected():
    i = s.classify(invite(pai=STRANGER), "203.0.113.9")
    assert s.decide(i, HOUSEHOLD)[0] == "reject_403"


@case
def magrathea_subnet_source_accepted():
    for ip in ("87.238.77.140", "213.166.4.190", "87.238.72.130"):
        assert s.decide(s.classify(invite(pai=STRANGER), ip), HOUSEHOLD)[0] == "monitor", ip
    for ip in ("87.238.72.127", "87.238.74.140", "not-an-ip"):
        assert s.decide(s.classify(invite(pai=STRANGER), ip), HOUSEHOLD)[0] == "reject_403", ip


@case
def wrong_ddi_rejected():
    i = s.classify(invite(ruri_user="441632960999", pai=STRANGER), MAG)
    assert s.decide(i, HOUSEHOLD)[0] == "reject_403"


@case
def diversion_not_household_is_recorded_not_trusted():
    i = s.classify(invite(pai=STRANGER, diversion=["<sip:+447700900999@x>;reason=no-answer"]), MAG)
    action, reasons = s.decide(i, HOUSEHOLD)
    assert action == "monitor" and "diverting_identity_not_household" in reasons


@case
def history_info_fallback():
    i = s.classify(invite(pai=STRANGER, history=[f"<sip:{CUSTOMER}@x>;index=1",
                                                 "<sip:443300884327@esip>;index=1.1"]), MAG)
    assert i["diversion"]["identity"] == CUSTOMER and i["diversion"]["source"] == "history-info"


@case
def national_format_normalised():
    assert s.e164("07700900123") == CUSTOMER
    assert s.e164("447700900123") == CUSTOMER
    assert s.e164("anonymous") is None


if __name__ == "__main__":
    failed = 0
    for i, fn in enumerate(CASES, 1):
        try:
            fn()
            print(f"{i:2}. PASS  {fn.__name__}")
        except AssertionError as e:
            failed += 1
            print(f"{i:2}. FAIL  {fn.__name__}: {e}")
    print(f"{len(CASES) - failed}/{len(CASES)} passed")
    sys.exit(1 if failed else 0)
