# Build 17 staging device test plan (prepared 2026-10-06)

**Status: PLAN ONLY. Not started.**
- No telephony change, no …1883 change, no migration applied, no fixture written.
- The test is independent of the Magrathea trial. It uses the existing architecture and the existing Fortress limits.

**Base:**
- [`2026-10-05-STAGING-DEVICE-TEST-PLAN.md`](2026-10-05-STAGING-DEVICE-TEST-PLAN.md): §0 limits, §2 START S1–S9, §4 END E1–E9, abort rules A1–A5, Appendix A scripts. Everything there still applies; only the differences are listed here.
- Results from the 5 Oct window: [`2026-10-05-DEVICE-TEST-EVIDENCE.md`](2026-10-05-DEVICE-TEST-EVIDENCE.md).

**Roles (unchanged):**
- Subscriber: Andrew's iPhone `…2700`, running **Build 17**.
- Caller: the Motorola `…3030`, which makes outgoing calls only.
- Staging number: `…1883`.

---

## 0. Pre-window facts (checked read-only 2026-10-06)

| Item | State | Source |
|---|---|---|
| Build 17 upload | EAS build `eeccee2e…` (from `ee3fab1`) FINISHED. EAS Submit `920f523d…` FINISHED 07:36 UTC, no error | EAS API, read-only |
| Build 17 **in TestFlight** | **Not verifiable from the Mac** (no App Store Connect access). Andrew confirms in the TestFlight app that **1.0.2 (17)** is listed and installable. Once the phone is cabled, Claude confirms the installed version on the device | Andrew (P1) |
| Staging schema | 073 applied; **074 not applied** (`households.forwarding_proven_at` absent) | staging read |
| Household `ffc4cfe1` | Fixtures restored after 5 Oct:<br>• `auth_user_id` null<br>• `phone_number` `…0456`<br>• `twilio_provisioning_status` `pending`<br>• 0 contacts<br>• account `HCG-00010306`<br>• entitlement `935e230e` active (complimentary) | staging read |
| Old evidence still on the household | • `activation_verified_at` 2026-10-01 (direct dial)<br>• `voice_client_registered_at` and `delivery_verified_at` 2026-10-05 (Build 16)<br>This is **exactly the evidence that produced the false "Protected" on 5 Oct**, so it is the right fixture for LF-2 | staging read |
| Fortress (staging) | • Invariants ok, 0 active reservations<br>• Kill switch off, breaker closed, policy v2, enforce<br>• Caps: £1/day, £0.50/h, 5 active, 0 number purchases<br>• Rolling 24 h committed £0.02478 (the 5 Oct calls) | `fc_check_invariants`, `fc_global_status` |
| `…1883` Voice URL | **Not re-read today.** The read uses the production Twilio account, so it is done at S2, inside the approved window. It was empty at the 5 Oct E1 read-back | E1 (5 Oct) |
| Supabase CLI link | Worktree `/Users/ad/call-ai-soft-launch-candidate` → staging `tigwgmayeuisrxjjykqd`. **Never** run the CLI from `/Users/ad/call-ai` (production) | `supabase/.temp/project-ref` |

---

## 1. Migration 074 on staging: exact requirement

**074 is not needed for the main LF-2 proof.** The application treats a missing column as "not proven", and the staging household carries the 5 Oct evidence. So without 074 the household **must** show `forwarding_unconfirmed` and never Protected (L1–L3 below).

**074 is needed only for the positive control (L4):** proof that the gate can still turn green, so "never Protected" is not just a broken screen.

**Recommendation:** apply 074 to staging and run L4. The migration is additive and nullable and has a rollback.

| Step | Detail |
|---|---|
| Approval | A separate "yes 074 staging" from Andrew. Not covered by GO |
| Where | `/Users/ad/call-ai-soft-launch-candidate` only. Linked-ref check: refuse if the link is `psbzynxplxfbyrbdidmn` |
| Dry run | `supabase db push --linked --dry-run` must list **exactly** `074_households_forwarding_proof.sql` and nothing else. Anything else → STOP |
| Apply | the same command without `--dry-run` (one migration). The file is idempotent |
| Verify | • Both columns exist and are null for every staging household<br>• Constraint `households_forwarding_proof_method_check` exists<br>• Comments set<br>• `fc_check_invariants()` ok<br>• `verify-staging-schema.js` passes |
| Rehearsal (local, before the window) | Run the pglite test (8 checks) and `tests/lf2-forwarding-proof.test.mjs` (19). **Open item:** confirm that the dashboard/bootstrap household read returns `forwarding_proven_at` once the column exists (`select *` versus an explicit column list). Otherwise L4 would stay red for the wrong reason. A local source search for this was blocked by the session permission check on 6 Oct, so it needs Andrew's OK. If it is not resolved before the window, an L4 failure is inconclusive, not a product failure |
| Rollback | `_rollbacks/074_rollback_households_forwarding_proof.sql` refuses while any proof is recorded. E3b clears the L4 fixture, so the rollback stays available. The column itself may stay on staging |
| Production | **Untouched.** 074 joins the 047→074 production set (blocker list) |

