"""Classify the identity evidence in an inbound Magrathea INVITE. Local analysis only.

Nothing here trusts a header by default. Each identity comes back with the header it
came from and an evidence grade, and the routing decision only treats a caller as
trusted when the evidence is strong enough. Grades are provisional until Magrathea
confirms which headers its network populates and whether callers can set them
(plan: MAGRATHEA-SIP-TRIAL-PLAN.md, M-Q3/M-Q7).

Header semantics come from Magrathea Schedule 3 s5 (Network Mode CLI):
- From / Remote-Party-ID carry the presentation number;
- P-Asserted-Identity carries the network number (confidential if it differs; never
  shown to an end user);
- Diversion carries the last diverting line (the CDR's LDLI is the *last* Diversion);
- privacy=full|yes on RPID/Diversion, or a Privacy header for PAI, means withheld.
"""
import re

DDI_E164 = "+443300884327"
DDI_RURI_USERS = {"443300884327", "03300884327", "3300884327", "+443300884327"}
# Documented Magrathea signalling IPs (handbook). Anything else is rejected.
MAGRATHEA_SIP_IPS = {
    "87.238.72.129", "87.238.72.130", "87.238.73.129",
    "87.238.73.130", "213.166.3.129", "213.166.3.130",
}

_URI_USER = re.compile(r"<?\s*(?:sips?|tel):\+?([^@;>]*)", re.I)


def e164(raw):
    """Normalise a UK number to +44 form, or None if absent/anonymous/unparseable."""
    if not raw:
        return None
    digits = re.sub(r"[^\d+]", "", raw)
    if not digits or raw.strip().lower().startswith("anonymous"):
        return None
    if digits.startswith("+"):
        return digits if len(digits) >= 8 else None
    if digits.startswith("44"):
        return "+" + digits
    if digits.startswith("0") and len(digits) >= 10:
        return "+44" + digits[1:]
    return None


def uri_user(value):
    if not value:
        return None
    m = _URI_USER.search(value)
    return m.group(1) if m else None


def _privacy(value):
    return bool(value and re.search(r"privacy\s*=\s*(full|yes)", value, re.I))


def parse_headers(raw_invite):
    """Return (request_line, {lower-name: [values...]}) preserving header order."""
    text = raw_invite.replace("\r\n", "\n")
    head = text.split("\n\n", 1)[0]
    lines = head.split("\n")
    headers = {}
    for line in lines[1:]:
        if ":" not in line:
            continue
        name, value = line.split(":", 1)
        name = name.strip().lower()
        name = {"f": "from", "i": "call-id", "t": "to", "v": "via"}.get(name, name)
        # Comma-separated Diversion / History-Info values are separate entries.
        parts = [p.strip() for p in re.split(r",(?=\s*<)", value)] if name in (
            "diversion", "history-info") else [value.strip()]
        headers.setdefault(name, []).extend(parts)
    return lines[0].strip(), headers


def classify(raw_invite, source_ip):
    request_line, h = parse_headers(raw_invite)
    first = lambda n: (h.get(n) or [None])[0]
    problems = []

    if source_ip not in MAGRATHEA_SIP_IPS:
        problems.append("source_ip_not_magrathea")

    ruri = request_line.split(" ")[1] if " " in request_line else ""
    dialled_user = uri_user(ruri)
    if dialled_user not in DDI_RURI_USERS:
        problems.append("request_uri_not_trial_ddi")

    from_v, rpid_v, pai_v = first("from"), first("remote-party-id"), first("p-asserted-identity")
    presented = e164(uri_user(rpid_v)) or e164(uri_user(from_v))
    network = e164(uri_user(pai_v))
    withheld = (_privacy(rpid_v) or bool(re.search(r"\bid\b|header|user",
                (first("privacy") or ""), re.I)) or (from_v or "").lower().find("anonymous") >= 0)

    if presented is None and network is None:
        caller_grade = "absent"
    elif network is None:
        caller_grade = "presentation_only"        # caller-settable; never enough for trust
    elif presented in (None, network):
        caller_grade = "network_asserted"          # PAI present and consistent
    else:
        caller_grade = "presentation_differs"      # PAI is a confidential network number

    diversions = h.get("diversion") or []
    last_div = diversions[-1] if diversions else None
    history = h.get("history-info") or []
    diverting = e164(uri_user(last_div)) if last_div else None
    div_source = "diversion" if diverting else None
    if diverting is None and len(history) >= 2:
        diverting = e164(uri_user(history[-2]))    # the entry before the final target
        div_source = "history-info" if diverting else None
    reason = None
    if last_div:
        m = re.search(r"reason\s*=\s*\"?([\w-]+)", last_div, re.I)
        reason = m.group(1).lower() if m else None

    # Loop signals: the call was diverted more than once, or the DDI itself appears as
    # a caller or diverting identity (our own number coming back to us).
    loop = len(diversions) > 1 or DDI_E164 in (presented, network, diverting)
    if loop:
        problems.append("loop_suspected")

    return {
        "call_id": first("call-id"),
        "dialled_user": dialled_user,
        "caller": {
            "presented": presented, "network": network, "withheld": withheld,
            "grade": caller_grade,
            # The identity HCG may match against a trusted list. Only a network-asserted
            # number qualifies; presentation numbers can be set by VoIP callers.
            "match_identity": network if caller_grade == "network_asserted" else None,
        },
        "diversion": {
            "identity": diverting, "source": div_source, "reason": reason,
            "count": len(diversions), "privacy": _privacy(last_div),
            # Unverified until Magrathea confirms it is network-set (M-Q7b) and T8 passes.
            "grade": "unverified" if diverting else "absent",
        },
        "x_callinfo": first("x-callinfo"),
        "problems": problems,
    }


def decide(info, household, recent_call_keys=()):
    """Routing decision for a call that has ALREADY reached Magrathea.

    household = {"mobile": "+447700900123", "trusted": {"+44...", ...}}
    Returns (action, reasons). Actions: reject_486, monitor, monitor_flag_trusted.

    There is no "forward to the customer's mobile" action yet. The only documented way is
    a new paid PSTN leg that can loop back under CFU (plan §4.5). REFER, redirect or a
    provider-assisted transfer is PENDING Magrathea confirmation (SIP plan §5), and is
    added only once confirmed and proven, with billing evidence.
    """
    reasons = list(info["problems"])
    if "source_ip_not_magrathea" in reasons or "request_uri_not_trial_ddi" in reasons:
        return "reject_403", reasons
    if "loop_suspected" in reasons:
        return "reject_486", reasons
    key = (info["caller"]["presented"], info["diversion"]["identity"])
    if info["call_id"] in recent_call_keys or key in recent_call_keys:
        return "reject_486", reasons + ["duplicate"]
    if info["diversion"]["identity"] and info["diversion"]["identity"] != household["mobile"]:
        reasons.append("diverting_identity_not_household")   # recorded, not acted on
    match = info["caller"]["match_identity"]
    if match and match in household["trusted"] and not info["caller"]["withheld"]:
        return "monitor_flag_trusted", reasons + ["trusted_caller_reached_carrier"]
    if info["caller"]["grade"] == "absent" or info["caller"]["withheld"]:
        reasons.append("no_usable_cli")
    return "monitor", reasons
