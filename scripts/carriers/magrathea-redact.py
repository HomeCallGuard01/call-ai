"""Redact a Magrathea REST response for sharing (stdout). Raw input stays private.

- Keys that identify people/accounts (name, address, email, VAT, label, password...)
  are replaced wholesale.
- Any run of 7+ digits (phone / Network Numbers, which Magrathea Schedule 3 s5 forbids
  passing to end users) is masked to its last 3 digits, except HCG's own trial DDI.
- Non-JSON bodies are masked the same way and truncated.
"""
import json
import re
import sys

SENSITIVE_KEY = re.compile(
    r"name|company|addr|vat|mail|label|pass|pwd|secret|token|user|contact|phone|postcode|^ip$|ip_?addr|sipip",
    re.I,
)
OWN_NUMBERS = {"03300884327", "443300884327", "+443300884327", "3300884327"}
DIGITS = re.compile(r"\+?\d{7,}")


def mask_digits(text):
    def repl(m):
        s = m.group(0)
        return s if s in OWN_NUMBERS else "*" * (len(s) - 3) + s[-3:]
    return DIGITS.sub(repl, text)


def redact(value, key=""):
    if key and SENSITIVE_KEY.search(key):
        return "[REDACTED]"
    if isinstance(value, dict):
        return {k: redact(v, k) for k, v in value.items()}
    if isinstance(value, list):
        return [redact(v, key) for v in value]
    if isinstance(value, str):
        return mask_digits(value)
    return value


def main(path):
    raw = open(path, encoding="utf-8", errors="replace").read()
    try:
        data = json.loads(raw)
    except ValueError:
        text = mask_digits(raw)
        text = re.sub(r"[\w.+-]+@[\w-]+\.[\w.]+", "[EMAIL]", text)
        print(json.dumps({"_non_json_body": text[:2000], "_bytes": len(raw)}, indent=2))
        return
    print(json.dumps(redact(data), indent=2, sort_keys=True))


if __name__ == "__main__":
    main(sys.argv[1])
