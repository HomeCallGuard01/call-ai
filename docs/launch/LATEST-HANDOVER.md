# LATEST HANDOVER (updated 2026-10-06, ~19:35 UTC)

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
- No Magrathea work until the trial number arrives.
- Never weaken Fortress or raise budgets.
- Never run the Supabase CLI in `/Users/ad/call-ai` (production-linked).
