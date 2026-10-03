# Telephony Fraud & Abuse — Threat Model and Control Matrix

**Branch:** `security/telephony-abuse-p0` (based on `security/voice-surface-p0` 7f0bae3, which is based on `origin/main` eb43368)
**Date:** 2026-10-03
**Status:** Code on this branch only. **Not merged, not deployed, no migration applied anywhere.** "ENFORCED" below means *enforced by code on this branch and covered by an automated test*. It does not mean live in production.

Status key:

| Status | Meaning |
|---|---|
| **ENFORCED** | Refused or contained in code before the paid step, with an adversarial test |
| **PARTIAL** | Enforced, but with a stated gap (usually process-local state or a missing signal) |
| **OBSERVED** | Detected and audited/alerted; deliberately not refused |
| **NOT IMPLEMENTED** | Known gap, no control on this branch |
| **PROVIDER DEPENDENCY** | Cannot be closed in HCG code; needs Twilio, carrier or Ofcom data/capability |

---

## 1. What actually happens on a call (legs and direction)

```
 Caller (PSTN, CLI unauthenticated)
   │  dials the customer's own mobile/landline
   ▼
 Customer's carrier  ── unconditional/conditional forward ──►  HCG Twilio number (UK geographic)
                                                               │  INBOUND leg, billed per minute to HCG
                                                               ▼
                                                     POST /voice  (signed webhook)
                                                               │  TwiML:
                                                               │   <Say> announcement (unknown callers only)
                                                               │   <Start><Stream> → /media-stream → OpenAI transcription (paid)
                                                               │   <Dial><Client>household_<id></Client>  (Voice SDK leg, billed)
                                                               ▼
                                                     HCG mobile app on the customer's phone
 Side effects: warning SMS → households.phone_number (paid); red-line redirect (calls(sid).update)
```

Facts that shape every control below. Each is verified in code:

- **The trusted contact is the *caller* on an *inbound* call.** It is never a destination. `contacts` rows are only compared with `From`. Nothing reads a contact number into a dial, SMS or lookup.
- **HCG creates no PSTN leg.** Delivery is `<Dial><Client>` only (`services/callRouting.js`, `households.self_protecting`). The Voice SDK token has an outgoing grant, but `/voice` rejects every `client:` origin. A mobile client therefore cannot make HCG place a PSTN call.
- **The only HCG-paid destinations a customer can influence** are:
  - the warning SMS destination (`households.phone_number`);
  - *which* number HCG buys (it cannot choose this: the first available GB local number is taken).
- **Every inbound minute is HCG's cost**, including trusted-contact calls. Refusing with `<Reject>` as the first verb is unbilled.
- **Andrew's hard requirement:** never stop delivery while a customer's forwarding points at HCG. Controls that *refuse* calls are therefore limited to:
  - patterns that are not a real person's call (loops, client origin, a number with no household);
  - one abusive caller (only that caller is refused, and only for a limited time);
  - engaged-line concurrency;
  - explicit kill states (`full_stop`, financial kill switch).

  Floods from many callers are *observed*, never refused.

## 2. Inventory of HCG paid / chargeable actions

