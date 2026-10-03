# Adversarial Test Specification

This document covers the framework layout, how to run it, how to bind it to the finished branches, and the manual test specifications for everything that cannot be automated offline. The per-scenario fields (precondition, action, expected safe result, maximum exposure, mode, evidence, owner, status) for S1–S30 live in `tests/launch-gate/registry.mjs` and are rendered in `LAUNCH_GATE_MATRIX.md`.

## 1. Framework layout

| path | role |
|---|---|
| `tests/launch-gate/registry.mjs` | Single source of truth: controls A1–I7 and scenarios S1–S30, with claimed status, evidence, owner and links to the executable checks |
| `tests/launch-gate/lib/status.mjs` | Status vocabulary, the strong/weak evidence rules, and `combine()` (results can only lower a status) |
| `tests/launch-gate/probes.mjs` | 12 executable probes (PR-01…PR-12) against the **current working tree**, both behavioural and static |
| `tests/launch-gate/financial-contract.mjs` | 8 adversarial contract checks (FC-1…FC-8) against an **adapter interface** |
| `tests/launch-gate/adapters/reference-model.mjs` | In-memory model that satisfies the contract (proves it is satisfiable) |
| `tests/launch-gate/adapters/naive-model.mjs` | Deliberately broken model (race, no dedupe, no validation, fail-open). The contract must FAIL it, which proves the contract discriminates |
| `tests/launch-gate/migration-inventory.mjs` | Read-only cross-branch migration collision inventory |
| `tests/launch-gate/run.mjs` | Runner: report / `--json` / `--markdown` / `--enforce` (exit 1 while any blocker is not PROVEN) |
| `tests/launch-gate-framework.test.mjs` | Self-test of the framework's own integrity. Must always pass |

None of this touches the network, `.env`, a database or a provider. The probes force dummy Supabase env vars and delete the Twilio and Resend env vars before loading app modules.

## 2. Commands

```bash
node tests/launch-gate-framework.test.mjs          # framework integrity (expected: pass)
node tests/launch-gate/run.mjs                     # gate report (expected on main: GATE CLOSED)
node tests/launch-gate/run.mjs --enforce           # CI form: exit 1 until every blocker is PROVEN
node tests/launch-gate/run.mjs --markdown          # regenerate the matrix tables
node tests/launch-gate/migration-inventory.mjs --min 046   # cross-branch collisions (exit 1 if any)
LAUNCH_GATE_FINANCIAL_ADAPTER=tests/launch-gate/adapters/reference-model.mjs node tests/launch-gate/run.mjs   # sanity: all FC PASS
```

Probes need `node_modules` (twilio, supabase-js). In a worktree, symlink it to the primary checkout's `node_modules` (the sibling-worktree convention) and never commit it.

## 3. Probe catalogue (baseline results on origin/main eb43368)

| probe | kind | main | flips to PASS on (verified on exported snapshots 2026-10-03) |
|---|---|---|---|
| PR-01 Twilio HTTP webhooks enforce signature | static | FAIL | security/voice-surface-p0 ✔ |
| PR-02 /media-stream identity/SMS numbers not client-supplied | static | FAIL | security/voice-surface-p0 ✔ |
| PR-03 no cross-country trusted-contact tail match | behavioural | FAIL | none yet (WS-FRAUD) |
| PR-04 high-cost ranges rejected as destination | behavioural | FAIL | none yet (WS-FRAUD) |
| PR-05 no outbound PSTN/SIP leg | static | PASS | must stay PASS on every integrated tree, or each new leg needs an allow-list plus a cost gate |
| PR-06 every `<Dial>` has `timeLimit` | static | FAIL | feature/financial-safety-hard-limits ✔ |
| PR-07 orphaned number released on assign failure | behavioural | FAIL | none yet (WS-FRAUD / WS-ID) |
| PR-08 RevenueCat provisioning gated on environment | static | FAIL | fix/revenuecat-sandbox-environment-guard ✔ |
| PR-09 indexed household lookup (no full scan) | static | FAIL | none yet (WS-ID) |
| PR-10 migration numbers unique in tree | behavioural | PASS | will FAIL on a naive integration of 055/060/061 |
| PR-11 rate limits on unauthenticated auth endpoints | static | FAIL | none yet (WS-FRAUD) |
| PR-12 server-side emergency stop exists | static | FAIL | feature/financial-safety-hard-limits ✔ |

