# Handover — Financial Fortress P0 (financial containment)

**Date:** 2026-10-03

**Owner of this workstream:** Claude 1

**Status:**
- Implemented and tested on a branch.
- **Not deployed, not merged.**
- **No migration applied anywhere.**
- **No production, staging, Twilio or carrier change.**

## 1. Where it is

| | |
|---|---|
| Branch | `security/financial-containment-p0` (pushed to `origin`) |
| Worktree | `/Users/ad/call-ai-financial-containment-p0` (`node_modules` is a symlink to `/Users/ad/call-ai/node_modules`, excluded via `.git/info/exclude`) |
| Base | `30d454c` = `origin/feature/financial-safety-hard-limits` (056 + ledger 051). It is the same base as Claude 3's `feature/customer-allowance` |
| Code HEAD | `8cc23d6` (three commits on the base: `cf0c557`, `15afd27`, `8cc23d6`) |
| HEAD at handover | `8cc23d6` + the single docs commit that adds this file (see `git log -1`) |
| Working tree | clean after the handover commit; nothing intentionally left uncommitted |

The primary checkout (`/Users/ad/call-ai`, branch `p0-batch1-carrier-policy-quarantine`, with its own uncommitted `tests/checkout-confirmation.test.mjs`) and every other worktree were left untouched. The real-Postgres test binaries live in the session scratchpad only, not in the repo.

## 2. What was built (summary)

Migration 056 already refuses new calls for concurrency, bursts, floods, loops and £ ceilings. It does that on **already-spent** £, with **no reservation**. It never ends a live call on £ grounds, and it takes its limits from the app. This branch adds the missing containment layer on top:

1. **Reservation before spend.** Before any billable TwiML, `fc_authorize_call` atomically reserves the call's first 5-minute lease, plus the whole 30-minute monitoring window if the call is monitored. Every authorisation is serialised on one row lock, so ten simultaneous calls cannot all spend the same £0.20.
2. **Leases for live calls.**
   - A sweeper runs in every instance. It checks Twilio's call status and renews the lease from the budget.
   - If renewal is refused (budget gone, breaker, kill switch), the sweeper ends the **parent** call through the Twilio REST API (`status=completed`) when the paid lease runs out, never before.
   - Ending the parent call stops the inbound PSTN leg, the app leg and the Media Stream together. Stopping monitoring alone is not treated as containment.
3. **Provider-enforced backstop.**
   - `<Dial timeLimit>` = `min(056 max, a share of the household's headroom after the worst cases of its other live calls)`.
   - So `consumed + Σ live worst cases ≤ authorisation` holds for every household, **even if every HCG server crashed**.
   - Live worst case is also capped globally.
4. **Global breaker.**
   - Rolling-hour and rolling-24 h spend (committed estimate + in-flight + request) → refusal, and the breaker **latches**.
   - Capacity caps (outstanding reservations, worst-case exposure, live calls) → refusal without latching.
   - A soft monitoring cap, an unattributed-call cap and a 10-per-day number-purchase cap.
   - A manual kill switch.
   - While the breaker is open, live calls are not renewed, so they end within one lease.
5. **Authorisation ledger.**
   - `fc_ledger` is append-only and idempotent. It distinguishes estimated, reserved, committed, released and actual cost.
   - `fc_record_actual` charges `max(estimate, actual)` and never refunds below the estimate.
   - Overruns are committed and reported, never hidden.
6. **Policy in the database.**
   - `fc_policy` / `fc_budget_profiles` are CHECK-constrained and changed only by audited functions.
   - App env values can only **tighten** them.
   - The profile is resolved server-side from `entitlements` / `account_classifications`.
7. **Fail-closed app layer** (`services/containment/`):
   - **Calls, if the authority can't be reached:**
     - a small per-instance **degraded envelope**: 2 concurrent calls, 20 per hour, 10-minute calls, unmonitored;
     - then refusal after 15 minutes of outage.
   - **Monitoring, SMS, AI and number purchases, if the authority can't be reached:** refused.
   - **A database rejection** (validation or constraint) is a refusal, never a fall-back.
   - **Local lease memory:** if the database is down, an instance ends its own calls once their lease + grace has passed.
8. **Gates on the other cost surfaces:**
   - **SMS:** every send is authorised. This closes two bypasses found in the inventory: the null-period limit-notice / post-hang-up path, and streams with no household that used the raw client.
   - **`/process` OpenAI call:** needs a signed request and an authorisation.
   - **Number purchase:** authorised for the real Twilio client. A refusal never burns the household's attempts.