| # | Action | Where | Who can trigger | Guarded by (this branch) |
|---|---|---|---|---|
| P1 | Answer inbound call (minutes) | `POST /voice` | Anyone who can dial a customer's number or an HCG number | Signature (Security P0) → webhook integrity → inbound guard (§3) → TwiML egress guard |
| P2 | `<Dial><Client>` SDK leg | `dialHouseholdOrFailClosed` | Same as P1 | Same, plus egress guard: Client identity must equal this household's |
| P3 | `<Start><Stream>` → OpenAI transcription | `attachLiveMonitoring`, `/media-stream` | Unknown/untrusted callers | Entitlement gate + `abuseDecision.monitor` + single-use stream token (Security P0) + `costCaps` |
| P4 | Warning SMS | `riskMonitor` → `guardSmsClient` | Risky speech on a monitored call | `numberPolicy` SMS_WARNING (UK mobile only) + incident gate + `costCaps` per-household/global |
| P5 | Red-line redirect (`calls(sid).update`) | `callTermination.js` | Risky speech | URL built server-side from `APP_URL`; `/red-line-terminate` is signed, integrity-checked and egress-guarded |
| P6 | Buy phone number | `ensureTwilioNumberProvisioned` | Stripe webhook, `/billing/reconcile-session` (user), RevenueCat webhook, complimentary invite redeem, admin retry | `provisioningGuard` (§6) |
| P7 | Release number | quarantine release runner | Scheduler, after a human confirms deactivation | Unchanged (existing quarantine design); provisioning never adopts a quarantined number |
| P8 | OpenAI chat (`/process`) | dead route | Signed request only | Signature + webhook integrity + egress guard |
| P9 | Alert e-mail (Resend) | `sendCriticalAlert` | Many events | Existing per-type rate limit; abuse alerts additionally throttled (15 min/type) |
| P10 | Supabase auth e-mails (sign-up/reset) | `/register`, `/forgot-password` | Anyone | Supabase's own rate limits (not HCG code) — see §8 |

## 3. Precise order of checks for an inbound call

| Step | Check | Outcome on failure | Rationale |
|---|---|---|---|
| 0a | Twilio signature (`twilioWebhookGuard`, Security P0) | 403 | Forged webhook |
| 0b | Webhook integrity: AccountSid, parameter pollution, ≤200 params, ≤2 KB values, CallSid format | 403 / 400 / 413 | Unexpected provider, pollution, huge payloads |
| 0c | Duplicate/replay of `(path, CallSid, signature)` within 30 min | Identical cached TwiML; no new token, count or lease | Replay / Twilio retry |
| 1 | `From` = `client:*` | `<Reject>` | SDK outgoing grant cannot become a PSTN call |
| 2 | Global incident mode | `full_stop` → `<Reject>`; `suspend_paid` → no new monitoring | Global breaker sits above trust |
| 3 | Dialled number belongs to a household | `<Reject>` (previously a billed `<Say>`) | Quarantined/unassigned numbers cost nothing |
| 4 | Household abuse hold (operator/provisioning only) | `<Reject>` | Account status |
| 5 | Loop / lineage: `From == To`; `From` is any HCG number; `ForwardedFrom` is an HCG number; `ParentCallSid` present | `<Reject>` | Loops are refused before any paid TwiML |
| 6 | Caller velocity: caller→household burst (> 8 in 5 min → 15 min cooldown); caller fan-out (> 5 households in 60 min → 60 min cooldown everywhere) | `<Reject>` for **that caller only** | Attacker throttling without victim lockout |
| 7 | Household volume from many callers (> 20 in 10 min) | **Flag only**: audited, alerted, trusted bypass suspended | Refusing here would let an attacker switch protection off |
| 8 | Concurrency: household ≥ 3, caller ≥ 2 (provider-verified before refusing); global ≥ 200 | Household/caller: `<Reject>` (engaged line). Global: degrade (no new monitoring) + contain | |
| 9 | Financial authorisation (Claude 1 port) | `telephony: reject` → `<Reject>`; `monitoring: deny` → no new monitoring; unavailable → policy | Reservation only for calls that passed abuse checks |
| 10 | Trusted-contact match (full E.164) | Bypass suspended (→ monitored) for: withheld/malformed CLI; premium/070/076/084/087/satellite CLI; failed `StirVerstat`; ≥ 5 calls from that CLI in 5 min; elevated household | Trust is last, and only decides monitoring |
| 11 | Entitlement (`shouldStartPaidMonitoring`) ∧ `abuseDecision.monitor` ∧ not duplicate | Announcement + stream, or neither | Existing honesty invariant kept |
| 12 | TwiML egress guard | Anything outside scope → `<Reject>` | Final fail-closed backstop |

A trusted contact therefore passes steps 0–9 like everyone else. Tests show it cannot bypass any of them:

- global breaker (full_stop refuses a trusted CLI);
- loop (an HCG number stored as a contact is refused at step 5, before trust or financial authorisation);
- velocity (a trusted CLI flood is refused at step 6 before financial authorisation is called);
- financial authorisation (consulted for trusted calls; a £ denial removes monitoring, not delivery);
- account status (step 4).

