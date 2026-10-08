# Magrathea trial: proof-of-concept plan (PREPARE ONLY)

**Date:** 2026-10-08.
**Branch:** `research/magrathea-trial-poc`. Its worktree is `/Users/ad/call-ai-magrathea-trial`, and its base is `ad545a1` (the soft-launch candidate head).

**Status:** plan only. Nothing has been called, purchased, configured, registered, rotated or changed. No Magrathea API request of any kind has been made. Credentials are not in this repo, this document or any handover. They have not been seen in this session.

**Isolation:** this workstream does not touch:
- the Build 17 staging test (plan `8d3b60e`, handover `ad545a1`);
- Twilio (no number, Voice URL, SIP domain, trunk or subaccount change);
- production, live pricing or customer records.

The launch does **not** depend on this trial, AL-2 stays undecided, and no Magrathea savings are assumed anywhere (see the 2026-10-06 decision).

Labels used below:
- **DOC**: stated in an official Magrathea document (sources in §12).
- **CONFIRM**: needs a written answer from Magrathea.
- **LIVE**: can only be settled by a controlled live call.
- **INFERRED**: my reasoning from DOC material.

---

## 1. What we have been given

| Item | Value | Notes |
|---|---|---|
| Trial DDI | `0330 088 4327` (+44 330 088 4327) | Non-geographic 03 number. Magrathea's Schedule 3 defines "Geographic" as including 01/02/03, and the handbook says 03 numbers carry "no charge … no out-payment" (DOC). Its current target is **unknown**, so read it first (R6) |
| REST / NTS API access | `https://restapi.magrathea.net:8443/v1/` (Basic auth). NTSAPI raw TCP is `api.magrathea-telecom.co.uk:777` | REST is preferred: "new features will go into REST only" (DOC) |
| Outbound SIP account | `112168` @ `sipgw.magrathea.net` | **Outbound** (origination) account, prepaid (DOC). Not needed for inbound delivery (see §5) |
| Credentials | Received separately by Andrew | **Never** in chat, the repo, docs, logs or shell history. Rotate before any test (§2) |

**Contract constraints that apply to the trial (DOC, Schedule 3 v2026.6 §8):**
- Product Trial numbers **may not be used to provide a commercial service to End Users** (§8.3), so only Andrew's own devices may be used. No customer, no staging household and no production household.
- There are **2 concurrent calls per trial number** (§8.5). This is useful as a natural concurrency bound.
- No porting (§8.4).

Whether `0330 088 4327` is on the Product Trial or another package is **CONFIRM** (Q1).

---

## 2. Credentials: secure local entry and rotation

### 2.1 Rotate first (recommended before any test)
The passwords have been transmitted outside a secret store, so treat them as exposed.
- **REST/NTS API password:** Andrew asks Magrathea support (or uses the MAGIC portal if available) to issue a new one. **CONFIRM** whether a self-service change exists.
- **SIP password for 112168:** the REST `account/setsippw` exists, but it is a mutating call, so it is not run without approval. The alternative is for Magrathea support to rotate it.
- **Also ask** (Q2): restrict 112168 to **IP authentication or dual authentication** rather than registration-only, and confirm that nothing is registered to it today.

### 2.2 Local entry (nothing typed into chat)
**Revised 2026-10-08.** Andrew stores the REST username and password as two Keychain items, typed at hidden prompts in a **separate Terminal window**, not via `!`. No secret then appears on any command line, in shell history or in this session:

```
security add-generic-password -U -s hcg-magrathea-rest-user -a hcg -w   # REST username
security add-generic-password -U -s hcg-magrathea-rest      -a hcg -w   # REST password
```

The SIP secret for 112168 is not needed until an outbound test is approved, so it is not stored. **Andrew decided (2026-10-08) not to delay the trial for rotation. The existing trial credentials are used, and rotation is a recorded follow-up (F-1).**

### 2.3 A2 execution log

**Run 1, 2026-10-08 12:48:36 UTC:**
- **R1 `GET /account/services` returned HTTP 401** with the redacted body `{"error": "Wrong username, password or account"}`.
- The script stopped by design. **R2–R7 were not sent.** There was one request in total, and no retry.
- Raw output is in `/Users/ad/hcg-magrathea-trial/probe-20261008T124836Z/` (outside the repo).

