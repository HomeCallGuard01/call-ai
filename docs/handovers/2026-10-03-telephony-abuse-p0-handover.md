# Handover — Telephony Fraud & Abuse Fortress P0 (Claude 2)

**Date:** 2026-10-03
**Author:** Claude 2 (Claude Code session), for Andrew

## 1. Where the work is

| | |
|---|---|
| Branch | `security/telephony-abuse-p0` (pushed to `origin`) |
| Worktree | `/Users/ad/call-ai-telephony-abuse-p0` (its `node_modules` is a symlink to `/Users/ad/call-ai/node_modules`, gitignored) |
| Base | `origin/security/voice-surface-p0` @ `7f0bae3`, itself `origin/main` @ `eb43368` + 5 Security P0 commits |
| Code commits | `5ee4768` feat (abuse layer + wiring) · `c5f8c94` tests |
| Docs commit | this handover + threat model + provisional SQL (the commit after `c5f8c94`; see `git log`) |
| State | Clean and pushed at handover time. **Not merged, no PR, not deployed.** |

**Why base on Security P0, not main?** The brief says to reuse its webhook signature guard, stream tokens and cost caps rather than duplicate them. Consequence: **this branch must merge after (or together with) `security/voice-surface-p0`.**

No other Claude's worktree was edited. The primary checkout `/Users/ad/call-ai` (on `p0-batch1-carrier-policy-quarantine`, with someone's uncommitted `tests/checkout-confirmation.test.mjs`) was not touched.

## 2. Architecture

New: `services/abuse/`

| Module | Responsibility |
|---|---|
| `numberPolicy.js` | Parse + classify any number (UK National Numbering Plan top-level classes, Crown Dependencies, global service codes, short/emergency, malformed); per-purpose allowlists; canonical comparison; masking |
| `inboundCallGuard.js` | Ordered screening for `POST /voice` (§4 below); concurrency leases; financial port call; trusted decision last |
| `webhookIntegrity.js` | AccountSid, parameter pollution, payload bounds, CallSid format, replay/duplicate (cached identical TwiML) |
| `twimlEgressGuard.js` | Final check on every voice response: refuses Number/Sip/Conference/…, foreign callback hosts, another household's Client |
| `incidentMode.js` | `normal` / `contain` / `suspend_paid` / `full_stop`; sources: env, auto-trip (capped at contain), Claude 1 breaker port, provisional DB flag |
| `velocity.js` | Bounded process-local sliding windows, distinct counters, cooldowns, TTL leases |
| `provisioningGuard.js` | Single-flight, incident + global purchase velocity, account-risk hold, friendlyName idempotency tag, response check, orphan finder |
| `accountRisk.js` | Multi-account signals that exist today + ports for those that don't |
| `financialAuthorizationPort.js` | The only boundary with Claude 1 (timeouts, normalisation, unavailable semantics) |
| `abuseAudit.js` | One structured, PII-minimised record per decision (+ writer port) |
| `abuseConfig.js` | Every threshold, env-overridable |
| `index.js` | Composition root; read-only Supabase/Twilio adapters |

Changed:

- `server.js`
  - builds the layer once;
  - `/voice`, `/process`, `/red-line-terminate`, `/call-delivery-failed` and `/call-status` gain `twilioWebhookIntegrity`;
  - every voice response goes through `sendVoiceTwiml` (egress guard + replay cache);
  - `/voice` calls `inboundGuard.screen` before the trusted-contact decision;
  - the monitoring gate is narrowed by `abuseDecision.monitor`;
  - callbacks and stream end release leases;
  - SMS gets the incident gate.
- `services/twilioProvisioning.js`
  - `ensureTwilioNumberProvisioned` goes through the guard; the purchase mechanics are now `purchaseTwilioNumber`;
  - production refuses to buy if the guard is not configured.
- `services/householdPhoneNumber.js`: destination policy, and the number must not be HCG-owned (fails closed).
- `services/liveMonitoring/costCaps.js`
  - the SMS destination check uses `numberPolicy`;
  - `guardSmsClient` takes a paid-action gate.