## 4. Control matrix

### 4.1 Destination policy

| Threat | Status | Control | Test |
|---|---|---|---|
| Premium-rate (09) as SMS / household destination | **ENFORCED** | `numberPolicy` purposes SMS_WARNING / HOUSEHOLD_PHONE | controls §1, §2, §3 |
| 070 personal numbering, 076 paging, 07624 IoM via `/^\+447/` loophole | **ENFORCED** | Class-based allowlist replaces regex in `costCaps` | controls §2 |
| International / satellite (+870/881/882/883) / global service (+800/808/878/888/979) | **ENFORCED** | Not in any chargeable purpose allowlist | controls §1 |
| 084/087 revenue-share, 080 freephone, 055/056, 03 | **ENFORCED** for SMS and household phone | Not allowlisted | controls §1 |
| Short codes / emergency numbers | **ENFORCED** | Classified, never allowlisted | controls §1 |
| Malformed E.164, `+44 0…`, `++`, extensions, `#`/`;w` dial strings, non-ASCII digits | **ENFORCED** | Parser refuses, never guesses | controls §1 (16 cases) |
| Normalisation bypass (`0044`, `+44 (0)`, spaces/brackets, bidi marks, fullwidth digits) | **ENFORCED** | NFKC + invisible-char strip, then one canonical E.164 | controls §1 (8 variants) |
| Any HCG PSTN leg (current or future regression) | **ENFORCED** | `PSTN_DIAL` allows nothing; TwiML egress guard refuses `<Number>`/`<Sip>`/`<Conference>`/… | controls §6; attacks (162 responses scanned) |
| Channel Islands mobile sub-ranges; high-termination 07 blocks used for IRSF | **PROVIDER DEPENDENCY** | `ABUSE_DENY_E164_PREFIXES` lets ops block a range without a deploy. Authoritative data needed: Ofcom numbering allocations or Twilio Lookup line type | — |

### 4.2 Trusted-contact bypass

| Threat | Status | Control | Test |
|---|---|---|---|
| Premium/international number added as trusted → HCG pays to call it | **ENFORCED (no path exists)** | Contacts are never destinations; egress guard; client-origin reject | attacks "premium-rate number marked trusted" |
| International caller matching a UK contact's last 10 digits | **ENFORCED** | Full-E.164 matching; international contacts are now stored as E.164 | attacks; controls §1 |
| Spoofed CLI equal to a trusted contact | **PARTIAL / PROVIDER DEPENDENCY** | Bypass suspended on failed STIR, bursts, floods, untrustable classes. A single quiet spoof still gets the bypass: UK CLI is not cryptographically authenticated and HCG **cannot** prove caller identity | attacks (STIR, burst) |
| Trusted call bypasses breaker / financial / loops / velocity / account status | **ENFORCED** | Trust is step 10 of 12 | controls §4 "ORDER" checks |

### 4.3 Forwarding loops

| Threat | Status | Control | Test |
|---|---|---|---|
| HCG number forwarded to itself (`From == To`) | **ENFORCED** | Step 5 | attacks |
| A→B two-number loop / multi-household loop (an HCG number as caller, any format) | **ENFORCED** | Directory of assigned + quarantined HCG numbers | attacks |
| Carrier redirect visible as `ForwardedFrom` = HCG number | **ENFORCED (when present)** | Step 5. ForwardedFrom carried no usable information on 184/184 real calls (APP_DECISION_008) | attacks |
| Call created by our own account (`ParentCallSid`) | **ENFORCED** (hop limit 0) | Step 5. Whether Twilio sets this on an own-number re-entry is **unverified** | attacks |
| Customer sets `households.phone_number` = an HCG number | **ENFORCED** | `setHouseholdPhoneNumber` refuses HCG-owned numbers and fails closed if the lookup fails | controls §3 |
| Loop invisible to HCG (carrier-to-carrier forward chains that never present an HCG CLI) | **PROVIDER DEPENDENCY** | Bounded by caller velocity + household concurrency only | — |
| HCG-number directory unavailable | **PARTIAL** | Fails **open** (delivery) and is audited; velocity/concurrency still bound loops | controls §4 |