9. **Signed callbacks only.** `/call-delivery-failed` and `/call-status` settle or release only when Twilio-signed. A forged "call ended" could otherwise free a live call from its lease. This also fixes the same flaw for 056's `end_call`.

**Design of record:** `docs/finance/FINANCIAL_CONTAINMENT_P0.md`, covering:
- threat model;
- invariants I1–I10;
- state machine;
- reservation maths;
- breaker;
- failure modes;
- integration contract;
- decisions.

**Cost-surface inventory:** `docs/finance/cost-surfaces.json`.

## 3. Files

**New**
- `supabase/provisional/financial_containment_authorization_ledger.sql` + `rollback_…sql` (PROVISIONAL, see §4)
- `database/financialContainment.js` — RPC adapter; throws, never decides
- `services/containment/`:
  - `containment.js` — authorise, degraded envelope, settle, one-shot spend, lease memory
  - `leaseSweeper.js` — renew / provider repair / terminate / outage fail-closed
  - `twilioCallControl.js` — fetch + parent-call hang-up
  - `policy.js` — env validation, tighten-only overrides, essential callers
  - `economicPolicy.js` — derives the safe variable envelope from price/VAT/fees/rental/infra/reserve
  - `readModel.js` — admin views + the customer allowance contract
  - `index.js` — process singleton + number-purchase authoriser
- `docs/finance/FINANCIAL_CONTAINMENT_P0.md`, `docs/finance/cost-surfaces.json`
- tests:
  - `tests/financial-containment-harness.mjs`
  - `tests/financial-containment-ledger.pglite.test.mjs`
  - `tests/financial-containment-service.test.mjs`
  - `tests/financial-containment-e2e.pglite.test.mjs`
  - `tests/financial-containment-wiring.test.mjs`
  - `tests/financial-containment-realpg.test.mjs`

**Changed**
- `server.js`:
  - `/voice`: authorisation, `<Reject>` on refusal, Dial `timeLimit`, monitoring gate; the signature is computed for every request;
  - stream attach requires containment;
  - signed-only settlement on the Dial callbacks;
  - `/process` AI gate;
  - contained SMS client for media streams;
  - sweeper start.
- `services/usage/smsBudget.js` — optional `containment`; fail-closed; idempotent per message
- `services/twilioProvisioning.js` — `authorizeNumberPurchase` dep, defaulting to containment for the real client
- `package.json` — the 5 new test files are appended to `npm test`

## 4. Migrations

- **No migration file was added to `supabase/migrations/`.** The containment schema is in `supabase/provisional/`, which neither `supabase db push` nor the migration-number test reads.
- **Why provisional.** On 2026-10-03:
  - 046, 055, 058, 060 and 061 are each claimed twice across branches;
  - the 057–061 security migrations are applied to **staging** only;
  - 062 is `feature/customer-identity-carrier-abstraction`;
  - 063 is `feature/customer-allowance`;
  - Claude 2's telephony-abuse provisional schema says it needs ≥ 064.

  No number could be established safely.
- **Integration requirement.** Give it the next free number **after** 056 and after the telephony-abuse schema (probably **≥ 065**). Re-check every branch first. It depends only on:
  - `households`;
  - `entitlements` (`plan_code` from 056 is read defensively);
  - `account_classifications` (031).

  It does not depend on any 056 table, so its number only has to follow 031 and the base tables. Ordering it after 056 is for review clarity.
- **Pre-existing** (not caused here): `tests/migrations.pglite.test.mjs` fails 1 check (`051 contribution view keeps each currency on its own row`) on the base `30d454c` as well.

## 5. Tests — exact results

These are run per file with a dummy env (`SUPABASE_URL=http://127.0.0.1:9`, dummy keys, `APP_URL=https://example.test`). That is the same method used on the base.

| Run | Files | Passing checks | Failing checks | Failing files |
|---|---|---|---|---|
| Base `30d454c` | 116 | 4224 | 10 | `migrations.pglite` (1, 051 currency view), `android-full-screen-intent-permission` (4), `android-incoming-call-notification-visibility` (5) — all pre-existing |
| This branch | 121 | **4446** | 10 | **the same 3 files, the same failures**. No regressions |

**New containment tests:**