- `services/liveMonitoring/mediaStreamHandler.js`: passes `paidActionGate` through.
- `services/phone.js`, `services/contactsSync.js`, contact routes in `server.js` and `routes/mobileApi.js`: `normaliseContactNumber`.
  - UK contacts are stored unchanged (legacy 10 digits).
  - International contacts are now stored as E.164 instead of being truncated.
- `routes/admin.js`: admin retry-provisioning passes `abuseOverride: "admin"`. It clears only an account-risk hold; nothing else.

## 3. Threats found (new evidence from this investigation)

1. **Trusted-contact last-10-digit collision.** Any caller from any country whose number ended in the same 10 digits as a UK contact was treated as trusted and skipped monitoring. Example: `+33 7700 900555` matched UK `07700 900555`. Fixed.
2. **SMS destination loophole.** Security P0's `/^\+447\d{9}$/` admitted 070 personal numbers, 076 pagers and 07624 Isle of Man mobiles, all classic premium/IRSF ranges. `households.phone_number` accepted any 10-digit UK-shaped number, including 09 premium and 087. Fixed.
3. **Number purchase races.**
   - Concurrent `/billing/reconcile-session` calls, or webhook + reconcile together, could each buy a number before `assign` serialised them.
   - The loser was released, but its first-month charge had already been paid.
   - A create that timed out after succeeding, or a DB assign failure after purchase, left an **untracked orphan**, and the retry bought another.

   Fixed by single-flight plus a provider-side tag with adopt-before-buy.
4. **Calls to numbers owned by no household** (quarantined/unassigned) were *answered* with `<Say>` (billed). They now get `<Reject>` (unbilled).
5. **No replay protection.** A captured signed `/voice` could be replayed indefinitely; each replay minted a fresh stream token. Fixed within a 30-minute window. Older replays remain a provider limitation.
6. **No loop detection on inbound.** An HCG number calling an HCG number, `From == To`, or ForwardedFrom = HCG was handled as a normal call. Fixed.
7. **Rapid-abuse detection was alert-only.** Nothing refused a flood. Fixed with per-caller cooldowns that do not lock out the victim.
8. **No global way to stop new paid activity** short of a code change. Added incident mode.
9. **A trusted contact skipped every check after signature verification.** Trust is now the last step and only decides monitoring.

Confirmed **not** exploitable: premium/international trusted contacts cannot cause HCG-paid outbound traffic. Contacts are never destinations, HCG has no PSTN leg, and SDK client-origin calls are rejected. The egress guard now makes this a tested invariant rather than an emergent property.

## 4. Precise order of policy checks (inbound)

0. Twilio signature (Security P0) → webhook integrity → replay/duplicate.
1. Client origin.
2. Global incident mode.
3. Household exists for the dialled number.
4. Household abuse hold.
5. Loop / lineage (self, HCG caller, ForwardedFrom, ParentCallSid).
6. Caller velocity (pair burst, fan-out; cooldowns are per caller).
7. Household volume. **Flag only.**
8. Concurrency (household/caller refused only when the provider confirms; global degrades).
9. Financial authorisation (Claude 1 port).
10. Trusted-contact match (full E.164; suspended under spoofing indicators).
11. Entitlement ∧ `abuseDecision.monitor` ∧ not duplicate → announcement + stream.
12. TwiML egress guard.

Full table with rationale: `docs/security/TELEPHONY_ABUSE_THREAT_MODEL.md` §3.

## 5. Destination restrictions

| Purpose | Allowed classes |
|---|---|
| Warning SMS | UK mobile (071–075, 077–079, excluding 07624) **only**; must already be canonical E.164 |
| `households.phone_number` | UK mobile, UK geographic; never an HCG-owned (assigned or quarantined) number |
| HCG PSTN dial | **none** (no product path); egress guard refuses `<Number>`/`<Sip>`/… regardless |
| Provisioned HCG number | UK geographic only, and must equal the number requested |
| Trusted contact (identity only) | UK mobile/geographic/03/05x, Crown Dependency, international. Premium/070/076/084/087/satellite CLIs never get the bypass |

Operator escape hatch: `ABUSE_DENY_E164_PREFIXES` (no deploy). Still needed: Ofcom sub-range data or Twilio Lookup line type (paid) for Channel Islands mobile blocks and high-termination ranges.