### 4.4 Repeated calling / velocity

| Threat | Status | Control | Test |
|---|---|---|---|
| 100 rapid calls, one caller → one household | **ENFORCED / PARTIAL** | 8 delivered, 92 refused unbilled; other callers unaffected. Process-local counters | attacks |
| Same source → many households | **ENFORCED / PARTIAL** | Fan-out > 5 → caller refused everywhere for 60 min | attacks |
| Many callers → one household | **OBSERVED** (by design) | Flag, alert, trusted bypass suspended; all delivered | attacks (30 callers) |
| Withheld/anonymous flood | **PARTIAL** | No per-caller key; bounded by household concurrency + elevated flag | — |
| Repeated failed calls / retry storms | **PARTIAL** | Counted as attempts by the same caller keys; duplicate webhooks are not recounted | attacks (replay) |
| Victim lockout via induced throttling | **ENFORCED (mitigated)** | Never refuse on household volume; cooldowns are per caller and expire; leaked leases need provider confirmation before refusal, with a 10 min TTL | controls §4 (leaks, cooldown expiry) |
| Targeted relationship DoS (spoofing a relative's CLI to burn that caller's cooldown) | **NOT IMPLEMENTED** (residual) | Limited to that CLI for 15 min, alerted | — |

### 4.5 Mass provisioning / multi-account

| Threat | Status | Control | Test |
|---|---|---|---|
| Same person, 100 accounts → 100 numbers | **ENFORCED / PARTIAL** | Global ceiling 10/h, 40/day → hold + contain mode | controls §8 |
| Same protected phone number on many accounts | **ENFORCED** | Hold if another household holds it (if the phone is known before purchase) | controls §8 |
| Email aliases (gmail dots, `+tags`, googlemail) | **ENFORCED** | Normalised email base; hold at ≥ 2 prior | controls §8 |
| Buy → abandon → repeat | **ENFORCED** | ≥ 2 quarantined numbers for the household in 30 days → hold | controls §8 |
| Trial / complimentary abuse | **PARTIAL** | Free entitlement plus any other signal adds a reason; Stripe `trialing` still qualifies for a number (product decision) | — |
| Same payment instrument | **NOT IMPLEMENTED (port defined)** | `paymentFingerprint` port: Stripe `card.fingerprint` needs webhook expansion | — |
| Same device | **NOT IMPLEMENTED (deliberately)** | App sends no device id; no fingerprinting without a privacy decision | — |
| Same IP/network | **NOT IMPLEMENTED (port defined)** | Not stored. `X-Forwarded-For` is trustworthy only at Railway's last hop (`trust proxy` unset) | — |
| Account creation itself (no paid resource) | **NOT IMPLEMENTED** | Supabase auth rate limits only | — |
| Failed-payment loops | **PARTIAL** | No entitlement → no number. Provisioning failures are capped at 5 attempts (existing) | — |
| History/signal unreadable | **ENFORCED** | Hold (fail closed before spending) | controls §8 |

### 4.6 Number provisioning safety

| Threat | Status | Control | Test |
|---|---|---|---|
| Two concurrent purchases (double reconcile, webhook + reconcile) | **ENFORCED / PARTIAL** | Single-flight per household (process); cross-instance needs `claim_number_provisioning` (provisional) | controls §8 (3 concurrent → 1 create) |
| Retry after timeout (purchase actually succeeded) | **ENFORCED** | friendlyName `hcg-hh-<id>` + adopt-before-buy | controls §8 |
| Bought, DB assign failed (orphan) | **ENFORCED** | Adopted on retry; `findOrphanedTaggedNumbers` for read-only reconciliation | controls §8 |
| Adopting a quarantined number | **ENFORCED** | Quarantine-aware; quarantine unreadable → neither adopt nor buy | controls §8 |
| Provider returns a different / non-geographic number | **ENFORCED** | Released immediately, never assigned | controls §8 |
| Purchase during incident / breaker unreadable | **ENFORCED** | Contain+ blocks; unreadable fails closed | controls §8 |
| Guard not configured in production | **ENFORCED** | Refuses to buy | controls §8 |
| Explicit pending/held state persisted | **PARTIAL** | `held` is returned + audited; not a `twilio_provisioning_status` value (would need a schema change) | — |
| Numbers bought before this branch (no tag) | **NOT IMPLEMENTED** | Untagged legacy numbers can't be found by tag. Inventory: `project_twilio_number_inventory` | — |

