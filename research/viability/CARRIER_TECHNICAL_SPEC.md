# Network-side selective call routing: technical requirement

**From:** Home Call Guard Ltd. **For:** BT/EE, VodafoneThree, Virgin Media O2, Wireless Logic (Cloud9), aql, and UK MVNEs. **Version:** 0.1, 2026-09-30.

> Internal note (remove before sending): deliberately says nothing about how HCG protects unknown calls. EE, Vodafone and O2 sell competing scam-call products.

## 1. What we need

For subscribers who opt in, calls to their mobile number are routed by caller identity **in the network**:

| Caller | Routing |
|---|---|
| On the subscriber's trusted list | Delivered normally. HCG is **not** in the signalling or media path. |
| Everyone else, including withheld/anonymous and unverifiable CLI | Diverted to a Home Call Guard number or SIP endpoint. HCG then delivers the call to the subscriber. |

It must work on **any** handset (iPhone and Android), with no app involvement for trusted calls, over VoLTE, VoWiFi and any remaining CS domain.

## 2. Acceptable implementations (any one)

| Option | How it works |
|---|---|
| **A. IMS terminating application server** | For opted-in IMPUs, a terminating iFC routes the INVITE to an application server (operator-hosted and fed by HCG through an API, or HCG-hosted) acting as a **redirecting / proxy AS, not a media B2BUA**. Trusted: the AS proxies without Record-Route (drops out of the path). Otherwise: 3xx or CDIV to the HCG target. **iFC DefaultHandling = SESSION_CONTINUED** (AS unreachable → normal delivery). |
| **B. Conditional call diversion** (3GPP TS 24.604) | A CDIV rule "unconditional, **except** identity ∈ trusted list", plus the `anonymous` condition → HCG target. Rules managed by HCG on the subscriber's behalf through a partner API (we don't expect raw Ut/XCAP exposure). |
| **C. MVNO/MVNE core** | Option A or B implemented in the MVNE's own core for HCG-branded or partner SIMs, with number porting. |

## 3. Functional requirements

| # | Requirement |
|---|---|
| R1 | **Opt-in provisioning API:** enable, disable and query per MSISDN, with the subscriber's consent recorded. Disable must restore normal delivery immediately. |
| R2 | **Trusted-list API:** add and remove identities (E.164). At least 500 entries per subscriber. Changes effective ≤ 60 s. |
| R3 | **Divert target:** a UK geographic number or SIP URI per subscriber (or one target plus a subscriber identifier in the SIP headers: History-Info / Diversion / P-Called-Party-ID). |
| R4 | **Loop safety:** calls *from* HCG's return route to the subscriber must bypass the rule, identified by trunk, P-Asserted-Identity or a routing prefix. |
| R5 | **Caller ID on the return leg:** HCG's return leg may present the **original caller's CLI** to the subscriber, within Ofcom CLI guidance (network number vs presentation number). |
| R6 | **CLI integrity:** trusted-list matching only on network-validated CLI. Calls with spoofed or unvalidated CLI (e.g. international-origin presenting a UK number) are treated as untrusted. |
| R7 | **Fail-open:** any failure of the rule, the AS or the HCG target results in **normal delivery**, never a failed call. The subscriber can always disable the service with no HCG involvement (short code or self-care). |
| R8 | **Status API:** returns whether the rule is active for an MSISDN, so HCG never stops serving a subscriber whose calls still divert to it (CAMARA *Call Forwarding Signal*, or equivalent). |
| R9 | **Roaming / VoWiFi / CS:** state the behaviour. Acceptable fallback: the rule doesn't apply and calls deliver normally (unprotected, never dropped). |
| R10 | **Records:** per-call divert CDR or event (time, MSISDN, diverted yes/no; no content) for reconciliation. |

## 4. Commercial questions

1. Is Option A, B or C available (today, or roadmap and date)? Which domains: VoLTE, VoWiFi, CS?
2. Price model: per subscriber per month, per diverted call or minute, set-up. Who pays for the diverted leg to HCG's number?
3. Minimum volumes, contract length, eligibility (post-pay/pre-pay, business/consumer, MVNOs on your network).
4. Number retention: can existing customers keep their SIM and number (Options A/B), or is porting to your SIM required (C)?
5. Technical contact for an integration trial, and trial environment availability.

## 5. Out of scope

- What HCG does with diverted calls.
- Any change to trusted callers' experience.
- Customer billing by the operator, unless you propose it.