**Static probes are pattern checks, not proofs.** Their PASS supports PARTIAL at most. Each static probe names the behavioural or manual test that is still required.

## 4. Binding the financial contract to the real implementation (integration step 12)

Write `tests/launch-gate/adapters/hcg.mjs` exporting `createSubject()` that maps the interface onto the integrated code:

| adapter method | bind to (30d454c naming; confirm against the final WS-FIN branch) |
|---|---|
| `setAllowance(h, s)` | insert/update `household_usage_periods` for household h |
| `authorizeCall({householdId, callSid})` | the real admission entry point (`services/usage/callAdmission.js admit` → `admit_call` RPC) |
| `recordUsage({...})` | the real usage/ledger writer (`051` `financial_entries`, `056` sessions) |
| `remaining(h)` | the server-side meter the customer UI reads |
| `setStoreAvailable(false)` | make the DB client throw or time out (inject the client) |
| `setGlobalCeiling` / `addGlobalSpend` | `financial_safety_state` / safety config |
| `setRateLimit` | burst configuration |

**Store requirements:**
1. **pglite** with every migration applied (reuse the `tests/migrations.pglite.test.mjs` bootstrap; one shared instance, no per-test reinstall).
2. **FC-2 / S27 cross-instance:** run two Node processes against one Postgres. In-process `Promise.all` only proves single-instance serialisation. Use `@electric-sql/pglite-socket` or the staging DB **with explicit authorisation**.
3. Only when 1 and 2 pass may FC-* results be cited as `automated-test` evidence for PROVEN.

## 5. Manual test specifications

Each execution must be recorded as `manual-execution` evidence with **date, operator, environment (staging project id / build number / handset), steps run, observed result, and artefacts** (Twilio call SID and call-log export, screenshots, DB row ids). **Staging only. Never production. Never a real customer number.** Real-money and provider-console steps need Andrew.

