# LATEST HANDOVER (updated 2026-10-08: Magrathea trial prepared; Build 17 state below unchanged since 2026-10-06 ~19:35 UTC)

## 0. NEW 2026-10-08: Magrathea trial, first live call PASSED

**Plan:** [`../carriers/MAGRATHEA-TRIAL-PLAN.md`](../carriers/MAGRATHEA-TRIAL-PLAN.md)
**Branch:** `research/magrathea-trial-poc`. Worktree: `/Users/ad/call-ai-magrathea-trial`. Base: `ad545a1`.

**What Magrathea provisioned:**
- trial DDI `0330 088 4327`;
- REST/NTS API access;
- outbound SIP account `112168` @ `sipgw.magrathea.net`.

**Done:**
- read the official REST guide v1.2.9, the live resource docs, the NTSAPI guide, Handbook v1.5, the CDR definition and Schedule 3 plus its annex;
- wrote the plan;
- prepared a **dry-run-default** read-only probe, `scripts/carriers/magrathea-readonly-probe.sh` (7 allowlisted GETs; Keychain credentials; output outside the repo).

**L2 DONE: E-SIP test server LIVE since 2026-10-08 16:07 UTC (approved by Andrew, £5 ceiling):**
- **Resources:** DigitalOcean `lon1`, `s-1vcpu-512mb-10gb` (512 MiB), Ubuntu 24.04, droplet `607324203`, public IP **`159.65.27.229`**.
  - Billed per second at $0.00595/h; capped at $4/month ($4.80 incl. VAT ≈ £3.60–3.85 worst case).
  - Plus firewall `a76c14a2-…`, SSH key `59937436` and tag `hcg-magrathea-trial` (all free). Nothing else was created.
- **SIP destination for Magrathea:** `S:443300884327@159.65.27.229`, UDP 5060. RTP on UDP 40000–40019.
- **Firewalls:**
  - Cloud firewall plus host ufw: inbound SIP/RTP from the Magrathea handbook's 6 IPs and 6 /26 subnets only; SSH from Andrew's IP only.
  - Outbound: UDP to Magrathea plus DNS/NTP only. No outbound TCP, verified blocked to Twilio, Supabase and OpenAI.
- **Endpoint:** `sip-lab` from `416051e` (tests on the VM: 14/14 and 16/16).
  - `esip.service` runs as unprivileged `esip` in `answer_hold` mode, with a 120 s call cap; **test window extended to 2026-10-09 12:00 UTC (13:00 BST)**: `esip-stop.timer` stops the endpoint and capture then; an `ExecStartPre` guard refuses any start after it; services are enabled so they survive a reboot. The VM and evidence are **not** deleted automatically.
  - `esip-pcap.service` captures SIP and RTP only.
  - Evidence is kept private on the VM (`/home/esip/evidence`, `/var/lib/esip-pcap`, mode 700).
- **Not done from this session:** no Magrathea routing change (the target was set outside this session by 16:25 UTC), no SIP registration. The first call is recorded below.
- **Teardown:** `/Users/ad/hcg-magrathea-trial/teardown-do.sh` (outside git). It copies the evidence, deletes the droplet, firewall, key and tag, and verifies each is gone. Afterwards, revoke the DO token and delete the Keychain item.

