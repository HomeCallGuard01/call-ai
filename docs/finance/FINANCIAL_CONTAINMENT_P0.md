# Financial containment P0 ("Financial Fortress")

Branch `security/financial-containment-p0`, 2026-10-03. Built on
`feature/financial-safety-hard-limits` (30d454c). **Not deployed. Not merged.
No migration applied anywhere.**

This document is the design of record. The handover
(`docs/handovers/2026-10-03-financial-fortress-p0-handover.md`) records the
state, test results and open decisions.

## 1. What this adds, and why 056 alone was not enough

Migration 056 (Layer A allowance + Layer B admission) already refuses new
calls for concurrency, bursts, floods, loops and £ ceilings. Three properties
it does not have, and which this layer adds:

| Gap in 056 | Consequence | This layer |
|---|---|---|
| Admission compares *already-spent* £ with a ceiling; nothing is reserved for the call being admitted | "£1 left, 10 calls at once": 3 are admitted (concurrency cap), each may then run 240 min (£2.57 each). Spend can exceed the ceiling by concurrency × max call cost | **Reservation before expenditure.** Every admitted call reserves its first lease from the household's remaining authorisation, atomically. The 2nd…10th call see the 1st call's reservation |
| £ ceilings never touch a call in progress | A call admitted with £0.01 left runs to its time limit | **Leases.** A call holds authorisation for 5 min at a time. A server-side sweeper renews it from the budget; if renewal is refused the call is ended through the provider REST API when the paid-for lease runs out |
| Limits are passed in by the app (`p_limits`); a bug or a bad env value can loosen them | A misconfiguration silently raises a hard limit | **Policy in the database.** The RPCs read limits from `fc_policy` / `fc_budget_profiles` (CHECK-constrained, changed only through an audited function). App-side values can only *tighten* them |
| No company-wide limit on £ authorised per hour or on concurrent exposure | A bug/compromise across many households is limited only per household | **Global breaker** on rolling-hour and rolling-day authorised £, outstanding reservations, worst-case exposure of all live calls and live-call count, plus a manual kill switch. It latches on spend-rate trips |
| Estimates and supplier cost are separate systems | Under-estimation is only an alert | **Authorisation ledger** records estimate, reservation, commitment, release and *actual* provider cost per resource, idempotently; actual > estimate is charged to the household (never refunded below the estimate) and alerts |

056 stays in place underneath (defence in depth): its concurrency, burst,
caller-flood and loop rules run first.

## 2. Threat and cost model

HCG pays per use for (full inventory: `docs/finance/cost-surfaces.json`):

- the inbound PSTN leg of every forwarded call, for the **whole** call
  (Twilio support confirmed this includes `<Dial><Client>`);
- the app (Voice SDK) leg (billed £0 today, priced at list as a precaution);
- Media Streams and transcription while a call is monitored;
- Polly greetings, SMS, OpenAI chat (`/process`), number purchase + rental.

Ways those become unbounded:

1. one household's usage (genuine heavy use, a business using a consumer plan);
2. concurrency (many calls at once against one remaining balance);
3. long calls (a call left connected);
4. technical failure (lost callbacks, crashed server, DB down, retries);
5. routing loops;
6. abuse (call floods, forged webhooks, compromised credentials, mass sign-ups);
7. provider price changes and billing granularity.

## 3. Invariants

Enforced by the database functions in
`supabase/provisional/financial_containment_authorization_ledger.sql`.
Tested in `tests/financial-containment-*.test.mjs`.

- **I1 — No reservation, no HCG-funded call.** A signed `/voice` request is
  connected only after `fc_authorize_call` returned `allowed` (or the bounded
  degraded envelope, §8, admitted it). Otherwise the call gets `<Reject>` as
  its first verb, which the provider does not bill.
- **I2 — Reserve before spend, atomically.** Authorisations are serialised on
  one row lock (`fc_global_state`). A household's
  `reserved + consumed ≤ budget + adjustments (+ reserve for telephony)` holds
  after every authorisation. Concurrent requests cannot all read the same
  balance.