| id | scenarios / controls | procedure | pass criterion |
|---|---|---|---|
| M-01 | S1, C8, A8 | From one device/IP, script 20 sign-ups on staging (`/api/v1/register`), then attempt checkout or sandbox IAP on each | Refused at or before a configured N; no Twilio purchase beyond N (console export) |
| M-02 | S2, S22, D7 | TestFlight sandbox purchase on staging with RevenueCat pointed at the staging webhook | No production entitlement row and no Twilio purchase; webhook log shows environment=SANDBOX handled |
| M-03 | S6, S27, B3 | 10 simultaneous inbound calls to one staging household (call generator on a separate Twilio test account) with allowance set to 45 s | At most the cap admitted; refused calls get `<Reject>` before connect; Twilio logs show no long legs |
| M-04 | S7, S26, D11 | One call; exhaust the allowance / expire the entitlement mid-call | Customer and caller informed; Twilio call record ends at or before the policy bound |
| M-05 | S8, B1 | Hold a trusted call past `SAFETY_MAX_CALL_MINUTES` (temporarily lowered on staging, e.g. 3 min) | Twilio call duration ≤ limit + 5 s, independent of monitoring state |
| M-06 | S9, S10, C4, C5 | Handset sets `**21*<HCG number>#`; then household destination = same handset; then two staging households forwarding to each other | No outbound HCG leg, no loop, apology played; Twilio shows a single inbound leg per attempt |
| M-07 | S5, C3 | From a CLI-spoofing-capable test line (or a SIP test trunk presenting a trusted CLI) call the protected number | Matches the documented residual-risk acceptance; exact-E.164 matching verified (a +1 number with the same tail is NOT trusted) |
| M-08 | S15, G2 | Staging with an invalid OpenAI key; place an unknown-caller call | Call delivered; no retry storm (log counts); customer-visible state says monitoring unavailable |
| M-09 | S16, S17, G1, B6 | Staging with Supabase URL pointed at a black hole (or DB paused) | Fail-closed caller message; no admission without authorisation; no £-ceiling bypass |
| M-10 | S18, S19, S29, G6, I4 | Lower the global ceiling and the burst limit on staging; generate a burst; **no admin intervention** | Automatic suspension; new calls refused; durable `financial_safety_events` rows; alert sent (the alert alone does not pass) |
| M-11 | S20, G5, A7, C10 | **Provider-config export** (Andrew): Twilio API keys in use vs master token, subaccount separation, voice and SMS geo permissions, usage triggers (action = suspend, not email only), auto-recharge off. Dated JSON or screenshots | Backend uses a scoped API key; geo restricted to GB; usage triggers suspend; rotation drill completed |
| M-12 | S24, D3 | Sandbox IAP with the RevenueCat webhook delayed (temporarily disabled, then replayed) | App shows a pending state; no provisioning before the webhook; consistent afterwards |
| M-13 | S30, F2, F3, H7 | Install, activate forwarding, uninstall the app / delete the account / let the subscription lapse on staging; keep calling | Only the inbound leg is billed; apology played; customer was told to remove forwarding; the number lifecycle sweep records the state |
| M-14 | F1, F6, F7 | Device matrix: Android (Motorola, Pixel) and iPhone; locked screen, DND, notification/microphone/FSI permissions revoked | Rings or fails visibly with an apology; never silent loss without an alert; results per device |
| M-15 | G4 | Stop the staging backend; call the staging number | Twilio fallback URL behaviour recorded; caller experience defined; no cost beyond the inbound leg |
| M-16 | G7 | Run the recovery runbook end-to-end on staging (credential rotation, DB restore point, re-enable after suspension) | Completed within the target time; steps updated |
| M-17 | A5 | Two staging accounts; using A's token, try to read or modify B's contacts, calls, household, invites and usage via every authenticated route | All 403/404; no B data in responses |

## 6. Scenario-to-test map

| scenario | automated | manual |
|---|---|---|
| S1 | PR-11 | M-01 |
| S2 | PR-07, PR-08 | M-02 |
| S3 | PR-04, PR-05 | — |
| S4 | PR-05 | M-11 (geo export) |
| S5 | PR-03 | M-07 |
| S6 | FC-2 | M-03 |
| S7 | FC-1 | M-04 |
| S8 | PR-06 | M-05 |
| S9, S10 | PR-05 | M-06 |
| S11 | FC-3 | — |
| S12 | PR-01, PR-02, FC-3 | — |
| S13 | (to write: fake-client timeout-after-success) | — |
| S14 | PR-07 | — |
| S15 | (to write: transcribe failure injection) | M-08 |
| S16, S17 | FC-6 | M-09 |
| S18 | FC-7, PR-12 | M-10 |
| S19 | FC-8 | M-10 |
| S20 | — | M-11 |
| S21 | FC-4, FC-5 | — |
| S22 | PR-08 | M-02 |
| S23 | (to write: signed Stripe event ×2 through the route) | — |
| S24 | — | M-12 |
| S25 | existing cancellation tests | — |
| S26 | FC-1, PR-06 | M-04 |
| S27 | FC-2 (two-process binding) | M-03 |
| S28 | FC-4 | — |
| S29 | PR-12 | M-10 |
| S30 | — | M-13 |

The "(to write)" tests depend on the final shape of WS-FIN and WS-BILL code. They are specified here and will be written against the integrated tree.