**Confirmed (non-revealing checks):**
- both Keychain items exist;
- neither value has leading or trailing whitespace, control or non-ASCII characters, or characters that need curl-config escaping;
- the password is 10 characters;
- **the stored username is 69 characters long, which is unusually long for an API username.** Most likely a wrong value was pasted, such as a whole line or label, or the wrong field.

**Not established:**
- whether the REST login is a different credential from the one stored (for example, the outbound SIP account's username or password);
- whether the REST user lacks a permission (CPORTAL / NTSAPIUSER);
- whether Magrathea restricts REST access by source IP.

Further shape checks would require reading the secret back out of the Keychain. The session's permission system blocked that, and it was not worked around.

**Next:**
1. Andrew checks the stored username himself, in his own Terminal, and re-enters it if wrong.
2. If it is correct, ask Magrathea which username and permissions the REST API expects (this can go in A3).
3. Only then one re-run, with the same allowlist and the same stop-on-401 rule.

**Run 2 (approved single retry), 2026-10-08 12:56:11 UTC:**
- Before the run, Andrew corrected the username, and it was **verified as 7 characters** (length only; the value was not displayed).
- **R1 returned HTTP 401 again**, with the same redacted body `{"error": "Wrong username, password or account"}`. The script stopped, and **R2–R7 were not sent.**
- Raw output: `/Users/ad/hcg-magrathea-trial/probe-20261008T125610Z/`.

**Script mechanics ruled out:**
- A local loopback test with fake credentials containing `$`, `"` and `\` showed that `curl -K -` sends exactly `user:password` as Basic auth to the right path with GET.
- No traffic went to Magrathea during this test.

**Status: A2 BLOCKED on authentication after two attempts in total (2 requests).** No further attempts until Magrathea confirms the REST login. This respects their misuse clause ("do not try to guess user credentials") and avoids a possible lockout.

**Likely causes (to confirm with Magrathea; not established):**
- the credentials supplied are for the MAGIC portal, NTSAPI or the SIP account, not a REST API user;
- the REST user lacks the required permission (the guide says it needs "a main account and one or more of CPORTAL, ACCMGMT, … NTSAPIUSER");
- the password is wrong;
- REST access is not yet enabled on the trial account.

**Questions to Magrathea (can be sent on their own, ahead of A3):**
- Which username format does the REST API expect for our account?
- Is REST access enabled, and with which permissions?
- Is there any source-IP restriction?
- Are the REST and NTSAPI/portal credentials the same?

The probe now writes `raw/` and `redacted/` (`scripts/carriers/magrathea-redact.py`). Only `redacted/` is ever read in-session.

`-w` as the last argument makes `security` prompt for the password. If the macOS version does not prompt, stop and do not pass the password on the command line.

**Rules for any tooling:**
- read the secret with `security find-generic-password -s … -w` inside a subshell;
- pass it to `curl` through a config file on **stdin** (`curl -K -`), never argv, so it is not visible in `ps`;
- never `set -x`, never echo, never write it to a file;
- evidence files are written outside the repo in `/Users/ad/hcg-magrathea-trial/` (mode 700);
- detail and CDR output includes account PII and **Network Numbers**, which Schedule 3 §5 says must not reach end users. That output stays in the evidence directory and never goes into git.

The prepared read-only probe (`scripts/carriers/magrathea-readonly-probe.sh`, §3.3) follows these rules. It defaults to a dry run and refuses any endpoint that is not on its allowlist.

---

## 3. REST API: safe read-only operations

Source: REST API User Guide v1.2.9 (26 Apr 2023) and the live resource docs at `https://restapi.magrathea.net:8443/docs/` (v1.2.9, fetched 2026-10-08 without credentials).

> **Important:** the HTTP method is **not** a safety signal in this API.
> - `account/transfer/{From}/{To}/{Funds}` **moves money and is a GET**.
> - `account/listsipip` and `account/transferhistory` are read-only but are **POST**.
> - `number/feature` **reads or writes** through one PUT, depending on `?enabled=`.
>
> The allowlist is therefore by exact path, not by method.

### 3.1 Tier R: read-only by documentation, GET. Proposed first probe (approval A2)

| # | Call | Purpose (test it serves) | Documented response |
|---|---|---|---|
| R1 | `GET /account/services` | Which permissions the credentials hold (CPORTAL, FTRANSFER, MACCOUNT, ACCOUNT list) and which account numbers exist | services list |
| R2 | `GET /account/detail/112168` | Confirms the account identity. Output holds PII, so it goes to the evidence directory only | `{name, company, addr1, vat, label, email, …}` |
| R3 | `GET /account/balance/112168` | Prepaid funds and promo funds (test 7) | `{funds, promofunds}` |
| R4 | `GET /account/gettariff/112168` | Tariff band plus **restriction** (NONE / HIGH ≤3p / MEDIUM ≤15p) (test 7) | `{band, restriction}` |
| R5 | `GET /account/cdrs/112168` | "Details of the last few calls". Baseline before any test (test 6) | `{calldate, calltime, anumber, bnumber, origination, dialled, destination, duration, debit}` or 400 "No CDRS" |
| R6 | `GET /number/status/03300884327` | **Current status, expiry and target(s)** of the DDI (tests 1, 3, 5). Must be known before anything else | `{status, expiry, targets:[{index, value}]}` |
| R7 | `GET /block/info/03300884327` | Whether the DDI is part of a block | first number and size |

R1–R7 are run **once each**. Magrathea's "Misuse" clause forbids "a large number of requests". If R1 lists another account or client code that owns the DDI, R3–R5 are repeated **once** for that account (same approval).

### 3.2 Tier R2: read-only by description, but POST, or rate-limited. Only with explicit mention in the approval

| Call | Why it is held back |
|---|---|
| `POST /account/listsipip` | Read-only by name, but uses POST. Shows which IPs are authorised on the account (relevant to Q2) |
| `POST /account/transferhistory` | Read-only, POST, needs FTRANSFER |
| `GET /nine/status/{n}`, `GET /nine/dataj/{n}` | Read-only, but the guide says at most once per day per number. Not needed: HCG does not originate from the DDI |
| `POST /number/alist/{range}/{size}` | Read-only listing of *available* numbers. Not needed |

### 3.3 Never (in this trial without separate, specific approval)

These calls change state or money:
- `account/transfer` (**GET**);
- `settariff`, `setsippw`, `setlabel`, `addsipip`, `removesipip`;
- `number/allocate|activate|deactivate|reactivate|set|order|setpin|info (POST)`;
- `number/feature` (PUT, even "read" form, until Magrathea confirms the no-`enabled` form is read-only);
- all of `block/*` except `info`;
- all of `nine/*` writes.

NTSAPI (TCP 777) is not used at all: same commands, no extra read value.

**Prepared, not run:** `scripts/carriers/magrathea-readonly-probe.sh`:
- dry run by default;
- `--execute` needed for any network call;
- an exact path allowlist (R1–R7 only), GET only;
- credentials from Keychain via `curl -K -`;
- output to `/Users/ad/hcg-magrathea-trial/probe-<UTC>/`.

### 3.4 What the APIs do **not** offer (DOC, by absence)

- **No per-call routing decision.** Routing is static per number: `set` up to 3 targets plus `order` by time of day, with 20 s sequential failover. There is no webhook, and no simultaneous ring.
- **No spend cap API.** There is no daily or monthly limit, no hard stop and no alert. The only controls are tariff *restriction* (destination price class) and a prepaid balance.
- **No real-time call or CDR feed.** `account/cdrs` gives the "last few calls" with limited fields. Full CDRs (including `inbound`, `outbound`, `result`, `cpacc`, `cpstop`, **`LDLI`**) are a daily CSV ZIP, available the day after, downloaded through MAGIC/FTP. Access is **CONFIRM** (Q8).
- **No number-level diversion data in the API.** Diversion identity appears only in **SIP headers** (Network Mode) and in the CSV `LDLI` field.

---

## 4. Architectural facts that shape every test (DOC + INFERRED)

1. **Inbound to a Magrathea 01/02/03 number delivered to SIP has no Magrathea call charge** (Annex 3 v6.0; handbook 03 row) (DOC).
   - The handbook's `inbound` CDR field exists for configurations where inbound is chargeable, so every test checks that it is £0 (LIVE).
2. **A PSTN target needs a Chargeable Number Translation account** (setup from £100 + VAT; minutes deducted from prepay) (DOC).
   - On a basic account, a PSTN target "will not work because the mobile call is chargeable" (DOC). The trial account's status here is **CONFIRM**.
   - Either way, **a Magrathea PSTN forward is a paid HCG leg**, so it is not the trusted-call route.
3. **Delivery identity:** Network Mode is the default.
   - Presentation number in `From`/`Remote-Party-ID`, network number in `P-Asserted-Identity`, diverting line in `Diversion`, privacy flags, `+E.164`, and `X-CALLINFO: cdr=<ref>` to match CDRs (DOC).
   - Network numbers and LDLI **must not be disclosed to any end user**, and are for "the sole purpose of facilitating your service operation" (Schedule 3 §5) (DOC).
4. **The SIP target must encode the dialled number.** SIP does not otherwise carry it, so the target is `S:443300884327@<endpoint>` (NTSAPI guide) (DOC).
5. **Trusted calls cannot cost HCG nothing if they ever reach Magrathea.** Once the customer's MNO has diverted a call to the DDI, the only ways back to the customer's handset are:
   - a new PSTN leg (paid, and it **loops** under CFU);
   - a VoIP/app leg that HCG hosts.

   So the trusted £0 path must be decided **before** diversion, at the handset (conditional forwarding: CFB `**67*` / CFNRy `**61*`). Magrathea then only ever sees unknown callers. This matches the earlier research (`research/carrier-routing-v2`, trusted-bypass E1/E2) (INFERRED).
   - A SIP **302** answer from HCG's endpoint is undocumented (CONFIRM Q5). Even if Magrathea follows it, it would originate a paid leg, so it is not a lever.

---

## 5. Is the outbound SIP account (112168) required?

| Route / test | Needs 112168? | Why |
|---|---|---|
| Inbound DDI → HCG SIP endpoint (tests 1, 2, 4, 5, 8) | **No** | The number's `set` target sends INVITEs to our endpoint. Delivery to SIP is "Basic Number Translation", free. No registration needed (DOC) |
| Delivery to a **registered** UA instead of a public SIP URI | **CONFIRM** (Q6) | Not documented. If supported, it could avoid a public endpoint, but it means SIP registration, which is not approved |
| Trusted native routing via handset CFB/CFNRy (test 3) | **No** | The trusted call never leaves the customer's MNO |
| Trusted routing via Magrathea PSTN forward (rejected design, measured only if approved) | **No**, but needs a **Chargeable Translation** account plus prepay | Billed through number translation, not the SIP trunk (DOC). Whether it debits 112168's balance is CONFIRM |
| Test 6 charges | No for inbound. Yes only if outbound is tested | |
| LF-2 option A verification call placed through Magrathea (HCG calls P from V) | **Yes** | Origination needs an outbound account plus a CLI that HCG is allowed to present (the DDI). Only relevant if the passive LDLI proof (test 8) fails |
| Placing the live test calls themselves | **No** | The test calls are made by Andrew from ordinary phones |

**Conclusion:** the first live test (Phase 5a) does **not** use 112168. Leave it unregistered. Ask Magrathea to bar international and premium destinations on it, or set restriction `HIGH`, until LF-2 option A is chosen.

---

## 6. Smallest controlled test design

### 6.1 Equipment

- **E-SIP:** a temporary capture endpoint.
  - One small cloud VM (UK region), created only for this trial, running a minimal SIP UAS (Asterisk/FreeSWITCH or `sipp` scenarios).
  - It logs every INVITE header (`From`, `P-Asserted-Identity`, `Remote-Party-ID`, `Diversion`, `History-Info`, `Privacy`, `X-CALLINFO`) and answers per test case: `486` busy, `180`→`200` + 10 s tone → BYE, or answer and hold until the caller hangs up.
  - **It never originates, never redirects (no 3xx), never forwards and never REFERs.**
  - Firewall: SIP only from the documented Magrathea IPs (87.238.72.129/130, 87.238.73.129/130, 213.166.3.129/130) plus the RTP subnets from the handbook.
  - Auto-shutdown after 4 h.
  - Not connected to Twilio, Supabase, staging or production.
  - Approval A4.
- **Why not Twilio for the first test:** routing the DDI to a Twilio SIP domain would change Twilio configuration on the shared production account (staging shares it). That is out of scope here, and HCG monitoring integration is Phase 6.
- **Handsets:** Andrew's own phones only.
  - **H-T, the test handset:** a phone whose forwarding may be changed. It must **not** be the iPhone used for the Build 17 staging test while that test is pending, and **not** the Motorola while its forwarding points at its production HCG number (`**21*` masks conditional forwards and would send test calls into production).
  - Preferred: a spare SIM in any handset. Its MNO is recorded.
  - **H-C, the caller:** any other phone. Ideally a second MNO, plus one landline call and one withheld call.
- **Evidence:** `/Users/ad/hcg-magrathea-trial/` (mode 700):
  - SIP logs;
  - R-probe outputs before and after;
  - the REST `cdrs` before and after;
  - the next-day CSV;
  - MNO itemised bills for H-T and H-C;
  - `timeline.txt` in UTC.

### 6.2 Configuration changes required (each is a separate approval)

| Step | Change | Reversal |
|---|---|---|
| C1 | `POST /number/set/03300884327` index 1 → `S:443300884327@<E-SIP>`, after recording the original target from R6 | `set` back to the R6 value, or the state Magrathea specifies. Then read back with R6 |
| C2 | H-T conditional forwarding: CFB (`**67*03300884327#`) for most tests, CFU (`**21*…#`) only for T5b | `##67#` / `##21#`. Read back with `*#67#` / `*#21#` |
| C3 | E-SIP VM created / destroyed | Destroy the VM after the session |

There is no `order`, `feature`, ACR or PIN change, and no 999 record.

### 6.3 Call matrix (minimum: 9 calls, one attended session)

Each line is a PASS/FAIL checklist item run in the foreground, one physical instruction at a time.

| # | Test | Setup | Action | PASS criteria | Source of truth |
|---|---|---|---|---|---|
| T1 | **(1) Inbound DDI delivery** | C1 only, no forwarding | H-C dials `0330 088 4327` directly. E-SIP answers 200, plays tone 10 s, sends BYE | INVITE arrives at E-SIP with the request-URI user `443300884327`. Audio both ways. The call clears when E-SIP sends BYE | SIP log, REST `cdrs`, CSV |
| T2 | **(2) CLI preservation, direct** | same | (T1 call) | `From`/RPID = H-C's number in +E.164. PAI present or absent recorded. `privacy` = N | SIP log; CSV `anumber`, `PN` |
| T2w | (2) withheld caller | same | H-C dials with `141` | Privacy flag present. Presentation hidden. HCG would treat it as withheld (no display) | SIP log; CSV `privacy`=Y |
| T3a | **(3) Trusted native** | C2 = CFB on H-T | H-C calls H-T. **Andrew answers on H-T** (standing in for a trusted caller), talks 30 s, hangs up | H-T rings natively. **No INVITE at E-SIP. No Magrathea CDR** for that time window | SIP log empty, REST/CSV no row; H-C bill shows an ordinary call to H-T |
| T4 | **(4) Unknown → HCG** | C2 = CFB on H-T | H-C calls H-T. **Andrew declines on H-T** (standing in for the handset's screening reject) | The MNO diverts to the DDI. The INVITE arrives at E-SIP with `From` = H-C (the original caller, **not** H-T). E-SIP answers 200, tone, BYE | SIP log; CSV `anumber`; H-T bill shows the forwarded leg (and whether it is charged) |
| T8 | **(8) Forwarding proof** | (the T4 call) | — | `Diversion` (or `History-Info`) header present and = H-T's number with a `reason=user-busy`-style parameter, **and** CSV `LDLI` = H-T. Absent or wrong = FAIL for that MNO | SIP log; CSV `LDLI` |
| T5a | **(5) Loop prevention, busy reject** | C2 = CFB on H-T; E-SIP set to answer `486` | Repeat T4 | Exactly **one** INVITE at E-SIP. H-C hears busy or a failure tone. No second diversion, no ring-back loop. One CDR, `result` 486, `duration` 0, debit 0 | SIP log count, CSV |
| T5b | (5) Loop prevention, unconditional | C2 = CFU on H-T; E-SIP answers `486` | H-C calls H-T | Exactly one INVITE. No re-presentation. The CDR count is 1. **This proves no path back to the PSTN exists on a Basic Translation number** | SIP log, CSV |
| T6 | **(6) Per-leg charges + cessation** | C2 = CFB; E-SIP answers and **holds** | H-C calls H-T, Andrew declines, E-SIP answers. After 60 s, **H-C hangs up**. One more call: after 60 s **E-SIP sends BYE** | For both: CSV `inbound` = £0, `outbound` = £0, `debit` = £0, `cpstop − cpacc` ≈ E-SIP's measured talk time (±2 s). The CDR ends when either side clears. The balance (R3) is unchanged. H-T bill: the forwarded leg rated as the MNO prices a call to 03 (record it, do not assume it). H-C bill: the original call only | CSV, R3 before and after, MNO bills, invoice |

**Not called:** international, premium or 08 numbers, emergency numbers, or any outbound through 112168.

**T7** (enforced spend and destination limits) is a **read and CONFIRM** test, not a call test, until Magrathea answers Q9–Q12. See §7.

### 6.4 Per-MNO repetition

T4, T8 and T6 are the only results that depend on the MNO. Repeat them (three calls each) on each MNO that the first-five cohort uses, once T1–T6 pass on the first MNO. iPhone and Android behave the same here: the network does the diversion. The handset only matters for how "decline" maps to CFB.

E2 (iPhone "Silence Unknown Callers" → CFNRy/CFB) is the existing gating experiment from the trusted-bypass research. It can **share** this rig: the E-SIP plus DDI are a free, Twilio-independent landing target. It is listed as optional T3b and needs its own approval.

### 6.5 Stop rules (any one → stop, then E1-style reset)

- More than one INVITE per test call, or any INVITE that was not expected;
- any CDR with non-zero `inbound`, `outbound`, `debit` or surcharge that is not understood;
- the R3 balance changes;
- the H-T or H-C bill shows an unexpected charge (checked after the session);
- E-SIP receives traffic from a non-Magrathea IP;
- any Twilio, staging or production change is observed;
- the call does not clear within 5 s of BYE or hangup.

**Reset (mandatory, in order):**
1. H-T forwarding off (`##002#` then read back);
2. DDI target restored (C1 reversal plus R6 read-back);
3. E-SIP destroyed;
4. R3, R5 and R6 snapshots after the session;
5. the timeline closed out.

### 6.6 Expected cost of the whole live session

- Magrathea: £0 per DOC. To be verified, not assumed.
- VM: a few pence to pounds.
- H-C: about 9 ordinary calls.
- H-T: up to about 7 forwarded legs at whatever the MNO charges for forwarding to 03 (often inclusive; **not assumed**).
- No HCG/Twilio/OpenAI spend.

---

## 7. Test 7: enforced spend and destination limits

**Do not assume the prepaid balance is a hard spending cap.** The docs actively argue against it:
- The handbook says PSTN-fallback forwarding costs are "deducted from your prepaid account balance **at the end of the month**". Some charges are therefore post-paid against a prepaid balance (DOC).
- What happens to a call **in progress** when the balance reaches zero, and whether the balance can go negative, is undocumented (CONFIRM Q9).
- Schedule 3 §7.8: third-party charges (such as reverse-charge) are invoiced with a 25% handling charge, outside the balance (DOC).
- Chargeable translation minutes are "deducted in real-time", but real-time deduction is not the same as a hard stop (CONFIRM).

| Control | Exists? | Enforced how | Status |
|---|---|---|---|
| Inbound concurrency | Yes: 2 per trial number, 10 per standard number | Network | DOC. LIVE-verifiable only by a 3-call test, **not proposed** |
| Outbound destination class | Yes: `restriction` NONE / HIGH (≤3p) / MEDIUM (≤15p) | Per account, set by the client | DOC. Read with R4 |
| Outbound channels | 150 "notional" by default | — | DOC. Ask to reduce to 2 (Q10) |
| Surcharge limit per call type | CDR `result 402` = "rejected because the surcharge … higher than the limit set" | Network | DOC. What the limit is and who sets it: CONFIRM (Q11) |
| Daily or monthly spend cap or alert | **Not found** | — | CONFIRM (Q9) |
| PSTN targets on the number | Blocked unless Chargeable Translation is enabled | Account type | DOC. Confirm that the trial account is **not** enabled (Q4). This is HCG's loop and cost guard |
| HCG-side bound | Inbound-only on a Basic Translation number means **no HCG-originated paid leg exists** | Architecture | INFERRED. Proven by T5b plus T6 |

**PASS for test 7:** Magrathea confirms in writing that:
- the trial DDI cannot reach a PSTN target;
- 112168 has restriction HIGH (or outbound barred), with reduced channels;
- its behaviour at zero balance;
- no other charge can arise on inbound-only use.

Plus R3 and R4 read back. Until then test 7 = **NOT PROVEN**.

---

## 8. Supported by the API, needs confirmation, or needs a live test

| Need | API supports | Needs Magrathea confirmation | Needs a live test |
|---|---|---|---|
| (1) Inbound delivery | `number/set` to a SIP target; `status` read-back | Whether the trial DDI is active, its package and channels (Q1) | **T1** |
| (2) Original CLI | — (signalling, not API) | Network Mode enabled, and whether the Network Mode Agreement is signed for this account (Q3) | **T2, T2w, T4** |
| (3) Trusted native, no HCG paid leg | — (no per-call routing, no webhook; PSTN target = paid leg) | 302 handling (Q5), for completeness only | **T3a** (proves Magrathea never sees it); iPhone E2 optional |
| (4) Unknown → HCG monitoring | `set` to the HCG SIP endpoint | — | **T4** proves delivery to an HCG-controlled endpoint. Full monitoring needs Phase 6 |
| (5) Loop prevention | Indirect: a Basic Translation account cannot reach PSTN | Confirm that PSTN targets are disabled on the trial (Q4) | **T5a, T5b** |
| (6) Per-leg charges and cessation | `account/cdrs` (last few, `debit`), `balance` | CSV CDR access, and whether the trial has any fee (Q1, Q8) | **T6** plus the next-day CSV and the invoice |
| (7) Spend and destination limits | `gettariff` (read), `settariff` (write, not approved), `balance` | Zero-balance behaviour, caps, alerts, channel reduction, surcharge limit (Q9–Q12) | No call test proposed |
| (8) Forwarding proof for LF-2 | — (Diversion in SIP; `LDLI` in the CSV only) | That internal **non-displayed** use of the diverting identity to verify a customer's forwarding is permitted under §5.5 (Q7); per-MNO population | **T8** per MNO |

---

## 9. Test 8 in detail: can the carrier supply LF-2 forwarding proof?

**Hypothesis.** When a customer's phone *P* diverts to their HCG number on Magrathea, the INVITE's `Diversion` header and the CSV `LDLI` carry *P*. HCG could then record `forwarding_proven_at` **passively on the first real forwarded call** where the diverting identity equals the household's confirmed *P*. No outbound verification call or outbound account would be needed, unlike LF-2 option A.

**Why this is stronger than today:** Twilio's `ForwardedFrom` showed only the Twilio number on all 184 production calls checked.

**Conditions for this to count as proof (to be fixed in a later LF-2 design, not now):**
1. The diverting identity is present and equals *P* exactly (E.164).
2. It arrived on the household's **current** DDI.
3. It came from the network, not the caller. Magrathea receives `Diversion` from the interconnect. Whether it can be spoofed by a SIP-originated caller is **CONFIRM** (Q7b).
4. The proof is never shown to the customer as a number. It is a boolean only, so §5.3/§5.5 non-disclosure is respected (CONFIRM Q7).
5. If `Diversion` is absent for an MNO, that MNO falls back to option A or a support-led check.

**PASS for test 8:** T8 PASS on each cohort MNO, plus a written Q7 answer.
**FAIL on any MNO:** LF-2 stays open for that MNO. This is not a launch dependency.

---

## 10. Questions for Magrathea (send only with approval A3)

1. **Package:** Is `0330 088 4327` on the Product Trial (2 channels, no commercial use)? What is its current target and expiry? Is there any fee for the trial?
2. **Security:**
   - Please rotate the REST/NTS and SIP passwords we received.
   - Can 112168 be IP-authenticated (or dual-auth) only?
   - Is anything currently registered to it?
3. **Network Mode:** Is it active on this account, and is a signed Network Mode Agreement on file?
4. **PSTN targets:** Is chargeable translation **disabled** on this account? Can you guarantee that a mis-set PSTN target cannot connect?
5. **SIP 3xx:** If our endpoint replies 302, do you follow it, and how is it billed? *(For completeness. We do not intend to use it.)*
6. **Registered UA target:** Can a number's target be a UA registered on `sipgw.magrathea.net` rather than a public SIP URI?
7. **Diversion identity:**
   - (a) May we use the `Diversion` / LDLI identity internally (never displayed) to confirm that a customer's own phone forwarded to our number?
   - (b) Can that header ever be set by a VoIP-originated caller rather than the network?
   - (c) Do Vodafone, EE, O2 and Three populate it on CFU, CFB and CFNRy to an 03 number?
   - (d) Is `History-Info` ever sent?
8. **CDRs:** How do we get the daily CSV (MAGIC/FTP)? Is GPG encryption available? How many calls does `account/cdrs` return?
9. **Spend:**
   - Is the prepaid balance a hard stop? What happens to in-progress calls at zero, and can the balance go negative?
   - Are any charges post-paid?
   - Is a daily or monthly cap or a low-balance alert available?
10. **Channels:** Can outbound channels on 112168 be reduced to 2 and international or premium destinations barred?
11. **Surcharges:** What is the "surcharge limit" behind CDR result 402? Who sets it, and can inbound calls ever carry a surcharge to us?
12. **Inbound cost:** Please confirm that inbound to the trial DDI over SIP is £0, including mobile-originated and diverted calls.
13. *(Carry-over from 2026-10-03 research.)* What is the scope and timing of your mobile product, and do you support 07 port-in?

---

## 11. Phases and approvals

| Phase | What | Approval |
|---|---|---|
| 0 | This plan plus the read-only probe script (prepared, not run) | **Done** |
| 1 | Andrew: rotate the passwords (via Magrathea) and enter the secrets in Keychain (§2.2) | **A1**: Andrew's own action |
| 2 | Read-only probes R1–R7 (once each), optional R2-tier `listsipip` | **A2** |
| 3 | Send the §10 questions to Magrathea | **A3** (outward contact) |
| 4 | Create E-SIP VM (C3); `number/set` DDI → E-SIP (C1) | **A4**: provider configuration change plus new infrastructure |
| 5a | Attended session T1, T2, T2w (no forwarding change) | **A5a**: live calls |
| 5b | H-T conditional forwarding (C2) plus T3a, T4, T8, T5a, T5b, T6 | **A5b**: forwarding change plus live calls; not the Build 17 iPhone or the production Motorola |
| 5c | Per-MNO repetition of T4, T8, T6; optional E2 (iPhone Silence) | **A5c** |
| 6 | Unknown callers into **real** HCG monitoring. Options: Twilio BYOC/SIP domain on an **isolated subaccount**, or self-hosted media. Each needs its own design, because it touches Twilio or the core voice path | Separate plan |
| — | Anything involving 112168 outbound, LF-2 option A through Magrathea, PSTN targets, number purchases, transfers or `settariff` | Separate, specific approval each |

---

## 12. Sources (all fetched 2026-10-08 unless stated)

- REST API User Guide v1.2.9, 26 Apr 2023: `https://www.magrathea-telecom.co.uk/wp-content/uploads/RESTAPI-User-Guide.pdf`
- REST resource docs v1.2.9: `https://restapi.magrathea.net:8443/docs/` (public, no credentials used)
- NTSAPI instructions (Aug 2024): `https://www.magrathea-telecom.co.uk/wp-content/uploads/Numbering-API-Instructions-Aug-2024-1.pdf`
- Client Handbook v1.5 (7 Oct 2025): `https://www.magrathea-telecom.co.uk/wp-content/uploads/CLIENT-HANDBOOK_2025.1.pdf`
- CDR file definition (25 Aug 2021): `https://www.magrathea-telecom.co.uk/wp-content/uploads/New-CDR-Information.pdf`
- Schedule 3 Inbound Geographic Number Service v2026.6: `https://www.magrathea-telecom.co.uk/wp-content/uploads/Schedule-3-Inbound-Geographic-Number-Service-v2026.6.pdf`
- Schedule 3 Annex price list v6.0: `https://www.magrathea-telecom.co.uk/wp-content/uploads/Annex-Schedule-3-UK-Geo-price-list-v6.0.pdf`
- Prior desk research: `research/carrier-routing-v2/sources/magrathea_number_hosting.md` (branch `research/carrier-routing-v2`, 2026-10-03)
- LF-2 option A: `docs/launch/2026-10-06-LF2-VERIFICATION-CALL-DESIGN.md`