### 4.7 Webhook abuse

| Threat | Status | Control | Test |
|---|---|---|---|
| Unsigned / forged | **ENFORCED** | Security P0 guard (reused, not duplicated) | attacks |
| Replay / duplicate within 30 min | **ENFORCED / PARTIAL** | Cached identical TwiML; callbacks' side effects skipped. Process-local | attacks |
| Stale replay (after window/restart) | **PROVIDER DEPENDENCY** | Twilio signs no timestamp/nonce. Closing it needs a REST `calls(sid).fetch()` liveness check (latency) or HTTP Basic auth plus rotation | — |
| Parameter pollution | **ENFORCED** | Arrays on decision fields → 400 | attacks |
| Unexpected provider / AccountSid | **ENFORCED** when `TWILIO_ACCOUNT_SID` is set | 403 | controls §7 |
| Huge payloads | **ENFORCED** | > 200 params / > 2 KB value → 413; body parser default 100 KB | attacks |
| Callback URL abuse | **ENFORCED** | Egress guard: action/url/statusCallback/Redirect must be relative or own host; Stream path fixed | controls §6 |
| Malformed numbers in webhook | **ENFORCED** | Parsed by `numberPolicy`. Malformed `From` is never trusted, still delivered | attacks |
| `/media-stream` forgery | **ENFORCED** (Security P0) | Single-use CallSid-bound token, never re-issued for duplicates | voice-surface-security |

### 4.8 Authorization boundaries

| Threat | Status | Control | Test |
|---|---|---|---|
| Client chooses arbitrary destination | **ENFORCED** | Only `households.phone_number` is client-set, via policy | controls §3, §9 |
| Client marks itself trusted / skips monitoring / overrides cost / picks routing | **ENFORCED** | No such request fields exist (structural test) | controls §9 |
| Client provisions for another household | **ENFORCED** | All routes use `req.household` from auth; admin routes need `requireAdmin` | controls §9 |
| Client uses outgoing grant to call PSTN | **ENFORCED** | `client:` origin → `<Reject>` | controls §9 |
| TwiML App voice URL pointing somewhere else | **PROVIDER DEPENDENCY** | Console config unverified (catastrophic-risk review) | — |
| Master auth token can re-enable geo permissions via API | **PROVIDER DEPENDENCY / NOT IMPLEMENTED** | Move to restricted API keys; lock geo permissions | — |

### 4.9 Concurrency

| Threat | Status | Control | Test |
|---|---|---|---|
| Household flooded with simultaneous calls | **ENFORCED / PARTIAL** | > 3 live → `<Reject>` (provider-verified when the REST client exists) | attacks; controls §4 |
| One caller holding many lines | **ENFORCED / PARTIAL** | > 2 live per caller | — |
| Global surge | **OBSERVED + degrade** | ≥ 200 → no new monitoring + contain; never refuses delivery | — |
| Monitoring streams per household | **ENFORCED** (Security P0 `costCaps`) | 2 streams | media-stream tests |

### 4.10 Global incident mode

| Threat | Status | Control | Test |
|---|---|---|---|
| Stop new paid activity without a dashboard | **ENFORCED** | `HCG_INCIDENT_MODE` env (redeploy/restart, no code) + auto trip + financial breaker port + provisional DB flag | attacks (3 boots); controls §5 |
| Automation stopping customer calls | **ENFORCED (prevented)** | Auto trips capped at `contain`; `full_stop` manual only; financial `telephonySuspended` maps to `suspend_paid` | controls §5 |
| Breaker source unavailable | **ENFORCED** | Purchases fail closed. Others keep last known for 60 s, then floor at `contain` | controls §5 |
| Shared across instances / survives restart | **PARTIAL** | Env is shared. Auto-trip is process-local until the provisional `abuse_incident_state` exists | — |