## 6. Trusted-contact behaviour

- Matching is on full E.164. A legacy 10-digit row is read as UK.
- International contacts are stored as E.164 from now on. Rows already stored truncated stay UK-interpreted, so a few pre-existing international contacts will now be **monitored** instead of bypassed until re-saved. This is deliberate: the safe direction.
- The bypass only removes monitoring and its announcement. It never removes:
  - steps 0–9;
  - entitlement checks;
  - the egress guard.
- The bypass is suspended when any of these holds:
  - the CLI is withheld or malformed;
  - the CLI's class is not trustable;
  - `StirVerstat` reports a failure;
  - that CLI has made ≥ 5 calls to the household in 5 minutes;
  - the household is in an elevated (flood) state.
- **HCG cannot prove PSTN caller identity.** A single, quiet, well-spoofed call presenting a trusted CLI still gets the bypass. This is a provider limitation (no UK STIR/SHAKEN).

## 7. Loop prevention

Refused at step 5:

- `From == To`;
- `From` is any HCG number (assigned or quarantined, any format);
- `ForwardedFrom` is an HCG number;
- `ParentCallSid` present (hop limit 0; whether Twilio sets it on own-number re-entry is unverified).

Refused at write time: `households.phone_number` equal to any HCG number.

If the directory is unavailable, the check fails **open** (audited), still bounded by velocity and concurrency. Carrier-internal forward chains that never present an HCG CLI are invisible to HCG (provider dependency).

## 8. Velocity controls (defaults; all env-tunable)

- **Caller → household:** > 8 calls in 5 min → that caller refused for 15 min. Other callers unaffected.
- **Caller → households:** > 5 distinct households in 60 min → that caller refused everywhere for 60 min.
- **Household from many callers:** > 20 in 10 min → **flag + alert + trusted bypass suspended. Never refused.**
- **Concurrency:**
  - household 3 and caller 2: refused only after Twilio REST (`calls.list`, read-only) confirms the live count; provider unavailable → delivered;
  - leaked leases expire after 10 min;
  - global 200 → degrade + contain.
- **Global call rate:** > 300/min → auto `contain` (no purchases, no SMS) for 30 min.

## 9. Provisioning controls

In order:

1. single-flight per household;
2. incident mode (contain+, or breaker unreadable → no purchase);
3. global ceilings 10/hour, 40/day (→ hold + contain);
4. account-risk hold (§10; admin can override with an audit record);
5. optional cross-instance claim port;
6. look up `friendlyName = hcg-hh-<householdId>` and adopt an existing, non-quarantined, unassigned number;
7. buy with the tag;
8. verify the provider response (same number, UK geographic), otherwise release immediately;
9. assign; if the race is lost, release (existing).

`findOrphanedTaggedNumbers()` is a read-only reconciliation helper. Release paths were reviewed and left unchanged: release happens only after human-confirmed deactivation, via quarantine.

## 10. Multi-account controls

Implemented with existing data:

- same protected phone number on another household;
- normalised email base reused ≥ 2 (gmail dots, `+tags`, googlemail, case);
- ≥ 2 quarantined numbers for the household in 30 days (buy → abandon → repeat);
- free entitlement combined with any other signal;
- history unreadable → hold.

Ports defined but **not implemented**:

- payment fingerprint (needs Stripe webhook expansion);
- sign-up IP (needs `trust proxy` + storage + retention decision);
- device (deliberately not fingerprinted without a privacy decision).

Account creation itself has no HCG rate limit (no paid resource at sign-up; Supabase auth limits apply).

## 11. Webhook controls

Reused, not duplicated: Security P0 signature guard (enforce mode, host allowlist) and stream tokens.

Added:

- AccountSid must match `TWILIO_ACCOUNT_SID` (403);
- arrays on decision fields (400);
- > 200 params or > 2 KB value (413);
- CallSid must be `CA` + 32 hex (400);
- duplicates within 30 min:
  - `/voice` returns the identical cached TwiML (no second stream token, count or lease);
  - callbacks skip their side effects.

Stale replays after the window or a restart: provider dependency (no signed timestamp).