| File | Checks | Proves |
|---|---|---|
| `financial-containment-ledger.pglite.test.mjs` | 115 | Every SQL rule on real Postgres (PGlite) — see the list below |
| `financial-containment-service.test.mjs` | 62 | Config validation (an invalid value never loosens); economics; fail-closed authorisation; degraded envelope limits and expiry; adoption; sweeper renew / terminate-at-lease-end / provider repair / retry / reentrancy / DB-outage local termination; Twilio call control; SMS gate incl. the former bypasses; number-purchase gate; customer view |
| `financial-containment-e2e.pglite.test.mjs` | 25 | Real SQL + real adapter + service + sweeper vs a fake Twilio over a simulated clock — see the list below |
| `financial-containment-wiring.test.mjs` | 20 | `server.js` invariants: refusal before any billable verb; timeLimit = backstop; monitoring only if reserved; signed-only settlement; `/process` gate; no raw SMS client; sweeper started; inventory validity |
| `financial-containment-realpg.test.mjs` | 15 (opt-in) | **True concurrency on PostgreSQL 18.4, 12 connections = 12 "instances"** — see the list below. Skips (exit 0, loud message) without `FC_REALPG_MODULES` |

What `financial-containment-ledger.pglite.test.mjs` covers:
- lock-down for anon / authenticated / service_role;
- profiles;
- reservation maths;
- 50× duplicate webhooks;
- duplicate stream start;
- settlement and duplicate callbacks;
- exhausted before the call;
- £0.20 with 10 simultaneous calls;
- exhaustion during the call → terminate at lease end;
- late-hang-up overrun;
- a long call up to the backstop;
- 200 short calls;
- actual > estimate, actual < estimate, and actual before settlement;
- malformed, negative, NaN and overflow values;
- tighten-only overrides;
- the period-reset guard;
- global caps (customer below cap but global reached);
- the rate breaker latching and its audited reset;
- the daily cap;
- the kill switch;
- the worst-case cap;
- SMS, AI and number-purchase caps;
- unattributed calls;
- stale, abandoned and forged reservations;
- degraded adoption;
- shadow mode;
- read models;
- invariants;
- rollback and re-apply.

What `financial-containment-e2e.pglite.test.mjs` covers:
- a monitored call renewed and settled;
- the budget drained mid-call → hang-up 0 s after lease end;
- the kill switch ending all live calls;
- a DB outage: degraded admission, local termination, adoption and settlement on recovery;
- no Dial callbacks at all;
- a server restart mid-call (a new instance takes over from the DB alone);
- the provider status API failing (renewed as live, never "unknown ⇒ free").

What `financial-containment-realpg.test.mjs` covers, on 12 connections:
- 5 rounds of 10 simultaneous calls on £0.20: Σ reserved and Σ worst case ≤ headroom every round, and £0.0991 consumed ≤ £0.20;
- the same CallSid on 12 connections → exactly one reservation;
- 48 calls / 24 households under a global cap of 10 → exactly 10 live;
- 4 sweepers renewing the same leases → each extended exactly once;
- a settle racing a duplicate settle and a renewal → committed once;
- 12 concurrent duplicate actual-cost records → charged once;
- a 60-call storm → breaker opened, spend never above the cap;
- invariants hold afterwards.

To run the real-Postgres test:

```
mkdir -p /tmp/realpg && cd /tmp/realpg && npm init -y && npm i embedded-postgres pg
FC_REALPG_MODULES=/tmp/realpg node tests/financial-containment-realpg.test.mjs
```

That run downloads a Postgres binary, outside the repo.

## 6. Financial invariants — status on this branch, once the provisional SQL is applied and the code deployed

| Invariant | Status |
|---|---|
| I1 No reservation → no HCG-funded call (`<Reject>`, unbilled) | ENFORCED |
| I2 Reserve before spend, atomic across instances | ENFORCED (real-PG race-tested) |
| I3 Leases bound live calls; parent call ended at lease end when unaffordable | ENFORCED (sweeper); latency ≤ sweep interval (15 s) + Twilio; covered by the 60 s grace in each reservation; any excess committed as `overrun_gbp` |
| I4 Provider backstop (`<Dial timeLimit>`) | ENFORCED (Twilio-side, survives an HCG outage) |
| I5 Σ worst case ≤ authorisation, per household and globally | ENFORCED |
| I6 Idempotency (webhooks, callbacks, actuals, adjustments, SMS, adoption) | ENFORCED |
| I7 Estimate ≠ actual; charge `max(estimate, actual)` | ENFORCED in the ledger; **the actual-cost feed is NOT WIRED** (§9) |
| I8 No early budget reset (no overlap; ≤ 35-day periods) | ENFORCED |
| I9 No client can raise a limit (RLS, no grants, service_role-only functions, audited admin functions, tighten-only overrides) | ENFORCED (tested for anon/authenticated/service_role) |
| I10 Fail closed for HCG spend when authorisation is unavailable | ENFORCED: bounded degraded envelope (decision D3) or `reject` |

## 7. Cost surfaces

See `docs/finance/cost-surfaces.json` (18 surfaces).