### 4.11 Audit trail

| Requirement | Status | Notes |
|---|---|---|
| Reason code, action, kind, provider, severity, household, correlation id, timestamp | **ENFORCED** | `ABUSE DECISION {json}` log line per decision |
| Normalised facts, no secrets/PII | **ENFORCED** | Keyed caller hash + masked number (`+4477…555`); forbidden keys stripped; test scans every record for full numbers |
| Durable store | **PARTIAL** | Writer port exists; `abuse_decisions` table is provisional. Logs are on Railway only today |

## 5. Signals not available today (interfaces only)

| Signal | Why not | What is needed |
|---|---|---|
| Payment instrument | Stripe webhook payload not expanded | `charge.payment_method_details.card.fingerprint` captured on `checkout.session.completed`; implement `paymentFingerprint` + `countHouseholdsWithPaymentFingerprint` |
| Sign-up IP / network | Not stored; proxy chain untrusted | `app.set('trust proxy', 1)` reviewed for Railway, plus storage and a retention decision |
| Device | App sends none | A privacy decision first; then a per-install random id, not a fingerprint |
| Apple / Google purchaser identity | RevenueCat `original_app_user_id` only | RevenueCat transfer history (partially used for TRANSFER) |
| Line type / ported status of numbers | No Lookup integration | Twilio Lookup v2 `line_type_intelligence` (paid per lookup), at phone-number write time |

## 6. Integration with Claude 1 (Financial Fortress)

- **Boundary:** `services/abuse/financialAuthorizationPort.js`. Claude 1 supplies `{ authorize, release }` and an optional breaker reader. The abuse layer keeps **no £ ledger** and makes **no reservations**.
- **Order:** abuse checks 1–8 run first. A call refused as abuse never reaches `authorize`, so a reservation is never created and then orphaned.
- **Contract:**
  - `telephony: 'reject'` only for states Andrew approved as allowed to stop delivery (today: an explicit kill switch). £ ceilings return `monitoring: 'deny'`.
  - Malformed or slow (> 1.5 s) responses count as *unavailable*, never as approval of anything unusual.
- **Unavailable policy:** `ABUSE_FINANCIAL_UNAVAILABLE_POLICY`:
  - `local_caps` (default): delivered and monitored, bounded by `costCaps`;
  - `unmonitored`: delivered without new monitoring.
- **Breaker:** `createIncidentMode({ financialBreaker })` accepts `{ level }` or `{ telephonySuspended, monitoringSuspended }`.
- **Overlap to reconcile:** `feature/financial-safety-hard-limits` `callAdmission.admit` also detects loops and caller floods, and holds its own concurrency. When integrating, keep **one** owner per concern:
  - abuse layer: loops, caller/household velocity, abuse concurrency;
  - Claude 1: £ ceilings, allowance, reservations.

  Do not run both loop/flood checks with different thresholds.

## 7. Provider limitations (cannot be fixed in HCG code)

1. UK PSTN caller ID is not authenticated. STIR/SHAKEN is not deployed in the UK; `StirVerstat` is usually absent. A spoofed trusted CLI is indistinguishable from the real one.
2. Twilio webhook signatures have no timestamp or nonce, so a stale replay is undetectable without a provider round-trip.
3. Twilio has no hard spend cap. Usage Triggers only notify. Geo permissions and the master auth token are account-level controls.
4. The `ForwardedFrom`/diversion header does not reliably identify the forwarding line (184/184 calls).
5. There is no inbound concurrency cap per number in HCG's control. Twilio channel caps would need SIP/BYOC (see the commercial-viability research).
6. Dial `action` callback semantics when the caller hangs up during `<Say>` are not relied upon. Leases use a TTL and provider verification instead.
7. Ofcom numbering sub-range data (Crown Dependency mobile blocks, high-termination ranges) is not embedded. `ABUSE_DENY_E164_PREFIXES` covers it until a provider lookup exists.

