# Five-customer soft-launch gate (2026-10-04)

Binary: an item is **GREEN** only with recorded evidence (date, operator, SHA, artefact). Everything else is **RED**. Customer #1 may be accepted only when the Software, Staging and 5-customer gates are entirely GREEN, or an item is RED with a **written, signed Andrew acceptance** where that is explicitly allowed (marked ⚖).

Evidence lives in `docs/launch-gate/evidence/2026-10/` (create it during staging).

## Software gate (local)

| # | Item | Status | Evidence |
|---|---|---|---|
| S1 | Full suite green at the candidate HEAD | **GREEN** | 197/197 files, 8,716 ✓ (1a4fa71) + `alerting` re-run after the staging-label change |
| S2 | Mobile `tsc` clean | **GREEN** | 0 errors |
| S3 | Concurrency (real PostgreSQL: Fortress, accounting, number claim) | **GREEN** | `financial-containment-realpg`, `launch-fortress-realpg`, `accounting-posting-realpg`, `number-purchase-race-adversarial` |
| S4 | Active-call financial cutoff, latching breaker, kill switch, holds | **GREEN** (local) | Fortress suites, `provider-usage-alert-breaker.pglite` |
| S5 | Sandbox/reviewer/test cannot buy a real number; never "Paying" | **GREEN** (local) | `ops-events-commercial-classification` |
| S6 | Canonical protection status | **GREEN** (local) | `canonical-protection` |
| S7 | New-customer / needs-attention events, exactly once | **GREEN** (local) | `ops-events-commercial-classification` |
| S8 | Stripe deletion / replay paths | **GREEN** (local) | `stripe-deleted-household-webhook`, `entitlement-canonical` |
| S9 | Accounting capture isolation | **GREEN** (local) | `accounting-integration-safety` |
| S10 | Unsafe configuration refuses to start | **GREEN** (local) | `launch-config-safety` |

## Staging gate (candidate on staging Supabase + `…1883` + Motorola)