**FIRST LIVE CALL PASSED, 2026-10-08 18:01 UTC (19:01 BST):** [`../carriers/MAGRATHEA-LIVE-CALL-EVIDENCE.md`](../carriers/MAGRATHEA-LIVE-CALL-EVIDENCE.md)
- Andrew direct-dialled `0330 088 4327` from his iPhone. INVITE from Magrathea `87.238.73.129` → 180 → 200 after 2 s → ACK → caller BYE at 18:01:39 → 200. One INVITE, clean teardown. `cdr=6AC7DA6BAF3B522D`.
- Two-way G.711 A-law audio (1,044 sent / 1,026 received RTP at 50/s; media from `213.166.4.133`, so the subnet allowlist was needed). A 20.5 s WAV was recorded. The beep was sent exactly 0.4 s every 2.00 s; Andrew perceived about 1 s (handset/network side, unresolved).
- **Identity:** CLI in `From`/RPID only, **no PAI**, so the call is `presentation_only` and not trust-grade. Asked of Magrathea (M-Q3/M-Q7).
- **Earlier unexplained call** at 16:25:59 UTC from another number, 5 s, two-way audio (`cdr=6AC7C417GF374B24`). Possibly Magrathea's post-change test; to confirm.
- **Evidence:** on the VM, plus a SHA-256-verified sealed copy at `/Users/ad/hcg-magrathea-trial/evidence-live-20261008/` (mode 700). **Not in git.**
- **TEST 2 PASSED, 18:16:35 UTC (19:16 BST):** after 10.12 s, **our server sent the BYE**; Magrathea replied `200 OK` (`CSeq 1 BYE`) in 5 ms; media stopped at the BYE; the VM sent nothing else (`cdr=6AC7DE025F3BB2F9`). Temporary `answer_bye` drop-in removed; `answer_hold` restored at 18:18:23 UTC.
- **SAFETY-1 OPEN (fix before wider testing):** the BYE is sent once with no retransmission, and the 120 s backstop does nothing after any BYE, so a lost BYE or 200 OK leaves the carrier leg up. Also SAFETY-2 (re-INVITE gets 405) and PRIV-1 (BYE R-URI logged unmasked). Evidence doc §11.
- **TEST 3 PASSED, 18:21:25 UTC (19:21 BST), withheld via the iPhone setting:** `From: anonymous`; **no RPID, PAI or Privacy**; Andrew's number was in no header or SDP; classifier `withheld: true`, `grade: absent`; caller BYE, clean (`cdr=6AC7DF255F3BD120`). HCG can detect "no CLI" but cannot yet tell withheld from unavailable (M-Q3). **No call today carried PAI.** Evidence doc §12.
- **Billing proof PENDING (M-Q2 CDRs).** Draft for Jay and the next-test review are in the evidence doc §8–§9. Not sent; nothing further approved.

**First live call runbook (2026-10-08; EXECUTED, see above):** [`../carriers/MAGRATHEA-FIRST-LIVE-CALL.md`](../carriers/MAGRATHEA-FIRST-LIVE-CALL.md)
- UK VM + firewall (Magrathea 6 IPs + 6 /26 subnets).
- Magrathea support sets target 1 → `S:443300884327@VM_IP`, because our `/number/*` access still returns 401.
- One direct-dial call with beep + WAV two-way audio proof; rollback.
- Approvals **L1** email, **L2** VM, **L3** routing change, **L4** call.
- E-SIP now has a subnet allowlist, PCMA/PCMU negotiation, beep out / WAV in, and a 120 s per-call cap (16/16 loopback, 14/14 identity tests; RTP only to allowlisted addresses).

**SIP trial prepared (2026-10-08, local tooling only, nothing deployed):** [`../carriers/MAGRATHEA-SIP-TRIAL-PLAN.md`](../carriers/MAGRATHEA-SIP-TRIAL-PLAN.md)
- Header-trust model, handset-decided trusted routing, REFER/3xx/transfer all PENDING-M (undocumented by Magrathea).
- Billing-cessation method, tests T9–T12/T5c/TX1, provider comparison against £5.99, approvals A3–A5-TX, questions M-Q1–M-Q11.
- Tooling in `scripts/carriers/sip-lab/`: identity classifier (13/13 offline tests) and answer-only E-SIP capture endpoint (10/10 loopback tests).
- Nothing deployed, registered or called.