## 12. Tests and results

| Suite | Result |
|---|---|
| `tests/telephony-abuse-attacks.test.mjs` (real `server.js`, fake Supabase, no provider creds) | **34/34 pass** |
| `tests/telephony-abuse-controls.test.mjs` (module-level, in-memory fakes) | **90/90 pass** |
| Full suite, per file, dummy Supabase env | **107/109 files pass, 3964 ✓ checks** (baseline on base branch: 105/107, 3840). The 2 failures are the known Android tests needing a prebuilt `mobile/node_modules` (fail identically on the base) |
| Provisional SQL | Executed once in an **in-memory PGlite** in the scratchpad (not a repo test, not any real DB): creates cleanly, re-runs idempotently, `abuse_hit` counts 1/2/3, claim exclusive, automation cannot set `full_stop` |

Required attacks → outcome:

| Attack | Outcome | Where |
|---|---|---|
| Premium number marked trusted | No leg to it; bypass refused for that CLI | attacks |
| International number marked trusted | Identity-only, never dialled; last-10 collision refused | attacks |
| Alternate formatting of blocked destination | 8 formats → same class, refused for SMS/household/PSTN | controls |
| Malformed E.164 | 16 forms never parse/refused; malformed caller delivered, never trusted | controls, attacks |
| Spoofed caller matching trusted contact | STIR-fail / burst / flood → bypass suspended; a single quiet spoof is **not** detectable (documented) | attacks |
| Self-forward loop | `<Reject>` | attacks |
| Two-number loop | `<Reject>` | attacks |
| Multi-household loop | `<Reject>` (normalisation variant) | attacks |
| 100 rapid calls | 8 delivered, 92 refused unbilled; other caller delivered | attacks |
| Same caller attacking many households | 6th household refused; refused everywhere after; others unaffected | attacks |
| Many callers attacking one household | All 30 delivered; flagged | attacks |
| 100 account creations | 10 numbers bought, 90 held, contain tripped | controls |
| Repeated number provisioning | Held before purchase; admin override audited | controls |
| Duplicate provider callback | Identical response, side effects skipped | attacks |
| Retry after timeout | Adopted, no second purchase | controls |
| Two concurrent number purchases | 3 concurrent → 1 purchase | controls |
| Unauthorized account manipulating another household | No request-supplied household ids; identity from auth only (structural) | controls |
| Forged webhook | 403 | attacks |
| Replayed webhook | Identical cached TwiML, audited | attacks |
| Global incident mode | contain / suspend_paid / full_stop behave as specified (3 real boots) | attacks, controls |
| Abuse control unavailable | Directory throws → delivered + flagged; guard throws → delivered unscreened, never trusted, alerted; SMS gate throws → SMS refused; history unreadable → purchase held | controls |
| Financial authorization unavailable | Timeout/throw/malformed → delivered; monitoring per policy; audited critical | controls |

Five existing **source-string** tests were updated because the `/voice` signature and return statements changed:

- `subscription-enforcement-voice-gate`
- `voice-client-reachability-integration`
- `live-monitoring-scenarios`
- `live-monitoring-transcription-efficiency`
- `activation-verification`

Their invariants are unchanged; the diffs are in `c5f8c94`.

## 13. Migrations and conflicts

- **None created in `supabase/migrations/`. None applied anywhere.**
- Inventory across all local and remote branches: highest number used was **061** at the start of this work. Collisions exist at 055 (×2), 058 (×2), 060 (×2) and 061 (×2). Re-checked at handover: **062** (`feature/customer-identity-carrier-abstraction`) and **063** (`feature/customer-allowance`) have since been claimed.
- Provisional schema: `docs/security/provisional-migrations/PROVISIONAL_telephony_abuse_controls.sql`. It is unnumbered and covers:
  - `abuse_decisions`;
  - `abuse_counters` + `abuse_hit()`;
  - `abuse_cooldowns`;
  - `abuse_incident_state`;
  - `abuse_household_holds`;
  - `number_provisioning_claims` + `claim_number_provisioning()`.

  Everything is RLS-on, with anon/authenticated revoked.