## 8. Residual launch blockers (abuse-relevant)

1. **Process-local state.** Velocity, cooldowns, replay cache, leases, single-flight and auto-trips reset on restart and do not span instances. The provisional schema (`docs/security/provisional-migrations/PROVISIONAL_telephony_abuse_controls.sql`) must be numbered, reviewed and applied, and adapters written, before HCG runs more than one instance.
2. **Genuine inbound-minute flood from many spoofed CLIs to one household** is delivered by design (hard requirement). Cost is bounded only by household concurrency (3) × call duration. This needs Andrew's decision or a provider-side channel cap.
3. **Master Twilio auth token + geo permissions** (catastrophic-risk review). Outbound voice geo is reportedly all off; SMS geo is still pending in Console.
4. **Twilio number Voice URL hosts vs `TWILIO_WEBHOOK_ALLOWED_HOSTS`.** This is the Security P0 deploy risk, inherited.
5. **Migration-number collisions** (055/058/060/061) block numbering the provisional migration.
6. **Claude 1 integration:** the port is wired with `null` (not integrated), so financial authorisation is not consulted yet.
7. **Legacy untagged numbers** are invisible to adoption and orphan detection.

## 9. Configuration (all optional, env)

| Variable | Default | Meaning |
|---|---|---|
| `HCG_INCIDENT_MODE` | `normal` | `contain` / `suspend_paid` / `full_stop` (manual) |
| `ABUSE_CALLER_HOUSEHOLD_BURST` / `_WINDOW_MINUTES` / `_COOLDOWN_MINUTES` | 8 / 5 / 15 | Per caller→household |
| `ABUSE_CALLER_FANOUT_HOUSEHOLDS` / `_WINDOW_MINUTES` / `_COOLDOWN_MINUTES` | 5 / 60 / 60 | One caller → many households |
| `ABUSE_HOUSEHOLD_ELEVATED_CALLS` / `_WINDOW_MINUTES` | 20 / 10 | Flag only |
| `ABUSE_TRUSTED_BYPASS_BURST` / `_WINDOW_MINUTES` | 4 / 10 | Bypass suspension |
| `ABUSE_MAX_CONCURRENT_PER_HOUSEHOLD` / `_PER_CALLER` / `_GLOBAL` | 3 / 2 / 200 | |
| `ABUSE_CALL_LEASE_TTL_MINUTES` | 10 | Leaked-lease bound |
| `ABUSE_GLOBAL_CALLS_PER_MINUTE_TRIP` | 300 | Auto contain |
| `ABUSE_INCIDENT_AUTO_TRIP_MINUTES` | 30 | |
| `ABUSE_WEBHOOK_REPLAY_WINDOW_MINUTES` | 30 | |
| `ABUSE_MAX_PURCHASES_GLOBAL_PER_HOUR` / `_PER_DAY` | 10 / 40 | |
| `ABUSE_MAX_PURCHASES_HOUSEHOLD_30D` | 2 | Prior numbers → hold |
| `ABUSE_MAX_HOUSEHOLDS_PER_PHONE_NUMBER` | 1 | |
| `ABUSE_MAX_SIGNUPS_PER_EMAIL_BASE` | 2 | |
| `ABUSE_FINANCIAL_UNAVAILABLE_POLICY` | `local_caps` | or `unmonitored` |
| `ABUSE_FINANCIAL_AUTH_TIMEOUT_MS` | 1500 | |
| `ABUSE_DENY_E164_PREFIXES` | — | e.g. `+447624,+447781` |
| `ABUSE_HELD_HOUSEHOLD_IDS` | — | Emergency operator holds |
| `ABUSE_AUDIT_HASH_SECRET` | built-in constant | **Set in production** so caller hashes are not reversible by dictionary |

Defaults are **not** tuned on real traffic. HCG has no meaningful volume yet, so every default above is a decision for Andrew before launch.