**ENFORCED:**
- inbound PSTN (household and unattributed);
- the app leg;
- Media Streams;
- the `/process` AI call;
- SMS;
- number purchase.

**PARTIAL:**
- Whisper transcription: bounded in minutes, not in £. There is no OpenAI per-call cost source, and `/media-stream` is still unauthenticated on this base.
- Alert email: rate limiter per process.

**INDIRECTLY BOUNDED:**
- Polly;
- red-line redirect;
- provider status reads;
- number rental;
- OpenAI SDK retries.

**NOT YET BOUNDED (provider-side only):**
- Abuse of the master Twilio credentials.
- Calls arriving while HCG is unreachable. The fix is a static `<Reject>` fallback URL.

**UNKNOWN:**
- Supabase Auth email cost: depends on the SMTP provider, and there is no app rate limit.
- Client-originated calls through the Voice SDK outgoing grant: the TwiML App Voice URL is set in the console and unverified.

## 8. Behaviour notes

**Live-call cut-off.**
- When a call can't be paid for, it ends at the end of its already-paid 5-minute lease.
- In `hangup` mode the caller hears the line drop. `announce` mode exists, but its wording is not written (D6).
- With unconditional forwarding the customer's phone never rang, so this is a dropped incoming call, not a dropped handset call.
- Emergency calls the customer **makes** never touch HCG.
- An emergency **call-back** is an incoming call. It is only protected if its number is in `FC_ESSENTIAL_CALLERS` (separate £0.10 pool). Withheld call-backs can't be recognised (D4).

**Global breaker.**
- Latches on spend-rate trips. Resetting it needs `fc_reset_breaker(reason, actor)`.
- While open: all new calls are refused, and every live call ends within ≤ 5 minutes.
- **Delivery for every customer stops until a human resets it.** This is deliberate (D2).

**Failure modes.**

| Failure | Behaviour |
|---|---|
| DB down at `/voice` | Degraded envelope, then refusal after 15 minutes |
| DB down mid-call | The call is ended by its own instance after lease + 60 s |
| Twilio REST down | Retried every sweep; the provider timeLimit backstops it |
| Lost callbacks | Repaired from provider status within one lease |
| Forged callbacks | Ignored |
| Forged `/voice` | `<Reject>`, nothing reserved |
| Crash after the reservation | Released or settled from provider status |
| Crash after a provider hang-up but before the ledger write | The next sweep re-terminates (idempotent) and settles |

Exact per-instance degraded-mode bound with the defaults: ≤ 20 calls (the hourly cap spans the whole 15-minute outage window) × 11 started minutes × c·u (£0.01179/min) ≈ **£2.61 per instance per outage**. After that, every call is refused.

## 9. Dependencies and integration requirements

1. **056** must be applied before this layer's code is deployed. `server.js` keeps 056's admission, monitoring gate and SMS counts.
2. **Twilio signature validation must pass for genuine production calls.** The default `FC_REQUIRE_SIGNED_VOICE=true` **refuses unsigned `/voice`**. If production signature validation is broken (an `APP_URL` / host mismatch), **every call is rejected**. Verify on staging first, as the voice-surface-p0 handover also warns.
3. **Security (Claude 2):**
   - `security/voice-surface-p0` and `security/telephony-abuse-p0` change the same `server.js` routes and `mediaStreamHandler.js`.
   - **Dry-run merges conflict** in `package.json`, `server.js` and `mediaStreamHandler.js` (telephony-abuse also conflicts in `tests/subscription-enforcement-voice-gate.test.mjs`).
   - Their 403-on-unsigned webhook guard is compatible with this design. Keep both, so the guard rejects first and containment never sees unsigned traffic.
   - Their stream token makes the `/media-stream` gap (§7, PARTIAL) ENFORCED.
4. **Customer allowance (Claude 3, `feature/customer-allowance`, migration 063):**
   - 063 credits **minutes** (`bonus_monitored_seconds`); this layer budgets **£**.
   - **Requirement:** `credit_allowance` must also credit the £ budget, via `fc_admin_adjust(source='topup', idempotencyKey=<provider transaction id>, amount = minutes × (monitoring + connected rate) × uplift)`, in the same flow. Otherwise a paid top-up gives minutes that containment won't fund.
   - **Inconsistency to resolve (D1):**
     - 056's placeholder Standard allowance of 100 monitored minutes costs ≈ £1.88 at the containment rates (£2.07 with the 10% estimate uplift);
     - the derived £ budget is £0.50 (£0.86 in total);
     - the advertised minutes would therefore run out of £ authorisation long before they are used.
     - Either the allowance shrinks, or the price or budget changes.
   - Customer UI: consume `getCustomerAllowanceView`. There is no write path for customers.
   - Dry-run merge with `feature/customer-allowance` conflicts in `package.json` and `server.js`.