- **I3 — Leases bound live calls.** A call is covered up to
  `covered_seconds` (lease + termination grace). It is renewed in lease
  steps only if the next step can be reserved. A refused renewal marks it
  `terminating`, and the sweeper ends it through the provider when the paid
  lease runs out.
- **I4 — Provider-enforced backstop.** `<Dial timeLimit>` is the call's
  *backstop*: `min(policy max, what the household could afford at admission)`.
  Twilio ends the call there even if every HCG server is down.
- **I5 — Worst case is bounded globally.** The sum over live calls of their
  backstop cost (what they would cost if HCG crashed now and nothing renewed
  or terminated) is capped (`global worst-case exposure`). A call that would
  push it over the cap is refused.
- **I6 — Idempotency.** One reservation per idempotency key (`call:<CallSid>`,
  `sms:<…>`, …). A Twilio retry gets the original decision and the original
  time limit. Settlement, actual-cost records and adjustments each have
  unique keys, so a duplicated callback or webhook changes nothing.
- **I7 — Estimates are never reported as actual.** `committed_gbp` is an
  estimate. `actual_gbp` is only written from provider data
  (`fc_record_actual`). The household is charged `max(estimate, actual)`.
- **I8 — Budget resets cannot be forced early.** A new period never starts
  before the previous one ends, and is never longer than 35 days, whatever
  period the app passes in.
- **I9 — No client can raise a limit.** All tables have RLS on and no grants
  to `anon`/`authenticated`. Every function is `service_role` only. Policy,
  breaker and adjustments change only through audited functions with a
  required reason and bounded amounts.
- **I10 — Fail closed for HCG spend.** If the authorisation service can't
  answer, no monitoring, no SMS and no AI calls are authorised. Calls get only
  the small bounded degraded envelope (§8), and after
  `degradedMaxOutageSeconds` none at all.

## 4. Reservation model

### 4.1 Cost function

For a call covered for `s` seconds:

```
telephony(s)  = ceil(s / g) · g/60 · c · u
monitoring(s) = ceil(min(s, M) / g) · g/60 · m · u    (only if monitored)
fixed         = Polly greeting etc. (only if s > 0)
```

- `g` is the billing granularity (60 s, per started minute).
- `c` is the connected rate (inbound + app leg).
- `m` is the monitoring rate (stream + transcription).
- `M` is the monitoring maximum (30 min).
- `u` is the estimation uplift (1.10).

All of these are in `fc_policy`.

### 4.2 States

```
            authorize                 renew (affordable)
  (none) ───────────────▶ active ◀─────────────────────┐
     │                      │  └────────────────────────┘
     │ refused              │ renew refused / breaker / kill switch
     ▼                      ▼
  denied               terminating ──(sweeper: provider REST hang-up at lease end)──┐
                            │                                                       │
          settle (Dial action, provider status, lease sweep)                        │
     active / terminating ───────────────────────────────────▶ settled ◀────────────┘
```

- **authorize**:
  - reserve `telephony(lease + grace)`;
  - plus `monitoring(M)` in full if monitoring is authorised (so a monitored
    call never needs a monitoring renewal);
  - plus `fixed`;
  - compute the backstop.
- **renew**: when the lease ends within `renew_ahead_seconds`, add
  `telephony(covered + lease) − telephony(covered)`. A call is never renewed
  past its backstop.
- **settle**:
  - commit the estimate for the observed duration (`telephony(d) +
    monitoring(min(d, monitored)) + fixed`);
  - release the rest of the reservation;
  - if the call ran beyond its cover (termination latency), the excess is
    committed anyway and recorded as `overrun_gbp`;
  - duration 0 (provider says the call never existed or never connected)
    commits £0.
- **record actual**: provider cost per resource, unique per provider
  reference. If total actual > committed, the difference is charged to the
  household and an `estimate_undercount` event is written.

### 4.3 Funding sources (household)