---

## 2. Setup sequence for `…1883` (inside the window only)

The same rules as 5 Oct, in this exact order:

1. S1: production baseline (read-only fingerprint; production `…6063` Voice URL read-back).
2. S2: `…1883` Voice URL **read-back = empty**. If it is not empty → STOP; do not continue.
3. S3: staging invariants and caps as §0. Kill switch off, breaker closed.
4. S4/S5: window env (mode 600, outside the repo) → staging server on port 3099 → `check-launch-config` START. It refuses on production Supabase, a live Stripe key or real provisioning.
5. S6: tunnel + caffeinate; PIDs recorded. `/health` 200; unsigned `/voice` → 403.
6. S7: temporary login `hcg-staging-iphone@example.com` linked to `ffc4cfe1`. Originals recorded first, then:
   - trusted contact = Motorola `…3030` (never `…2700`);
   - `phone_number` → null (no warning SMS possible);
   - `twilio_provisioning_status` → `active`.
7. S8: **only now** point `…1883` → `https://ferret-augmented-distrust.ngrok-free.dev/voice` (POST), then read it back. Window LIVE; time recorded.
8. S9: captures:
   - `idevicesyslog` → private evidence folder `/Users/ad/hcg-staging-window-2026-10-0X/`;
   - server log;
   - Fortress snapshot every 10 minutes.

**Only Claude changes `…1883`, and only between S8 and E1.** It is never released, re-purposed, or set to a fallback or status callback.

---

## 3. Test sequence (Build 17)

Legend: 📱 Andrew on the iPhone · ☎️ Andrew calls from the Motorola · 💻 Claude.

### P: preparation (Andrew, before GO)

| # | Step | Andrew replies |
|---|---|---|
| P1 | TestFlight app → Home Call Guard → **1.0.2 (17)** is listed → Install/Update. Don't open it yet | "17 installed" |
| P2 | Cable the iPhone to the Mac, unlock it, Trust if asked. 💻 confirms the installed version is 1.0.2 (17) | – |

### L: LF-2 (no Protected without genuine forwarding proof)

| # | Step | Who | Andrew replies | Claude verifies |
|---|---|---|---|---|
| L1 | Sign in (T2). Look at Home **before any call** | 📱 | headline + the sentence under it | • API: `activationStage = forwarding_unconfirmed`, `fullyProtected = false`, `forwardingVerified = false`<br>• Home: "can't yet confirm your phone's call forwarding", button **"Check call forwarding"**, setup step "Call forwarding on" **not** ticked<br>• **Never** the green Protected hero (on 5 Oct this exact household showed Protected) |
| L2 | After D1 (a delivered trusted call), look at Home again | 📱 | headline | Still `forwarding_unconfirmed`. A delivered call must not make it Protected (the 5 Oct failure) |
| L3 | Tap **"Check call forwarding"**: look only. **Do not dial any code, do not change forwarding** | 📱 | what it shows | Guidance opens; nothing is sent; no call is placed. Admin/ops: `FORWARDING_NOT_PROVEN` / `forwarding_not_proven`, no `CUSTOMER_PROTECTED` event |
| L4 | *(only if 074 is applied; positive control)* 💻 sets `forwarding_proven_at = now()`, method `verification_call` on `ffc4cfe1`. This is a **labelled test fixture, not genuine proof**, audited as `claude:staging-window`. Andrew pulls to refresh. Then 💻 sets it back to null and Andrew refreshes again | 📱 | headline both times | First: Protected (all gates). After clearing: back to `forwarding_unconfirmed`. Proves the gate is wired end to end and that only `forwarding_proven_at` turns it green |

### D: DT-1 (in-app call screen)

Each call: Motorola → `…1883`, under 60 s.

| # | Step | Andrew replies | Claude verifies |
|---|---|---|---|
| D1 | **Foreground** (HCG open). Answer. The HCG screen shows **"Call in progress"**, the caller, a timer, **End call / Mute / Speaker**. Mute on → say a sentence (the Motorola should hear nothing) → Mute off. Speaker on → off. **End on the iPhone** | screen shown? Mute/Speaker worked? ended? | • One CallKit `CXEndCallAction`<br>• Twilio both legs completed<br>• Reservation released<br>• Screen gone<br>• No ghost call left in CallKit |
| D2 | **Background** (home screen; true T7). Answer on the banner. iOS opens HCG on the call screen. End from HCG | same | PushKit → CallKit → app foreground; the screen mounts on the active call |
| D3 | **Locked** (T8). Answer on the iOS full-screen call UI. End from **that** UI | full-screen UI? ended? | The native UI is used; the HCG model clears |
| D3b | Locked again. Answer, unlock, open HCG → End from the HCG screen | screen consistent? | One call only; CallKit and the app agree |
| D4 | **Caller hangs up**: answer on the iPhone, leave it **muted** and **on speaker**, then hang up **on the Motorola** | did the screen disappear by itself? | Screen gone within about 2 s; call completed |
| D5 | **Next-call reset**: straight after D4, a new call. Answer | muted? speaker? | Starts **unmuted, speaker off**, timer from 0:00 |