- Number it (≥ **064**, re-check first) only after the collisions are resolved and Andrew approves. Adapters for these ports are not written yet.

## 14. Dependencies on Claude 1 (Financial Fortress)

1. Supply `{ authorize, release }` for `createFinancialAuthorizationPort`, and a breaker reader, in `server.js` (currently `null`). The contract is in the port's header and threat model §6.
2. `telephony: 'reject'` only for Andrew-approved kill states. £ ceilings must return `monitoring: 'deny'` (the hard requirement already noted against `feature/financial-safety-hard-limits`).
3. De-duplicate overlapping checks. `callAdmission.admit` on Claude 1's branch also does loop detection, caller floods and concurrency. Decide one owner each. Proposal: abuse layer owns loops, velocity and abuse concurrency; Claude 1 owns £, allowance and reservations.
4. `authorize` must be idempotent per CallSid. The abuse layer already never calls it for duplicates within the replay window.

## 15. Provider limitations

- No UK caller-ID authentication.
- No timestamp/nonce in Twilio signatures.
- No Twilio spend cap; account-level master token and geo permissions.
- `ForwardedFrom` is not informative.
- No per-number inbound channel cap.
- Dial action semantics on early hang-up are not relied upon.
- No embedded Ofcom sub-range data.

Detail: threat model §7.

## 16. Residual launch blockers (abuse)

1. Process-local state (restart/instances): needs the provisional schema + adapters.
2. Many-spoofed-CLI inbound-minute flood to one household is delivered by design. Bounded only by concurrency × duration. **Andrew decision**, or a provider-side channel cap.
3. Master auth token / geo permissions / TwiML App voice URL: Console verification (catastrophic-risk review).
4. Deploying Security P0 first: inventory number Voice URL hosts against `TWILIO_WEBHOOK_ALLOWED_HOSTS`, otherwise genuine calls get 403.
5. Set `TWILIO_ACCOUNT_SID` (it already exists for the REST client) and **`ABUSE_AUDIT_HASH_SECRET`** in production.
6. Every default threshold is a placeholder awaiting Andrew's decision.
7. Legacy untagged Twilio numbers are not covered by adoption/orphan detection.

## 17. Exact integration order

1. Resolve migration-number collisions (055/058/060/061). Agree the next free number (062/063 are now taken, so ≥ 064).
2. Merge/deploy **`security/voice-surface-p0`** first, with its own host-allowlist checklist.
3. Merge **`security/telephony-abuse-p0`** on top. No migration is needed for it to run. Set env:
   - `TWILIO_ACCOUNT_SID` (present);
   - `ABUSE_AUDIT_HASH_SECRET`;
   - leave `HCG_INCIDENT_MODE` unset.
4. Staging verification with real signed calls:
   - trusted, unknown, loop, burst (from two handsets);
   - one purchase in a staging-safe way, following the non-prod provisioning guards.
5. Claude 1 wires the financial port and breaker. Remove duplicate loop/flood logic from one side.
6. Apply the (numbered) provisional schema. Add adapters:
   - audit writer;
   - shared velocity/cooldowns;
   - DB incident flag;
   - holds;
   - provisioning claim.
7. Only then run more than one instance.

## 18. Confirmation

- **No production, staging or live-carrier change was made.** No deploy, no merge, no PR.
- No migration was applied anywhere. The provisional SQL ran only in a throwaway in-memory PGlite.
- No Twilio/Supabase/Stripe/OpenAI network call was made by any test. The black-box harness has no provider credentials, and its Supabase and OpenAI are local fakes. No Twilio number, Voice URL or geo setting was read or changed.
- The handover and docs were scanned for secrets before commit (see §19).

## 19. Secret scan

Before committing, this handover, the threat model and the provisional SQL were scanned with:

- `grep -E` for `AC[0-9a-f]{32}`, `SK[0-9a-f]{32}`, `sk-`, `sk_live`, `rk_live`, `whsec_`, `eyJ` (JWT), `re_` (Resend), private-key headers, and `password=`;
- a check for real phone numbers outside the Ofcom drama range.

Matches found: none. Test files contain only obvious dummy values (`test_twilio_auth_token_abuse`, `sk-test-local-stub`, `ACtest`).