| # | Item | Status |
|---|---|---|
| G1 | Staging backup taken **and restore tested** | **GREEN** (2026-10-04: pg_dump backup; restore into throwaway PG matched 18/18 tables; STAGING-READINESS §7) |
| G2 | Migrations 052 → 072 applied; schema verifier 17/17; `fc_check_invariants` ok; grants ok | **GREEN** (2026-10-04; rehearsal + rollback rehearsal on a restored copy first; STAGING-READINESS §7) |
| G3 | `check-launch-config` → START with the staging configuration; unsigned `/voice` → 403 | RED |
| G4 | **Real handset inbound call delivery**: a call to `…1883` rings and is answered on the 1.0.2 staging APK | RED |
| G5 | **Trusted call**: …2700 → `…1883` bypasses monitoring, rings the app, `<Dial timeLimit>` present, one reservation | RED |
| G6 | **Monitored call**: an unknown caller hears the announcement, stream + transcription run | RED |
| G7 | **Warning path**: warning phrases → SMS warning sent (explicit authorisation) | RED |
| G8 | **Red-line termination** | RED |
| G9 | **Active-call financial cutoff**: budget exhausted mid-call → the call ends at lease renewal; a new unknown call is refused | RED |
| G10 | **Global breaker / kill switch**: latches, ends live calls, admin reset only | RED |
| G11 | **Per-household hold**: trusted, unknown, SMS and purchase are all refused while held | RED |
| G12 | **Concurrency**: ≥ 5 near-simultaneous calls to `…1883` stay within the household budget (as far as one test number allows) | RED |
| G13 | **Number-purchase lock** (066): a double provisioning attempt → one claim; the fake purchase is held when the claim is unavailable | RED |
| G14 | **Sandbox/reviewer cannot buy a real number**: a staging grant with `revenuecat_environment='sandbox'` → provenance refusal; the admin label is not "Paying" | RED |
| G15 | **Genuine-customer classification**: a Stripe *test-mode* staging purchase is classified correctly (the classifier honours `stripe_livemode=false` where it's recorded) | RED |
| G16 | **New-customer alert**: one `NEW_GENUINE_CUSTOMER` event for a genuine-classified staging household; a re-run creates none; `GET /admin/api/ops-events` shows it unseen | RED |
| G17 | **Customer-needs-attention alert**: a staging household past the window → one event | RED |
| G18 | **Canonical protection status**: held, quarantined and old-number households show "not protected" on the web and the 1.0.2 app | RED |
| G19 | **Stripe test payment / cancellation / refund**: subscribe, cancel, refund and delete the account, then `subscription.deleted` is `ignored`/200 | RED |
| G20 | **Accounting capture isolation**: 071 applied, capture ON in staging only; entitlement timing unchanged; one transaction per key | RED |
| G21 | Premium/international contacts refused | RED |
| G22 | Rollback rehearsal on a restored copy (070 with the code) | **Partly GREEN**: database rollback 072 → 053 rehearsed cleanly on a restored copy (2026-10-04). Code + 070 together still RED (needs the staging server) |
| G23 | Staging restored after each window (`…1883` Voice URL empty, processes stopped) | RED |

## 5-customer gate (production; nothing here may start before the staging gate is GREEN)

| # | Item | Status |
|---|---|---|
| C1 | Production backup and restore point | RED |
| C2 | Production migrations applied in the approved order (B-4), 053/066/067/070 before the backend | RED |
| C3 | Production `check-launch-config` → START; `TRUST_PROXY_HOPS` verified | RED |
| C4 | Backend deployed; first signed production call answered; rollback target recorded | RED |
| C5 | **Android 1.0.2 release build** tested on a handset (Closed testing track) | RED |
| C6 | iOS 1.0.2: either tested on TestFlight and approved, **or** iOS sign-ups not offered for the cohort | RED / ⚖ |
| C7 | **Provider exposure bounded or accepted**: at least a `<Reject/>` fallback on every production number, one designated usage trigger, and a written acceptance of the master-token residual | RED / ⚖ (written acceptance) |
| C8 | **OpenAI exposure bounded**: project spend limit set (evidenced), plus Fortress caps | RED |
| C9 | **operations@ alert destination tested**: mailbox exists; one staging-labelled event delivered with the sender adapter (once approved) | RED |
| C10 | **Support process ready**: inbox owner, response target, refund rule (D-B3), escalation | RED |
| C11 | **Customer terms / privacy / store wording aligned** with the **decided £5.99** price (website, terms §4, guides, store listings, live Stripe price, App Store Connect/RevenueCat product: all still £4.99 today; Mobile 1.0.2/store workstream), no-allowance-promise or minutes, and the deletion and retention behaviour | RED |
| C12 | Fortress production budget profiles set (D1) from the £5.99 economics (Stripe £1.07 expected ≈ £1.54 Fortress basis; store £0.74 ≈ £1.06) | RED |
| C13 | Andrew notified of every genuine customer (event runner scheduled; founder role on) | RED |
| C14 | Number cleanup decisions recorded (`2026-10-04-STAGING-READINESS.md` §6) | RED |
| C15 | Cohort is invite-only; sign-ups otherwise closed | RED |

## Public-launch gate (not before the 5→25 stages are clean)

| # | Item | Status |
|---|---|---|
| P1 | Provider containment GREEN (subaccount, master token offline, restricted runtime key, prepaid, automated suspension, Twilio Q1–Q12 answered) | RED (external) |
| P2 | Android Play Billing (RevenueCat) for Play Production | RED |
| P3 | iOS store screenshots and metadata current | RED |
| P4 | Launch price **decided: £5.99** (2026-10-04); economics validated with real cohort usage | RED (validation) |
| P5 | Accountant decisions AD-1…AD-11; Xero posting decision | RED |
| P6 | Trusted-call routing strategy (upstream vs Twilio) decided | RED |
| P7 | Launch gate `run.mjs --enforce` passes on staging and production evidence | RED |