**Magrathea clarification (2026-10-08, after run 4). Analysis is in plan §2.4 and §3.5; no further requests were made:**
- **The inbound account is `WHBILL1172`.** `112168` is outbound only, which explains R2's 401.
- **Trial REST access is limited to managing the trial number.** Account endpoints (balance, tariff, CDRs) and **encrypted FTP CDRs are full-account only**. So R2–R5 are out of trial scope; do not run them against `WHBILL1172` without Magrathea saying they are in scope.
- **R6 401 cause:**
  - The endpoint and number format match the docs (ruled out).
  - The request is the same one that got 200 on R1 (very unlikely to be the cause).
  - The Tomcat HTML 401 (not the documented JSON 401) means a container-level check on `/number/*` refused the login. Magrathea needs to enable or confirm number access for this login, or confirm there was no lockout.
- **Consequences:**
  - money questions on the trial (balance, restriction, per-leg charges) come from the MAGIC portal (`CPORTAL = 1`), Magrathea's written answers and handset bills, not the API;
  - LF-2 trial evidence = the SIP `Diversion` header only, because `LDLI` needs FTP CDRs.
- **Proposed next step:** Magrathea confirms `/number/status` access for this login on `03300884327`, then **one** approved run of `--only=R6,R7`.

**Not done (earlier entries; five read-only GETs have since been made under A2, see below):** zero API calls, calls, purchases, forwarding changes, transfers, SIP registration, rotation or provider configuration. Credentials have never been seen and are not stored anywhere in the repo. The Build 17 test, Twilio, production, pricing and customer records were not touched.

**Key findings:**
- **The HTTP method is not a safety signal:**
  - `account/transfer` moves money and is a **GET**;
  - `number/feature` reads or writes through one PUT.
  - So probes use an exact-path allowlist.
- **No per-call routing, webhook or spend-cap API.**
  - Prepaid is **not** a proven hard cap. The handbook says some forwarding costs are deducted "at the end of the month".
- **Trusted £0 can only be decided before diversion,** at the handset with CFB/CFNRy. A Magrathea PSTN forward is a paid leg and loops under CFU.
- **Inbound to the DDI, delivered over SIP, is £0 according to the docs.** The live test must verify this.
- **The outbound account `112168` is NOT needed** for the first live tests. It matters only for LF-2 option A placed through Magrathea.
- **LF-2 carrier route:** Network Mode `Diversion` header plus the CSV `LDLI` field could give **passive** forwarding proof on each MNO. This needs Magrathea's written OK (network numbers must never reach end users) and a live T8 test on each MNO.
- **Trial terms:** no commercial use, 2 channels. Use **Andrew's devices only.** Do not use the Build 17 iPhone or the production Motorola as the forwarding test handset.

**A2 run 4 (2026-10-08 14:12 UTC), R6 and R7 only (approved): R6 refused.**
- **R6 `number/status/03300884327` returned HTTP 401**, a generic Tomcat page, not Magrathea's JSON error. The script stopped; **R7 was not sent.** One request.
- **Likely cause (inference):** the REST user lacks the number permission. This is separate from the account-scope problem on R2.
- **No number status, routing, restriction or expiry data was obtained.**
- The probe now has `--only=` (it can only narrow the allowlist) and stops on any non-200 response. This script change is uncommitted.
- **Next:** ask Magrathea for the REST account ID, the read-only permissions for number and account resources, and the DDI's current routing and expiry (plan §2.3, run 4). Then a fresh approval for any re-run.

**A2 run 3 (2026-10-08 14:03 UTC), after Magrathea reset the password: PARTIAL.**
- **R1 `account/services` returned HTTP 200, so authentication works.** `CPORTAL = 1`; the `NTSAPIUSER` field is redacted.
- **R2 `account/detail/112168` returned HTTP 401** "Wrong username, password or account". The script stopped; R3–R7 were not sent. Two requests in total.
- **Likely cause (inference):** `112168` is the SIP account ID, not the account the REST login is scoped to.
- **Next:**
  - ask Magrathea for the correct REST account ID, and do not guess it;
  - then a fresh approval to run R2–R7.
  - R6/R7 (number status, block info) don't use the account ID and could run alone with approval.
- Still unknown: account status, number status, balance, tariff and CDRs. Plan §2.3.