| Funding | Pays for | Available when |
|---|---|---|
| `budget` | monitoring + telephony | `base + adjustments − consumed − reserved ≥ cost` |
| `reserve` (delivery reserve) | telephony only (unmonitored delivery) | budget can't cover even an unmonitored lease; `budget + reserve` can; profile scope allows (`all` or `trusted_only`) |
| `essential` | telephony only, for configured essential callers | budget and reserve exhausted. A separate small cap |
| `unattributed` | a call to an HCG number with no household (message + hang-up) | global daily unattributed cap |

When every source is exhausted the call is refused (`<Reject>`, unbilled).

## 5. Live-call cut-off

- **Who ends the call.** The lease sweeper (`services/containment/leaseSweeper.js`)
  runs in every server instance every `sweepIntervalMs`. The database row lock
  keeps instances from double-renewing. A call admitted by a crashed instance
  is renewed or terminated by a surviving one.
- **What is ended.** The *parent* inbound call, via
  `calls(sid).update({status: 'completed'})`. That stops the inbound PSTN leg,
  the `<Dial><Client>` leg and the Media Stream together. Stopping only AI
  monitoring is **not** treated as containment: the PSTN leg would keep
  billing.
- **Provider truth on renewal.** Before renewing, the sweeper fetches the
  call's status from Twilio (a free read):
  - call ended → settle with the provider duration (a lost Dial callback is
    repaired here);
  - unknown SID (404) → settle at 0, which releases the reservation;
  - status read fails → renew conservatively (assume live) if affordable.
- **DB unreachable during a live call.** The sweeper keeps a local copy of the
  leases this instance admitted. If the database can't be reached and a
  lease has passed `lease end + grace`, the instance ends the call itself
  (`terminateOnRenewalUnavailable`, default true).
- **Everything down.** If both HCG and the database are down, Twilio's
  `<Dial timeLimit>` backstop ends the call.

**What the customer experiences.** The call ends at the end of a paid lease,
never mid-way through an unpaid one. This branch doesn't invent wording.
`terminationMode` is `hangup` (default) or `announce` (a short TwiML message,
for Claude 3/Andrew to word).

**Emergency calls.** Calls the customer *makes* (999/112) never touch HCG:
call forwarding only affects incoming calls. An emergency service
**ringing the customer back** is an incoming call and would be forwarded to
HCG. If its number is configured as essential (`FC_ESSENTIAL_CALLERS`), it is
funded from the essential pool after the budget runs out. A withheld
call-back number can't be recognised. This is **unresolved decision D4**.

## 6. Global breaker

Evaluated inside every authorisation, under the same lock.

| Check | Default | Trip behaviour |
|---|---|---|
| Kill switch (manual) | off | All authorisations and renewals refused. Live calls end at lease end |
| Breaker (latched) | closed | Opened automatically by a spend-rate trip. Reset only by `fc_reset_breaker` (audited) |
| Rolling-hour authorised £ | max(£4, N × £0.03) | Refuse; **latch** the breaker |
| Rolling-24h authorised £ | max(£15, N × £0.20), absolute max £1000 | Refuse; **latch** the breaker |
| Outstanding reservations £ | max(£5, N × £0.05) | Refuse this request (capacity; no latch) |
| Worst-case exposure of live calls | max(£40, N × £0.50) | Refuse this request (no latch) |
| Live reservations | max(20, N / 5) | Refuse this request (no latch) |
| Monitoring £ / rolling hour (soft) | max(£1.50, N × £0.02) | New calls connect unmonitored |
| Unattributed calls £ / day | £2 | Refuse unattributed calls |
| Number purchases / 24 h | 10 | Refuse purchase |

`N` is the number of currently entitled households. The database counts it
(`fc_refresh_entitled_count`), so a client can't supply it. A count older than
26 h falls back to the floors.

While the breaker is open or the kill switch is on, renewals are refused
(`breaker_terminates_active`, default true). Live calls therefore end within
one lease (≤ 5 min) instead of running to their time limit.