### A: DT-2 (allowance display)

| # | Step | Andrew replies | Claude verifies |
|---|---|---|---|
| A1 | Home/Membership meter after D1–D5 | the exact label and % | • Label **"Protection allowance this month"** plus the explanation<br>• No "minutes" figure, no "trusted calls don't use it"<br>• % matches the API `customerAllowance` (`basis: protection_spend`) and the Fortress household spend<br>• The meter moves on monitored calls (T11–T14) as the Fortress ledger moves |

### T9–T23 (unchanged from the 5 Oct plan except as noted)

| # | Step | Note for Build 17 |
|---|---|---|
| T9 | Protection state after calls | **Replaced by L1–L4** |
| T10 | 💻 removes the Motorola from trusted contacts | – |
| T11 | Unknown caller, monitored | Also re-check A1 |
| T12 | Call forwarding | **Recommend SKIP.** Option A isn't built, so forwarding would still show `forwarding_unconfirmed` (truthful), and Andrew's real calls would route through staging while it is on. Needs a separate "yes" in any case |
| T13 | Warning script | **No SMS** (`phone_number` null) |
| T14 | Red-line script | The call should end by itself. **Also check DT-1:** the HCG call screen dismisses by itself |
| T15b | Real warning SMS | Optional; separate "yes"; default SKIP |
| T16 | Activity list matches the call rows | – |
| T17 | Financial hold → D-C5 sentence + busy, no spend | – |
| T18 | Kill switch refuses → reset | Then confirm the breaker is closed |
| T19 | Admin login | Optional; separate "yes" |
| T20 | Sign out → caller gets an unbilled reject | – |
| T21 | Sign in again → trusted call rings again | Also check the D5 reset on this call |
| T22 | Tunnel stopped → "couldn't confirm your protection", never Protected | – |
| T23 | Household budget cap refuses (last; only if budget remains) | Limits **not** raised |

**Call count:** about 15 Motorola calls (D1–D5 = 6, T11, T13, T14, T17, T18, T20, T21, plus T23 repeats). **Expected spend:** £0.20–£0.45; ceiling £1/day (Fortress) and abort rule A3.

**Motorola section (§6 of the 5 Oct plan):** a separate decision. Android vc 22 does not contain the DT-1/LF-2 app changes, so it would need a new Android staging build first. Out of scope for this window.

---

## 4. Mandatory reset (even after an abort)

E1–E9 of the 5 Oct plan, in order, plus E3b:

| # | Action | Verified by |
|---|---|---|
| **E1** | **`…1883` Voice URL → empty first** (no fallback, no status callback) | Read-back empty |
| E2 | If T12 ran: Andrew confirms forwarding off (`*#21#` → not forwarded) | Andrew |
| E3 | Fortress: kill switch off, breaker closed, no hold on `ffc4cfe1`; `fc_check_invariants()` ok | SQL read-back |
| **E3b** | If 074 was applied: `forwarding_proven_at` / `forwarding_proof_method` **null** on `ffc4cfe1` (and every staging household) | SQL read-back |
| E4 | Delete the temporary login. Unlink `auth_user_id`. Restore originals:<br>• `phone_number` `…0456`<br>• `twilio_provisioning_status` `pending`<br>• 0 contacts<br>Call rows kept as evidence | SQL read-back |
| E5 | Stop server, ngrok, caffeinate (PIDs verified by command line and working directory before each kill) | Port 3099 free; tunnel 404 |
| E6 | Delete the window env file (real secrets) | File absent |
| E7 | Production fingerprint and `…6063` identical to S1 | Diff empty |
| E8 | Twilio usage on `…1883` (calls, **0 SMS** unless T15b) versus the Fortress ledger | Within 20%; under £1 |
| E9 | Evidence summary committed (phones masked) to `docs/launch/`; raw logs stay private | Commit SHA |

Build 17 stays installed on the iPhone. With staging offline it shows "couldn't confirm".

---

## 5. Andrew's approvals for the window (one message)

- **"GO Build 17 staging window"**, which covers the same four items as 5 Oct:
  1. window credentials (Twilio/OpenAI, including the iOS push credential), deleted at E6;
  2. Claude points `…1883` at staging and makes it inert again at E1;
  3. temporary login + fixture corrections, restored at E4;
  4. the iPhone cabled for logs.
- Separate yes/no for each of:
  - **074 on staging + L4 positive control** (recommended: yes);
  - T12 forwarding (recommended: no);
  - T15b SMS (recommended: no);
  - T19 admin login (optional).