**A2 status after the retry (2026-10-08 12:56 UTC): still BLOCKED on authentication. Two requests in total, both R1, both HTTP 401.**
- Andrew corrected the username; it was verified at 7 characters without being displayed.
- The approved single retry returned the same "Wrong username, password or account". R2–R7 were not sent.
- A local fake-credential test proved that the script sends Basic auth correctly, so the cause is the credentials or the account's REST enablement.
- **Do not retry** until Magrathea confirms which REST login, permissions and IP rules apply (plan §2.3).
- Still unknown: account status, number status, balance, tariff and CDRs.

**First attempt (2026-10-08 12:48 UTC): BLOCKED on authentication.**
- Andrew approved A2 and said rotation should not delay the trial; rotation is follow-up **F-1**.
- R1 returned **HTTP 401** "Wrong username, password or account". The script stopped, so R2–R7 were not sent (one request in total, no retry).
- **No account, number, balance, tariff or CDR data was obtained.**
- The stored username is 69 characters long, so a mis-paste is likely. Andrew needs to check it locally and re-enter it, or confirm with Magrathea which REST credentials and permissions apply.
- Details are in plan §2.3.

**Approvals needed, in order:**
- **A1:** done. Credentials are in Keychain (`hcg-magrathea-rest-user`, `hcg-magrathea-rest`); rotation deferred as F-1.
- **A2:** read-only probes. **Partial:** R1 passed (14:03 UTC). R2–R5 are out of trial scope (inbound account `WHBILL1172`; account endpoints are full-account only). R6 returned a Tomcat 401 (14:12 UTC), and Magrathea must enable or confirm `/number/*` access before one approved R6+R7 run (plan §2.4).
- **A3:** send the 13 questions to Magrathea.
- **A4:** E-SIP capture VM plus `number/set` of the DDI.
- **A5a/b/c:** live call sessions (plus the test handset's forwarding change).
- **Phase 6:** HCG monitoring integration, as a separate plan.

---

**The single "where are we" page.** Older detail:
- [`2026-10-05-LAUNCH-SPRINT-HANDOVER.md`](2026-10-05-LAUNCH-SPRINT-HANDOVER.md) (morning reports 1–3)
- [`2026-10-06-BUILD17-STAGING-DEVICE-TEST-PLAN.md`](2026-10-06-BUILD17-STAGING-DEVICE-TEST-PLAN.md) (the test plan)
- [`../releases/2026-10-04-STAGING-TEST-BUILDS-1.0.2.md`](../releases/2026-10-04-STAGING-TEST-BUILDS-1.0.2.md) (builds)

## 1. Environment state: SAFE FOR OVERNIGHT

| Item | State (verified at shutdown) |
|---|---|
| `…1883` | **Inert.** Voice, fallback, status callback, voice app and SMS all empty. Read back 19:29:51 UTC. It was pointed at staging 19:23:47–19:29:50 UTC for the aborted window. **No call or SMS touched it** (Twilio: 0 calls to/from, 0 SMS on 6 Oct) |
| Twilio account | 0 calls in progress or ringing |
| Staging server / tunnel / caffeinate / iPhone log capture | All stopped (PIDs verified before killing). Port 3099 free; tunnel 404 |
| Temporary login `hcg-staging-iphone@example.com` | **Deleted** (auth user + `user_roles`) |
| Window secrets (`window-2026-10-06.env`, temporary password) | **Deleted** |
| Staging household `ffc4cfe1` | Restored to its originals:<br>• unlinked, original email<br>• `phone_number` `…0456`<br>• `twilio_provisioning_status` `pending`<br>• 0 contacts<br>• `forwarding_proven_at` null |
| Staging Fortress | Invariants ok; 0 active reservations; 0 holds; kill switch off; breaker closed; policy v2 enforce; caps unchanged (£1/day, £0.50/h, 5 active, 0 number purchases); **£0 spent tonight** |
| Production | Identical to the 19:12 UTC snapshot (36 households, 38 entitlements, 15 subscriptions, 107 calls, 851 contacts; `…6063` → `homecallguard.co.uk/voice`). Only difference: `…1883`'s `date_updated` from tonight's point and reset; its config is identical (empty) |
| Migration 074 | **Applied to STAGING only** (dry run = exactly 074; applied; verified). **Production: NOT applied** (column absent, checked read-only). Not rolled back, as Andrew decided |

## 2. What happened tonight (6 Oct)

1. Carrier decision: **Magrathea** is the preferred trial carrier. We are waiting for their trial number.
   - The launch does **not** depend on it.
   - AL-2 (production allowance budget) stays undecided.
   - No savings are assumed.
2. Build 17 was uploaded via EAS Submit `920f523d`, which FINISHED 07:36 UTC. Andrew confirmed it was **installed from TestFlight** on his iPhone.
3. Preflight, all done, with evidence:
   - read-only source check: the protection gate reads the household with `select('*')` (`database/lifecycleSnapshot.js:56`), so `forwarding_proven_at` is visible;
   - production snapshot;
   - `…1883` read-back (inert);
   - 074 dry run, apply and verify on staging: 31 households, 0 with proof; invariants ok; schema markers 17/17; pglite 074 checks pass.
4. Window setup S4–S8: server, tunnel, temporary login and fixtures, then `…1883` pointed.
5. **Build/staging confirmation (indirect).** On sign-in, the app registered with the **staging** server and reported `app_version 1.0.2`, `app_build_version 17`, `ios` (19:19:49 UTC).
   - This Mac has no tool to read the installed version straight off the phone (no `ideviceinstaller`/`devicectl`).
   - **Andrew wants a positive on-device confirmation tomorrow.** Options: TestFlight "Installed 1.0.2 (17)" screenshot, or the in-app version in Account/Help.
6. **LF-2 pre-call negative state, observed (L1).** Before any call, with the old evidence still present (1 Oct direct-dial `activation_verified_at`, 5 Oct delivery):
   - The API returns `activationStage: forwarding_unconfirmed`, `fullyProtected: false`, `protectionBlockers: [forwardingVerifiedForCurrentNumber]`, `forwarding_proven_at: null`.
   - Step list: "Call forwarding confirmed" ✗, "Protection Active" ✗.
   - The guidance gives the truthful "calls are reaching… haven't been able to confirm…" message.
   - **Andrew: the app was not showing Protected.**
   - This is the exact household that wrongly showed Protected on 5 Oct.
7. **No test call was made tonight. Andrew has NOT enabled or changed call forwarding.** Andrew stopped for the night before D1. Safe shutdown was done as in §1.

Side observations:
- The meter's API: `source: fortress`, `basis: protection_spend`, `includedMinutes: null`, **12% used**. That matches £0.02478 of the £0.20 staging budget from the 5 Oct calls.
- `check-launch-config` warns `allowance_display_matches_enforcement` because it runs before `server.js:1018` defaults `ALLOWANCE_SOURCE=fortress`. This is a false warning at runtime (minor; set the variable explicitly in production).
- `protection.lastConfirmedProtectedAt` still carries 5 Oct, but the app shows it only when Protected (`index.tsx:550`). Harmless.

Evidence is private, outside the repo: `/Users/ad/hcg-staging-window-2026-10-06/`:
- `S1`, `074-*`, `S7-household-originals.json`;
- `L1-dashboard.json` and `pre-L2-dashboard.json`;
- `S8`, `E1`, `E3`, `E4`, `E7`, `E8`;
- `server.log`, `ngrok.log`, `iphone-syslog.log`, `timeline.txt`.

## 3. Tomorrow evening: exact starting point

**Done; do not repeat:** source check, 074 on staging, the Build 17 install, the L1 server-side result.
**Repeat as setup only:** S1 snapshot, S2 `…1883` read-back, S3 invariants, S4–S7 (new window env + new temporary login + fixtures), then the new S1 baseline.

Order of the controlled attended session (one physical instruction at a time; minimum calls):

1. **Positive Build 17 / staging confirmation:** an on-device version check by Andrew, plus the registration again (`app_build_version 17` on staging). Only then S8 (point `…1883`).
2. **L1 recheck** (look only, no call): not Protected, truthful wording.
3. **L2 + D1 in ONE call:** Motorola → `…1883` with HCG in the foreground.
   - D1: answer, "Call in progress" screen, Mute (the Motorola can't hear) → unmute, Speaker on → off, **End on the iPhone**.
   - L2 afterwards: still **not Protected**; `forwarding_proven_at` null; one reservation committed and released.
4. **D2:** HCG in the background → answer on the banner → HCG call screen → End.
5. **D3:** locked → native iOS call UI → answer → unlock → HCG state correct → end.
6. **D4 + D5:** the caller hangs up while the iPhone is muted and on speaker → the screen dismisses by itself. Then the next call starts unmuted with speaker off (D5 can share the D3 or T20/T21 call).
7. **DT-2 (A1):** label "Protection allowance this month", no minutes, % equals the Fortress spend; no duplicate metering. **Staging budget not altered.**
8. **L4** (staging fixture, audited): set `forwarding_proven_at` → Protected; clear it → back to `forwarding_unconfirmed`. **This proves app logic only, not real forwarding detection.**
9. **Remaining launch-critical items, only if unproven:**
   - T11 monitored unknown caller;
   - T13 warning (no SMS);
   - T14 red line (plus the call screen auto-dismiss);
   - T16 activity;
   - T17 hold / D-C5;
   - T18 kill switch;
   - **T19 staging admin login (approved)**;
   - T20 sign-out → unbilled reject;
   - T21 reconnect;
   - T22 backend down;
   - T23 budget cap (last).
   - **Skip T12 (real forwarding) and T15b (real SMS):** not approved.
10. **Mandatory reset:** E1 `…1883` inert **first**, then L4 fixture cleared, fixtures restored, login and secrets deleted, Fortress clean, processes stopped, production compared, Twilio reconciled against the Fortress ledger, report committed.

Stop rules (unchanged):
- a reservation not released;
- duplicate metering;
- unexpected repeated calls;
- Fortress inconsistent;
- any production change;
- `…1883` unexpected;
- spend near the ceiling.

On any of these → `…1883` inert immediately.

## 4. Open decision (separate from tomorrow's test)

**How and when do we prove the genuine real-world call-forwarding customer flow?**
- L4 only proves that the app turns Protected when proof exists. Nothing in the product can create genuine proof yet.
- Options:
  - **A:** the verification-call design (`2026-10-06-LF2-VERIFICATION-CALL-DESIGN.md`). It needs a dedicated number, a narrow outbound exception, and a per-carrier caller-ID check with real forwarding (T12-style, attended).
  - **Carrier-side diversion state:** a possible Magrathea/AQL route, once the trial exists.
  - **Support-led manual check** for the first 5.
- **Until one is proven, no customer can be shown Protected.**

## 5. First-5 blockers (unchanged tonight)

- Runbook M1–M14.
- **LF-2 real-world forwarding proof** (§4).
- **DT-1 proven on Build 17** (tomorrow).
- AL-2 production profile (C12): undecided; Magrathea is not assumed.
- AL-3 wording and terms sign-off.
- AL-4 Apple Small Business Program.
- Production deploy plus migrations 047→074.
- Provider containment C7/C8 (RED).
- Live £5.99 cutover.
- L-1 channel decision.
- Support/refund rule.
- Notifications on.

## 6. Never (standing)

- No production changes, deploy or migrations.
- No live pricing changes.
- No store submission or review; no TestFlight purchases.
- No real forwarding change or real SMS without explicit approval.
- Never release `…1883`.
- Magrathea: plan and prepare only (§0). No API call, live call, configuration change or credential handling without the listed approvals. Never put Magrathea credentials in chat, the repo or handovers.
- Never weaken Fortress or raise budgets.
- Never run the Supabase CLI in `/Users/ad/call-ai` (production-linked).