**Why the breaker latches.** A spend-rate trip means something abnormal is
happening (a bug, compromised credentials, a loop across households). Letting
it reset by itself would let the same fault start again every hour. The price
of latching is that delivery stays stopped until a human resets it. That is
the trade-off of rejecting financial fail-open, and it is listed as decision D2.

## 7. Configuration

- **Authoritative.** `fc_policy` (one row) and `fc_budget_profiles`, seeded
  with conservative defaults by the provisional migration. CHECK constraints
  reject nonsense (negative or zero rates, leases outside 60–1800 s, a
  backstop over 4 h, …). Changes go only through `fc_set_policy` /
  `fc_set_budget_profile`, with an actor, a reason and an audit row.
- **App side.** `services/containment/policy.js` reads the `FC_*` env
  variables and validates them. The request overrides it sends can **only
  tighten** the database policy:
  - leases, caps and backstops are combined with `least`;
  - rates and uplift are combined with `greatest`.
- **Economics.** `services/containment/economicPolicy.js` derives a
  *suggested* standard budget from the price, VAT, the delivery-cost ceiling
  ratio, platform fees, number rental, an infrastructure allowance and a
  safety reserve. It validates that the configured profile can't exceed the
  ceiling. It does not change the database: changing a budget is an audited
  `fc_set_budget_profile` call (decision D1).

## 8. Failure modes

| Failure | Behaviour | Bound |
|---|---|---|
| Authorisation RPC errors or times out at `/voice` | Degraded envelope (per instance): ≤ `degradedMaxConcurrent` live calls, ≤ `degradedMaxCallsPerHour`, `timeLimit = degradedMaxCallSeconds`, unmonitored. After `degradedMaxOutageSeconds` of continuous failure: reject. Calls admitted this way are adopted into the ledger when the DB returns | per instance: `degradedMaxCallsPerHour × telephony(degradedMaxCallSeconds)` (defaults: 20 × 11 min × c·u ≈ £2.84/h, at most 15 min of outage ≈ £0.71) |
| `FC_DEGRADED_MODE=reject` | Every call refused while authorisation is unavailable | £0 |
| Renewal RPC fails | Local lease copy; terminate when `lease end + grace` has passed | one lease + grace |
| Provider REST hang-up fails | Retried each sweep. Provider `timeLimit` backstop | backstop |
| Dial action callback lost | Next renewal reads provider status → settle | one lease |
| Duplicate `/voice`, duplicate callback, duplicate actual-cost record | Idempotency keys; original result returned | £0 |
| Server crash after reservation, before TwiML | Twilio retries / caller retries. The reservation is settled at 0 when the provider says the SID ended unconnected | one lease reserved, £0 spent |
| Server crash after provider action, before ledger update | Settle is driven by provider status on the next sweep, never by memory | one lease |
| Unsigned `/voice` | `<Reject>` (`FC_REQUIRE_SIGNED_VOICE`, default true). Forged requests cost nothing and reserve nothing | £0 |
| Provider actual cost > estimate | Charged to the household; `estimate_undercount` event; rates are a policy change | the difference |
| Malformed, negative, NaN or overflow values | Rejected by the RPC (exception), by CHECK constraints, and by JS validation | — |

## 9. Remaining provider-level limitations (not solvable in HCG code)

- Twilio has **no account spend cap**. Usage Triggers only notify. A prepaid
  balance with auto-recharge off is the only provider-side hard stop, and it
  stops everything.
- Calls arriving while HCG is unreachable: Twilio bills about one started
  minute each and plays an error. Fix in the provider: a voice fallback URL
  that returns a static `<Reject>`.
- Master auth token in the backend: anyone holding it can buy numbers, place
  calls or change geo permissions directly, bypassing all of this. Fix in the
  provider: restricted API keys and subaccounts (security workstream).
- OpenAI price changes are invisible until the invoice. Only an OpenAI
  project budget stops them in £.
- Number rental is billed monthly for every number held, whatever this layer
  decides. It is bounded by number-lifecycle work, not here.