5. **Admin Control Centre (`feature/admin-control-centre-v2`):** consume `getAdminHouseholdView` / `getAdminGlobalView`. Admin actions are database functions only; HTTP routes are not built. Dry-run merge conflicts only in `package.json`.
6. **Ledger 051 reconciliation:** `fc_record_actual` is **not wired**. Until it is, `actual_gbp` stays 0, and every figure is an estimate and labelled as one.
7. **Other branches** (`p0/call-delivery-resilience`, `readiness/ios-parity`, `release/ios-1.0.2`): dry-run conflicts in `package.json` and `server.js`. `origin/main` and `security/supabase-staging-remediation` merge cleanly.

## 10. Needs provider confirmation

- Twilio `calls(sid).update({status:'completed'})` on the parent call tears down the `<Dial><Client>` child and the stream, and billing stops at that point. This is standard Twilio behaviour; confirm on staging with a real call.
- Twilio error codes for "already ended" (21220) are treated as confirmed termination.
- Whether `<Dial timeLimit>` counts from the Dial (child) start rather than parent answer.
  - The backstop includes the 60 s grace.
  - The parent's pre-Dial seconds (greeting) are small but real.
  - Verify the billed parent duration against `timeLimit` on staging.
- The OpenAI per-request cost source (none today) and an OpenAI project budget.
- The TwiML App Voice URL behind the SDK outgoing grant.

## 11. Needs staging validation later (not done; staging untouched)

1. Apply 056, then the provisional SQL (renumbered) to staging, then run `fc_check_invariants()`.
2. Real calls:
   - admission and the returned timeLimit;
   - a monitored call;
   - a forced budget exhaustion mid-call (`fc_admin_adjust` negative on a test household) → hang-up at lease end;
   - kill switch → live calls end;
   - Dial callback settlement;
   - sweeper provider-status repair.
3. Latency of `/voice`: one more RPC under a global row lock. Measure p95.
4. The breaker under realistic load. Tune floors (D9) before launch.
5. Multi-instance on Railway: two instances sweeping.

## 12. Recommended merge / integration order

1. Decide D1, D2, D3, D5 (§13). D5 especially: the branch now *ends or refuses* calls when authorisation is exhausted, which reverses the 2026-09-30 "never stop delivery" requirement in favour of the 2026-10-03 instruction.
2. Settle migration numbering across all branches: 046/055/058/060/061 duplicates, 062, 063, telephony-abuse ≥ 064, then this ledger (≥ 065).
3. Merge `feature/financial-safety-hard-limits` (056 + 051) first.
4. Merge this branch on top of it. It is three commits, so that is a fast-forward of the base plus these.
5. Merge security (`voice-surface-p0` → `telephony-abuse-p0`). Resolve the `server.js` / `mediaStreamHandler.js` conflicts, keeping both the 403 guards and the containment calls. Run `tests/financial-containment-wiring.test.mjs` and the security suites together.
6. Merge `feature/customer-allowance`, adding the £ credit in `credit_allowance` (§9.4).
7. Merge the admin read-model consumption.
8. Staging validation (§11). Then production, only on explicit approval: SQL first, code second.

## 13. Unresolved decisions

D1–D9 are in `docs/finance/FINANCIAL_CONTAINMENT_P0.md` §11:

- **D1** budget figures, and the minutes-vs-£ inconsistency;
- **D2** latching breaker;
- **D3** degraded envelope vs reject;
- **D4** essential callers / withheld emergency call-backs;
- **D5** conflict with "never stop delivery";
- **D6** announce wording;
- **D7** reserve scope;
- **D8** keep 056 £ ceilings underneath;
- **D9** global cap floors.

## 14. Confirmations

- Nothing was deployed.
- No production or staging database was read or written.
- No migration was applied anywhere.
- No Twilio, carrier or provider configuration was changed.
- Nothing was merged.
- The only remote action was pushing this branch.
- All database testing used in-process PGlite and a throwaway embedded PostgreSQL in the session scratchpad.
- This handover was scanned for secrets before commit (§15).

## 15. Secret scan

Patterns checked across the branch diff and this file:

- `sk_`, `rk_`, `whsec_`;
- Twilio `AC…`/`SK…` 32-hex SIDs;
- JWT `eyJ`;
- `-----BEGIN`;
- `password=`;
- service-role keys.

None found. The only credential-like strings are test fixtures:
- `pw` (local throwaway embedded Postgres);
- `dummy` / `dummy-token`.
